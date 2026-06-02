---
name: kiloclaw-openclaw-upgrade
description: Upgrades the OpenClaw version packaged in KiloClaw images and validates safe live persisted-root replacement. Use when bumping OpenClaw, reviewing a KiloClaw OpenClaw upgrade PR, running packaged-image upgrade smoke tests, or investigating OpenClaw Dockerfile patches, plugin diagnostics, or compatibility changes.
---

# KiloClaw OpenClaw Upgrade

Use this workflow for any packaged OpenClaw version change under `services/kiloclaw`.
The smoke scripts are the executable source of truth; this skill governs release
preparation, investigation, and review decisions around them.

## First Reads

Before editing or reviewing, read:

- `AGENTS.md`
- `services/kiloclaw/AGENTS.md`
- `.specs/kiloclaw-controller.md`
- `services/kiloclaw/DEVELOPMENT.md` controller smoke section
- `reference/validation-checklist.md` in this skill

## Upgrade Workflow

1. Check `git status`, the PR branch/base, and existing PR review feedback. Do not
   disturb a dirty main worktree; use an isolated worktree or clean branch checkout.
2. Inspect `services/kiloclaw/Dockerfile`, bundled plugin `package.json` files,
   `pnpm-workspace.yaml`, and `pnpm-lock.yaml` before changing the pin.
3. Update the checked-in image pin and align bundled plugin compile-time/peer
   dependencies. Update lockfile, package-policy configuration if required by a
   deliberately validated release, runbook expectations, and user-facing changelog
   when the release is part of the change.
4. Build the candidate image. If a Dockerfile patch guard fails, inspect the new
   OpenClaw package artifact or source rather than loosening the guard blindly.
5. Run `bash services/kiloclaw/scripts/controller-openclaw-upgrade-smoke-test.sh`
   from a clean committed bump branch. It compares refreshed `origin/main` by
   default, or an intentionally justified `BASE_REF`, to committed `HEAD` and retains
   `/root` between image phases.
6. Run required final KiloClaw submission gates and review output, diagnostics, and
   PR documentation before making the PR ready.

## Required Upgrade Evidence

Require successful checks for:

- Installed OpenClaw before/after versions.
- Candidate existing-config startup through the controller's `openclaw doctor` path.
- `openclaw config validate --json` in each phase.
- Controller/gateway readiness and proxied Control UI HTML.
- Packaged Kilo Chat config, plugin load, diagnostics handling, and semantic live
  webhook probe.
- A real, non-sensitive agent turn through `kilocode/kilo-auto/free`.

## Investigation Rules

- Preserve the KiloCode model-discovery timeout mitigation unless OpenClaw exposes a
  production-supported configuration or environment override used by its inner
  KiloCode fetch. Do not confuse live-test outer catalog timeouts with production
  provider discovery configuration.
- Target Dockerfile bundle patches using provider-specific markers such as
  `KILOCODE_MODELS_URL`; do not patch a generic minified constant across providers.
- Treat newly surfaced `plugins inspect` or `doctor` diagnostics as findings. Do not
  infer that a warning is harmless solely because the gateway becomes ready.
- If the smoke allows a known cosmetic warning, surface it in output and fail any
  changed or additional diagnostic until reviewed.

## Security And Reporting

- Never print or post Kilo API keys, organization credentials, gateway/proxy tokens,
  raw provider responses, or credential-bearing container logs.
- Keep live smoke containers bound to loopback and generate a random controller/proxy
  token by default unless a deliberate override is required for a controlled run.
- Send only generated non-sensitive nonce prompts through Auto Free.
- In the PR, document the before/after versions, persisted-root live result, manual
  verification, known diagnostics with their impact, and any Docker patch adaptation.
- Keep live provider testing manual/opt-in unless credential and transient-free-model
  constraints are deliberately addressed for gating.
