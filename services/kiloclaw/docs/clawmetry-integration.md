# ClawMetry observability integration

[ClawMetry](https://clawmetry.com) is a free, end-to-end-encrypted observability dashboard for OpenClaw agents (sessions, token usage, cost, tool timeline, channels, alerts). Every KiloClaw instance ships with ClawMetry pre-installed and pre-wired — but the sync daemon stays dormant until the user clicks "View Observability" in KiloClaw's web UI. No wasted compute / bandwidth / storage for users who never look.

## What this gives the user

- Real-time dashboard of agent sessions, token spend, and tool activity (once they open it)
- **Free tier (forever, no account required)**: 1 node monitoring · 24-hour Brain feed history · 7-day token tracking · E2E encryption
- Optional **Pro upgrade** ($5/node/month, 7-day free trial): unlimited nodes · 30-day Brain feed · 90-day token analytics + CSV export · 90-day event retention · approval policies · channel integrations (Slack/Telegram/PagerDuty/Phone) · Flow view · custom alert webhooks · budget limits
- Zero setup — works out of the box; one click to view
- E2E encrypted: cloud only ever sees ciphertext; encryption key never leaves their KiloClaw instance

Pricing: <https://clawmetry.com/pricing>

## How it works

### At bootstrap (every new instance)

The `provisionClawMetrySync` step in [`controller/src/bootstrap.ts`](../controller/src/bootstrap.ts) does the same thing any user installing ClawMetry on a fresh OpenClaw box would do — minus starting the daemon:

1. POSTs `{hostname, machine_id, platform: 'Linux', email?}` to `${CLAWMETRY_API_BASE}/api/register` (a public, idempotent endpoint)
2. Receives `{api_key, dashboard_id, node_id}` back — a per-machine token
3. Generates a 32-byte AES-256-GCM `encryption_key` **client-side** — never sent to any server
4. Writes `/root/.clawmetry/config.json` (mode 0600) with the schema `clawmetry sync` expects: `{api_key, encryption_key, node_id, platform, connected_at}`
5. Writes `/root/.clawmetry/dashboard-url.txt` (mode 0600) with a self-decrypting URL: `https://app.clawmetry.com/cloud#key=<enc_key>&node=<node_id>` — the `#fragment` is never sent to any server (browsers strip it from outgoing requests)

**The sync daemon is NOT spawned here.** Deferred until the user actually wants to view the dashboard.

### When the user clicks "View Observability" in KiloClaw's web UI

KiloClaw's web UI should expose two controller endpoints:

```
GET  /_kilo/clawmetry-dashboard-url    → returns contents of dashboard-url.txt
POST /_kilo/clawmetry-start-sync       → spawns `nohup clawmetry sync &` (idempotent — pgrep first)
```

The button click handler:

```ts
async function viewClawmetryDashboard() {
  // Start the sync daemon on demand (idempotent — controller checks pgrep)
  await fetch('/_kilo/clawmetry-start-sync', { method: 'POST' });
  // Open the self-decrypting dashboard URL in a new tab
  const url = await fetch('/_kilo/clawmetry-dashboard-url').then(r => r.text());
  window.open(url, '_blank');
}
```

Once the daemon starts, it reads `config.json`, processes any persisted local OpenClaw session files (catch-up batch), and streams live events from then on. The dashboard shows "Syncing your data..." until the first events arrive.

## E2E encryption guarantee

| Where                                        | Has plaintext events?         | Has encryption_key?                        |
| -------------------------------------------- | ----------------------------- | ------------------------------------------ |
| User's KiloClaw instance (Fly machine)       | ✅ yes                        | ✅ yes (in `/root/.clawmetry/config.json`) |
| ClawMetry cloud (`app.clawmetry.com`)        | ❌ no — only ciphertext blobs | ❌ no                                      |
| KiloClaw's cloud (`Kilo-Org/cloud`)          | ❌ no                         | ❌ no                                      |
| User's browser (after opening dashboard URL) | ✅ decrypted client-side      | ✅ yes (from URL fragment → localStorage)  |

The encryption key flows: instance → URL fragment → user's browser. **Never** through any server. Even KiloClaw's controller endpoint that returns the URL only sees the URL string itself; the fragment is meaningful only to the user's browser.

## Versioning

ClawMetry is installed via the upstream one-line installer (`curl -fsSL https://clawmetry.com/install.sh | bash`), not a PyPI version pin. Every fresh image build picks up the latest ClawMetry release at build time. ClawMetry can ship updates without requiring a PR back to this repo — trigger a KiloClaw image rebuild to pick them up.

Trade-off: builds are not bit-reproducible across rebuilds. That's intentional; the integration is best-effort observability.

## Env vars

All optional:

| Variable                      | Default                     | Purpose                                                                                                             |
| ----------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `CLAWMETRY_API_BASE`          | `https://app.clawmetry.com` | Override for staging / self-hosted ClawMetry                                                                        |
| `KILOCLAW_USER_EMAIL`         | unset                       | Email attached to the account so dashboard OTP-login surfaces this node under the user's existing ClawMetry account |
| `GITHUB_EMAIL`                | unset                       | Fallback when `KILOCLAW_USER_EMAIL` is absent                                                                       |
| `KILOCLAW_CLAWMETRY_DISABLED` | unset                       | Set to `'true'` to disable the integration entirely (escape hatch)                                                  |

`FLY_MACHINE_ID` and `HOSTNAME` are read directly from the runtime env (Fly auto-injects them); they don't need to be set.

## Verifying

After deploying a new KiloClaw image:

```bash
fly ssh console -s --app <kiloclaw-app>
ls -la /root/.clawmetry/                   # config.json + dashboard-url.txt, both 0600
cat /root/.clawmetry/dashboard-url.txt     # https://app.clawmetry.com/cloud#key=...&node=...
ps -ef | grep 'clawmetry sync'             # should show NOTHING (deferred — daemon not running yet)
```

Then in browser: paste the dashboard URL → see "Syncing your data..." overlay → KiloClaw web UI's "View Observability" button (when it's added) will start the daemon + open the URL in one click.

Once sync starts:

```bash
ps -ef | grep 'clawmetry sync'             # daemon now running
tail -20 /var/log/clawmetry-sync.log       # confirms events publishing
```

## Disabling

Set `KILOCLAW_CLAWMETRY_DISABLED=true` on the instance env. On next boot the bootstrap step skips silently. Existing files at `/root/.clawmetry/` remain — to fully clean up, also stop any running sync daemon and delete the directory.

## Follow-up work

This PR pre-wires the integration but doesn't add the UI surface. Tracking issue for KiloClaw web UI work:

- Add "View Observability Dashboard" button (likely in instance detail or settings page)
- Add controller endpoints `/_kilo/clawmetry-dashboard-url` (GET) and `/_kilo/clawmetry-start-sync` (POST, idempotent)
- Optional: show sync status (running / stopped) so users can see whether their data is up-to-date
