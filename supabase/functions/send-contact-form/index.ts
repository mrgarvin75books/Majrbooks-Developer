import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { serviceClient } from "../_shared/security.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ContactFormRequest {
  name: string;
  email: string;
  phone: string;
  message: string;
}

const handler = async (req: Request): Promise<Response> => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      console.error("[SEND-CONTACT-FORM] RESEND_API_KEY not configured");
      throw new Error("Email service not configured");
    }

    const resend = new Resend(resendApiKey);
    const { name, email, phone, message }: ContactFormRequest = await req.json();

    console.log("[SEND-CONTACT-FORM] Processing contact form submission", { name, email, phone });

    // Keep a copy in the MAJRBooks Messages inbox so admins can review and answer it in the app.
    try {
      const { error: inboxError } = await serviceClient().rpc("inbox_ingest", {
        p_name: String(name ?? "").slice(0, 200),
        p_email: String(email ?? ""),
        p_subject: `Website inquiry from ${String(name ?? "").slice(0, 200)}`,
        p_body: `${String(message ?? "").slice(0, 9500)}${phone ? `\n\nPhone: ${String(phone).slice(0, 50)}` : ""}`,
        p_source: "contact_form",
      });
      if (inboxError) console.error("[SEND-CONTACT-FORM] Inbox copy failed:", inboxError.message);
    } catch (inboxErr) {
      console.error("[SEND-CONTACT-FORM] Inbox copy failed:", inboxErr);
    }

    // Send notification to support
    const emailResponse = await resend.emails.send({
      from: "MAJR Books Contact <support@majrbooks.com>",
      to: ["support@majrbooks.com"],
      subject: `New Contact Form Submission from ${name}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #10b981;">New Contact Form Submission</h2>
          <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Name:</strong> ${name}</p>
            <p><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
            <p><strong>Phone:</strong> <a href="tel:${phone}">${phone}</a></p>
          </div>
          <div style="background: #ffffff; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
            <h3 style="margin-top: 0;">Message:</h3>
            <p style="white-space: pre-wrap;">${message}</p>
          </div>
          <p style="color: #6b7280; font-size: 12px; margin-top: 20px;">
            This message was sent from the MAJR Books contact form.
          </p>
        </div>
      `,
    });

    console.log("[SEND-CONTACT-FORM] Email sent successfully", emailResponse);

    return new Response(JSON.stringify({ success: true, data: emailResponse }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("[SEND-CONTACT-FORM] Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
};

serve(handler);
