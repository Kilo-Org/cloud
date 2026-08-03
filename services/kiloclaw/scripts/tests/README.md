# KiloClaw image tests

Host-side dev/test scripts. They build and/or run a KiloClaw Docker image and
assert behavior from the outside — none of them ship in the image, run at
container runtime, or run in CI. Run them locally.

## Which script do I run?

> **Validating an OpenClaw version bump? Run `openclaw-upgrade-validate.sh`.**
> It is the only script at the top level, and it orchestrates everything else.
> You should not need to run anything in `upgrade/` yourself.

```
tests/
├── openclaw-upgrade-validate.sh   ← ENTRY POINT. Run this for a bump.
├── upgrade/                       ← its two phases (called by the entry point)
│   ├── image-checks.sh              phase 1 — keyless
│   └── smoke.sh                     phase 2 — credentialed live upgrade
├── single-image/                  ← standalone smokes for one already-built image
│   ├── controller.sh
│   ├── entrypoint.sh
│   ├── proxy-auth.sh
│   └── live-provider.sh
└── lib/                           ← sourced libraries, not runnable
    ├── helpers.sh
    └── provider-creds.sh
```

The **executable bit means one thing**: a human runs this file directly. So
`openclaw-upgrade-validate.sh` and everything in `single-image/` are executable;
`upgrade/` phases and `lib/` are not. If it is not executable, it is not an
entry point.

## OpenClaw upgrade validation

Validate an OpenClaw version bump before merging the bump PR.

**Run this one:**

```bash
export KILOCODE_API_KEY=<key on an account with credits>   # for the live smoke; from app.kilo.ai/profile
export KILOCODE_ORGANIZATION_ID=<org id>             # REQUIRED if the key is a personal key in an org
bash services/kiloclaw/scripts/tests/openclaw-upgrade-validate.sh
```

> **Credits.** A personal Kilo token spends **personal** credits. If your account
> is in an organization and you want the org's credits, `KILOCODE_ORGANIZATION_ID`
> must be set — the token alone does not carry org scope. Note that exporting
> `KILOCODE_API_KEY` (the line above) means the smoke can no longer read the org id
> out of your Kilo CLI config the way it does for a CLI-sourced token, so set it
> explicitly. Get it wrong and the live turn fails with `402 Add credits to
> continue`, which reads as a broken image rather than a credential problem. The
> smoke now preflights this and refuses to run rather than let you debug the wrong
> thing.
>
> Note that a websocket `1008` close on the live turn is a *different* problem and
> not a credential one: it is OpenClaw's own in-container gateway refusing the
> CLI's device scope upgrade (`operator.read` to `operator.write`) with
> `pairing required`. The smoke now prints the close reason so the two are not
> confused.

It runs a preflight (Docker, bump branch, clean tree, grype, credential) then:

| Script | What it checks | Key? |
|---|---|---|
| `openclaw-upgrade-validate.sh` | **entry point** — orchestrates the two below | — |
| `upgrade/image-checks.sh` | the built image: version, bundle patches, plugin pins, config schema, hook boot-validation parity, grype CVE scan | no |
| `upgrade/smoke.sh` | the live upgrade: baseline → candidate on the same `/root`, plus a real gateway turn and hook config self-heal | yes |

### Hook boot-validation parity

`upgrade/image-checks.sh` asserts that the set of conditions OpenClaw
refuses to start the gateway on — the `throw`s in its `resolveHooksConfig` — is
exactly the set the controller mirrors in `hookConfigBootViolation` /
`ensureBootableHookConfig` (`controller/src/config-writer.ts`).

This exists because nothing else catches drift here. Those failures are raised
at **gateway startup**, so neither `openclaw config validate` (schema-only) nor
`openclaw doctor` sees them, and a config that trips one crash-loops the
instance with no self-recovery. If OpenClaw adds or rewords a condition, this
check fails on the bump PR with a diff; update the mirror **and its tests**,
then update the expected list in the script.

The live smoke covers the other half: `assert_hook_config_self_heal` plants an
unbootable config in the persisted root, restarts the gateway, and asserts the
controller repaired it and came back up rather than crash-looping.

Notes: run from a **clean committed bump branch** (the validator refuses a dirty
tree; `ALLOW_DIRTY_TREE=true` runs but can't report a clean result). `grype` is
optional (`brew install grype`). OpenClaw is intentionally never built or run in
CI — it's a security-sensitive upstream, so this gate is human-run.

## Single-image smoke tests (`single-image/`)

Test one already-built `kiloclaw:controller` image.

| Script | What it tests |
|---|---|
| `single-image/controller.sh` | controller HTTP endpoints, auth, env patching |
| `single-image/entrypoint.sh` | full startup: bootstrap → doctor → config patch → gateway |
| `single-image/proxy-auth.sh` | proxy-token enforcement |
| `single-image/live-provider.sh` | one image vs the real Kilo Gateway (the engine `upgrade/smoke.sh` reuses with `--upgrade`) |

## Shared (`lib/`, sourced — not runnable)

- `lib/helpers.sh` — shared assertions (kilo-chat, app config-write, exec-approvals).
- `lib/provider-creds.sh` — active-provider Kilo CLI credential lookup, shared so the
  validator and the live smoke agree on whether a key is available.
