# Migrate Email Sending from Customer.io to Mailgun

## Overview

Replace Customer.io transactional email API with Mailgun's Node.js SDK (`mailgun.js`). Instead of referencing remote Customer.io template IDs, we'll render the local HTML templates in `src/emails/*.html` server-side and send the full HTML body to Mailgun.

## Current Architecture

- **Provider**: Customer.io via `customerio-node` SDK
- **Config**: `CUSTOMERIO_EMAIL_API_KEY` in `config.server.ts`
- **Templates**: Remote, stored in Customer.io, referenced by numeric ID (`'10'`, `'11'`, etc.)
- **Variable substitution**: Done by Customer.io using Liquid syntax (`{{ var }}`, `{% if %}`)
- **Send function**: `send()` in `email.ts` creates `APIClient` + `SendEmailRequest`

## Target Architecture

- **Provider**: Mailgun via `mailgun.js` SDK + `form-data`
- **Config**: `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, and `EMAIL_PROVIDER` in `config.server.ts`
- **Templates**: Local HTML files in `src/emails/*.html`
- **Variable substitution**: Done server-side in Node.js before sending
- **Send function**: `send()` routes to either Customer.io or Mailgun backend based on `EMAIL_PROVIDER` env var

### Dual-Provider Routing

During the transition, `email.ts` delegates to a provider backend selected by the `EMAIL_PROVIDER` env var (`customerio` | `mailgun`, defaulting to `customerio`). The existing Customer.io logic moves to `src/lib/email-customerio.ts`; the new Mailgun logic lives in `src/lib/email-mailgun.ts`.

PostHog feature flags are **not** suitable for this toggle because some emails target logged-out users (magic link, invitations) where there is no user context for flag evaluation. A simple env var is the right mechanism.

```typescript
import { sendViaCustomerIo } from './email-customerio';
import { sendViaMailgun } from './email-mailgun';

type SendParams = {
  to: string;
  templateName: TemplateName;
  // Record<string, unknown> in PR 1 to support customerio's native types (numbers, booleans).
  // Tightened to Record<string, string> in PR 2 once renderTemplate is added.
  templateVars: Record<string, unknown>;
};

function send(params: SendParams) {
  if (EMAIL_PROVIDER === 'mailgun') {
    // PR 2: looks up subjects[templateName], calls renderTemplate, then sendViaMailgun
    return sendViaMailgun();
  }
  return sendViaCustomerIo({
    transactional_message_id: templates[params.templateName],
    to: params.to,
    message_data: params.templateVars,
    identifiers: { email: params.to },
    reply_to: 'hi@kilocode.ai',
  });
}
```

Each `send*Email` function builds `templateVars` and calls `send()` once. Customer.io receives its native `transactional_message_id` + `message_data` interface. Mailgun (PR 2) renders HTML locally and looks up the subject from `subjects[templateName]` — no subject arg needed at call sites. All emails use `{ email: to }` as the Customer.io identifier.

### Template Rendering

A `renderTemplate()` function reads an HTML file from `src/emails/{name}.html` and replaces `{{ variable_name }}` placeholders with provided values:

```typescript
function renderTemplate(name: string, vars: Record<string, string>) {
  const templatePath = path.join(process.cwd(), 'src', 'emails', `${name}.html`);
  const html = fs.readFileSync(templatePath, 'utf-8');
  return html.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    if (!(key in vars)) {
      throw new Error(`Missing template variable '${key}' in email template '${name}'`);
    }
    return vars[key];
  });
}
```

The 3 OSS templates currently use a Liquid conditional `{% if has_credits %}...{% endif %}` which must be replaced with a `{{ credits_section }}` placeholder. The JS builds the snippet:

```typescript
function buildCreditsSection(monthlyCreditsUsd: number): string {
  if (monthlyCreditsUsd <= 0) return '';
  return `<br />• <strong style="color: #d1d5db">$${monthlyCreditsUsd} USD in Kilo credits</strong>, which reset every 30 days`;
}
```

### Subject Lines

Customer.io stores subjects in the remote template. Mailgun needs them passed explicitly. Rather than adding a subject argument to every `send*Email` call site, subjects are stored in a `subjects` map in `email.ts` keyed by `TemplateName`. The Mailgun branch of `send()` looks up `subjects[templateName]` internally — call sites are unchanged.

| Template name               | Subject                                       |
| --------------------------- | --------------------------------------------- |
| `orgSubscription`           | "Welcome to Kilo for Teams!"                  |
| `orgRenewed`                | "Kilo: Your Teams Subscription Renewal"       |
| `orgCancelled`              | "Kilo: Your Teams Subscription is Cancelled"  |
| `orgSSOUserJoined`          | "Kilo: New SSO User Joined Your Organization" |
| `orgInvitation`             | "Kilo: Teams Invitation"                      |
| `magicLink`                 | "Sign in to Kilo Code"                        |
| `balanceAlert`              | "Kilo: Low Balance Alert"                     |
| `autoTopUpFailed`           | "Kilo: Auto Top-Up Failed"                    |
| `ossInviteNewUser`          | "Kilo: OSS Sponsorship Offer"                 |
| `ossInviteExistingUser`     | "Kilo: OSS Sponsorship Offer"                 |
| `ossExistingOrgProvisioned` | "Kilo: OSS Sponsorship Offer"                 |
| `deployFailed`              | "Kilo: Your Deployment Failed"                |

### Template Variables

All templates use `{{ variable }}` interpolation. `year` is always `String(new Date().getFullYear())`. `credits_section` is built in JS (HTML snippet or empty string).

| Template file                    | Variables                                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `orgSubscription.html`           | `seats`, `organization_url`, `invoices_url`, `year`                                                                        |
| `orgRenewed.html`                | `seats`, `invoices_url`, `year`                                                                                            |
| `orgCancelled.html`              | `invoices_url`, `year`                                                                                                     |
| `orgSSOUserJoined.html`          | `new_user_email`, `organization_url`, `year`                                                                               |
| `orgInvitation.html`             | `organization_name`, `inviter_name`, `accept_invite_url`, `year`                                                           |
| `magicLink.html`                 | `magic_link_url`, `email`, `expires_in`, `year`                                                                            |
| `balanceAlert.html`              | `minimum_balance`, `organization_url`, `year`                                                                              |
| `autoTopUpFailed.html`           | `reason`, `credits_url`, `year`                                                                                            |
| `ossInviteNewUser.html`          | `tier_name`, `seats`, `seat_value`, `credits_section`, `accept_invite_url`, `integrations_url`, `code_reviews_url`, `year` |
| `ossInviteExistingUser.html`     | `tier_name`, `seats`, `seat_value`, `credits_section`, `organization_url`, `integrations_url`, `code_reviews_url`, `year`  |
| `ossExistingOrgProvisioned.html` | `tier_name`, `seats`, `seat_value`, `credits_section`, `organization_url`, `integrations_url`, `code_reviews_url`, `year`  |
| `deployFailed.html`              | `deployment_name`, `deployment_url`, `repository`, `year`                                                                  |

### Admin Email Testing Page

An admin page for sending test emails and previewing output. Controls:

- **Template** — dropdown of all available templates (one entry per `send*Email` function)
- **Provider** — dropdown of implemented providers; only shows providers that are actually wired up (starts as just `customerio`; `mailgun` appears once `email-mailgun.ts` is implemented)
- **Recipient** — text input pre-filled with the logged-in admin's email address, overridable with any valid email

Preview pane (updates when template or provider selection changes):

- **Customer.io**: shows the `message_data` variables that would be sent to the Customer.io API (key/value pairs, not rendered HTML)
- **Mailgun**: shows the fully rendered HTML email in an iframe

Submitting sends a test email using hardcoded representative fixture data for the selected template, routed through the selected provider (ignoring the `EMAIL_PROVIDER` env var for this request). This page is useful both during QA and long-term for testing new templates.

### Environment Variables

- `EMAIL_PROVIDER` — Which email backend to use: `customerio` or `mailgun`. Defaults to `customerio` when unset. Setting an unrecognised value will throw at startup.
- `MAILGUN_API_KEY` — Mailgun API key (starts with `key-...`)
- `MAILGUN_DOMAIN` — Mailgun sending domain (`app.kilocode.ai`)

### Dependencies

Install: `pnpm add mailgun.js form-data` (keep `customerio-node` until cleanup)

## Migration Strategy

### PR 1: Routing Shell + Admin Testing Page ✅ Done

- ~~Add `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `EMAIL_PROVIDER` to `src/lib/config.server.ts`~~ ✅
- ~~Extract existing Customer.io send logic into `src/lib/email-customerio.ts` with `sendViaCustomerIo()`~~ ✅
- ~~Create `src/lib/email-mailgun.ts` as a stub (throws "not yet implemented")~~ ✅
- ~~Add routing layer in `email.ts`: `send()` takes `{ to, templateName, templateVars }` and delegates to the active provider~~ ✅
- ~~Refactor all `send*Email` functions to use `templateName` + `templateVars` instead of building `SendEmailRequestOptions` directly~~ ✅
- ~~Remove `inviteCode` from `OrganizationInviteEmailData` and `OssInviteEmailData`; all sends use `{ email: to }` as the Customer.io identifier~~ ✅
- ~~Export `templates`, `subjects`, `TemplateName` from `email.ts`~~ ✅
- ~~Build the admin testing page with template/provider/recipient controls and preview pane~~ ✅
- ~~Hardcode representative fixture data for each template~~ ✅
- ~~The provider dropdown only shows `customerio` at this point~~ ✅
- ~~Add `EMAIL_PROVIDER=customerio` to `.env.local`, `.env.test`, and `.env.development.local.example`~~ ✅
- Deploy with `EMAIL_PROVIDER=customerio` — no production change

### PR 2: Mailgun Send Logic + Template Rendering ✅ Done (merged into PR 1 branch)

Pre-requisite template work:

- ~~Replace `{{ "now" | date: "%Y" }}` with `{{ year }}` in all 12 templates~~ ✅
- ~~Re-include `src/emails/*.html` and `src/emails/AGENTS.md`~~ ✅
- ~~Replace the `{% if has_credits %}...{% endif %}` block with `{{ credits_section }}` in the 3 OSS templates (`ossInviteNewUser.html`, `ossInviteExistingUser.html`, `ossExistingOrgProvisioned.html`)~~ ✅

Implementation:

- ~~Install `mailgun.js` + `form-data`~~ ✅
- ~~Implement `sendViaMailgun({ to, subject, html })` in `src/lib/email-mailgun.ts`~~ ✅
- ~~Add `renderTemplate()` and `buildCreditsSection()` to `email.ts`~~ ✅
- ~~Update `send()` in `email.ts`: mailgun branch looks up `subjects[templateName]`, calls `renderTemplate(templateName, templateVars)`, then `sendViaMailgun()`. Tighten `templateVars` to `Record<string, string>` — update all `send*Email` call sites (OSS functions replace `has_credits: boolean` + `monthly_credits_usd: number` with `credits_section: buildCreditsSection(...)`)~~ ✅
- ~~Add `mailgun` to the providers list in `email-testing-router.ts`; update `getPreview` to return rendered HTML for mailgun; update `sendTest` to call `sendViaMailgun` directly~~ ✅
- ~~The admin page now shows `mailgun` in the provider dropdown with a full HTML iframe preview~~ ✅
- Deploy with `EMAIL_PROVIDER=customerio` — still no production change

**QA** (no PR): Use the admin testing page to send each template via Mailgun to real inboxes. Compare rendered output against the Customer.io versions. Verify all variable substitution, styling, links.

### PR 3: Flip to Mailgun

- Set `EMAIL_PROVIDER=mailgun` in production
- Monitor delivery, bounce rates, rendering across email clients

### PR 4: Cleanup

After the provider switch is confirmed stable:

- Remove `customerio-node` from `package.json`
- Remove `CUSTOMERIO_EMAIL_API_KEY` from `config.server.ts`
- Remove the `templates` map (no longer needed)
- Remove `SendEmailRequestOptions` type imports
- Remove `EMAIL_PROVIDER` routing logic from `email.ts` and delete `src/lib/email-customerio.ts`
- Note: `src/lib/external-services.ts` also references Customer.io for user deletion — that's a separate concern and uses different API keys (`CUSTOMERIO_SITE_ID`, `CUSTOMERIO_API_KEY`)

## Files Changed

| File                                                        | PR  | Change                                                                                              |
| ----------------------------------------------------------- | --- | --------------------------------------------------------------------------------------------------- |
| `src/lib/email.ts`                                          | 1   | Routing via `send({ templateName, templateVars })`; exports `templates`, `subjects`, `TemplateName` |
| `src/lib/email-customerio.ts`                               | 1   | Extracted `sendViaCustomerIo()`; minimal PII-free logging                                           |
| `src/lib/email-mailgun.ts`                                  | 1→2 | Stub in PR 1 (throws); full `sendViaMailgun({ to, subject, html })` implementation in PR 2          |
| `src/lib/config.server.ts`                                  | 1   | Add `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `EMAIL_PROVIDER` with runtime validation guard             |
| `src/routers/admin/email-testing-router.ts`                 | 1   | New tRPC router with `getTemplates`, `getProviders`, `getPreview`, `sendTest`                       |
| `src/app/admin/email-testing/page.tsx`                      | 1   | New admin page; Customer.io variable preview; mailgun iframe preview added in PR 2                  |
| `src/app/admin/components/AppSidebar.tsx`                   | 1   | Add Email Testing nav link                                                                          |
| `src/routers/admin-router.ts`                               | 1   | Register `emailTestingRouter`                                                                       |
| `.env.local`, `.env.test`, `.env.development.local.example` | 1   | Add `EMAIL_PROVIDER=customerio`                                                                     |
| `src/emails/*.html`                                         | 2   | OSS templates: replace Liquid credits conditional with `{{ credits_section }}`                      |
| `package.json`                                              | 2   | Add `mailgun.js` + `form-data` (keep `customerio-node` until PR 4)                                  |
