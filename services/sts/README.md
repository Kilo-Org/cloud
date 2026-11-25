# STS — the secrets broker

STS serves each workload one bundle of runtime secrets read from Infisical Cloud EU, and it records
every delivery in an audit log that a queue relays to the audit pipeline. It is phase 1 of the
secrets design: service-token minting, database leases, CI deploy tokens and the audit queue
consumer are not part of this Worker.

## How a read works

- A Worker in the account binds `SecretsBroker`
  (`services: [{ binding, service: "sts", entrypoint: "SecretsBroker", props: { caller: "<own worker name>" } }]`)
  and STS authorizes on `props.caller` against `policy/*.yaml`. This is deploy-level trust: only a
  deploy right in this Cloudflare account can set `props`.
- A caller outside the account posts a provider OIDC token to `POST /v1/bundle`. STS verifies the
  token against the provider's published keys, maps the claims to the one policy that declares them,
  and answers with the bundle.
- One Durable Object per environment and workload holds that workload's bundle, sealed with an
  AES-GCM key generated inside the object. A refresher object per environment reads the manager once
  every four minutes and pushes changed bundles. A read whose ETag still matches returns `304` and
  writes no audit row; every other delivery appends one `ai.kilo.sts.bundle.delivered` row in the
  same call, and a failed append refuses the read.

Routes: `POST /v1/bundle`, `GET /manager-auth/.well-known/openid-configuration`,
`GET /manager-auth/.well-known/jwks.json`. Production is `https://sts.kiloapps.io`, staging is
`https://sts-staging.kiloapps.io`.

## Configuration

No secret is stored in this Worker. Everything is a plain var, validated with zod at the start of
each entry (the fetch handler, the `SecretsBroker` entrypoint and every Durable Object constructor).

| Var | Meaning |
|---|---|
| `STS_ENVIRONMENT` | `development`, `staging` or `production`. Also the Durable Object name prefix. |
| `STS_ISSUER` | Public base URL, `https://sts.kiloapps.io` in production. The manager OIDC issuer is `${STS_ISSUER}/manager-auth`. |
| `MANAGER_BASE_URL` | Infisical Cloud base URL; defaults to `https://eu.infisical.com`. |
| `MANAGER_PROJECT_ID` | Infisical project holding the runtime secrets (`kilo-runtime`). |
| `MANAGER_ENVIRONMENT_SLUG` | Infisical environment slug for this deployment: `dev`, `staging` or `prod`. |
| `MANAGER_SECRET_PATH` | Folder read from the project; `/runtime`. |
| `MANAGER_IDENTITY_ID` | Infisical machine identity STS logs in as. |
| `DO_JURISDICTION` | `eu` in production and staging, `none` locally. Durable Objects hold secret material and the signing key, so they stay in the EU. |

Bindings: `AUDIT_QUEUE` (queue producer), `STS_BUNDLE_DO`, `STS_REFRESHER_DO`, `STS_SIGNER_DO`.

## Policy

One file per workload in `policy/`, named `<workload>.yaml`. The schema is strict: an unknown field,
a non-canonical secret name, or a duplicate identity binding fails the load, and a workload with no
policy is denied. Example:

```yaml
workload: o11y
environments: [development, staging, production]
identity:
  kind: worker-binding
secrets:
  - O11Y_CF_AE_API_TOKEN
```

Identity kinds: `worker-binding`, `vercel-oidc` (`teamSlug`, `projectId`, `vercelEnvironments`),
`fly-oidc` (`org`, `app`), `github-oidc` (`repositoryId`, `repositoryOwnerId`, and `refs` or
`environments`). Production STS serves only Vercel `environment=production` tokens; staging and
local serve only non-production Vercel environments.

Adding a file also means adding it to `src/policy/registry.ts`; the typed import map in
`src/policy/index.ts` makes the two disagree at typecheck, and `test/repo/policy-files.test.ts`
checks the directory itself. That test also scans every `services/*/wrangler.jsonc` environment and
fails a `SecretsBroker` binding whose `props.caller` is not the worker's own top-level `name` (the
workload name is the same in every environment), a production block that binds `sts-staging` or a
`staging` block that binds `sts`, or a caller with no `worker-binding` policy.

The first request after a deploy compares the policy hash with the stored one and writes one
`ai.kilo.sts.policy.changed` event naming the workloads and secret names that were added or removed.
Secret values never appear in an audit event, a log line or a Durable Object response.

## Infisical identity setup, per environment

For each STS environment create a machine identity in Infisical with generic OIDC auth:

| Field | Value |
|---|---|
| OIDC Discovery URL | `https://sts.kiloapps.io/manager-auth` (staging: `https://sts-staging.kiloapps.io/manager-auth`; local: `http://localhost:8825/manager-auth`) |
| Issuer | same as the discovery URL, as STS publishes it |
| Subject | `sts:production` (or `sts:staging`, `sts:development`) |
| Audience | `infisical` |
| Access token TTL | 2 hours, so the refresher's cached token outlives one refresh cycle |

Grant the identity read-only access to `/runtime` of its own environment in the `kilo-runtime`
project. STS signs the login JWT with an Ed25519 key that lives only in `SignerDO`; the public half is
served at `${STS_ISSUER}/manager-auth/.well-known/jwks.json`, which is why the discovery URL must be
publicly reachable before the first login.

Infisical references: generic OIDC login
(`POST /api/v1/auth/oidc-auth/login`, body `identityId` + `jwt`) —
https://infisical.com/docs/documentation/platform/identities/oidc-auth/general; bulk secret read
`GET /api/v4/secrets` with `projectId`, `environment`, `secretPath`, `recursive` and `If-None-Match`
— https://infisical.com/docs/api-reference/endpoints/secrets/list.

## Local development

```sh
pnpm --filter cloudflare-sts dev     # wrangler dev --env local
```

The local block serves `http://localhost:8825` with `DO_JURISDICTION=none` (workerd enforces no data
residency, so the objects live in the default jurisdiction) and the local queue
`kilo-audit-local`. The manager vars point at a placeholder identity, so a bundle read waits on no
manager and reports `manager_unreachable_no_copy` until you point `MANAGER_*` at a real development
identity. The discovery and JWKS routes work without any manager access.

## Production prerequisites

1. **DNS and route**: a custom domain `sts.kiloapps.io` on the `kiloapps.io` zone, and
   `sts-staging.kiloapps.io` for staging. `workers_dev` stays false.
2. **Queues**: `kilo-audit` (production) and `kilo-audit-staging`, both EU. The producer binding
   exists here; the consumer is the separate audit-relay service.
3. **Infisical identities**: one per environment as described above, with `MANAGER_PROJECT_ID` and
   `MANAGER_IDENTITY_ID` filled in. The committed values are placeholders on purpose.
4. **Runtime secrets**: every name in a policy file must exist on the manager's `/runtime` path of
   that environment. Names in a policy that the manager does not hold are reported in the bundle's
   `missing` list rather than failing the read.

## Tests

`pnpm --filter cloudflare-sts test` runs the Workers-pool suites in `test/worker/` (identity
acceptance per provider against locally generated JWKS, policy schema, bundle delivery and relay,
refresher against a mocked manager) and then the Node suite in `test/repo/` (policy files and the
`props.caller` scan). `typecheck` and `lint` are the usual package scripts.
