import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { formatDistanceToNow, format } from "date-fns";
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Inbox,
  Loader2,
  Mail,
  MessageCircle,
  Plus,
  Send,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import {
  markThreadRead,
  replyToThread,
  startThread,
  useInboxThreads,
  useThreadMessages,
} from "@/lib/inbox";

interface Message {
  id: string;
  text: string;
  sender: "user" | "support";
  timestamp: Date;
}

type Tab = "ai" | "messages";
type MessagesView = { kind: "list" } | { kind: "new"; draft?: string } | { kind: "thread"; id: string } | { kind: "sent" };

export const ChatWidget = () => {
  const { user, isClient, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("ai");
  const [view, setView] = useState<MessagesView>({ kind: "list" });

  // Conversations this user started, and (for firm users) the client inbox they answer.
  const mine = useInboxThreads("mine", user?.id);
  const inbox = useInboxThreads("inbox", user && !isClient ? user.id : null, isAdmin);
  const myUnread = mine.threads.filter((t) => t.requester_unread).length;
  const inboxUnread = inbox.threads.filter((t) => t.staff_unread).length;
  const totalUnread = myUnread + inboxUnread;

  const openMessages = (next: MessagesView) => {
    setTab("messages");
    setView(next);
  };

  return (
    <>
      {isOpen && (
        <Card className="fixed bottom-24 right-4 sm:right-6 w-[calc(100vw-2rem)] sm:w-96 h-[540px] max-h-[calc(100vh-8rem)] shadow-xl border-border z-50 flex flex-col overflow-hidden">
          <div className="bg-primary text-primary-foreground">
            <div className="flex items-center justify-between px-4 pt-3 pb-2">
              <div className="flex items-center gap-2">
                <MessageCircle className="h-5 w-5" />
                <span className="font-semibold">{tab === "ai" ? "AI Support" : "Messages"}</span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsOpen(false)}
                className="h-8 w-8 hover:bg-primary-foreground/10 text-primary-foreground"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex px-2" role="tablist">
              <TabButton active={tab === "ai"} onClick={() => setTab("ai")} icon={<Bot className="h-3.5 w-3.5" />}>
                AI Assistant
              </TabButton>
              <TabButton
                active={tab === "messages"}
                onClick={() => openMessages(user ? { kind: "list" } : { kind: "new" })}
                icon={<Mail className="h-3.5 w-3.5" />}
                badge={totalUnread}
              >
                Messages
              </TabButton>
            </div>
          </div>

          {tab === "ai" ? (
            <AiChat onTalkToPerson={(draft) => openMessages({ kind: "new", draft })} />
          ) : (
            <MessagesPanel
              view={view}
              setView={setView}
              signedIn={!!user}
              isClient={isClient}
              threads={mine.threads}
              loading={mine.loading}
              refresh={mine.refresh}
              inboxUnread={inboxUnread}
              onOpenInbox={() => {
                setIsOpen(false);
                navigate("/messages");
              }}
            />
          )}
        </Card>
      )}

      <Button
        onClick={() => setIsOpen(!isOpen)}
        size="icon"
        className="fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-lg z-50 hover:scale-110 transition-transform"
        aria-label={isOpen ? "Close support chat" : "Open support chat"}
      >
        {isOpen ? <X className="h-6 w-6" /> : <MessageCircle className="h-6 w-6" />}
        {!isOpen && totalUnread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-red-600 text-white text-[11px] font-semibold flex items-center justify-center">
            {totalUnread > 9 ? "9+" : totalUnread}
          </span>
        )}
      </Button>
    </>
  );
};

function TabButton({
  active,
  onClick,
  icon,
  badge,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex-1 flex items-center justify-center gap-1.5 py-2 text-sm border-b-2 transition-colors",
        active ? "border-primary-foreground font-semibold" : "border-transparent opacity-75 hover:opacity-100",
      )}
    >
      {icon}
      {children}
      {!!badge && badge > 0 && (
        <span className="ml-0.5 min-w-4 h-4 px-1 rounded-full bg-red-600 text-white text-[10px] font-semibold flex items-center justify-center">
          {badge > 9 ? "9+" : badge}
        </span>
      )}
    </button>
  );
}

// ─── AI assistant (unchanged behaviour) ──────────────────────────────────────
function AiChat({ onTalkToPerson }: { onTalkToPerson: (draft: string) => void }) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "1",
      text: "Hi! I'm your MAJRBooks AI assistant. How can I help you today?",
      sender: "support",
      timestamp: new Date(),
    },
  ]);
  const [inputValue, setInputValue] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const text = inputValue.trim();
    if (!text || loading) return;

    const userMessage: Message = { id: Date.now().toString(), text, sender: "user", timestamp: new Date() };
    setMessages((prev) => [...prev, userMessage]);
    setInputValue("");
    setLoading(true);

    try {
      const history = [...messages, userMessage]
        .filter((m) => m.sender === "user" || m.id !== "1")
        .map((m) => ({ role: m.sender === "user" ? "user" : "assistant", content: m.text }));

      const { data, error } = await supabase.functions.invoke("chat-support", { body: { messages: history } });

      const replyText =
        error || !data?.reply
          ? "Sorry, I'm having trouble connecting right now. Please try again, or use the Messages tab to reach a person."
          : data.reply;

      setMessages((prev) => [...prev, { id: (Date.now() + 1).toString(), text: replyText, sender: "support", timestamp: new Date() }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: (Date.now() + 1).toString(), text: "Sorry, something went wrong. Please try again.", sender: "support", timestamp: new Date() },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const lastUserText = [...messages].reverse().find((m) => m.sender === "user")?.text ?? "";

  return (
    <>
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-4">
          {messages.map((message) => (
            <div key={message.id} className={`flex ${message.sender === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[80%] rounded-lg p-3 ${
                  message.sender === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                }`}
              >
                <p className="text-sm whitespace-pre-wrap">{message.text}</p>
                <span className="text-xs opacity-70 mt-1 block">
                  {message.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-lg p-3 flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Thinking…</span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      <div className="p-4 border-t border-border space-y-2">
        <div className="flex gap-2">
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            placeholder="Type your message…"
            className="flex-1"
            disabled={loading}
          />
          <Button onClick={handleSend} size="icon" disabled={loading || !inputValue.trim()} aria-label="Send">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        <button
          onClick={() => onTalkToPerson(lastUserText)}
          className="text-xs text-primary hover:underline w-full text-center"
        >
          Need a person? Send a message to our team →
        </button>
      </div>
    </>
  );
}

// ─── Messages to a person ─────────────────────────────────────────────────────
function MessagesPanel({
  view,
  setView,
  signedIn,
  isClient,
  threads,
  loading,
  refresh,
  inboxUnread,
  onOpenInbox,
}: {
  view: MessagesView;
  setView: (v: MessagesView) => void;
  signedIn: boolean;
  isClient: boolean;
  threads: ReturnType<typeof useInboxThreads>["threads"];
  loading: boolean;
  refresh: () => void;
  inboxUnread: number;
  onOpenInbox: () => void;
}) {
  const recipient = isClient ? "your accountant" : "the MAJRBooks support team";

  if (view.kind === "sent") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-6 gap-3">
        <CheckCircle2 className="h-12 w-12 text-primary" />
        <p className="font-semibold">Message sent</p>
        <p className="text-sm text-muted-foreground">
          Thanks! Our team will reply to your email address as soon as possible.
        </p>
        <Button variant="outline" size="sm" onClick={() => setView({ kind: "new" })}>Send another message</Button>
      </div>
    );
  }

  if (view.kind === "new" || !signedIn) {
    return (
      <NewMessageForm
        signedIn={signedIn}
        recipient={recipient}
        draft={view.kind === "new" ? view.draft : undefined}
        onCancel={signedIn ? () => setView({ kind: "list" }) : undefined}
        onSent={(threadId) => {
          refresh();
          setView(signedIn && threadId ? { kind: "thread", id: threadId } : { kind: "sent" });
        }}
      />
    );
  }

  if (view.kind === "thread") {
    const thread = threads.find((t) => t.id === view.id);
    return (
      <ThreadView
        threadId={view.id}
        subject={thread?.subject ?? "Conversation"}
        closed={thread?.status === "closed"}
        unread={!!thread?.requester_unread}
        onBack={() => setView({ kind: "list" })}
        onChanged={refresh}
      />
    );
  }

  return (
    <>
      {!isClient && (
        <button
          onClick={onOpenInbox}
          className="flex items-center gap-2 px-4 py-2.5 bg-muted/60 border-b text-sm hover:bg-muted text-left"
        >
          <Inbox className="h-4 w-4 text-primary shrink-0" />
          <span className="flex-1">
            <span className="font-medium">Client inbox</span>
            <span className="text-muted-foreground"> — review messages and emails from clients</span>
          </span>
          {inboxUnread > 0 && (
            <span className="rounded-full bg-red-600 text-white text-[11px] font-semibold px-1.5">{inboxUnread}</span>
          )}
        </button>
      )}
      <div className="flex items-center justify-between px-4 py-2.5 border-b">
        <span className="text-xs text-muted-foreground">Your conversations with {recipient}</span>
        <Button size="sm" className="h-7 gap-1" onClick={() => setView({ kind: "new" })}>
          <Plus className="h-3.5 w-3.5" />New
        </Button>
      </div>
      <ScrollArea className="flex-1">
        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : threads.length === 0 ? (
          <div className="text-center px-6 py-10 text-sm text-muted-foreground space-y-3">
            <Mail className="h-8 w-8 mx-auto opacity-40" />
            <p>No messages yet. Send a message to {recipient} and get a reply here and by email.</p>
            <Button size="sm" onClick={() => setView({ kind: "new" })}>Write a message</Button>
          </div>
        ) : (
          <ul>
            {threads.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => setView({ kind: "thread", id: t.id })}
                  className="w-full text-left px-4 py-3 border-b hover:bg-muted/60"
                >
                  <div className="flex items-center gap-2">
                    {t.requester_unread && <span className="h-2 w-2 rounded-full bg-primary shrink-0" />}
                    <span className={cn("flex-1 truncate text-sm", t.requester_unread ? "font-semibold" : "font-medium")}>
                      {t.subject}
                    </span>
                    <span className="text-[11px] text-muted-foreground shrink-0">
                      {formatDistanceToNow(new Date(t.last_message_at))}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {t.status === "closed" ? "Closed · " : ""}{t.last_message_preview}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </>
  );
}

function NewMessageForm({
  signedIn,
  recipient,
  draft,
  onCancel,
  onSent,
}: {
  signedIn: boolean;
  recipient: string;
  draft?: string;
  onCancel?: () => void;
  onSent: (threadId: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState(draft ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSend = subject.trim() && body.trim() && (signedIn || (name.trim() && email.trim()));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend || sending) return;
    setSending(true);
    setError(null);
    try {
      const id = await startThread({
        subject: subject.trim(),
        body: body.trim(),
        source: "chat_widget",
        name: signedIn ? undefined : name.trim(),
        email: signedIn ? undefined : email.trim(),
      });
      onSent(id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send your message");
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b">
        {onCancel && (
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 -ml-1" onClick={onCancel} aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        <span className="text-sm font-medium">New message to {recipient}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {!signedIn && (
          <>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" maxLength={200} required />
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Your email" maxLength={254} required />
          </>
        )}
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" maxLength={300} required />
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="How can we help?"
          className="min-h-[160px] resize-none"
          maxLength={10000}
          required
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <p className="text-xs text-muted-foreground">
          {signedIn ? "You'll get the reply here and by email." : "We'll reply to the email address above."}
        </p>
      </div>
      <div className="p-4 border-t">
        <Button type="submit" className="w-full gap-2" disabled={!canSend || sending}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Send message
        </Button>
      </div>
    </form>
  );
}

function ThreadView({
  threadId,
  subject,
  closed,
  unread,
  onBack,
  onChanged,
}: {
  threadId: string;
  subject: string;
  closed: boolean;
  unread: boolean;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { messages, loading } = useThreadMessages(threadId);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (unread) markThreadRead(threadId).then(onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, unread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    const text = reply.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await replyToThread(threadId, text);
      setReply("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2 px-4 py-2.5 border-b">
        <Button variant="ghost" size="icon" className="h-7 w-7 -ml-1" onClick={onBack} aria-label="Back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium truncate flex-1">{subject}</span>
        {closed && <span className="text-[11px] text-muted-foreground">Closed</span>}
      </div>
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-3">
          {loading && messages.length === 0 ? (
            <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : (
            messages.map((m) => {
              const mine = m.author_type === "requester";
              return (
                <div key={m.id} className={cn("flex", mine ? "justify-end" : "justify-start")}>
                  <div className={cn("max-w-[85%] rounded-lg p-3", mine ? "bg-primary text-primary-foreground" : "bg-muted")}>
                    {!mine && <p className="text-xs font-medium mb-1">{m.author_name}</p>}
                    <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
                    <span className="text-xs opacity-70 mt-1 block">{format(new Date(m.created_at), "MMM d, h:mm a")}</span>
                  </div>
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
      <div className="p-4 border-t space-y-1">
        <div className="flex gap-2">
          <Input
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
            placeholder={closed ? "Reply to reopen this conversation…" : "Write a reply…"}
            maxLength={10000}
            disabled={sending}
          />
          <Button size="icon" onClick={send} disabled={!reply.trim() || sending} aria-label="Send reply">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </>
  );
}
