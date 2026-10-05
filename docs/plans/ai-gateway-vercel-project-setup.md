# AI gateway Vercel project setup plan

## Outcome

Create the `kilocode-ai-gateway` Vercel project for `apps/ai-gateway`, ready to serve the AI gateway API from `fra1` and `sfo1` in staging and production. The project must:

- reach the same databases and upstreams as the web app;
- keep the same abuse protection;
- report to the same observability tools.

This plan stops before traffic moves. Pointing clients or `apps/web` rewrites at the gateway is a separate change.

The settings below were read from `kilocode-global-app` and `kilocode-app` with read-only Vercel API calls on 2026-10-05. `kilocode-global-app` is the reference project because it also runs in `fra1` and `sfo1`.

This repository is public. Do not add project, network, subnet or security-group IDs, IP addresses, or rate-limit thresholds to this file. Read them from the reference project in the Vercel dashboard when you configure the new one.

## Prerequisites

- #7164 is merged, so `pnpm web:env copy` exists and `pnpm web:env set` covers `kilocode-ai-gateway`.
- The `Deploy AI Gateway` workflow (`.github/workflows/deploy-ai-gateway.yml`, from #7052) is on `main`.
- You have owner access to the `kilocode` Vercel team, write access to the `Kilo Web ENV Production` 1Password vault, access to the `kilo.ai` DNS zone, and admin access to the GitHub repository settings.
- These decisions are made:
  - [ ] the production and staging hostnames (step 8);
  - [ ] the Sentry project (step 5);
  - [ ] the shape of the inference rate limit (step 7).

## Steps

Do them in this order. Each step can be repeated if it fails partway.

### 1. Create the project

In the `kilocode` team, create a project named `kilocode-ai-gateway` without a Git link: run `vercel project add kilocode-ai-gateway --scope kilocode`, or import the repository and then disconnect it under Settings → Git. Like `kilocode-global-app`, it must have no Git link: deploys come only from the `Deploy AI Gateway` workflow. A Git link would also deploy every push to `main`, ahead of migrations.

| Setting | Value | Reference project |
|---|---|---|
| Framework | Next.js | same |
| Root directory | `apps/ai-gateway` | `apps/web` |
| Include files outside the root directory | On | On |
| Install, build, output commands | Defaults | Defaults |
| Node.js version | 24.x | 24.x |
| Build machine | Standard is enough; the local build takes about 15 s | Turbo, fixed |
| Git | Not connected | Not connected |

### 2. Configure functions and deployments

| Setting | Value | Notes |
|---|---|---|
| Fluid compute | On | Same as reference |
| Elastic concurrency | On | Same as reference |
| Default function memory | Performance | Same as reference |
| Default function timeout | 300 s | Routes still set their own `maxDuration` |
| Default function regions | `fra1`, `sfo1` | `apps/ai-gateway/vercel.json` also sets these. `isUSRegion` relies on only these two. |
| Zero-config failover | Match the reference project | Check it still applies with Secure Compute (step 4) |
| Rolling releases | Production, 10% for 5 minutes, then 100% | Same as both web projects; check in step 10 that the workflow's `vercel promote` goes through it |
| Skew protection | Off, or match the reference (12 h) | API clients do not pin deployments |
| Deployment retention | Match the reference | |
| Deployment protection | Vercel Authentication for all deployments except custom domains | Same as both web projects; no password protection, trusted IPs or bypass secrets |
| Automatically expose system environment variables | On | Same as reference |
| OIDC federation | Team issuer | Same as reference; no gateway code uses it |
| Web Analytics, Speed Insights | Off | API-only app |
| Crons | None | Crons stay on the web app |

### 3. Add the staging environment

Create a custom environment with the slug `staging` (type preview, no branch matcher), matching `kilocode-global-app`. The workflow deploys staging with `vercel deploy --target=staging`, and `pnpm web:env` writes staging values to the `staging` custom environment, so the slug must be exactly `staging`.

### 4. Enable Secure Compute and static IPs

`kilocode-global-app` is attached to two Secure Compute networks, one in `fra1` and one in `sfo1`. Each network is attached for production, preview and staging, and builds stay off. Attach `kilocode-ai-gateway` the same way:

- [ ] the `fra1` network that `kilocode-global-app` uses, for production, preview and staging;
- [ ] the `sfo1` network that `kilocode-global-app` uses, for production, preview and staging;
- [ ] builds not on the network.

`kilocode-app` only has a `fra1` network, so take both networks from `kilocode-global-app`.

Static IPs are enabled on `kilocode-global-app` for `fra1` and `sfo1`, without builds. Enable them on the new project for the same regions. Then:

- [ ] Compare the project's egress IPs with `kilocode-global-app`'s. If they differ, add them to every allowlist that has the web egress IPs before step 10: databases, providers, and partners.
- [ ] Confirm with whoever owns those allowlists which upstreams depend on them.

### 5. Connect integrations

The Sentry and Axiom integrations are installed for all projects, and they own these variables in both web projects. `pnpm web:env copy` skips them, so the integrations have to create them.

| Integration | Action | Variables it manages |
|---|---|---|
| Sentry | Map `kilocode-ai-gateway` to a Sentry project in the integration settings. Use the web project's, or a new one if gateway issues should be kept apart; OTel reports `kilocode-ai-gateway` either way. | `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_OTLP_TRACES_URL`, `SENTRY_PROJECT`, `SENTRY_PUBLIC_KEY`, `SENTRY_VERCEL_LOG_DRAIN_URL`, `VERCEL_GIT_COMMIT_SHA` |
| Axiom | Confirm the integration created a log drain for `kilocode-ai-gateway`. Each existing Axiom drain covers one project, so the gateway needs its own. | `NEXT_PUBLIC_AXIOM_INGEST_ENDPOINT` |

Upstash, Neon, MotherDuck and Supabase are also installed, but none of them links a store or variables to either web project. Upstash Redis and the databases reach the gateway as ordinary variables in step 6.

### 6. Copy environment variables

```bash
pnpm web:env copy --from kilocode-global-app --to kilocode-ai-gateway --dry-run
pnpm web:env copy --from kilocode-global-app --to kilocode-ai-gateway
```

- [ ] Review the "Not copied" list from the dry run. Set the missing values with `pnpm web:env set VARIABLE`.
- [ ] Check that `NEXTAUTH_URL` and `APP_URL_OVERRIDE` still point at the **web** app. Links in gateway responses must open the web app.
- [ ] Check that every database variable, including the US and EU replicas used by `isUSRegion`, is present for production and staging.

Sensitive values come from 1Password. A secret rotated directly in Vercel without `pnpm web:env set` is copied with its old value.

### 7. Configure the firewall

Copy the firewall by hand in the dashboard from `kilocode-app`, not `kilocode-global-app`. Both projects have the same custom rules apart from one description, but `kilocode-app` has 32 IP blocks. `kilocode-global-app` has 12, all of which are among those 32. Copy thresholds, windows, actions and values exactly from the source rule.

Project-wide settings:

- [ ] Firewall on.
- [ ] OWASP core ruleset: the same categories on, with the same actions. Today those are generic, remote execution, XSS and SQL injection.
- [ ] Managed rulesets (Vercel ruleset, bot filter, AI bots, OWASP managed): off, as in the source.
- [ ] BotID off. JA3 and JA4 fingerprinting on.
- [ ] IP blocking: all IP rules from `kilocode-app` (hostname `*`, deny).
- [ ] System bypass rules: none exist; nothing to copy.
- [ ] Attack Challenge Mode: off. It is switched on per incident.

Custom rules:

| Rule | Copy | Why |
|---|---|---|
| Gateway inference per account | As is | **Required.** `isGatewayAccountRateLimited` calls `checkRateLimit('gateway-inference')`. A missing rule counts as "not rate limited", so the per-account inference cap is off, and Sentry gets `Firewall rate limit 'gateway-inference' is not configured` once a minute per instance. |
| Rate limit chat completions API | With path changed | `eq /api/gateway/chat/completions` becomes `eq /api/v1/chat/completions` |
| Rate limit uncovered inference paths | With paths changed | `/api/gateway/v1/` and `/api/openrouter/v1/` become `/api/v1/`; `/api/gateway/messages`, `/api/openrouter/messages` become `/api/v1/messages`; the same for `responses`. See the decision below. |
| abuse ip ban | As is | IP list |
| Block traffic from OFAC-sanctioned countries and regions | As is | Compliance |
| hard limit user hammering us | As is | IP-based |
| blocking gemini abuser | As is | Header and user agent based |
| The single-IP bypass rule | As is | Allowlisted address |
| The `python-httpx` user-agent rule | As is | User agent and ASN based |
| Device Auth – Code Generation, Device Auth – Polling | No | Web-only paths |
| Magic Links, Magic Links v2, Magic Links v3 | No | Web-only paths and `checkRateLimit` IDs |
| Sign-in discovery by IP, Sign-in discovery by email | No | Web-only `checkRateLimit` IDs |
| data-export-download-code, passkey-authentication-options | No | Web-only `checkRateLimit` IDs |

Decision: on web, "uncovered inference paths" and "chat completions" matched different paths. At the gateway, a `/api/v1/` prefix also matches `/api/v1/chat/completions` and cheap routes such as `/api/v1/models`, so chat completions would count against both limits. Pick one of these:

- [ ] keep `/api/v1/` and accept the overlap;
- [ ] list the gateway's inference routes explicitly;
- [ ] add a negated condition for `/api/v1/chat/completions`.

Rate-limit counters are per project. While web and the gateway both serve inference, a client gets a budget in each. Firewall changes made later in one project have to be repeated in the others.

### 8. Add domains and DNS

Choose the hostnames first. For example, `ai-gateway.kilo.ai` for production and `staging-ai-gateway.kilo.ai` for staging. The existing ones are `api.kilo.ai` (`kilocode-app`), `global-api.kilo.ai` (`kilocode-global-app`), and `staging-api.kilo.ai` (`kilocode-app` staging).

- [ ] In the project's Domains settings, add the production hostname to production and the staging hostname to the `staging` environment.
- [ ] `kilo.ai` uses external DNS at the registrar (`registrar-servers.com` nameservers), not Vercel DNS. At the registrar, add the CNAME record that Vercel shows for each hostname. The existing web hostnames point at project-specific `*.vercel-dns-016.com` targets.
- [ ] Wait for Vercel to verify the domains and issue certificates. `kilo.ai` has no CAA records, so nothing blocks Let's Encrypt.
- [ ] The workflow deploys production with `--skip-domain` and assigns the domain on promote, so the production hostname serves nothing until the first promote in step 10.

### 9. Configure GitHub

| Kind | Name | Value |
|---|---|---|
| Repository variable | `VERCEL_PROJECT_ID_AI_GATEWAY` | The new project's ID |
| Repository secret | `VERCEL_TOKEN_AI_GATEWAY` | A Vercel token that can deploy the project |

It must be a repository-level variable, as `VERCEL_PROJECT_ID_APP` is; the workflow reads it before entering an environment. Promote uses the existing team-wide `VERCEL_TOKEN`.

### 10. Deploy and verify

Run **Actions → Deploy AI Gateway** from `main`, first with `staging`, then with `production`. It deploys the commit of the last completed scheduled release for that environment.

For each environment, check:

- [ ] `GET https://<hostname>/api/v1/models` returns 200 and carries `X-Content-Type-Options`, `Strict-Transport-Security` and `Referrer-Policy`.
- [ ] Function logs show both `fra1` and `sfo1`, and requests reach the database from both regions, which confirms Secure Compute and the allowlists.
- [ ] Sentry receives events, and traces show `service.name=kilocode-ai-gateway`. There are no `gateway-inference ... is not configured` messages.
- [ ] Axiom's `vercel` dataset has logs for `kilocode-ai-gateway`.
- [ ] Firewall: the dashboard shows rule evaluations for the gateway's custom rules.
- [ ] Production only: the promote went through the rolling release (10% for 5 minutes) before reaching 100%.
- [ ] Optional: a low-balance email sent from a gateway code path renders, which shows the templates were bundled.

### 11. Before moving traffic

- [ ] Postgres connection headroom: the gateway adds Fluid instances in two regions on top of the web projects. Check pool and server limits on the primary and both replicas. The gateway rate limit code records an earlier connection-pool exhaustion.
- [ ] Axiom monitors and dashboards, and Sentry alerts, that filter on a project name include `kilocode-ai-gateway`.
- [ ] Optional: annotate gateway promotes in Axiom like `promote-app` in `deploy-production.yml` does. That is a code change: the `promote` job in `deploy-ai-gateway.yml` has to pass the `axiom_annotation_dataset` and `axiom_expected_project: kilocode-ai-gateway` inputs of `promote-vercel-deployment.yml`, and the `AXIOM_ANNOTATION_TOKEN` secret.
- [ ] Reconcile the IP blocks of `kilocode-global-app` with `kilocode-app`; they have drifted.

## Out of scope

- Moving clients, or `apps/web` rewrites, to the gateway hostname.
- Adding the gateway to the scheduled deploy workflows. It stays on the manual workflow until it serves traffic.
- Removing the handlers from `apps/web`.
