import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  Loader2,
  Mail,
  Monitor,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  Smartphone,
  XCircle,
} from "lucide-react";

type Field = "subject" | "preheader" | "heading" | "body" | "secondary_body" | "cta_label";
type Content = Record<Field, string>;

interface TemplateRow {
  key: string;
  name: string;
  description: string;
  audience: string;
  trigger: string;
  resendable: boolean;
  variables: string[];
  enabled: boolean;
  customized: boolean;
  updated_at: string | null;
  defaults: Content;
  content: Content;
  stats: { sent: number; failed: number; skipped: number; pending: number };
}

interface Overview {
  templates: TemplateRow[];
  totals: { sent: number; failed: number; skipped: number; pending: number };
  config: { from: string; appUrl: string };
}

interface LogRow {
  id: string;
  template_key: string;
  recipient_email: string;
  subject: string | null;
  status: "pending" | "sent" | "failed" | "skipped";
  resend_id: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  sent_at: string | null;
  resent_from: string | null;
  superseded_by: string | null;
}

interface Rendered {
  subject: string;
  html: string;
  text: string;
}

async function emailAdmin<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("email-admin", { body });
  if (error) {
    let message = error.message;
    try {
      const parsed = await (error as { context?: Response }).context?.json();
      if (parsed?.error) message = parsed.error;
    } catch {
      /* keep message */
    }
    throw new Error(message);
  }
  return data as T;
}

const FIELDS: { key: Field; label: string; multiline?: boolean; hint?: string }[] = [
  { key: "subject", label: "Subject line" },
  { key: "preheader", label: "Preview text", hint: "Shown after the subject in most inboxes." },
  { key: "heading", label: "Heading" },
  { key: "body", label: "Main message", multiline: true, hint: "Shown above the details card and button." },
  { key: "cta_label", label: "Button label" },
  { key: "secondary_body", label: "After the button", multiline: true, hint: "Instructions and next steps. Optional." },
];

function StatusBadge({ status }: { status: LogRow["status"] }) {
  const map = {
    sent: { label: "Sent", className: "bg-green-100 text-green-800 border-green-200" },
    failed: { label: "Failed", className: "bg-red-100 text-red-800 border-red-200" },
    skipped: { label: "Skipped", className: "bg-amber-100 text-amber-800 border-amber-200" },
    pending: { label: "Sending", className: "bg-slate-100 text-slate-700 border-slate-200" },
  } as const;
  const s = map[status];
  return <Badge variant="outline" className={s.className}>{s.label}</Badge>;
}

function EmailFrame({ html, mobile }: { html: string; mobile: boolean }) {
  return (
    <div className="flex justify-center rounded-lg border bg-muted/40 p-3">
      <iframe
        title="Email preview"
        srcDoc={html}
        sandbox=""
        className="rounded-md border bg-white transition-all"
        style={{ width: mobile ? 375 : "100%", height: 640 }}
      />
    </div>
  );
}

function DeviceToggle({ mobile, onChange }: { mobile: boolean; onChange: (m: boolean) => void }) {
  return (
    <div className="inline-flex rounded-md border p-0.5">
      <Button size="sm" variant={mobile ? "ghost" : "secondary"} className="h-7 gap-1" onClick={() => onChange(false)}>
        <Monitor className="h-3.5 w-3.5" /> Desktop
      </Button>
      <Button size="sm" variant={mobile ? "secondary" : "ghost"} className="h-7 gap-1" onClick={() => onChange(true)}>
        <Smartphone className="h-3.5 w-3.5" /> Mobile
      </Button>
    </div>
  );
}

function PreviewDialog({ template, onClose }: { template: TemplateRow | null; onClose: () => void }) {
  const [mobile, setMobile] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["email-preview", template?.key],
    queryFn: () => emailAdmin<Rendered>({ action: "preview", templateKey: template!.key }),
    enabled: !!template,
  });
  return (
    <Dialog open={!!template} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{template?.name}</DialogTitle>
          <DialogDescription>Preview with sample data. Subject: <strong>{data?.subject ?? "…"}</strong></DialogDescription>
        </DialogHeader>
        <div className="flex justify-end"><DeviceToggle mobile={mobile} onChange={setMobile} /></div>
        {isLoading && <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin" /></div>}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {data && <EmailFrame html={data.html} mobile={mobile} />}
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ template, onClose }: { template: TemplateRow | null; onClose: () => void }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Content | null>(null);
  const [preview, setPreview] = useState<Rendered | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    setDraft(template ? { ...template.content } : null);
    setPreview(null);
    setPreviewError(null);
  }, [template]);

  // Live preview, debounced.
  useEffect(() => {
    if (!template || !draft) return;
    const t = setTimeout(async () => {
      try {
        setPreview(await emailAdmin<Rendered>({ action: "preview", templateKey: template.key, content: draft }));
        setPreviewError(null);
      } catch (e) {
        setPreviewError((e as Error).message);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [template, draft]);

  const save = useMutation({
    mutationFn: () => emailAdmin({ action: "save", templateKey: template!.key, content: draft }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-admin-overview"] });
      toast({ title: "Template saved", description: `${template?.name} will use the new wording from now on.` });
      onClose();
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Couldn't save", description: e.message }),
  });

  const reset = useMutation({
    mutationFn: () => emailAdmin({ action: "reset", templateKey: template!.key }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-admin-overview"] });
      setDraft(template ? { ...template.defaults } : null);
      toast({ title: "Default wording restored" });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Couldn't reset", description: e.message }),
  });

  const test = useMutation({
    mutationFn: () =>
      emailAdmin<{ success: boolean; error?: string; to: string }>({ action: "test", templateKey: template!.key, content: draft }),
    onSuccess: (r) =>
      r.success
        ? toast({ title: "Test email sent", description: `Check ${r.to}.` })
        : toast({ variant: "destructive", title: "Test email failed", description: r.error ?? "See the delivery log." }),
    onError: (e: Error) => toast({ variant: "destructive", title: "Test email failed", description: e.message }),
  });

  const dirty = useMemo(
    () => !!template && !!draft && FIELDS.some((f) => draft[f.key] !== template.content[f.key]),
    [template, draft],
  );

  if (!template || !draft) return null;

  return (
    <Dialog open={!!template} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl max-h-[94vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Pencil className="h-4 w-4" /> Edit: {template.name}</DialogTitle>
          <DialogDescription>{template.trigger}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            {FIELDS.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={`f-${f.key}`}>{f.label}</Label>
                {f.multiline ? (
                  <Textarea
                    id={`f-${f.key}`}
                    rows={f.key === "body" ? 7 : 6}
                    value={draft[f.key]}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                    className="font-mono text-xs"
                  />
                ) : (
                  <Input id={`f-${f.key}`} value={draft[f.key]} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
                )}
                {f.hint && <p className="text-xs text-muted-foreground">{f.hint}</p>}
              </div>
            ))}

            <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-medium">Variables (click to copy)</p>
              <div className="flex flex-wrap gap-1.5">
                {template.variables.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(`{{${v}}}`);
                      toast({ title: "Copied", description: `{{${v}}}` });
                    }}
                    className="rounded border bg-background px-1.5 py-0.5 font-mono text-[11px] hover:border-primary hover:text-primary"
                  >
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Formatting: blank line = new paragraph · <code>- item</code> bullets · <code>1. item</code> numbered ·{" "}
                <code>## Title</code> section heading · <code>**bold**</code> ·{" "}
                <code>{"{{#if var}}…{{/if}}"}</code> shows text only when the value exists. HTML is not allowed; the logo,
                details card, button, security notice and footer are added automatically.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground truncate">
                Subject: <span className="font-medium text-foreground">{preview?.subject ?? "…"}</span>
              </p>
              <DeviceToggle mobile={mobile} onChange={setMobile} />
            </div>
            {previewError && <p className="text-sm text-destructive">{previewError}</p>}
            {preview ? <EmailFrame html={preview.html} mobile={mobile} /> : (
              <div className="flex h-[640px] items-center justify-center rounded-lg border"><Loader2 className="h-6 w-6 animate-spin" /></div>
            )}
          </div>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-between">
          <Button
            variant="ghost"
            onClick={() => window.confirm("Restore the default wording for this email?") && reset.mutate()}
            disabled={reset.isPending || !template.customized}
          >
            <RotateCcw className="mr-2 h-4 w-4" /> Reset to default
          </Button>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending || !user?.email}>
              {test.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              Send test to me
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !dirty}>
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save changes
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeliveryLog({ templates }: { templates: TemplateRow[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("all");
  const [templateKey, setTemplateKey] = useState("all");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(0), [status, templateKey, debounced]);

  const names = useMemo(() => Object.fromEntries(templates.map((t) => [t.key, t])), [templates]);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["email-logs", status, templateKey, debounced, page],
    queryFn: () =>
      emailAdmin<{ rows: LogRow[]; total: number; page: number; pageSize: number }>({
        action: "logs",
        status: status === "all" ? undefined : status,
        templateKey: templateKey === "all" ? undefined : templateKey,
        search: debounced || undefined,
        page,
      }),
  });

  const resend = useMutation({
    mutationFn: (logId: string) => emailAdmin<{ success: boolean; status: string; error?: string }>({ action: "resend", logId }),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["email-logs"] });
      queryClient.invalidateQueries({ queryKey: ["email-admin-overview"] });
      if (r.success) toast({ title: "Email resent" });
      else toast({ variant: "destructive", title: "Resend failed", description: r.error ?? r.status });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Resend failed", description: e.message }),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-end sm:justify-between space-y-0">
        <div>
          <CardTitle>Delivery Log</CardTitle>
          <CardDescription>Every email attempt. Links and tokens are never stored.</CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input placeholder="Search recipient…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-9 w-44" />
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="skipped">Skipped</SelectItem>
              <SelectItem value="pending">Sending</SelectItem>
            </SelectContent>
          </Select>
          <Select value={templateKey} onValueChange={setTemplateKey}>
            <SelectTrigger className="h-9 w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All templates</SelectItem>
              {templates.map((t) => <SelectItem key={t.key} value={t.key}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => refetch()} aria-label="Refresh">
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Recipient</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Details</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={6} className="py-10 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></TableCell></TableRow>
              )}
              {!isLoading && data?.rows.length === 0 && (
                <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No emails match these filters.</TableCell></TableRow>
              )}
              {data?.rows.map((row) => {
                const canResend = (row.status === "failed" || row.status === "skipped") && !row.superseded_by &&
                  names[row.template_key]?.resendable;
                return (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {format(new Date(row.created_at), "MMM d, yyyy h:mm a")}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm font-medium">{names[row.template_key]?.name ?? row.template_key}</div>
                      <div className="max-w-[220px] truncate text-xs text-muted-foreground" title={row.subject ?? ""}>{row.subject}</div>
                    </TableCell>
                    <TableCell className="text-sm">{row.recipient_email}</TableCell>
                    <TableCell><StatusBadge status={row.status} /></TableCell>
                    <TableCell className="max-w-[260px] text-xs">
                      {row.error_message && <span className="text-destructive line-clamp-2" title={row.error_message}>{row.error_message}</span>}
                      {row.superseded_by && <span className="text-muted-foreground">Resent</span>}
                      {row.resent_from && <span className="text-muted-foreground">Retry of an earlier attempt</span>}
                      {row.resend_id && !row.error_message && (
                        <span className="font-mono text-muted-foreground" title="Resend email id">{row.resend_id.slice(0, 13)}…</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {canResend && (
                        <Button size="sm" variant="outline" onClick={() => resend.mutate(row.id)} disabled={resend.isPending}>
                          {resend.isPending && resend.variables === row.id
                            ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                          Resend
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between pt-4 text-sm text-muted-foreground">
          <span>{data ? `${data.total} email${data.total === 1 ? "" : "s"}` : ""}</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <span>Page {page + 1} of {totalPages}</span>
            <Button size="sm" variant="outline" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const AdminEmailNotifications = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [previewing, setPreviewing] = useState<TemplateRow | null>(null);
  const [editing, setEditing] = useState<TemplateRow | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["email-admin-overview"],
    queryFn: () => emailAdmin<Overview>({ action: "overview" }),
  });

  const toggle = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) => emailAdmin({ action: "save", templateKey: key, enabled }),
    onSuccess: (_d, v) => {
      queryClient.invalidateQueries({ queryKey: ["email-admin-overview"] });
      toast({ title: v.enabled ? "Notification enabled" : "Notification disabled" });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Couldn't update", description: e.message }),
  });

  if (isLoading) {
    return <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }
  if (error || !data) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="flex items-center gap-3 py-8">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          <div>
            <p className="font-medium">Email settings couldn't be loaded</p>
            <p className="text-sm text-muted-foreground">
              {(error as Error)?.message ?? "Unknown error"}. Make sure the <code>email-admin</code> function is deployed.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const { totals } = data;
  const attempted = totals.sent + totals.failed;
  const rate = attempted ? Math.round((totals.sent / attempted) * 1000) / 10 : null;
  const disabledCount = data.templates.filter((t) => !t.enabled).length;

  const stats = [
    { label: "Sent (30 days)", value: totals.sent.toLocaleString(), icon: CheckCircle2, tone: "text-green-600" },
    { label: "Failed (30 days)", value: totals.failed.toLocaleString(), icon: XCircle, tone: totals.failed ? "text-destructive" : "text-muted-foreground" },
    { label: "Delivery success", value: rate === null ? "—" : `${rate}%`, icon: Send, tone: "text-primary" },
    { label: "Disabled templates", value: String(disabledCount), icon: Mail, tone: disabledCount ? "text-amber-600" : "text-muted-foreground" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold">Email Notifications</h2>
          <p className="text-muted-foreground">Transactional emails sent through Resend.</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Sending as <span className="font-medium text-foreground">{data.config.from}</span> · links go to{" "}
          <span className="font-medium text-foreground">{data.config.appUrl}</span>
        </p>
      </div>

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardContent className="flex items-center justify-between p-5">
              <div>
                <p className="text-sm text-muted-foreground">{s.label}</p>
                <p className="text-2xl font-bold">{s.value}</p>
              </div>
              <s.icon className={`h-7 w-7 ${s.tone}`} />
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="templates" className="space-y-4">
        <TabsList>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="log">
            Delivery Log
            {totals.failed > 0 && <Badge variant="destructive" className="ml-2 h-5 px-1.5">{totals.failed}</Badge>}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="templates">
          <Card>
            <CardHeader>
              <CardTitle>Email Templates</CardTitle>
              <CardDescription>Turn notifications on or off, preview them, and edit their wording.</CardDescription>
            </CardHeader>
            <CardContent className="divide-y p-0">
              {data.templates.map((t) => (
                <div key={t.key} className="flex flex-col gap-3 px-6 py-4 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{t.name}</span>
                      <Badge variant="secondary">{t.audience}</Badge>
                      {t.customized && <Badge variant="outline">Customized</Badge>}
                      {!t.enabled && <Badge variant="outline" className="border-amber-300 text-amber-700">Off</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground">{t.description}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium">When:</span> {t.trigger} · <span className="font-medium">Subject:</span>{" "}
                      {t.content.subject}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Last 30 days: {t.stats.sent} sent
                      {t.stats.failed > 0 && <span className="text-destructive"> · {t.stats.failed} failed</span>}
                      {t.stats.skipped > 0 && <> · {t.stats.skipped} skipped</>}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="mr-2 flex items-center gap-2">
                      <Switch
                        checked={t.enabled}
                        onCheckedChange={(enabled) => toggle.mutate({ key: t.key, enabled })}
                        disabled={toggle.isPending}
                        aria-label={`${t.enabled ? "Disable" : "Enable"} ${t.name}`}
                      />
                      <span className="w-6 text-xs text-muted-foreground">{t.enabled ? "On" : "Off"}</span>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setPreviewing(t)}>
                      <Eye className="mr-1 h-4 w-4" /> Preview
                    </Button>
                    <Button size="sm" onClick={() => setEditing(t)}>
                      <Pencil className="mr-1 h-4 w-4" /> Edit
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="log">
          <DeliveryLog templates={data.templates} />
        </TabsContent>
      </Tabs>

      <PreviewDialog template={previewing} onClose={() => setPreviewing(null)} />
      <EditDialog template={editing} onClose={() => setEditing(null)} />
    </div>
  );
};

export default AdminEmailNotifications;
