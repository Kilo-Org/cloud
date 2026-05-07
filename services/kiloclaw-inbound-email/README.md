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

`observability.enabled` in `wrangler.jsonc` only turns on script logs at the runtime level. Logs flow into Axiom only when the script is **also added to the account-level Logpush job's script-name filter** (configured in the Cloudflare dashboard, not in this repo).

Any new worker added to this repo must be added to that filter or its logs will be invisible in Axiom — even if `observability.enabled = true`. Check the `cloudflare-logpush` Axiom dataset for `ScriptName == "<your-worker>"` after deploy to confirm.
