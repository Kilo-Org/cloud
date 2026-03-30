# Security Analysis: kilocode-agent/kilocode-2.0

**Date:** 2026-03-30
**Repository:** https://github.com/kilocode-agent/kilocode-2.0
**Method:** Remote inspection via GitHub API only (no code cloned or executed)

---

## Verdict: MALICIOUS — Trojanized Impersonation of OpenCode Desktop

This repository is a **social-engineering trap** that impersonates Kilocode but actually distributes a **pre-compiled, opaque Windows binary** (`Kilocode_2_x64.7z`, 89 MB) via GitHub Releases. The source code in the repo is stolen from the legitimate [OpenCode](https://github.com/anomalyco/opencode) Electron desktop app and is **not what the binary was built from** — it serves purely as window dressing to make the repo look credible.

---

## Key Findings

### 1. Distributed Binary Has No Verifiable Build Pipeline

- The release asset `Kilocode_2_x64.7z` (89 MB, SHA-256: `91c7f94852b8538a75c77624ee12b3a6026ff9208fd1eff2fb709b630237e251`) was manually uploaded.
- There are **zero GitHub Actions workflows** in the repository — no CI/CD, no build pipeline.
- There is **no `package.json`**, no `electron-builder` config, no `electron-forge` config, no `tsconfig.json`, no build tooling of any kind.
- The binary **cannot have been built from this source code**. It is an opaque, pre-compiled artifact of unknown provenance.
- The 7z archive targets Windows x64 only. The README also advertises a macOS `.dmg` that does not exist in releases.

### 2. Source Code Is Stolen from OpenCode Desktop (Laundering)

Every source file in the repo belongs to the **OpenCode** project (by Anomaly/SST):
- All imports reference `@opencode-ai/app`, `@opencode-ai/ui`, etc.
- The menu bar says "OpenCode", links to `https://opencode.ai/docs` and `https://discord.com/invite/opencode`.
- Bug report links point to `https://github.com/anomalyco/opencode/issues`.
- The app ID is `ai.opencode.desktop`, the protocol handler is `opencode://`.
- The CLI binary is named `opencode-cli` and installs to `~/.opencode/bin/opencode`.

The README has been rewritten to say "Kilocode 2.0" and falsely claims features like "Smart Loop Breaker", "File Freezing", "Live Budget Dashboard", etc. None of these features exist in the source code present in the repo.

### 3. Suspicious Account and Organization

| Entity | Details |
|---|---|
| **Org** `kilocode-agent` | Created **2026-03-13**, has exactly 1 repo, no description, no website |
| **User** `nNETqPINGm7` | Created 2025-09-22, zero public repos, bio: "NETqPING", sole release uploader |
| **Repo** | Created 2026-03-13, all activity on a single day |

### 4. Commit History Is Suspicious

The entire commit history consists of 6 commits, all on the same day:
1. `Initial commit`
2. `kilocode-2.0` (bulk code dump)
3. `Update README.md` (x2)
4. `Create LoopBreaker.ts` (now deleted)
5. `Delete core directory` (cleaning up evidence of modification)

The "Delete core directory" commit suggests files were added and then removed — possibly experimental malware code that was cleaned up before the final push.

### 5. No Malicious Patterns in the Source Code Itself

After reviewing **all 27 files** in the repository, the TypeScript/TSX source code does **not** contain:
- Obfuscated strings, `eval()`, `Function()` constructor abuse
- Exfiltration of env vars, tokens, or credentials
- Suspicious URLs or IP addresses (beyond legitimate `opencode.ai` references)
- Reverse shells or backdoors
- Encoded payloads

This is consistent with the assessment that the source is legitimate OpenCode code used as a decoy. **The threat is the binary, not the source.**

### 6. SEO-Optimized for Discoverability

The repo uses topics specifically designed to intercept searches for Kilocode:
- `kilocode`, `kilo-code`, `kilocode-cli`, `kilo-code-mcp`, `download-kilocode`, `install-kilocode`

---

## Attack Vector

1. User searches GitHub for "kilocode" or "kilocode 2.0"
2. Finds this repository with a professional-looking README and familiar-sounding feature list
3. Follows the "Installation" section to the Releases page
4. Downloads and runs `Kilocode_2_x64.7z` — an opaque binary of unknown origin
5. The binary executes with full desktop privileges on the user's machine

This is a classic **trojanized software supply chain attack** using brand impersonation.

---

## Recommendations

1. **Do NOT download or execute** the release binary from this repository
2. **Report the repository** to GitHub for impersonation and potential malware distribution
3. **Report the organization** `kilocode-agent` as fraudulent
4. If anyone has already run the binary: assume compromise, rotate all credentials, scan the system
5. The real Kilocode project is at https://github.com/nicepkg/kilocode (VS Code extension, not a desktop app)

---

## Files Reviewed

All 27 files in the repository were inspected via `gh api` content decoding:

**src/main/**: `index.ts`, `server.ts`, `ipc.ts`, `cli.ts`, `apps.ts`, `constants.ts`, `migrate.ts`, `windows.ts`, `store.ts`, `logging.ts`, `menu.ts`, `markdown.ts`, `env.d.ts`

**src/preload/**: `index.ts`, `types.ts`

**src/renderer/**: `index.tsx`, `index.html`, `loading.html`, `loading.tsx`, `cli.ts`, `updater.ts`, `webview-zoom.ts`, `env.d.ts`, `styles.css`

**src/renderer/i18n/**: `index.ts`, `en.ts`, `ar.ts`, `br.ts`, `bs.ts`, `da.ts`, `de.ts`, `es.ts`, `fr.ts`, `ja.ts`, `ko.ts`, `no.ts`, `pl.ts`, `ru.ts`, `zh.ts`, `zht.ts`

**Root**: `.gitignore`, `LICENSE`, `README.md`

**Assets**: `kilocode.png`, `kilocode-releases.png`
