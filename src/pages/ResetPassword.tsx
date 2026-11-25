import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Check, CheckCircle2, Eye, EyeOff, Loader2, Mail, ShieldCheck, XCircle } from "lucide-react";
import logoImage from "@/assets/logo-majr-books-new.jpg";

const MIN_LENGTH = 8;

/** Reads `{ error }` from an edge-function error response. */
async function functionError(error: unknown, fallback: string): Promise<string> {
  try {
    const body = await (error as { context?: Response }).context?.json();
    if (body?.error) return String(body.error);
  } catch {
    /* fall through */
  }
  return fallback;
}

/**
 * Landing page for the password reset email (`/reset-password?token=...`).
 * The token is single use and expires after 60 minutes; it is checked (without
 * being used) on load and only consumed when the new password is submitted, so
 * link scanners that open the page cannot burn it.
 */
const ResetPassword = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  // Read once, then remove from the address bar so it isn't kept in history.
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token") ?? "");
  const [status, setStatus] = useState<"checking" | "invalid" | "ready" | "done">("checking");
  const [invalidReason, setInvalidReason] = useState<string | null>(null);
  const [emailHint, setEmailHint] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (token) window.history.replaceState(null, "", window.location.pathname);
    if (!token) {
      setInvalidReason("This link is missing its security token. Please use the button in your email.");
      setStatus("invalid");
      return;
    }
    (async () => {
      const { data, error } = await supabase.functions.invoke("complete-password-reset", {
        body: { token, validateOnly: true },
      });
      if (error || !data?.valid) {
        const reason = data?.error ?? (error ? await functionError(error, "") : "");
        setInvalidReason(reason || null);
        setStatus("invalid");
        return;
      }
      setEmailHint(data.email_hint ?? null);
      setStatus("ready");
    })();
  }, [token]);

  const checks = [
    { label: `At least ${MIN_LENGTH} characters`, ok: password.length >= MIN_LENGTH },
    { label: "Contains a letter", ok: /[A-Za-z]/.test(password) },
    { label: "Contains a number", ok: /[0-9]/.test(password) },
  ];
  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = checks.every((c) => c.ok) && password === confirm && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    const { error } = await supabase.functions.invoke("complete-password-reset", {
      body: { token, password },
    });
    setSubmitting(false);

    if (error) {
      const message = await functionError(error, "We couldn't update your password. Please try again.");
      if (/invalid or has expired/i.test(message)) {
        setInvalidReason(message);
        setStatus("invalid");
        return;
      }
      toast({ variant: "destructive", title: "Password not updated", description: message });
      return;
    }

    // The server signed the account out everywhere; clear any local session too.
    await supabase.auth.signOut({ scope: "local" }).catch(() => {});
    setStatus("done");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 via-background to-secondary/5 p-4">
      <Card className="w-full max-w-md shadow-xl border-primary/10">
        <CardHeader className="space-y-3 text-center">
          <div className="flex items-center justify-center mb-2">
            <Link to="/">
              <img src={logoImage} alt="MAJR Books Logo" className="h-20 w-auto object-contain" />
            </Link>
          </div>
          <CardTitle className="text-2xl">
            {status === "done" ? "Password Updated" : status === "invalid" ? "Link Can't Be Used" : "Set a New Password"}
          </CardTitle>
          <CardDescription className="text-base">
            {status === "ready" && (emailHint ? <>For the account <strong>{emailHint}</strong></> : "Choose a new password for your account")}
            {status === "checking" && "Checking your reset link…"}
            {status === "done" && "You can now sign in with your new password."}
            {status === "invalid" && "Reset links work once and expire after 60 minutes."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {status === "checking" && (
            <div className="flex justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {status === "invalid" && (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-3 py-2">
                <div className="h-14 w-14 rounded-full bg-destructive/10 flex items-center justify-center">
                  <XCircle className="h-7 w-7 text-destructive" />
                </div>
                <p className="text-center text-sm text-muted-foreground">
                  {invalidReason || "This password reset link is invalid or has expired. Please request a new one."}
                </p>
              </div>
              <Button className="w-full gap-2" onClick={() => navigate("/auth?forgot=1")}>
                <Mail className="h-4 w-4" />
                Request a New Link
              </Button>
              <Button variant="ghost" className="w-full" onClick={() => navigate("/auth")}>
                Back to Login
              </Button>
            </div>
          )}

          {status === "done" && (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-3 py-2">
                <div className="h-14 w-14 rounded-full bg-green-100 flex items-center justify-center">
                  <CheckCircle2 className="h-7 w-7 text-green-600" />
                </div>
                <p className="text-center text-sm text-muted-foreground">
                  For your security we signed you out on all devices and emailed you a confirmation.
                </p>
              </div>
              <Button className="w-full" onClick={() => navigate("/auth")}>
                Login to Your Account
              </Button>
            </div>
          )}

          {status === "ready" && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="reset-password">New Password</Label>
                <div className="relative">
                  <Input
                    id="reset-password"
                    type={show ? "text" : "password"}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    maxLength={72}
                    className="pr-10"
                    autoFocus
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShow((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={show ? "Hide password" : "Show password"}
                  >
                    {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <ul className="space-y-1 pt-1">
                  {checks.map((c) => (
                    <li key={c.label} className={`flex items-center gap-2 text-xs ${c.ok ? "text-green-600" : "text-muted-foreground"}`}>
                      <Check className={`h-3.5 w-3.5 ${c.ok ? "opacity-100" : "opacity-30"}`} />
                      {c.label}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reset-confirm">Confirm New Password</Label>
                <Input
                  id="reset-confirm"
                  type={show ? "text" : "password"}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  maxLength={72}
                  required
                />
                {mismatch && <p className="text-sm text-destructive">Passwords don't match.</p>}
              </div>
              <Button type="submit" className="w-full" disabled={!canSubmit}>
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                Update Password
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default ResetPassword;
