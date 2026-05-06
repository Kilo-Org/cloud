# ClawMetry observability integration

[ClawMetry](https://clawmetry.com) is a real-time observability dashboard for OpenClaw agents (sessions, token usage, cost, tool timeline, channels, alerts). Every KiloClaw instance ships with the ClawMetry sync daemon pre-installed — when enabled, agent activity flows to a per-user free ClawMetry account at `app.clawmetry.com`.

## What this gives the user

- A real-time dashboard of their agent's sessions, token spend, and tool activity
- Free tier: one node (their KiloClaw instance), 90-day session retention
- Optional Pro upgrade ($5/mo, redeemable via KiloCredits) — multi-node, unlimited retention, alerts, approvals

The integration is **opt-in by env var** — it ships dormant. When `CLAWMETRY_PARTNER_KEY` is set on the instance, bootstrap auto-provisions a free account and starts the sync daemon. Until then, the package is installed but inert.

## Versioning

ClawMetry is installed via the upstream one-line installer (`curl -fsSL https://clawmetry.com/install.sh | bash`), not a PyPI version pin. This means:

- Every fresh image build picks up the **latest** ClawMetry release at build time.
- ClawMetry can ship updates (new features, install-script changes) without requiring a PR back to this repo. Trigger a KiloClaw image rebuild to pick them up.
- Builds are **not bit-reproducible** across rebuilds — different builds may install different ClawMetry versions. That's intentional: the integration is best-effort observability, and the sync daemon is fail-soft (see `provisionClawMetrySync` in `controller/src/bootstrap.ts`).

If a specific version is ever needed for an incident or hotfix, override at build time:

```bash
docker build --build-arg CLAWMETRY_INSTALL_OVERRIDE='pip install --break-system-packages clawmetry==<version>' ...
```

(That build arg doesn't exist today — file an issue if you need it.)

## Activation

Set these env vars on the KiloClaw instance (typically via the controller's normal env-var injection path; both can be `KILOCLAW_ENC_*` encrypted):

| Variable                      | Required                | Purpose                                                                                                            |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `CLAWMETRY_PARTNER_KEY`       | yes                     | Service-to-service key issued by ClawMetry to KiloClaw. Without it, the integration is a no-op.                    |
| `KILOCLAW_USER_EMAIL`         | yes (or `GITHUB_EMAIL`) | Email used to provision the free ClawMetry account. Falls back to `GITHUB_EMAIL` if unset.                         |
| `CLAWMETRY_API_BASE`          | no                      | Override the ClawMetry endpoint (default `https://app.clawmetry.com`). Useful for staging / self-hosted ClawMetry. |
| `KILOCLAW_CLAWMETRY_DISABLED` | no                      | Set to `'true'` to disable even when partner key is present (escape hatch).                                        |

## What bootstrap does

The `clawmetry-sync` phase in `bootstrapNonCritical` (controller, [bootstrap.ts](../controller/src/bootstrap.ts)):

1. POSTs `{email, source: 'kiloclaw'}` to `${CLAWMETRY_API_BASE}/api/partner/kiloclaw/provision` with `X-Partner-Key` header
2. Receives `{ok: true, cm_token: 'cm_...'}` (existing account if email matches; new free account otherwise)
3. Writes the token to `/root/.clawmetry/token` (mode 0600)
4. Spawns `clawmetry sync` as a detached background process — events flow to ClawMetry cloud from then on

Failures are warned and skipped — they NEVER block boot. Observability is best-effort; the gateway is the critical path.

## Cloud-side prerequisite

This integration depends on a ClawMetry endpoint that does not exist at the time of writing:

```
POST /api/partner/kiloclaw/provision
Headers: X-Partner-Key: <issued-key>
Body:    {"email": "<user>", "source": "kiloclaw"}

Response (201): {"ok": true, "cm_token": "cm_..."}
Response (400): {"ok": false, "error": "..."}
```

Until ClawMetry ships this route + issues a partner key, leave `CLAWMETRY_PARTNER_KEY` unset on KiloClaw instances. The integration is dormant — there is zero behavior change.

Tracking: contact `vivek@clawmetry.com` to coordinate partner-key issuance.

## Verifying

After enabling on a test instance:

```bash
fly ssh console -s --app <kiloclaw-app>
cat /root/.clawmetry/token       # cm_<32 hex chars>
ps -ef | grep 'clawmetry sync'   # daemon should be running
tail -f /var/log/clawmetry-sync.log
```

Then visit `https://app.clawmetry.com/cloud` and sign in with the same email — the user's KiloClaw instance shows up as a node within ~1 minute.

## Disabling

Set `KILOCLAW_CLAWMETRY_DISABLED=true` on the instance env. On next boot the bootstrap step skips silently. Existing tokens at `/root/.clawmetry/token` remain — to fully clean up, also stop the sync daemon and delete the token file.
