# Security Report: Malicious Impersonation of Kilo Code

**Date:** 2026-03-30
**Repository:** `kilocode-agent/kilocode-2.0`
**Organization:** `kilocode-agent` (GitHub Organization, created 2026-03-13)
**Author behind commits:** `NETqPING`
**Status:** Active threat — repo is public with downloadable binaries

---

## Executive Summary

The GitHub repository `kilocode-agent/kilocode-2.0` is a **malicious impersonation** of Kilo Code that lures developers into downloading a pre-built executable (`.7z` archive) under the guise of "Kilocode 2.0". The source code in the repository is **stolen from the open-source project [OpenCode](https://github.com/anomalyco/opencode)** (an Electron desktop app), not from Kilo Code. The source code itself is a decoy — the actual threat is the **opaque 89 MB binary** distributed via GitHub Releases, whose contents cannot be verified from the source.

---

## Findings

### 1. Impersonation and Brand Abuse

- **Organization name:** `kilocode-agent` — clearly designed to impersonate Kilo Code.
- **Repository name:** `kilocode-2.0` — implies it is an official next-generation release.
- **README description:** "Kilocode 2.0: Ultimate autonomous AI coding agent & agentic assistant for VS Code."
- **SEO-optimized topics:** `kilocode`, `kilo-code`, `kilo-code-mcp`, `kilocode-cli`, `download-kilocode`, `install-kilocode`.
- **README claims:** Falsely states the repo is "proudly maintained by a community of open-source enthusiasts with the official support of the core Kilocode dev team."
- **Comparison table in README:** Directly compares "Official Kilocode" vs "Kilocode 2.0" to position the fake as superior.
- **None of this is affiliated with Kilo Code** (`github.com/kilocode`).

### 2. Source Code is Stolen from OpenCode, Not Kilo Code

The entire TypeScript source tree (`src/main/`, `src/preload/`, `src/renderer/`) is copied verbatim from the open-source [OpenCode desktop app](https://github.com/anomalyco/opencode) (132k+ stars, MIT license). Evidence:

- All internal identifiers reference "OpenCode": `APP_NAMES` maps to `"OpenCode"`, app IDs are `ai.opencode.desktop.*`.
- The Electron window title is `"OpenCode"` (`src/main/windows.ts`).
- The macOS menu says "OpenCode" (`src/main/menu.ts`).
- HTML pages have `<title>OpenCode</title>`.
- The help menu links to `opencode.ai/docs` and `discord.com/invite/opencode`.
- Imports reference `@opencode-ai/app` and `@opencode-ai/ui` packages.
- The deep-link protocol is `opencode://`.
- The CLI binary is named `opencode-cli`.
- The migration code references Tauri app IDs for `ai.opencode.desktop`.

**The source code has zero Kilo Code functionality.** It is an OpenCode Electron shell — not a VS Code extension, not related to Kilo Code in any way.

### 3. Suspicious Binary in GitHub Releases

This is the primary attack vector:

- **Release name:** "Install kilocode 2.0"
- **Asset:** `Kilocode_2_x64.7z` (93,614,057 bytes / ~89 MB)
- **Download count:** 6 downloads (as of investigation)
- **Tag:** `kilocode-agent`

The binary is an opaque `.7z` archive that **cannot be reproduced from the source code in the repository**. The source has no `package.json` in the root directory (returns 404), no build scripts, no `electron-builder` configuration, and no CI/CD pipeline. There is no way to build the source into the distributed binary.

**This means the binary could contain anything** — malware, a trojanized Electron app, credential stealers, reverse shells — and its contents have no verifiable relationship to the source code shown in the repository.

### 4. Social Engineering Tactics

The README is specifically crafted to convince developers to download the binary:

- Claims features that don't exist in the source ("Smart Loop Breaker", "Live Budget Dashboard", "File Freezing") — these are marketing copy to drive downloads.
- Instructs users to download `.exe` and `.dmg` files from the Releases page.
- Uses urgent/competitive language: "Why switch?" and positions itself as better than the real product.
- Created a `LoopBreaker.ts` file then deleted it in a later commit (commit `bbba6b3` followed by `269e811`), suggesting the attacker initially tried to add legitimacy to the feature claims.

### 5. Repo Metadata Anomalies

- **Organization created:** 2026-03-13 (same day as all commits).
- **All 7 commits made within ~1 hour** on 2026-03-13 by a single author (`NETqPING`).
- **No package.json** — the repository cannot be installed or built.
- **No CI/CD** — no GitHub Actions, no build verification.
- **`.gitignore` is for AL (Dynamics 365 Business Central)** — completely unrelated to Node.js/Electron, suggesting copy-paste from a template.
- **License claims copyright by "kilocode-agent"** but the actual code is OpenCode (MIT, copyright Anomaly).
- **Only 1 star, 0 forks** — no organic community.

---

## Attack Chain

1. Developer searches for "Kilo Code" or related terms on GitHub.
2. SEO-optimized topics and name cause `kilocode-agent/kilocode-2.0` to appear in results.
3. Professional-looking README with feature comparisons convinces the user this is a legitimate enhanced version.
4. User downloads `Kilocode_2_x64.7z` from the Releases page.
5. User extracts and runs the executable, potentially compromising their system.

---

## Recommendations

1. **Report the repository** to GitHub for impersonation/brand abuse and malware distribution.
2. **Report the organization** `kilocode-agent` for trademark infringement.
3. **Warn users** via official Kilo Code channels that this is not an affiliated project.
4. **Request binary analysis** — the `Kilocode_2_x64.7z` file should be submitted to VirusTotal and analyzed in a sandbox to determine its actual payload.
5. **Consider filing a DMCA takedown** for the misuse of the Kilo Code brand name.

---

## Files Examined (via GitHub API, no code was cloned)

| File | Assessment |
|------|-----------|
| `README.md` | Impersonation copy with fake feature claims |
| `LICENSE` | False copyright attribution to "kilocode-agent" |
| `.gitignore` | Unrelated template (Dynamics 365 Business Central) |
| `src/main/index.ts` | OpenCode Electron main process (verbatim copy) |
| `src/main/server.ts` | OpenCode sidecar server management |
| `src/main/cli.ts` | OpenCode CLI spawning and management |
| `src/main/ipc.ts` | OpenCode IPC handlers |
| `src/main/store.ts` | OpenCode electron-store wrapper |
| `src/main/windows.ts` | OpenCode window creation (title: "OpenCode") |
| `src/main/menu.ts` | OpenCode macOS menu (links to opencode.ai) |
| `src/main/constants.ts` | OpenCode channel/store constants |
| `src/main/apps.ts` | OpenCode app path resolution |
| `src/main/logging.ts` | OpenCode logging setup |
| `src/main/markdown.ts` | OpenCode markdown parsing |
| `src/main/migrate.ts` | OpenCode Tauri migration code |
| `src/preload/index.ts` | OpenCode context bridge |
| `src/preload/types.ts` | OpenCode Electron API types |
| `src/renderer/index.tsx` | OpenCode SolidJS renderer entry |
| `src/renderer/loading.tsx` | OpenCode loading screen |
| `src/renderer/updater.ts` | OpenCode auto-updater |
| `src/renderer/cli.ts` | OpenCode CLI installer UI |
| `src/renderer/webview-zoom.ts` | OpenCode zoom handler |
| `src/renderer/i18n/index.ts` | OpenCode i18n with `@opencode-ai/*` imports |
| `src/renderer/env.d.ts` | OpenCode global window type declarations |
| `src/renderer/index.html` | HTML with `<title>OpenCode</title>` |
| `src/renderer/loading.html` | HTML with `<title>OpenCode</title>` |
| **GitHub Release** | `Kilocode_2_x64.7z` (89 MB) — **unverifiable binary** |
