# Integrations Cloud hub and personal BYOC

Approved 2026-09-09. Moves Vercel compute setup into Integrations and extends customer-paid Vercel (BYOC) to personal Kilo accounts.

## Goal

- Put compute in Integrations behind one **Cloud** card that opens a provider list.
- Ship **Vercel** as the only provider.
- Let an enrolled personal user connect Vercel for that user’s personal Cloud Agent sessions only.
- Keep org BYOC isolated from personal BYOC.

## Non-goals

- Other providers (AWS, E2B, and similar).
- Hobby-owned Vercel projects (`accountId` that does not start with `team_`).
- Sharing a personal Vercel credential with an organization.
- Redirects from `/organizations/:id/cloud/compute`.
- Browser/E2E coverage (manual live Vercel setup remains a manual check).
- Keeping `BYOC_VERCEL_ORG_IDS` as a second allowlist.

## Surfaces

Personal Integrations (`/integrations`) and org Integrations (`/organizations/:id/integrations`) show a **Cloud** hub card in the existing grid. Cloud is a hub, not an OAuth platform in `PLATFORM_DEFINITIONS`.

Visibility:

- Hidden unless the current owner is enrolled in `BYOC_VERCEL_IDS`, or that owner already has a credential row (so disconnect remains possible after enrollment is removed).
- Connect/setup is allowed only when enrolled.
- Personal: the signed-in user is the owner.
- Org: same roles as today’s Compute nav — organization **owner** and **admin** only. Members and billing managers do not see the card.

Routes:

- Hub: `/integrations/cloud` and `/organizations/:id/integrations/cloud`
- Vercel: `/integrations/cloud/vercel` and `/organizations/:id/integrations/cloud/vercel`

The hub lists providers. Vercel is the only card. Do not show coming-soon placeholders.

The Vercel page is Integrations-style: connected / not connected, connect, disconnect. The steps stay: masked token → Continue → team/project → Start setup.

Remove org **Cloud → Compute** from the sidebar and delete the Compute page. Chat, sessions, webhooks, triggers, and MCP stay under Cloud. No redirect; the old URL is gone.

## Enrollment

Replace `BYOC_VERCEL_ORG_IDS` with `BYOC_VERCEL_IDS`.

- Comma-separated user IDs and organization IDs.
- Empty is off.
- `*` admits every personal user and every organization.
- Do not read the old name. Callers rename the variable.

Worker enrollment stays authoritative. Web UI and tRPC also hide/reject setup when the owner is not enrolled, so the card is not a second policy.

## Ownership

A credential has exactly one owner: a user **or** an organization.

- Personal Cloud Agent sessions (`organization_id` absent) use that user’s credential, and only if the user is enrolled.
- Org sessions use that org’s credential, and only if the org is enrolled.
- An enrolled owner without a ready credential fails closed. No platform-paid fallback.
- Code Reviewer sessions (`billingOrigin === 'code-review'`) stay on platform compute. Do not broaden that exception unless a new origin is named.

Siblings keep the same immutable binding (owner + credential id). Missing or swapped binding rejects.

## Data model

Keep table `organization_vercel_compute_credentials`. Do not rename it in this change.

- Add nullable `user_id` as `text` (Kilo user IDs are not always UUIDs; OAuth ids often start with `oauth/`).
- Make `organization_id` nullable.
- Check: exactly one of `organization_id` or `user_id` is set.
- Unique on `organization_id` where present; unique on `user_id` where present. One credential per owner.
- Existing org rows stay org-owned. No backfill.

Token envelope stays BYOC RSA (`byoc-vercel-credential-rsa-aes-256-gcm`).

- Org decrypt context stays `byoc-vercel-credential:v1:${organizationId}:${credentialId}`. Do not re-encrypt existing org rows.
- Personal encrypt/decrypt context is `byoc-vercel-credential:v1:user:${userId}:${credentialId}`.
- Decrypt must fail if the owner in context does not match the row.

`softDeleteUser` must delete a personal credential. Org credentials stay with the organization.

## APIs

Generalize the existing org Vercel compute router to an owner (`user` | `org`), matching Integrations `Owner`. Personal procedures authorize the signed-in user. Org procedures stay owner/admin.

Two enrollment surfaces, both need a user-owner variant. Path-encode owner ids (`encodeURIComponent`) so `oauth/…` ids work.

1. Worker → web credential lookup (existing org URLs):
   - Credential GET already takes `credentialId` plus owner. Accept exactly one of `organizationId` or `userId`.
   - Enrollment GET: keep `/api/internal/byoc/vercel-credentials/organization/:organizationId`. Add `/api/internal/byoc/vercel-credentials/user/:userId`.
2. Web → Worker status (`getVercelComputeEnrollment`):
   - Keep `GET /internal/byoc/vercel-enrollment/:organizationId`.
   - Add `GET /internal/byoc/vercel-enrollment/user/:userId` (do not put a user id in the organization path).

Credential JSON, Worker Zod, snapshot-build DO, `SandboxProviderBinding`, and credential PATCH use a discriminated owner: org rows keep `organizationId`; personal rows send `userId`. Never put `userId` in `organizationId`. Personal `userId` is text; do not validate user ids as UUIDs. Response owner must match the request.

## Runtime

At session start the Worker reads `BYOC_VERCEL_IDS` and the matching credential.

- Org session: org id in the list and a ready org credential. Binding is org + credential id.
- Personal session: session user id in the list and a ready user credential. Binding is user + credential id.
- Team-scoped tokens still send Vercel `teamId`. Project-scoped tokens still omit it.
- Setup still uses the snapshot-build path. Public `setupStep` stays null until ready/failed, same as today.

Discovery and validation stay fail-closed: Vercel teams only (`team_…`), exact project/account match, 20 pages / 1,000 results / 10s deadline. Hobby-owned projects stay `FORBIDDEN`.

Never log tokens, envelopes, or auth headers.

## Errors and recovery

Disconnect removes the credential and its setup resources, same as Compute today.

If the owner is not enrolled and has no credential, the Cloud card is absent and setup APIs reject. If a credential row exists, the owner can open Cloud and disconnect even when no longer enrolled. Connect stays rejected until they are enrolled again.

Failed setup stays visible and retryable on the Vercel page. It does not take down other Integrations.

## Testing

Cover the new contracts. Do not retest the Vercel client unless this change edits it.

- Schema: exactly one owner; unique per user and per org; `user_id` accepts non-UUID ids.
- Web router: enrolled personal user can set up; unenrolled is hidden/rejected; org stays owner/admin; a personal credential cannot be read as an org credential.
- Envelope: decrypt fails if owner id does not match.
- Worker: personal session with ready user credential enrolls; enrolled personal user without credential fails closed; org path unchanged; Code Reviewer stays platform-paid.
- User deletion removes the personal credential.

No browser/E2E in this change.

## Out of scope follow-ups

- Additional Cloud providers on the hub.
- Hobby Vercel accounts.
- Renaming the credential table.
