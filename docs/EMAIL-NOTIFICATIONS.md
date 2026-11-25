# Email Notifications (Resend)

Transactional email for MAJR Books: invitations, account confirmations and
password security. All mail is sent server-side from Supabase Edge Functions
through the Resend API, using the same `RESEND_API_KEY` the app already used.

## What gets sent, and when

| User action | Email (template key) | Sent by |
|---|---|---|
| Admin/staff invites a client (Client Invitations, client list "Resend invitation") | Client Invitation (`client_invitation`) — "You're Invited! Access Your Client Portal" | `send-client-invitation` |
| Account owner invites a team member (Team / User Permissions) | Staff Invitation (`staff_invitation`) — "Welcome to the Team! Your Account Invitation Is Ready" | `send-team-invite` |
| Client finishes `/accept-client-invite` | Account Created — Client (`signup_client`) | `send-login-notification` |
| Staff finishes `/accept-invite` | Account Created — Staff (`signup_staff`) | `send-login-notification` |
| Business owner signs up on `/auth` | Account Created — Account Owner (`signup_owner`) | `send-login-notification` |
| User clicks "Forgot password?" (or Settings → "Email me a reset link") | Password Reset (`password_reset`) — "Password Reset Request – Secure Your Account" | `request-password-reset` |
| User completes `/reset-password` | Password Changed (`password_changed`) | `complete-password-reset` |
| Signed-in user changes password (Settings, Client Settings) | Password Changed (`password_changed`) | `send-password-changed` |

The account-created variant is chosen from the database (client role, team
membership), never from user-editable sign-up metadata.

## Code map

```
supabase/functions/_shared/email/
  config.ts       brand colors, company details, env-driven settings (APP_URL, EMAIL_FROM, ...)
  templates.ts    the 7 templates: default wording, variables, sample data
  render.ts       responsive HTML + plain-text renderer, safe mini-markup
  send.ts         Resend REST call, retries, idempotency, logging, duplicate suppression
  workflows.ts    invitation / signup / password flows (read every value from the DB)
  *_test.ts       Deno tests (deno test --allow-env supabase/functions/_shared/email/)
supabase/functions/
  request-password-reset/   public; issues a single-use token, emails the link
  complete-password-reset/  public; validates/consumes the token, sets the password
  send-password-changed/    signed-in; confirmation after an in-app password change
  email-admin/              platform admins; templates, previews, logs, resend, test send
supabase/migrations/20261125100000_email_notifications.sql
supabase/tests/email_notifications_test.sql      (pgTAP; npm run test:db)
src/pages/ResetPassword.tsx                      /reset-password
src/components/admin/AdminEmailNotifications.tsx Admin → Emails tab
```

## Template variables

Every template can use: `{{brand_name}}`, `{{support_email}}`, `{{support_phone}}`,
`{{company_address}}`, `{{app_url}}`, `{{login_url}}`, `{{forgot_password_url}}`,
`{{current_year}}`. Template-specific ones include `{{first_name}}`, `{{email}}`,
`{{company_name}}`, `{{invitation_link}}`, `{{expiration_date}}`, `{{role}}`,
`{{reset_link}}`, `{{expires_in}}` — the editor lists the exact set per template.

Admins edit wording (subject, preview text, heading, main message, button label,
after-button text) in **Admin → Emails**. Formatting: blank line = paragraph,
`- item`, `1. item`, `## Heading`, `**bold**`, `{{#if var}}…{{/if}}`. HTML is
rejected; values are always escaped. The logo, details card, button, security
notice and footer are fixed so every email stays on-brand. Only changes are
stored, so "Reset to default" restores the built-in wording.

## Security notes

- `RESEND_API_KEY` is only read inside edge functions; nothing email-related is in the browser bundle.
- Reset tokens: 256-bit random, stored only as SHA-256 hashes, expire after
  `PASSWORD_RESET_TTL_MINUTES` (default 60, clamped 15–60), claimed atomically
  (single use), and all other outstanding tokens are revoked on success. A
  successful reset signs the account out on every device.
- The reset page checks the token on load without using it; it is consumed only
  when the new password is submitted, so link scanners can't burn it. The token
  is removed from the address bar immediately.
- `request-password-reset` answers identically whether or not an account exists,
  and is rate limited (3 per address and 10 per IP per 15 minutes; IPs are hashed).
- `email_logs` never stores links, tokens or passwords; errors are scrubbed of
  URLs/keys. Only platform admins can read the logs (RLS).
- Duplicates are suppressed atomically by `claim_email_send()` (advisory lock +
  dedupe key) and by Resend's `Idempotency-Key` on retries.
- All links are built from `APP_URL` (https only), never from the request.

## Deployment checklist

1. **Apply the migration**: `supabase db push` (adds `email_templates`,
   `email_logs`, `password_reset_tokens` and three service-role-only functions).
2. **Set edge-function secrets** (see `supabase/functions/.env.example`). At minimum
   `RESEND_API_KEY` and `APP_URL=https://majrbooks.com` (or your production domain).
3. **Deploy the frontend first** (so `/reset-password` and
   `public/majr-books-logo-email-header.png` exist), then the functions:
   ```
   supabase functions deploy send-client-invitation send-team-invite send-login-notification \
     request-password-reset complete-password-reset send-password-changed email-admin
   ```
   `request-password-reset` and `complete-password-reset` must be deployed with
   JWT verification off (set in `supabase/config.toml`; or pass `--no-verify-jwt`).
4. **Resend domain**: the `EMAIL_FROM` domain (`majrbooks.com`) must be verified
   in Resend → Domains. Resend shows the exact records; typically:
   - SPF: `TXT` on `send.majrbooks.com` → `v=spf1 include:amazonses.com ~all`
   - MX: `send.majrbooks.com` → `feedback-smtp.<region>.amazonses.com` (priority 10)
   - DKIM: `TXT` on `resend._domainkey.majrbooks.com` → the key Resend gives you
   - DMARC (recommended): `TXT` on `_dmarc.majrbooks.com` → `v=DMARC1; p=none; rua=mailto:dmarc@majrbooks.com`
5. **Supabase Auth settings**: add `https://majrbooks.com/reset-password` to
   Authentication → URL Configuration → Redirect URLs (harmless, and keeps the
   allow-list accurate). Supabase's own "Confirm signup" email is unchanged;
   its built-in "Reset password" email is no longer triggered by the app.
6. **Smoke test** in Admin → Emails: "Send test to me" on each template, then
   check the Delivery Log shows `Sent` with a Resend id.
