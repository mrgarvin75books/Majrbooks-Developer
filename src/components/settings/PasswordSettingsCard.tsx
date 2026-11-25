import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2, Eye, EyeOff, KeyRound, Loader2, Mail } from "lucide-react";

// Matches the minimum enforced on the signup form.
const MIN_PASSWORD_LENGTH = 6;

/**
 * Lets a signed-in account owner set a new password, or email themselves a
 * reset link. Owners who just signed up are already logged in, and /auth
 * redirects logged-in users to the dashboard, so the "Forgot password?" link
 * there is out of their reach; this card is how they change it.
 */
export function PasswordSettingsCard() {
  const { user, updatePassword } = useAuth();
  const { toast } = useToast();

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sendingLink, setSendingLink] = useState(false);
  const [linkSent, setLinkSent] = useState(false);

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      toast({
        variant: "destructive",
        title: "Password too short",
        description: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast({
        variant: "destructive",
        title: "Passwords don't match",
        description: "Please enter the same password in both fields.",
      });
      return;
    }

    setSaving(true);
    const { error } = await updatePassword(newPassword);
    setSaving(false);

    if (error) {
      toast({
        variant: "destructive",
        title: "Couldn't change password",
        description:
          error.message ||
          "Please try again, or use the reset link option below.",
      });
      return;
    }

    setNewPassword("");
    setConfirmPassword("");
    setSaved(true);
    setTimeout(() => setSaved(false), 4000);
    toast({ title: "Password updated", description: "Use your new password next time you sign in." });
  };

  const handleSendResetLink = async () => {
    if (!user?.email) return;
    setSendingLink(true);
    const { error } = await supabase.functions.invoke("request-password-reset", {
      body: { email: user.email },
    });
    setSendingLink(false);

    if (error) {
      toast({
        variant: "destructive",
        title: "Couldn't send reset link",
        description: error.message || "Please try again in a minute.",
      });
      return;
    }
    setLinkSent(true);
    toast({ title: "Reset link sent", description: `Check ${user.email} (and your spam folder).` });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          Password
        </CardTitle>
        <CardDescription>Change the password you use to sign in</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <form onSubmit={handleChangePassword} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="settings-new-password">New Password</Label>
            <div className="relative">
              <Input
                id="settings-new-password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={MIN_PASSWORD_LENGTH}
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-confirm-password">Confirm New Password</Label>
            <Input
              id="settings-confirm-password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              minLength={MIN_PASSWORD_LENGTH}
            />
            {mismatch && <p className="text-sm text-destructive">Passwords don't match.</p>}
          </div>
          <div className="flex items-center justify-end gap-3">
            {saved && (
              <span className="flex items-center gap-1 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                Password updated
              </span>
            )}
            <Button type="submit" disabled={saving || !newPassword || !confirmPassword || mismatch}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Update Password
            </Button>
          </div>
        </form>

        <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {linkSent
              ? <>We sent a reset link to <strong>{user?.email}</strong>.</>
              : <>Prefer email? We'll send a reset link to <strong>{user?.email}</strong>.</>}
          </p>
          <Button variant="outline" onClick={handleSendResetLink} disabled={sendingLink || !user?.email}>
            {sendingLink ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
            {linkSent ? "Send Again" : "Email Me a Reset Link"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
