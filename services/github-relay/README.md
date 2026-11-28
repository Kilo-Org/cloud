# GitHub relay

A small Node service on one VM with a fixed public address. It forwards a short list of read-only
GitHub REST calls for Cloudflare Workers whose own egress the Kilo-Org IP allow list refuses.

The migration proxy (`services/migration-proxy`) is its only caller. Its installation-token mint
(`POST /app/installations/<id>/access_tokens`) is not refused from Cloudflare and stays on
`api.github.com`; its repository reads go through the relay when
`MIGRATION_PROXY_GITHUB_RELAY_URL` is set.

## What it relays

`GET` requests under a caller prefix, to the fixed origin `https://api.github.com`. It never takes
a host, scheme or port from the request. The allow-list is `src/callers.ts`:

| Prefix | STS scope | Workload | Paths (`Kilo-Org/cloud` only) |
|---|---|---|---|
| `/migration-proxy` | `github-relay:migration-proxy.read` | `migration-proxy` | `compare/<sha>...<sha or main>?per_page`, `git/trees/<sha>`, `git/blobs/<sha>`, `commits?sha&path&per_page` (path under `packages/db/src/migrations`), `commits/<sha>/pulls?per_page`, `pulls/<n>/reviews?per_page&page`, `contents/packages/db/src/migrations/...?ref=<sha>` |

Every query key is listed per path with the shape of its value; a key appears at most once.
`test/callers.test.ts` drives the proxy's own GitHub client through the relay and checks that
every call it makes is on the list.

## How a caller authenticates

- `Kilo-Relay-Authorization: Bearer <STS token>`: an STS service token with audience
  `github-relay` and the prefix's scope. The relay verifies it with `@kilocode/verify` against the
  STS public key sets (signature, issuer, `env`, audience, scope, lifetime), then requires the
  token's workload to be the prefix's workload. The migration proxy mints it through its STS
  binding; the STS policy grants the scope to `migration-proxy` per environment.
- `Authorization`: the caller's own GitHub installation token, passed to GitHub unchanged. The
  relay holds no GitHub credential and stores no token.

## What it refuses

| Request | Answer |
|---|---|
| A path, query key, query value, repeated key or prefix off the list (dot segments are resolved first; encoded slashes and dots never match) | 403 `not_allowed` (never 404: the proxy reads a GitHub 404 as "no such commit") |
| No STS token, or a malformed, expired or wrongly signed one, another issuer or another `env` | 401 with an RFC 9728 challenge |
| A valid STS token without the prefix's audience or scope | 403 `insufficient_scope` |
| A valid STS token of another workload | 403 `caller_not_allowed` |
| The STS key set cannot be fetched and no usable copy is cached | 503 with `Retry-After` |
| Any method but `GET` | 405 |
| A request body | 400 |
| No GitHub `Authorization` (the relay never calls GitHub anonymously from the allowed address) | 400 |
| More than 32 GitHub calls in flight | 503 with `Retry-After: 1` |
| GitHub unreachable or slower than 25 s | 502 `upstream_unavailable` |

Only `authorization`, `accept` and `x-github-api-version` reach GitHub, with the relay's own
`User-Agent`. Only `content-type`, `etag`, `last-modified`, `link`, `retry-after`,
`x-github-request-id` and `x-ratelimit-*` come back. A GitHub redirect is passed back without its
`Location` and never followed.

## Logs

One JSON line per request on stdout (journald): time, method, route name (`tree`, `compare`, ...),
caller workload, STS environment, status, refusal reason and duration. Never a path parameter,
query, header, token or body. `GET /healthz` answers `ok` without credentials and without a log
line. Caddy keeps no access log.

```sh
sudo journalctl -u github-relay --since -1h
```

## Configuration

Three environment variables, none secret, set in `deploy/github-relay.service`:

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_STS_ENVIRONMENTS` | `staging,production` | STS environments whose tokens it accepts (the unit sets `staging`) |
| `RELAY_PUBLIC_URL` | `https://github-relay.kiloapps.io` | Its public origin, for the 401 challenge |
| `RELAY_PORT` | `8080` | The loopback port Caddy proxies to |

## Checks

```sh
pnpm --filter github-relay typecheck
pnpm --filter github-relay lint
pnpm --filter github-relay test
pnpm --filter github-relay build   # dist/server.mjs, the one file the host runs
```

## Deploy

The host is an e2-micro VM `github-relay` in project `kilocode`, zone `us-central1-a`, with the
reserved regional address `136.119.16.41` (`migration-proxy-github-relay`, us-central1, Premium
tier) as its own external address. Debian 12, no service account, Shielded VM, OS Login. Caddy
terminates TLS on 443; the relay listens on `127.0.0.1:8080` under systemd with `DynamicUser`.
The host holds no secret. Cost: about $10 a month (about $4 with the free e2-micro).

Steps 1 and 2 are organisation and DNS settings; the rest are GCP commands from the repository
root.

1. **Allow list.** An organisation owner adds `136.119.16.41/32` to the Kilo-Org IP allow list
   (organisation settings, Authentication security, IP allow list), description
   `migration-proxy github relay (kilocode GCP)`, enabled. Nothing else on that page changes.
2. **DNS.** A DNS-only (grey cloud) record `github-relay.kiloapps.io A 136.119.16.41` in the
   `kiloapps.io` Cloudflare zone. Workers cannot fetch an IP literal, so the relay needs a name;
   DNS-only, so Caddy holds the certificate and no Cloudflare proxy sits in front of it.
3. **The VM.** The project's existing `default-allow-https` rule opens TCP 443 to the
   `https-server` tag (Let's Encrypt validates on 443 too); `default-allow-ssh` allows SSH from
   the IAP range.

   ```sh
   gcloud compute instances create github-relay --project=kilocode --zone=us-central1-a \
     --machine-type=e2-micro --image-family=debian-12 --image-project=debian-cloud \
     --boot-disk-size=10GB --boot-disk-type=pd-standard \
     --address=136.119.16.41 --network-tier=PREMIUM --tags=https-server \
     --no-service-account --no-scopes \
     --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
     --metadata=enable-oslogin=TRUE \
     --metadata-from-file=startup-script=services/github-relay/deploy/startup.sh
   ```

   The startup script installs Caddy (Debian) and Node (nodejs.org, pinned version and SHA-256)
   on every boot if missing, and starts the relay once its files are in place.
4. **The relay.** Build, copy, install, start:

   ```sh
   pnpm --filter github-relay build
   gcloud compute scp --project=kilocode --zone=us-central1-a --tunnel-through-iap \
     services/github-relay/dist/server.mjs services/github-relay/deploy/Caddyfile \
     services/github-relay/deploy/github-relay.service github-relay:/tmp/
   gcloud compute ssh github-relay --project=kilocode --zone=us-central1-a --tunnel-through-iap \
     --command='set -e
       sudo install -m 0644 /tmp/Caddyfile /etc/caddy/Caddyfile
       sudo install -m 0644 /tmp/github-relay.service /etc/systemd/system/github-relay.service
       if [ -f /opt/github-relay/server.mjs ]; then sudo cp /opt/github-relay/server.mjs /opt/github-relay/server.mjs.previous; fi
       sudo install -m 0644 /tmp/server.mjs /opt/github-relay/server.mjs
       sudo systemctl daemon-reload
       sudo systemctl enable github-relay
       sudo systemctl restart github-relay
       sudo systemctl reload caddy'
   ```

5. **Check.** TLS and the process, then the refusals, from any machine:

   ```sh
   curl -fsS https://github-relay.kiloapps.io/healthz                     # ok
   curl -s -o /dev/null -w '%{http_code}\n' \
     https://github-relay.kiloapps.io/migration-proxy/repos/Kilo-Org/cloud/git/trees/$(git rev-parse HEAD)   # 401
   curl -s -o /dev/null -w '%{http_code}\n' https://github-relay.kiloapps.io/repos/Kilo-Org/cloud   # 403
   ```

6. **Uptime check and alert.** One HTTPS check of `/healthz`, then an alert policy on it:

   ```sh
   gcloud monitoring uptime create github-relay-healthz --project=kilocode \
     --resource-type=uptime-url --resource-labels=host=github-relay.kiloapps.io,project_id=kilocode \
     --protocol=https --path=/healthz --validate-ssl=true --period=5 --timeout=10 \
     --matcher-type=contains-string --matcher-content=ok
   ```

   In Cloud Monitoring, Uptime checks, `github-relay-healthz`, Create alert: notify the team's
   channel when the check fails for 5 minutes. A failed certificate renewal fails the check too.
7. **Staging.** Merge the STS policy grant and the proxy change; set
   `MIGRATION_PROXY_GITHUB_RELAY_URL` to `https://github-relay.kiloapps.io/migration-proxy` in the
   proxy's staging vars and deploy it; run one staging migration end to end.

## Production

After the staging run passes: add a `production` grant of `github-relay` /
`github-relay:migration-proxy.read` to `services/sts/policy/migration-proxy.yaml`, set
`RELAY_STS_ENVIRONMENTS=staging,production` in the unit and redeploy it (step 4), then set the
proxy's production `MIGRATION_PROXY_GITHUB_RELAY_URL`.

## Rotation

- **TLS:** Caddy renews the Let's Encrypt certificate itself, about 30 days before it expires; the
  uptime check validates it.
- **Tokens:** none on the host. The installation token belongs to the proxy (about an hour); the
  STS token is short-lived. The relay refetches the STS key sets by itself (every few minutes, and
  on an unknown `kid`), so an STS key rotation needs nothing here.
- **The address:** to move to a new address, reserve it, add it to the allow list first, attach it
  to the VM, change the DNS record, wait for the old record's TTL, then remove the old allow-list
  entry and release the old address.
- **Node and Caddy:** Debian security updates install themselves (`unattended-upgrades`). For a
  new Node release, change `NODE_VERSION` and `NODE_SHA256` in `deploy/startup.sh` with `.nvmrc`,
  update the instance metadata
  (`gcloud compute instances add-metadata github-relay --zone=us-central1-a --metadata-from-file=startup-script=services/github-relay/deploy/startup.sh`)
  and rerun it (`sudo google_metadata_script_runner startup`).

## Rollback

- **A bad relay build:** put the previous file back and restart:
  `sudo cp /opt/github-relay/server.mjs.previous /opt/github-relay/server.mjs && sudo systemctl restart github-relay`.
- **CI migrations through the proxy failing:** revert the pull request that switched that
  environment's migration path to the proxy, so CI migrates the old way again. Emptying
  `MIGRATION_PROXY_GITHUB_RELAY_URL` is not a rollback: the proxy's reads then go straight to
  GitHub, which the allow list refuses.
- **Remove the relay:** first take every caller off it (above), then delete the VM, the DNS record
  and the allow-list entry, release the address
  (`gcloud compute addresses delete migration-proxy-github-relay --region=us-central1`), and
  remove the STS grant.

## Adding a caller

One row in `CALLERS` (`src/callers.ts`) with its own prefix, scope, workload and paths; the scope
registered in `STS_SCOPE_REGISTRY` (`@kilocode/sts-contracts`) under the `github-relay` audience;
a grant in that caller's STS policy; and a test that drives its client through `matchTarget`.
