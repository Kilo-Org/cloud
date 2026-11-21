<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Bump pnpm joi override from 17.13.8 to 17.13.9 to fix the email({ multiple: true }) ReDoS

## Problem

Dependabot reports a high-severity advisory (GHSA-4528-X5FX-H6HG / CVE-2026-118772) for joi >= 17.1.1, < 17.13.9: when `string().email({ multiple: true })` is used, splitting the value takes quadratic time, which allows a denial of service. In the pinned checkout, joi is a transitive-only dependency. No workspace package.json declares it. `pnpm-workspace.yaml` forces it through the override `joi: 17.13.8`, and `pnpm-lock.yaml` resolves exactly one copy, joi@17.13.8, which is in the vulnerable range.

## Evidence

- pnpm-workspace.yaml line 241 in the overrides block has `joi: 17.13.8`.
- pnpm-lock.yaml line 178 (overrides section) has `joi: 17.13.8`. The package and snapshot entries `joi@17.13.8:` are at lines 16828 and 38546. Five dependent snapshot entries reference `joi: 17.13.8` (lines 24850, 24862, 25372, 34817, 44676). No other joi version is resolved.
- A repo-wide search finds no direct `"joi"` dependency in any package.json.
- History: PR #7189 bumped this same override from 17.13.7 to 17.13.8, and PRs #7042 and #5935 made earlier joi override bumps. This is the repo's established remediation pattern.
- pnpm-workspace.yaml sets `minimumReleaseAge: 6842` (minutes) and has an explicit `minimumReleaseAgeExclude` list.

## Desired outcome

The dependency graph resolves joi only at 17.13.9, the provider-declared fixed version. No copy of joi in the range >= 17.1.1, < 17.13.9 remains in pnpm-lock.yaml. No other package versions change.

## Scope

- Change the `joi` override in pnpm-workspace.yaml from 17.13.8 to 17.13.9.
- Regenerate pnpm-lock.yaml with the repository's pinned pnpm version so the overrides section, the joi package and snapshot entries, and the five dependent snapshot references all point to 17.13.9.

## Exclusions

- No other dependency upgrades, override changes, or lockfile churn beyond what the joi bump requires.
- No application code changes. joi is transitive-only and 17.13.9 is a patch release.
- No suppression or dismissal of the finding.
- No new minimumReleaseAgeExclude entry unless an operator explicitly approves one (see risks).

## Approach

- Edit pnpm-workspace.yaml: change `joi: 17.13.8` to `joi: 17.13.9`. Keep it exact-pinned like the neighbouring overrides.
- Run `pnpm install --lockfile-only` with the pnpm version from the root package.json `packageManager` field to regenerate pnpm-lock.yaml.
- Review the lockfile diff. Expected changes are limited to the joi override line, the `joi@17.13.9` package and snapshot entries (including the integrity hash), and the dependent `joi:` references. If joi 17.13.9 changes its @hapi/* or @sideway/* sub-dependency versions, the matching entries may also change. Revert any unrelated churn.
- Confirm with `pnpm install --frozen-lockfile --ignore-scripts` that the lockfile is consistent.

## Affected areas

- pnpm-workspace.yaml (overrides block)
- pnpm-lock.yaml

## Acceptance criteria

### ac-1: pnpm-workspace.yaml overrides pin `joi: 17.13.9`, and no other override entry changes.

**Verification:** Source review

### ac-2: pnpm-lock.yaml resolves joi only as joi@17.13.9: the overrides section, package entry, snapshot entry, and every dependent `joi:` reference. No `joi@17.13.8` or any other joi version below 17.13.9 remains.

**Verification:** Source review

### ac-3: The lockfile diff contains no version changes for packages other than joi and any sub-dependencies that joi 17.13.9 itself requires.

**Verification:** Code review

## Risks

- minimumReleaseAge (6842 minutes, about 4.75 days): if joi 17.13.9 was published too recently, pnpm will refuse to resolve it. Earlier remediations met this requirement without adding exclusions. If this one cannot, the implementer must stop and ask an operator whether to add a temporary `joi@17.13.9` exclusion instead of choosing a different version.
- Low runtime risk: this is a patch release within 17.x, and the only behaviour change is the linear split regex for email({ multiple: true }).

## Assumptions

- Five snapshot entries depend on joi. pnpm-lock.yaml is too large for the research read tool, so they were located by search rather than read in full. They follow the override, so no direct dependency needs updating.
- joi 17.13.9 is published on the npm registry, as stated in the advisory's fixed version.

## Decisions

### d-1: Remediate through the existing pnpm override rather than upgrading the packages that own joi.

**Answer:** Yes. The existing exact override already controls every joi copy, and earlier joi fixes (#7189, #7042, #5935) used the same mechanism.

**Blocking:** no
