# KiloClaw Grafana

This setup runs a local Grafana instance that queries Cloudflare Analytics Engine's ClickHouse endpoint.

Grafana is opt-in. It is behind the `grafana` Docker Compose profile so normal local dev only starts the default services unless you explicitly request Grafana.

It ships with two prebuilt dashboards:

- `KiloClaw Events`
- `KiloClaw Controller Telemetry`

## Cloudflare connection

Cloudflare's ClickHouse endpoint should be configured exactly like this:

- URL: `https://api.cloudflare.com/client/v4/accounts/<account_id>/analytics_engine/sql`
- auth settings: off
- custom header: `Authorization: Bearer <token>`
- no other datasource options are required by Cloudflare

This repo bakes those settings into datasource provisioning and uses Cloudflare's required ClickHouse plugin: `vertamedia-clickhouse-datasource`. The Altinity plugin's provisioned config maps the Cloudflare URL into `jsonData.dataSourceUrl` and the bearer token into `secureJsonData.xHeaderKey`.

## Required environment variables

In normal use, you only need to provide the Cloudflare API token. The recommended place is the repo-root `.env.local` (the same file used for other local dev secrets):

```
CF_AE_TOKEN=<cloudflare-api-token>
```

When Grafana is started via `pnpm dev:start`, the runner passes `--env-file .env.local` to docker compose, so the token reaches the Grafana container as an environment variable. The file's values are scoped to that compose invocation — they are _not_ loaded into the runner's process env or inherited by sibling services.

Shell exports still take precedence over file values (docker compose's standard `--env-file` behaviour), so you can temporarily override with `CF_AE_TOKEN=<other> pnpm dev:start observability`.

Provision a Cloudflare user API token with permission `All accounts - Account Analytics:Read`, then use that token as `CF_AE_TOKEN`.

`CF_ACCOUNT_ID` defaults to the repo's Cloudflare account ID from `kiloclaw/wrangler.jsonc`, so you usually do not need to set it manually.

Optional overrides (same file):

```
CF_ACCOUNT_ID=<32-character-account-id>
GRAFANA_CLICKHOUSE_SECURE=true
GRAFANA_CLICKHOUSE_SKIP_TLS_VERIFY=false
```

## Keeping credentials out of git

`.env.local` is already gitignored — never move these values into a committed file. If you use the standalone docker compose path instead of `pnpm dev:start`, either export the token in the shell or pass it inline:

```bash
CF_AE_TOKEN="<cloudflare-api-token>" docker compose --profile grafana -f dev/docker-compose.yml up grafana
```

If you want to avoid putting the token directly in shell history, enter it interactively:

```bash
read -s CF_AE_TOKEN
export CF_AE_TOKEN
docker compose --profile grafana -f dev/docker-compose.yml up grafana
```

## Start Grafana

### Via `pnpm dev:start` (recommended)

Grafana is part of the `observability` group in the dev runner. With `CF_AE_TOKEN` set in `.env.local` (see above):

```bash
pnpm dev:start observability    # or: pnpm dev:start all
```

Grafana appears in the tmux sidebar under the `OBSERVABILITY` group. Toggle it on/off with space; press Enter on the service to focus its logs pane.

If `CF_AE_TOKEN` isn't set anywhere, the runner prints an advisory warning and still boots Grafana — only dashboard queries fail until a token is provided. Add the token to `.env.local`, restart the session (or the `grafana` window with `r` in the sidebar), and queries start working.

### Via Docker Compose directly

Shortest path from the repo root:

```bash
CF_AE_TOKEN="<cloudflare-api-token>" docker compose --profile grafana -f dev/docker-compose.yml up grafana
```

If you prefer, you can export the token first and then run compose separately:

```bash
export CF_AE_TOKEN="<cloudflare-api-token>"
docker compose --profile grafana -f dev/docker-compose.yml up grafana
```

Default local dev remains unchanged:

```bash
docker compose -f dev/docker-compose.yml up postgres
```

Or, if you use the compose default service set, Grafana will still stay off unless you explicitly enable the `grafana` profile.

Grafana will be available at:

```text
http://localhost:4000
```

Default Grafana credentials are the upstream defaults unless you override them with Grafana env vars:

- username: `admin`
- password: `admin`

## What gets provisioned

- datasource name: `kilo-cloudflare-analytics-engine`
- datasource uid: `kiloclaw-clickhouse`
- dashboard folder: `KiloClaw`
- datasource URL target: `https://api.cloudflare.com/client/v4/accounts/<account_id>/analytics_engine/sql`
- auth header: `Authorization: Bearer <token>`

The dashboards are loaded from `dev/grafana/dashboards/` and update automatically when the container refreshes its file-based provisioning.

## Dashboard coverage

### KiloClaw Events

Queries `kiloclaw_events` and includes panels for:

- overall event volume
- distinct sandboxes
- error rate
- average operation duration
- event throughput by event name
- delivery volume by source (`http`, `do`, `reconcile`, `queue`)
- reconcile and restore activity
- top events, top errors, capacity evictions
- recent failures and recent lifecycle activity

Available filters:

- `Sandbox ID`
- `User ID`
- `Delivery`
- `Fly Region`
- `Event`

### KiloClaw Controller Telemetry

Queries `kiloclaw_controller_telemetry` and includes panels for:

- distinct sandboxes and machines
- average load and uptime
- check-ins by supervisor state
- restart deltas
- bandwidth in and out
- supervisor state distribution
- top restarting sandboxes
- latest controller check-ins

Available filters:

- `Sandbox ID`
- `Supervisor State`
- `Fly Region`
- `Controller Version`

## Notes

- This setup does not run ClickHouse locally. Grafana connects to Cloudflare-hosted Analytics Engine storage using the credentials you provide.
- The datasource provisioning and shipped dashboards use Cloudflare's required datasource type `vertamedia-clickhouse-datasource`.
- The Cloudflare token must have permission to query Analytics Engine SQL.
- `.env*.local*` is already gitignored in this repo if you still prefer a local env file for repeated use.
