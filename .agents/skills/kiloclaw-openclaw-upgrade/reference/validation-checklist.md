# OpenClaw Upgrade Validation Checklist

Use this reference after reading the KiloClaw controller spec and current scripts.
File names are stable workflow touchpoints; verify the actual branch diff instead of
assuming every upgrade needs every file.

## Typical Release Touchpoints

| Path | Check |
|---|---|
| `services/kiloclaw/Dockerfile` | Pinned OpenClaw release and build-time compatibility patches |
| `services/kiloclaw/plugins/kilo-chat/package.json` | OpenClaw peer/dev version alignment |
| `services/kiloclaw/plugins/kiloclaw-morning-briefing/package.json` | OpenClaw peer/dev version alignment |
| `pnpm-lock.yaml` | Resolved plugin compile/test dependency graph |
| `pnpm-workspace.yaml` | Release-age or build-script policy needed for the reviewed pin |
| `services/kiloclaw/e2e/docker-image-testing.md` | Expected image version in manual checks |
| `apps/web/src/app/(app)/claw/components/changelog-data.ts` | User-visible release note when applicable |

`services/kiloclaw/Dockerfile.local` installs a developer-provided tarball rather
than the published production pin; do not update it solely for a release number.

## Narrow Checks Before Live Validation

Run repository-required formatting before committing. Prefer targeted checks while
iterating, then allow push hooks or the relevant release process to run broader gates.

```bash
pnpm install --lockfile-only
pnpm install --frozen-lockfile
pnpm format
bash -n services/kiloclaw/scripts/controller-smoke-helpers.sh
bash -n services/kiloclaw/scripts/controller-live-provider-smoke-test.sh
bash -n services/kiloclaw/scripts/controller-openclaw-upgrade-smoke-test.sh
git diff --check
bun run script/check-md-table-padding.ts
pnpm --filter @kiloclaw/kilo-chat test
pnpm --filter @kiloclaw/kiloclaw-morning-briefing test
pnpm --filter @kiloclaw/kiloclaw-morning-briefing typecheck
```

If pnpm rejects a just-reviewed OpenClaw release because of repository supply-chain
policy, do not bypass installation ad hoc. Determine whether an explicit narrow policy
entry is justified by the pinned image build and successful live upgrade evidence.

Before submitting a KiloClaw change, run the required final gates from
`services/kiloclaw/AGENTS.md`:

```bash
# Before tests, confirm Postgres is active or start it with pnpm test:db.
docker compose -f dev/docker-compose.yml ps postgres
pnpm typecheck
pnpm test
pnpm lint
```

If a required final gate cannot be run, state that explicitly in the PR and handoff;
do not describe narrow checks as full submission validation.

## Official Upgrade Smoke

Run only from a clean committed bump branch; the wrapper builds detached source
worktrees so ignored local files do not enter either candidate image.

```bash
bash services/kiloclaw/scripts/controller-openclaw-upgrade-smoke-test.sh
```

Expected behaviors:

- It refreshes `origin/main` by default; use `BASE_REF` only when the intended
  upgrade baseline differs and document that reason in the PR.
- It rejects an identical before/after OpenClaw pin by default.
- It builds one baseline and one candidate image from checked-in Dockerfiles.
- It starts the baseline on an empty temporary `/root`, then starts the candidate
  against the same `/root`.
- The candidate therefore exercises existing-config startup and `openclaw doctor`.

## Pass Criteria

A release candidate is not validated until output proves all of the following:

| Assertion | Why it matters |
|---|---|
| `OpenClaw version` for each phase | Images contain the intended packages |
| `OpenClaw config validate` | Resulting config is accepted explicitly |
| Gateway status and Control UI proxy | Controller and gateway boot correctly |
| Configured live smoke model | KiloCode model selection survived boot/upgrade |
| Kilo Chat plugin load | Packaged extension loads successfully |
| Kilo Chat diagnostics | New warnings/errors cannot remain invisible |
| Kilo Chat webhook semantic rejection | Live handler route is registered without side effects |
| Live Auto Free agent turn | Real Kilo Gateway compatibility and execution work |

## Docker Patch Investigation

OpenClaw bundles may change between releases. If an image build fails around a
minified bundle patch:

1. Obtain or inspect the intended OpenClaw package without exposing credentials.
2. Locate provider-specific markers and the exact behavior being patched.
3. Confirm whether the patch is still necessary or whether upstream added a stable
   production config/env setting.
4. Change the assertion to target the intended provider/behavior, not whichever
   generic text happens to match first.
5. Rebuild and rerun the persisted-root live smoke.

The KiloCode model discovery workaround patches KiloCode's own fetch timeout. An
environment variable that only wraps live-test provider catalog execution does not
replace that production fetch-level control.

## Diagnostics Policy

Inspect plugin diagnostics through `openclaw plugins inspect kilo-chat --json`.
Current smoke behavior may explicitly surface an acknowledged cosmetic warning, such
as missing optional `channelConfigs` metadata, while verifying runtime routing
separately. Do not expand the allowance without review:

- Fail on any unexpected warning or error.
- Include the exact accepted diagnostic and impact assessment in the PR.
- Prefer fixing actionable metadata rather than retaining a permanent allowance.

## Safe PR Evidence

A PR verification summary may include image tags, version checks, named assertions,
pass/fail totals, and known diagnostic text. While reviewing or modifying live smoke,
keep its controller port loopback-only and its default controller/proxy token randomly
generated. A PR summary must not include:

- API key or organization credential values.
- Controller/proxy or gateway tokens.
- Raw provider response bodies or failure logs from live credential runs.
- Sensitive prompts; use only generated nonce prompts in live smoke tests.
