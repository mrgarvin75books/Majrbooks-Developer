import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { formatDistanceToNow, format } from "date-fns";
import {
  ArrowLeft,
  CheckCircle2,
  Inbox,
  Loader2,
  Mail,
  MailOpen,
  MessageCircle,
  RotateCcw,
  Search,
  Send,
} from "lucide-react";
import { toast } from "sonner";
import Layout from "@/components/Layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import {
  type InboxThread,
  type ThreadStatus,
  SOURCE_LABELS,
  markThreadRead,
  replyToThread,
  updateThread,
  useInboxThreads,
  useThreadMessages,
} from "@/lib/inbox";

type Filter = "open" | "pending" | "closed" | "all";

const STATUS_STYLES: Record<ThreadStatus, string> = {
  open: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300",
  pending: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300",
  closed: "bg-muted text-muted-foreground",
};
const STATUS_LABELS: Record<ThreadStatus, string> = {
  open: "Needs reply",
  pending: "Waiting on client",
  closed: "Closed",
};

const Messages = () => {
  const { user, isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("thread");
  const [filter, setFilter] = useState<Filter>("open");
  const [search, setSearch] = useState("");
  const { threads, loading, refresh } = useInboxThreads("inbox", user?.id, isAdmin);

  const counts = useMemo(() => ({
    open: threads.filter((t) => t.status === "open").length,
    pending: threads.filter((t) => t.status === "pending").length,
    closed: threads.filter((t) => t.status === "closed").length,
    all: threads.length,
    unread: threads.filter((t) => t.staff_unread).length,
  }), [threads]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return threads.filter((t) =>
      (filter === "all" || t.status === filter) &&
      (!q || [t.subject, t.requester_name, t.requester_email, t.ref_code, t.last_message_preview ?? ""]
        .some((v) => v.toLowerCase().includes(q))),
    );
  }, [threads, filter, search]);

  const selected = threads.find((t) => t.id === selectedId) ?? null;

  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("thread", id);
    else next.delete("thread");
    setParams(next, { replace: true });
  };

  return (
    <Layout>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Inbox className="h-6 w-6 text-primary" />
              Messages
              {counts.unread > 0 && <Badge className="ml-1">{counts.unread} new</Badge>}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Messages and emails from your clients{isAdmin ? ", website visitors and MAJRBooks users" : ""}. Replies are emailed to the sender.
            </p>
          </div>
        </div>

        <Card className="flex overflow-hidden" style={{ height: "calc(100vh - 200px)", minHeight: 480 }}>
          {/* Thread list */}
          <div className={cn("w-full md:w-[360px] md:border-r flex flex-col min-w-0", selected && "hidden md:flex")}>
            <div className="p-3 space-y-2 border-b">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, email, subject…"
                  className="pl-8"
                />
              </div>
              <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
                <TabsList className="grid grid-cols-4 w-full">
                  <TabsTrigger value="open" className="text-xs">Open {counts.open > 0 && `(${counts.open})`}</TabsTrigger>
                  <TabsTrigger value="pending" className="text-xs">Waiting</TabsTrigger>
                  <TabsTrigger value="closed" className="text-xs">Closed</TabsTrigger>
                  <TabsTrigger value="all" className="text-xs">All</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <ScrollArea className="flex-1">
              {loading ? (
                <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
              ) : visible.length === 0 ? (
                <div className="text-center py-12 px-6 text-sm text-muted-foreground">
                  <MessageCircle className="h-8 w-8 mx-auto mb-2 opacity-40" />
                  {threads.length === 0
                    ? "No messages yet. When clients write from the chat widget or by email, they'll show up here."
                    : "No conversations match."}
                </div>
              ) : (
                <ul>
                  {visible.map((t) => (
                    <ThreadRow key={t.id} thread={t} active={t.id === selectedId} onClick={() => select(t.id)} />
                  ))}
                </ul>
              )}
            </ScrollArea>
          </div>

          {/* Conversation */}
          <div className={cn("flex-1 flex-col min-w-0", selected ? "flex" : "hidden md:flex")}>
            {selected ? (
              <Conversation key={selected.id} thread={selected} onBack={() => select(null)} onChanged={refresh} />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground text-sm gap-2">
                <MailOpen className="h-10 w-10 opacity-30" />
                Select a conversation to read and reply
              </div>
            )}
          </div>
        </Card>
      </div>
    </Layout>
  );
};

function ThreadRow({ thread: t, active, onClick }: { thread: InboxThread; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button
        onClick={onClick}
        className={cn(
          "w-full text-left px-4 py-3 border-b hover:bg-muted/60 transition-colors",
          active && "bg-muted",
        )}
      >
        <div className="flex items-center gap-2">
          {t.staff_unread && <span className="h-2 w-2 rounded-full bg-primary shrink-0" aria-label="Unread" />}
          <span className={cn("truncate flex-1 text-sm", t.staff_unread ? "font-semibold" : "font-medium")}>
            {t.requester_name}
          </span>
          <span className="text-xs text-muted-foreground shrink-0">
            {formatDistanceToNow(new Date(t.last_message_at), { addSuffix: false })}
          </span>
        </div>
        <div className={cn("text-sm truncate mt-0.5", t.staff_unread ? "text-foreground" : "text-muted-foreground")}>
          {t.subject}
        </div>
        <div className="flex items-center gap-1.5 mt-1">
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">{SOURCE_LABELS[t.source]}</Badge>
          <span className="text-xs text-muted-foreground truncate">{t.last_message_preview}</span>
        </div>
      </button>
    </li>
  );
}

function Conversation({ thread, onBack, onChanged }: { thread: InboxThread; onBack: () => void; onChanged: () => void }) {
  const { messages, loading } = useThreadMessages(thread.id);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (thread.staff_unread) markThreadRead(thread.id).then(onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id, thread.staff_unread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async (closeAfter = false) => {
    const text = reply.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await replyToThread(thread.id, text);
      if (closeAfter) await updateThread(thread.id, { status: "closed" });
      setReply("");
      toast.success(`Reply sent to ${thread.requester_email}`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send the reply");
    } finally {
      setSending(false);
    }
  };

  const setStatus = async (status: ThreadStatus) => {
    try {
      await updateThread(thread.id, { status });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update the conversation");
    }
  };

  const markUnread = async () => {
    await updateThread(thread.id, { staffUnread: true });
    onChanged();
    onBack();
  };

  return (
    <>
      <div className="px-4 py-3 border-b flex flex-wrap items-start gap-3">
        <Button variant="ghost" size="icon" className="md:hidden -ml-2 h-8 w-8" onClick={onBack} aria-label="Back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold truncate">{thread.subject}</h2>
          <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
            <span className="font-medium text-foreground">{thread.requester_name}</span>
            <a href={`mailto:${thread.requester_email}`} className="hover:underline flex items-center gap-1">
              <Mail className="h-3 w-3" />{thread.requester_email}
            </a>
            <span>· {thread.ref_code}</span>
            <span>· via {SOURCE_LABELS[thread.source]}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={STATUS_STYLES[thread.status]}>{STATUS_LABELS[thread.status]}</Badge>
          <Button variant="ghost" size="sm" onClick={markUnread} title="Mark as unread">
            <Mail className="h-4 w-4" />
          </Button>
          {thread.status === "closed" ? (
            <Button variant="outline" size="sm" onClick={() => setStatus("open")} className="gap-1.5">
              <RotateCcw className="h-3.5 w-3.5" />Reopen
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setStatus("closed")} className="gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" />Close
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1 px-4">
        <div className="py-4 space-y-4">
          {loading && messages.length === 0 ? (
            <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : (
            messages.map((m) => {
              const mine = m.author_type === "staff";
              return (
                <div key={m.id} className={cn("flex", mine ? "justify-end" : "justify-start")}>
                  <div className={cn("max-w-[80%] rounded-2xl px-4 py-2.5", mine ? "bg-primary text-primary-foreground rounded-tr-sm" : "bg-muted rounded-tl-sm")}>
                    <div className={cn("text-xs mb-1 flex items-center gap-1.5", mine ? "opacity-80" : "text-muted-foreground")}>
                      <span className="font-medium">{m.author_name}</span>
                      <span>· {format(new Date(m.created_at), "MMM d, h:mm a")}</span>
                      {m.via_email && <span className="flex items-center gap-0.5">· <Mail className="h-3 w-3" /> email</span>}
                    </div>
                    <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
                  </div>
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      <div className="border-t p-3 space-y-2">
        <Textarea
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={`Reply to ${thread.requester_name}… (Ctrl+Enter to send)`}
          className="resize-none min-h-[80px]"
          maxLength={10000}
          disabled={sending}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Your reply is also emailed to {thread.requester_email}.</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => send(true)} disabled={!reply.trim() || sending}>
              Send & close
            </Button>
            <Button size="sm" onClick={() => send()} disabled={!reply.trim() || sending} className="gap-1.5">
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send reply
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

export default Messages;
