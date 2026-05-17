# kiloclaw-inbound-email

Cloudflare Email Routing handler for `kiloclaw.ai`. Receives mail addressed to `<alias>@kiloclaw.ai`, looks up the alias in `kiloclaw_inbound_email_aliases`, parses the message, and enqueues a delivery for the consumer to forward to the platform worker's `/api/platform/inbound-email` endpoint.

## Pipeline

```
Cloudflare Email Routing
    → email() handler (this worker)
        → resolveRecipient → lookupInstanceIdByAlias
        → parseRawEmail
        → INBOUND_EMAIL_QUEUE.send({ instanceId, alias, from, subject, text, ... })
    → queue consumer (this worker)
        → POST kiloclaw worker /api/platform/inbound-email
            → POST instance controller /_kilo/hooks/email
                → OpenClaw /hooks/email
```

## Observability

To make logs reach Axiom, the worker needs **both** flags in `wrangler.jsonc`:

```jsonc
"observability": { "enabled": true },
"logpush": true,
```

The account-level Logpush job is set to "all logs", but Cloudflare still requires each worker to opt in via `logpush: true`. `observability.enabled` alone isn't enough: without `logpush: true`, the worker's trace events stay inside Cloudflare and never reach the `cloudflare-logpush` Axiom dataset. Check `ScriptName == "<your-worker>"` in Axiom after deploy to confirm.
