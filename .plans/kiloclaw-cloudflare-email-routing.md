# KiloClaw Cloudflare Email Routing Plan

## Goal

Add one inbound email address per KiloClaw instance, backed by Cloudflare Email Routing, so an email sent to that address is converted into an OpenClaw hook payload and wakes the instance agent.

## Key Findings

- Cloudflare Email Routing can invoke a Worker `email(message, env, ctx)` handler. The `ForwardableEmailMessage` exposes `from`, `to`, `headers`, `raw`, and `rawSize`.
- Email Routing supports catch-all routes and subaddressing. Catch-all is the best fit because it avoids creating one Cloudflare routing rule per KiloClaw instance.
- Email Routing currently rejects messages larger than 25 MiB. The KiloClaw path should enforce a much lower product limit before parsing or queuing.
- Existing `services/gmail-push` already demonstrates the right pattern for machine delivery: use a Cloudflare service binding to the `kiloclaw` Worker, resolve KiloClaw status/token there, then forward to the Fly machine with `fly-force-instance-id`.
- The controller currently only enables hooks when `KILOCLAW_HOOKS_TOKEN` exists, and that token is only generated for Gog/Gmail credentials. For inbound email, hooks need to be enabled for every instance.
- The controller's current hook token is generated inside the machine and is not visible to Workers. External Workers should not call the gateway hook endpoint directly unless the controller mediates that call.

## Recommended Architecture

Create a new Worker service, `services/kiloclaw-inbound-email`, rather than adding this to `services/gmail-push` or directly to `services/kiloclaw`.

Reasons:

- Email Routing requires an `email` handler and a catch-all Email Routing binding; that is operationally distinct from Gmail Pub/Sub and the public KiloClaw proxy.
- A dedicated Worker keeps MIME parsing, queueing, and abuse controls isolated from the KiloClaw proxy Worker.
- It can use a service binding to `kiloclaw`, so the email Worker does not need Fly credentials or direct machine-routing logic.
- It can have its own queue, dead-letter queue, observability settings, and size limits.

Flow:

```text
sender
  -> Cloudflare Email Routing catch-all address
  -> kiloclaw-inbound-email Worker email() handler
  -> Cloudflare Queue: kiloclaw-inbound-email
  -> queue consumer
  -> service binding: kiloclaw /api/platform/inbound-email
  -> KiloClaw Worker resolves DB/DO/Fly routing
  -> Fly Proxy pinned with fly-force-instance-id
  -> controller /_kilo/hooks/email
  -> local gateway /hooks/email
  -> OpenClaw hooks mapping wakes agent
```

## Address Format

Use deterministic per-instance local parts, with no database migration in v1:

```text
ki-<instance_uuid_without_dashes>@<inbound-domain>
```

Example:

```text
ki-550e8400e29b41d4a716446655440000@clawmail.example.com
```

Implementation details:

- The email Worker parses `message.to`, lowercases the local part, validates `^ki-[0-9a-f]{32}$`, and reconstructs the UUID.
- Invalid local parts are permanently rejected with a generic reason such as `Address unavailable`.
- Destroyed or unknown instances are also rejected generically to avoid leaking instance existence details.
- A future version can add user-friendly/random aliases with a DB column, but v1 can avoid schema changes by using `kiloclaw_instances.id`.

## OpenClaw Hook Configuration

Update the controller so every boot configures an inbound email hook.

Managed config shape:

```ts
{
  hooks: {
    enabled: true,
    token: env.KILOCLAW_HOOKS_TOKEN,
    path: "/hooks",
    mappings: [
      {
        id: "cloudflare-email-inbound",
        match: { path: "email" },
        action: "agent",
        wakeMode: "now",
        name: "Inbound Email",
        sessionKey: "hook:webhook:{{payload.messageId}}",
        messageTemplate: "From: {{payload.from}}\nSubject: {{payload.subject}}\n\n{{payload.text}}",
        deliver: false,
      },
    ],
  },
}
```

Controller changes:

- Change `generateHooksToken()` to generate `KILOCLAW_HOOKS_TOKEN` for every boot, not only when `KILOCLAW_GOG_CONFIG_TARBALL` is present.
- Update `.specs/kiloclaw-controller.md` to reflect that hooks token generation is now universal and still per-boot/non-reused.
- Update `config-writer.ts` to upsert the managed email mapping by `id`, preserving unrelated user mappings and the existing Gmail preset behavior.
- Keep `hooks.token` as the controller-generated per-boot token.
- Add/extend tests in `services/kiloclaw/controller/src/bootstrap.test.ts` and `services/kiloclaw/controller/src/config-writer.test.ts`.

Important token decision:

- Do not use one global shared hook token across all instances.
- Do not expose `KILOCLAW_HOOKS_TOKEN` to Cloudflare Workers.
- Use the existing per-instance gateway token for Worker-to-controller authentication, and let the controller use its local hook token when forwarding to the gateway.

## Controller Delivery Endpoint

Add a new controller route before the catch-all proxy:

```text
POST /_kilo/hooks/email
Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>
Content-Type: application/json
```

Behavior:

- Authenticate with the existing timing-safe bearer-token helper.
- Require the gateway supervisor to be running.
- Require `KILOCLAW_HOOKS_TOKEN` in runtime config.
- Forward the JSON body to `http://127.0.0.1:3001/hooks/email` with the hook token in the auth/header format expected by OpenClaw hooks.
- Return 2xx for successful hook delivery, permanent 4xx for bad hook payloads, and 5xx for transient gateway/controller errors.
- Log only metadata: message id, recipient instance id, status, and body length. Never log email text, headers, or sender address unless redacted/hashed.

Files likely touched:

- `services/kiloclaw/controller/src/index.ts`
- `services/kiloclaw/controller/src/routes/inbound-email.ts` or `routes/hooks.ts`
- `services/kiloclaw/controller/src/startup.test.ts`
- New controller route tests near `services/kiloclaw/controller/src/routes/gmail-push.test.ts`

## KiloClaw Platform Endpoint

Add an internal platform route on the KiloClaw Worker:

```text
POST /api/platform/inbound-email
x-internal-api-key: <INTERNAL_API_SECRET>
Content-Type: application/json
```

Body:

```ts
type InboundEmailDelivery = {
  instanceId: string;
  messageId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  receivedAt: string;
};
```

Behavior:

- Validate the internal API key like other platform routes.
- Validate body with Zod: UUID instance id, bounded strings, bounded text length.
- Look up the active `kiloclaw_instances` row by id via Hyperdrive using `getInstanceById()`.
- Include `organization_id` in `getInstanceById()` so the route can resolve the registry owner key.
- Resolve the DO key with `KiloClawRegistry.resolveDoKey(ownerKey, instanceId)`; fall back to `instanceId` for new instances and support legacy/lazy-migrated personal instances where the DO key may still be `userId`.
- Fetch `stub.getStatus()` and require `running`, `flyMachineId`, `flyAppName`, and `sandboxId`.
- Derive the gateway token from `sandboxId` and `GATEWAY_TOKEN_SECRET`.
- POST the hook payload to `https://{flyAppName}.fly.dev/_kilo/hooks/email` with:
  - `Authorization: Bearer <gatewayToken>`
  - `fly-force-instance-id: <flyMachineId>`
  - `Content-Type: application/json`
- Return clear retry semantics to the queue consumer:
  - `202/200`: delivered or accepted
  - `404/410`: permanent unknown/destroyed instance
  - `409/503`: transient not running/recovering/starting
  - `5xx`: transient infrastructure failure

Files likely touched:

- `services/kiloclaw/src/routes/platform.ts`
- `services/kiloclaw/src/db/index.ts`
- `services/kiloclaw/src/routes/platform*.test.ts`
- `services/kiloclaw/src/types.ts` if new env vars are needed

## Email Worker Service

Create `services/kiloclaw-inbound-email`.

Wrangler shape:

```jsonc
{
  "name": "kiloclaw-inbound-email",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-13",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "placement": { "mode": "smart" },
  "services": [{ "binding": "KILOCLAW", "service": "kiloclaw" }],
  "queues": {
    "producers": [{ "binding": "INBOUND_EMAIL_QUEUE", "queue": "kiloclaw-inbound-email" }],
    "consumers": [
      {
        "queue": "kiloclaw-inbound-email",
        "max_batch_size": 1,
        "max_batch_timeout": 5,
        "max_retries": 5,
        "dead_letter_queue": "kiloclaw-inbound-email-dlq",
      },
    ],
  },
  "secrets_store_secrets": [
    {
      "binding": "INTERNAL_API_SECRET",
      "store_id": "342a86d9e3a94da698e82d0c6e2a36f0",
      "secret_name": "INTERNAL_API_SECRET_PROD",
    },
  ],
  "vars": {
    "INBOUND_EMAIL_DOMAIN": "<domain>",
    "MAX_EMAIL_RAW_BYTES": "1048576",
    "MAX_EMAIL_TEXT_CHARS": "32000",
  },
}
```

Runtime behavior:

- `email(message, env, ctx)`:
  - Validate recipient domain/local part.
  - Reject raw messages over `MAX_EMAIL_RAW_BYTES` before reading `message.raw`.
  - Parse MIME into `from`, `subject`, `text`, and `messageId`.
  - Ignore attachments in v1.
  - Truncate text to `MAX_EMAIL_TEXT_CHARS`.
  - Enqueue a small JSON delivery message.
- `queue(batch, env, ctx)`:
  - POST each delivery to `env.KILOCLAW.fetch(new Request("https://kiloclaw/api/platform/inbound-email", ...))`.
  - Ack on success/permanent failures.
  - Retry transient failures using Queue retry semantics.
  - Avoid logging message bodies, subject, or raw sender addresses.

Dependency recommendation:

- Add a MIME parser dependency such as `postal-mime` if it passes Worker bundle size/typecheck constraints.
- If the dependency is too heavy, implement a v1 parser that only extracts `Message-ID`, `From`, `Subject`, and the first `text/plain` MIME part, with strict size limits.

## Cloudflare Email Routing Setup

One-time infrastructure steps:

1. Choose the inbound domain, preferably a dedicated subdomain such as `clawmail.kilosessions.ai`.
2. Enable Cloudflare Email Routing for that zone and add the required MX/TXT records.
3. Configure the catch-all address action to the `kiloclaw-inbound-email` Email Worker.
4. Optionally reserve/disable normal custom-address rules for the same domain so catch-all behavior is predictable.
5. Confirm Email Routing logs show the Worker receives `ki-...@domain` recipients.

Operational note:

- Email Routing route setup may need dashboard/API work outside `wrangler deploy`; document this in service README or deployment runbook.

## Product/UI Changes

Expose the instance email address wherever users manage KiloClaw instances.

Recommended v1 approach:

- Add a shared helper that formats `ki-${instanceId.replaceAll('-', '')}@${domain}`.
- Add a non-secret public env var for the domain in the web app, for example `NEXT_PUBLIC_KILOCLAW_INBOUND_EMAIL_DOMAIN`.
- Show the address in the KiloClaw instance settings/details UI with copy affordance and concise copy explaining that email content will be sent to the agent.
- If the UI already receives `instanceId`, compute client-side; otherwise include `inboundEmailAddress` in the relevant tRPC response.

Privacy copy should be explicit: inbound emails are processed by Cloudflare Email Routing, KiloClaw infrastructure, and the user's KiloClaw agent instance.

## Rollout Plan

1. Implement controller hook token/config changes and route, with tests.
2. Build and deploy a new KiloClaw controller image.
3. Implement the KiloClaw platform delivery endpoint and tests.
4. Implement and deploy `kiloclaw-inbound-email` with queue and DLQ.
5. Configure Cloudflare Email Routing catch-all to the new Worker.
6. Add UI exposure for per-instance addresses.
7. Roll existing instances onto the new controller image:
   - New/restarted instances will pick up the hook config on boot.
   - Existing running instances need restart or a live config patch after the new controller is running.
8. Run an end-to-end smoke test by sending an email to a test instance address and verifying the agent receives the rendered hook message.

## Verification Plan

Run targeted checks as implementation lands:

```bash
pnpm --filter kiloclaw test
pnpm --filter kiloclaw typecheck
pnpm --filter kiloclaw lint
pnpm --filter kiloclaw-inbound-email test
pnpm --filter kiloclaw-inbound-email typecheck
pnpm --filter kiloclaw-inbound-email lint
pnpm typecheck
```

Manual smoke checks:

- Send valid text email to a test instance address and verify an agent session starts with the expected message template.
- Send to invalid local part and verify permanent generic rejection.
- Send oversized email and verify rejection before raw body parsing.
- Stop the instance, send email, and verify queue retry/DLQ behavior.
- Restart the instance and verify hook token rotation does not break delivery because the controller mediates local hook auth.

## Risks and Mitigations

- Hook auth header uncertainty: verify OpenClaw's hook token header format during implementation and assert it in controller route tests.
- Existing running instances lack the new hook mapping: require restart/live config patch rollout.
- Email loops or spam: do not auto-reply in v1, enforce size limits, and rate-limit later if abuse appears.
- PII in logs: log message ids and status only; avoid sender, subject, body, and full headers.
- Duplicate delivery: rely on `sessionKey: hook:webhook:{{payload.messageId}}` and stable Message-ID fallback hashing.
- Legacy DO keys: use registry resolution and fallback behavior instead of assuming every instance DO is keyed by instanceId.

## Open Decisions

Recommended defaults for v1:

- Worker: create new `services/kiloclaw-inbound-email`.
- Addressing: deterministic `ki-<uuid-no-dashes>@<domain>`.
- Hook token: per-boot controller-generated `KILOCLAW_HOOKS_TOKEN`, not a global shared secret.
- Delivery: queued asynchronous delivery through the KiloClaw Worker platform endpoint.
- MIME scope: text-only, attachments ignored, strict raw/text limits.
