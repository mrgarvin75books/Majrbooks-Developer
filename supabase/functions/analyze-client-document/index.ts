import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertProjectStorageUrl } from "../_shared/security.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { fileUrl, fileName, documentType } = await req.json();
    if (!fileUrl || !fileName) {
      return new Response(JSON.stringify({ error: 'Missing fileUrl or fileName' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');

    let safeFileUrl: string;
    try {
      safeFileUrl = assertProjectStorageUrl(fileUrl, "fileUrl");
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const fileResponse = await fetch(safeFileUrl);
    if (!fileResponse.ok) throw new Error(`Failed to fetch file: ${fileResponse.status}`);

    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const isText = ['txt', 'csv'].includes(ext);
    const isPDF = ext === 'pdf';
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);

    const systemPrompt = `You are an expert financial document analyzer for a bookkeeping firm.
Analyze the provided document and give a comprehensive summary including:
- Document type and purpose
- Key financial figures and dates
- Important items requiring attention
- Recommendations for the accountant

Be concise but thorough. Use clear headings and bullet points.`;

    let messageContent: any[];

    if (isText) {
      const text = await fileResponse.text();
      messageContent = [{
        type: 'text',
        text: `Document: ${fileName}\nType: ${documentType || 'Financial Document'}\n\n${text}`,
      }];
    } else if (isPDF) {
      const arrayBuffer = await fileResponse.arrayBuffer();
      const base64 = arrayBufferToBase64(arrayBuffer);
      messageContent = [
        { type: 'text', text: `Please analyze this ${documentType || 'financial'} document named "${fileName}":` },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      ];
    } else if (isImage) {
      const arrayBuffer = await fileResponse.arrayBuffer();
      const base64 = arrayBufferToBase64(arrayBuffer);
      const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
      messageContent = [
        { type: 'text', text: `Please analyze this ${documentType || 'financial'} document named "${fileName}":` },
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
      ];
    } else {
      messageContent = [{
        type: 'text',
        text: `I have a financial document named "${fileName}" of type "${documentType || 'Unknown'}". Please describe what this document typically contains and what an accountant should look for.`,
      }];
    }

    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: messageContent }],
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      throw new Error(`AI analysis failed: ${errorText}`);
    }

    const aiData = await aiResponse.json();
    const analysis = aiData.content?.[0]?.text || 'No analysis available.';

    return new Response(JSON.stringify({ success: true, analysis }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error analyzing document:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
