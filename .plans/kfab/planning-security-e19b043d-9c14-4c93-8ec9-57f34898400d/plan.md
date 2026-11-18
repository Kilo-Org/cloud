<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Raise the body-parser override to 2.4.0 to fix the compressed-body crash advisory (GHSA-27R3-JXMH-P828)

## Problem

Dependabot reports body-parser (high severity, CVE-2026-111181 / GHSA-27R3-JXMH-P828, vulnerable range >=2.0.0 <2.4.0) in pnpm-lock.yaml. The bug: a compressed request body followed by extra trailing bytes can raise an uncaught exception and crash the process. At the pinned commit, pnpm-workspace.yaml has a workspace-wide override `body-parser: 2.3.0` (line 245). Because of it, pnpm-lock.yaml lists `body-parser: 2.3.0` in its overrides section and has one installed copy, `body-parser@2.3.0`. That version is in the vulnerable range. No workspace package.json declares body-parser directly. It comes in through Express 5 consumers such as the MCP SDK, OpenClaw and web-ext tooling.

## Evidence

- pnpm-workspace.yaml:245 has the override `body-parser: 2.3.0`. pnpm-lock.yaml:184 lists the same override, and the only package entry is `body-parser@2.3.0` (lines 13044 and 33452).
- Searching all package.json files for "body-parser" found nothing, so it is only a transitive dependency, pinned by the override.
- pnpm-workspace.yaml:69 sets `minimumReleaseAge: 6842` (minutes). The `qs: 6.16.0` override is also in pnpm-workspace.yaml.
- Repository history: open PR #8990 (2026-10-28), '(janitor/dependencies): patch body-parser and qs vulnerabilities'. It reports that body-parser 2.4.0 was published 2026-10-22 and is now past the release-age window. It also reports that 2.4.0 declares qs ^6.16.1 and pulls content-type 2.1.0 and iconv-lite 0.7.3. It raises the qs override 6.16.0 → 6.16.1. PR #8890 deferred this same alert only because of the release-age window.

## Desired outcome

The resolved dependency graph has only body-parser 2.4.0. There is no copy in the >=2.0.0 <2.4.0 range, and the release-age policy and the other overrides stay the same.

## Scope

- Change the `body-parser` override in pnpm-workspace.yaml from 2.3.0 to 2.4.0.
- Raise the existing `qs` override from 6.16.0 to the lowest version that satisfies body-parser 2.4.0's declared qs range and clears the release-age window (expected 6.16.1), only if pnpm install shows the current pin breaks resolution. The pin has to move to get a fixed graph.
- Regenerate pnpm-lock.yaml with the pinned pnpm version (`pnpm install --lockfile-only`), with no hand edits. New transitive entries that body-parser 2.4.0 itself requires (for example content-type, iconv-lite) are accepted.

## Exclusions

- Other open alerts (fast-uri, ts-deepmerge, node-forge) and unrelated upgrades or override changes.
- Changes to minimumReleaseAge or its exclusions, or suppressing or dismissing the finding.
- Application code changes, including the `inflate: false` workaround. The version upgrade fixes the issue.
- body-parser 1.x (1.20.9). No 1.x copy is in the tree.

## Approach

- Edit pnpm-workspace.yaml: `body-parser: 2.3.0` → `body-parser: 2.4.0`, keeping its position and the surrounding comments.
- Run `pnpm install --lockfile-only` with the packageManager-pinned pnpm. If resolution fails or reports qs outside body-parser 2.4.0's range, raise only the `qs` override to the lowest qualifying patch (6.16.1) and regenerate.
- Check that the lockfile diff only touches body-parser, qs (if bumped), and body-parser 2.4.0's new transitive dependencies. Check that `pnpm why -r body-parser` lists only 2.4.0.
- Before opening a PR, check whether PR #8990 has already merged the same change. If it has, the work is already done and no duplicate PR should be published.

## Affected areas

- pnpm-workspace.yaml (overrides: body-parser, possibly qs)
- pnpm-lock.yaml

## Acceptance criteria

### ac-1: pnpm-workspace.yaml overrides body-parser to exactly 2.4.0. pnpm-lock.yaml's overrides section and package entries list only body-parser@2.4.0, with no body-parser copy in >=2.0.0 <2.4.0.

**Verification:** Source review

### ac-2: The lockfile diff only touches body-parser, qs if body-parser 2.4.0's declared range requires it (set to the lowest qualifying patch), and transitive packages that body-parser 2.4.0 newly requires. minimumReleaseAge, its exclusions, patches and all other overrides are unchanged.

**Verification:** Code review

### ac-3: The regenerated lockfile installs as-is with the pinned pnpm (`pnpm install --frozen-lockfile` succeeds), so the override and lockfile agree.

**Verification:** Manual: run `pnpm install --frozen-lockfile` with the packageManager-pinned pnpm and confirm success, plus `pnpm why -r body-parser` showing only 2.4.0

## Risks

- Open PR #8990 makes the same change. Publishing in parallel would duplicate it and conflict in the lockfile, so check its status first.
- body-parser 2.4.0 is a minor bump inside Express 5's major. It also pulls newer content-type and iconv-lite, which carries a small risk of request-parsing behavior changes in Express-based tooling.

## Assumptions

- body-parser 2.4.0 is past the 6842-minute release-age window. PR #8990 reports a 2026-10-22 publish date, and today is 2026-10-28.
- The installed version listed as 'unknown' in the finding is 2.3.0, based on the pinned lockfile.

## Decisions

### d-1: Fix by moving the existing workspace override instead of adding direct dependencies or changing owning packages.

**Answer:** Yes. body-parser is only transitive and is pinned by a global override, so moving the override is the smallest change that fixes the graph.

**Blocking:** no

### d-2: Allow a qs override bump as part of this fix.

**Answer:** Only if required: body-parser 2.4.0's declared qs range has to be met for a fixed graph, which the remediation scope allows. Use the lowest qualifying patch.

**Blocking:** no
