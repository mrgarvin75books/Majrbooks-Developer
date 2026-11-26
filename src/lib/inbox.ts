import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Client Messages inbox (supabase/migrations/20261125100000_client_messages_inbox.sql).
 * The generated Supabase types don't include these tables yet, so this module
 * is the one typed entry point for them.
 */

export type ThreadStatus = "open" | "pending" | "closed";
export type ThreadSource = "chat_widget" | "portal" | "contact_form" | "email";

export interface InboxThread {
  id: string;
  ref_code: string;
  firm_owner_id: string | null;
  requester_id: string | null;
  requester_name: string;
  requester_email: string;
  subject: string;
  source: ThreadSource;
  status: ThreadStatus;
  staff_unread: boolean;
  requester_unread: boolean;
  last_message_at: string;
  last_message_preview: string | null;
  created_at: string;
}

export interface InboxMessage {
  id: string;
  thread_id: string;
  author_id: string | null;
  author_type: "requester" | "staff" | "system";
  author_name: string;
  body: string;
  via_email: boolean;
  created_at: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const SOURCE_LABELS: Record<ThreadSource, string> = {
  chat_widget: "Chat",
  portal: "Portal",
  contact_form: "Contact form",
  email: "Email",
};

/** Email the other side about a message. Never blocks or fails the send. */
function notify(messageId: string | null | undefined) {
  if (!messageId) return;
  supabase.functions.invoke("notify-inbox-message", { body: { messageId } }).catch(() => {});
}

export async function startThread(input: {
  subject: string;
  body: string;
  source?: ThreadSource;
  name?: string;
  email?: string;
}): Promise<string> {
  const { data, error } = await db.rpc("inbox_start_thread", {
    p_subject: input.subject,
    p_body: input.body,
    p_source: input.source ?? "chat_widget",
    p_name: input.name ?? null,
    p_email: input.email ?? null,
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  notify(row?.message_id);
  return row?.thread_id;
}

export async function replyToThread(threadId: string, body: string): Promise<void> {
  const { data, error } = await db.rpc("inbox_reply", { p_thread_id: threadId, p_body: body });
  if (error) throw new Error(error.message);
  notify(data as string);
}

export async function markThreadRead(threadId: string): Promise<void> {
  await db.rpc("inbox_mark_read", { p_thread_id: threadId });
}

export async function updateThread(
  threadId: string,
  changes: { status?: ThreadStatus; staffUnread?: boolean },
): Promise<void> {
  const { error } = await db.rpc("inbox_update_thread", {
    p_thread_id: threadId,
    p_status: changes.status ?? null,
    p_staff_unread: changes.staffUnread ?? null,
  });
  if (error) throw new Error(error.message);
}

/**
 * Threads visible to the signed-in user.
 *  - "mine": conversations the user started (client / firm user in the widget)
 *  - "inbox": conversations the user answers (firm owner, team, admins)
 */
export function useInboxThreads(scope: "mine" | "inbox", userId: string | null | undefined) {
  const [threads, setThreads] = useState<InboxThread[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!userId) {
      setThreads([]);
      setLoading(false);
      return;
    }
    let query = db.from("inbox_threads").select("*").order("last_message_at", { ascending: false }).limit(200);
    query = scope === "mine"
      ? query.eq("requester_id", userId)
      : query.or(`requester_id.is.null,requester_id.neq.${userId}`);
    const { data, error } = await query;
    if (!error) setThreads((data ?? []) as InboxThread[]);
    setLoading(false);
  }, [scope, userId]);

  useEffect(() => {
    refresh();
    if (!userId) return;
    const channel = supabase
      .channel(`inbox-threads-${scope}-${userId}-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "inbox_threads" }, () => refresh())
      .subscribe();
    // Fallback in case realtime is unavailable.
    const timer = setInterval(refresh, 60_000);
    return () => {
      supabase.removeChannel(channel);
      clearInterval(timer);
    };
  }, [refresh, scope, userId]);

  return { threads, loading, refresh };
}

export function useThreadMessages(threadId: string | null) {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!threadId) {
      setMessages([]);
      return;
    }
    const { data, error } = await db
      .from("inbox_messages")
      .select("*")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true });
    if (!error) setMessages((data ?? []) as InboxMessage[]);
    setLoading(false);
  }, [threadId]);

  useEffect(() => {
    setLoading(true);
    refresh();
    if (!threadId) return;
    const channel = supabase
      .channel(`inbox-messages-${threadId}-${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "inbox_messages", filter: `thread_id=eq.${threadId}` },
        () => refresh(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [refresh, threadId]);

  return { messages, loading, refresh };
}
