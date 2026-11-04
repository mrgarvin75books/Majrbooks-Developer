import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  corsHeaders,
  errorResponse,
  isInternalRequest,
  requireUser,
  serviceClient,
} from "../_shared/security.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Scheduler (CRON_SECRET / service key) processes every account;
    // a signed-in user running it manually only processes their own invoices.
    const scopeUserId = isInternalRequest(req) ? null : (await requireUser(req)).id;
    const supabase = serviceClient();

    // Get today's date
    const today = new Date().toISOString().split("T")[0];

    // Find overdue invoices (due_date < today and status is pending or draft)
    let invoiceQuery = supabase
      .from("invoices")
      .select("*")
      .lt("due_date", today)
      .in("status", ["pending", "draft"])
      .order("due_date", { ascending: true });
    if (scopeUserId) invoiceQuery = invoiceQuery.eq("user_id", scopeUserId);
    const { data: overdueInvoices, error: invoicesError } = await invoiceQuery;

    if (invoicesError) {
      console.error("Error fetching overdue invoices:", invoicesError);
      throw invoicesError;
    }

    console.log(`Found ${overdueInvoices?.length || 0} overdue invoices`);

    if (!overdueInvoices || overdueInvoices.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No overdue invoices found", processed: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get all active workflows with invoice_overdue trigger
    let workflowQuery = supabase
      .from("workflows")
      .select("*")
      .eq("trigger_type", "invoice_overdue")
      .eq("status", "active");
    if (scopeUserId) workflowQuery = workflowQuery.eq("user_id", scopeUserId);
    const { data: workflows, error: workflowsError } = await workflowQuery;

    if (workflowsError) {
      console.error("Error fetching workflows:", workflowsError);
      throw workflowsError;
    }

    console.log(`Found ${workflows?.length || 0} active invoice_overdue workflows`);

    if (!workflows || workflows.length === 0) {
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: "No active invoice_overdue workflows configured", 
          overdueCount: overdueInvoices.length,
          processed: 0 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let processedCount = 0;
    const results: any[] = [];

    // Process each overdue invoice
    for (const invoice of overdueInvoices) {
      // Calculate days overdue
      const dueDate = new Date(invoice.due_date);
      const todayDate = new Date(today);
      const daysOverdue = Math.floor((todayDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));

      // Find workflows for this user
      const userWorkflows = workflows.filter(w => w.user_id === invoice.user_id);

      for (const workflow of userWorkflows) {
        // Prepare trigger data with invoice details
        const triggerData = {
          invoice_id: invoice.id,
          invoice_number: invoice.invoice_number,
          client_name: invoice.client_name,
          client_email: invoice.client_email || "",
          amount: invoice.amount,
          amount_due: invoice.amount - (invoice.amount_paid || 0),
          due_date: invoice.due_date,
          days_overdue: daysOverdue,
          issue_date: invoice.issue_date,
        };

        console.log(`Triggering workflow "${workflow.name}" for invoice ${invoice.invoice_number}`);

        try {
          // Execute the workflow
          const { data: execResult, error: execError } = await supabase.functions.invoke(
            "execute-workflow",
            {
              body: {
                workflowId: workflow.id,
                triggerData,
              },
            }
          );

          if (execError) {
            console.error(`Error executing workflow for invoice ${invoice.invoice_number}:`, execError);
            results.push({
              invoice_number: invoice.invoice_number,
              workflow: workflow.name,
              success: false,
              error: execError.message,
            });
          } else {
            console.log(`Workflow executed successfully for invoice ${invoice.invoice_number}`);
            results.push({
              invoice_number: invoice.invoice_number,
              workflow: workflow.name,
              success: true,
            });
            processedCount++;
          }
        } catch (execException) {
          console.error(`Exception executing workflow:`, execException);
          results.push({
            invoice_number: invoice.invoice_number,
            workflow: workflow.name,
            success: false,
            error: execException instanceof Error ? execException.message : String(execException),
          });
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Processed ${processedCount} workflow executions for ${overdueInvoices.length} overdue invoices`,
        overdueCount: overdueInvoices.length,
        processed: processedCount,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return errorResponse(error);
  }
});
