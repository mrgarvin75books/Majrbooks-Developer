import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { Resend } from "https://esm.sh/resend@2.0.0";
import {
  assertUuid,
  corsHeaders,
  errorResponse,
  escapeHtml,
  getScopeOwnerId,
  HttpError,
  isInternalRequest,
  jsonResponse,
  requireUser,
  serviceClient,
} from "../_shared/security.ts";

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      throw new Error("RESEND_API_KEY is not configured");
    }

    const supabase = serviceClient();
    const resend = new Resend(resendApiKey);

    // Internal callers (recurring-invoice generator) may send any invoice;
    // signed-in users may only send invoices from the books they work in.
    const internal = isInternalRequest(req);
    const caller = internal ? null : await requireUser(req);

    const body = await req.json().catch(() => ({}));
    const invoiceId = assertUuid(body?.invoiceId, "invoiceId");

    // Get invoice details
    const { data: invoice, error: invoiceError } = await supabase
      .from("invoices")
      .select("*")
      .eq("id", invoiceId)
      .maybeSingle();

    if (invoiceError) throw invoiceError;
    if (!invoice) throw new HttpError(404, "Invoice not found");

    if (caller) {
      const ownerId = await getScopeOwnerId(supabase, caller.id);
      if (invoice.user_id !== ownerId) {
        throw new HttpError(404, "Invoice not found");
      }
    }

    if (!invoice.client_email) {
      throw new HttpError(400, "This invoice has no client email address");
    }

    // Get line items
    const { data: lineItems } = await supabase
      .from("invoice_line_items")
      .select("*")
      .eq("invoice_id", invoiceId);

    // Create email content
    const lineItemsHtml = lineItems
      ?.map(
        (item) => `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #eee;">${escapeHtml(item.description)}</td>
          <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">$${Number(item.rate).toFixed(2)}</td>
          <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: center;">${escapeHtml(item.quantity)}</td>
          <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">$${(Number(item.rate) * Number(item.quantity)).toFixed(2)}</td>
        </tr>
      `
      )
      .join("");

    const emailHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <h1 style="color: #00C896; margin: 0;">Invoice ${escapeHtml(invoice.invoice_number)}</h1>
          </div>

          <div style="margin-bottom: 20px;">
            <p><strong>Billed To:</strong> ${escapeHtml(invoice.client_name)}</p>
            <p><strong>Date of Issue:</strong> ${new Date(invoice.issue_date).toLocaleDateString()}</p>
            <p><strong>Due Date:</strong> ${new Date(invoice.due_date).toLocaleDateString()}</p>
          </div>

          <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
            <thead>
              <tr style="background: #f8f9fa;">
                <th style="padding: 12px; text-align: left; border-bottom: 2px solid #dee2e6;">Description</th>
                <th style="padding: 12px; text-align: right; border-bottom: 2px solid #dee2e6;">Rate</th>
                <th style="padding: 12px; text-align: center; border-bottom: 2px solid #dee2e6;">Qty</th>
                <th style="padding: 12px; text-align: right; border-bottom: 2px solid #dee2e6;">Line Total</th>
              </tr>
            </thead>
            <tbody>
              ${lineItemsHtml}
            </tbody>
          </table>

          <div style="text-align: right; margin-bottom: 20px;">
            <p><strong>Subtotal:</strong> $${Number(invoice.subtotal || invoice.amount).toFixed(2)}</p>
            <p><strong>Tax:</strong> $${Number(invoice.tax || 0).toFixed(2)}</p>
            <p style="font-size: 1.2em; color: #00C896;"><strong>Amount Due:</strong> $${Number(invoice.amount).toFixed(2)}</p>
          </div>

          ${invoice.notes ? `
            <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-top: 20px;">
              <p style="margin: 0;"><strong>Notes:</strong></p>
              <p style="margin: 10px 0 0 0;">${escapeHtml(invoice.notes)}</p>
            </div>
          ` : ''}

          <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #dee2e6; text-align: center; color: #6c757d; font-size: 0.9em;">
            <p>Thank you for your business!</p>
            <p>Please remit payment by ${new Date(invoice.due_date).toLocaleDateString()}</p>
          </div>
        </body>
      </html>
    `;

    // Send invoice email using Resend
    const { data: emailData, error: emailError } = await resend.emails.send({
      from: 'MajrBooks <support@majrbooks.com>',
      to: [invoice.client_email],
      subject: `Invoice ${invoice.invoice_number} from MajrBooks`,
      html: emailHtml,
    });

    if (emailError) {
      console.error("Error sending invoice email:", emailError);
      throw new Error(`Failed to send email: ${emailError.message}`);
    }

    console.log(`Invoice ${invoice.invoice_number} sent to ${invoice.client_email}`, emailData);

    // Update invoice status to pending if it was draft
    if (invoice.status === "draft") {
      await supabase
        .from("invoices")
        .update({ status: "pending" })
        .eq("id", invoiceId);
    }

    return jsonResponse({
      success: true,
      message: `Invoice sent to ${invoice.client_email}`,
      emailId: emailData?.id
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};

serve(handler);
