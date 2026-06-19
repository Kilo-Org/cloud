# KiloClaw image tests

Host-side dev/test scripts. They build and/or run a KiloClaw Docker image and
assert behavior from the outside — none of them ship in the image, run at
container runtime, or run in CI. Run them locally.

## OpenClaw upgrade validation (`openclaw-upgrade-*`)

Validate an OpenClaw version bump before merging the bump PR.

**Run this one:**

```bash
export KILOCODE_API_KEY=<dedicated free-model key>   # for the live smoke; from app.kilo.ai/profile
bash services/kiloclaw/scripts/tests/openclaw-upgrade-validate.sh
```

It runs a preflight (Docker, bump branch, clean tree, grype, credential) then:

| Script | What it checks | Key? |
|---|---|---|
| `openclaw-upgrade-validate.sh` | **entry point** — orchestrates the two below | — |
| `openclaw-upgrade-image-checks.sh` | the built image: version, bundle patches, plugin pins, config schema, grype CVE scan | no |
| `openclaw-upgrade-smoke.sh` | the live upgrade: baseline → candidate on the same `/root`, plus a real gateway turn | yes |

Notes: run from a **clean committed bump branch** (the validator refuses a dirty
tree; `ALLOW_DIRTY_TREE=true` runs but can't report a clean result). `grype` is
optional (`brew install grype`). OpenClaw is intentionally never built or run in
CI — it's a security-sensitive upstream, so this gate is human-run.

## Single-image smoke tests (`smoke-*`)

Test one already-built `kiloclaw:controller` image.

| Script | What it tests |
|---|---|
| `smoke-controller.sh` | controller HTTP endpoints, auth, env patching |
| `smoke-entrypoint.sh` | full startup: bootstrap → doctor → config patch → gateway |
| `smoke-proxy-auth.sh` | proxy-token enforcement |
| `smoke-live-provider.sh` | one image vs the real Kilo Gateway (the engine `openclaw-upgrade-smoke` reuses with `--upgrade`) |

## Shared

- `smoke-helpers.sh` — shared assertions (kilo-chat, app config-write, exec-approvals).
- `provider-creds.sh` — active-provider Kilo CLI credential lookup, shared so the
  validator and the live smoke agree on whether a key is available.
