# ClawMetry observability integration

[ClawMetry](https://clawmetry.com) is a real-time observability dashboard for OpenClaw agents (sessions, token usage, cost, tool timeline, channels, alerts). Every KiloClaw instance ships with the ClawMetry sync daemon pre-installed and auto-registers on first boot — agent activity flows to a per-instance free ClawMetry account at `app.clawmetry.com`.

## What this gives the user

- A real-time dashboard of their agent's sessions, token spend, and tool activity
- Free tier: one node (their KiloClaw instance), 90-day session retention
- No setup required — works out of the box on every new instance

## How it works

The bootstrap step `provisionClawMetrySync` (controller, [bootstrap.ts](../controller/src/bootstrap.ts)) does the same thing any user installing ClawMetry on a fresh OpenClaw box would do:

1. POSTs `{hostname, machine_id, platform: 'Linux', email?}` to `${CLAWMETRY_API_BASE}/api/register` (a public, idempotent endpoint)
2. Receives `{api_key: 'cm_...'}` back — a per-machine token
3. Writes the token to `/root/.clawmetry/token` (mode 0600)
4. Spawns `clawmetry sync` as a detached background process — events flow to ClawMetry cloud from then on

No special endpoint. No partner key. No secrets to manage. Tokens are scoped to `machine_id` (Fly machine ID, falling back to HOSTNAME), so each instance gets its own ClawMetry account. Users with multiple KiloClaw instances can link them later via the standard `clawmetry connect` OTP flow.

Failures are warned and skipped — they NEVER block boot. Observability is best-effort; the gateway is the critical path.

## Versioning

ClawMetry is installed via the upstream one-line installer (`curl -fsSL https://clawmetry.com/install.sh | bash`), not a PyPI version pin. Every fresh image build picks up the latest ClawMetry release at build time. ClawMetry can ship updates without requiring a PR back to this repo — trigger a KiloClaw image rebuild to pick them up.

Trade-off: builds are not bit-reproducible across rebuilds. That's intentional; the integration is best-effort observability.

## Env vars

All optional:

| Variable                      | Default                     | Purpose                                                                          |
| ----------------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| `CLAWMETRY_API_BASE`          | `https://app.clawmetry.com` | Override for staging / self-hosted ClawMetry                                     |
| `KILOCLAW_USER_EMAIL`         | unset                       | Email attached to the account for recovery (optional — account works without it) |
| `GITHUB_EMAIL`                | unset                       | Fallback when `KILOCLAW_USER_EMAIL` is absent                                    |
| `KILOCLAW_CLAWMETRY_DISABLED` | unset                       | Set to `'true'` to disable the integration entirely (escape hatch)               |

`FLY_MACHINE_ID` and `HOSTNAME` are read directly from the runtime env (Fly auto-injects them); they don't need to be set.

## Verifying

After deploying a new KiloClaw image:

```bash
fly ssh console -s --app <kiloclaw-app>
cat /root/.clawmetry/token       # cm_<32 hex chars>
ps -ef | grep 'clawmetry sync'   # daemon should be running
tail -f /var/log/clawmetry-sync.log
```

Then visit `https://app.clawmetry.com/cloud` and sign in with the email that was attached (via `clawmetry connect` OTP flow) — the user's KiloClaw instance shows up as a node within ~1 minute.

## Disabling

Set `KILOCLAW_CLAWMETRY_DISABLED=true` on the instance env. On next boot the bootstrap step skips silently. Existing tokens at `/root/.clawmetry/token` remain — to fully clean up, also stop the sync daemon and delete the token file.
