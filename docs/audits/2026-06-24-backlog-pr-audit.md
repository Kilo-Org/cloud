# Cloud Backlog and PR Integrity Audit Report

## 1. Scope and timestamp

| Field | Value |
|---|---|
| Repository | [Kilo-Org/cloud](https://github.com/Kilo-Org/cloud) |
| Audit date | 2026-06-24 |
| Scope | All open GitHub issues and all open pull requests at audit time |
| Open issues | 284 |
| Open pull requests | 64 |
| Total open items | 348 |

This report consolidates three prior analyses into a single actionable document. No GitHub mutations were performed.

## 2. Methodology and definitions

### Data sources

- GitHub issue/PR metadata, titles, bodies, labels, comments, reviews, and check status obtained via the GitHub API (`gh`).
- Diffs and changed-file lists for substantive pull requests.
- No local repository source code was executed or altered for the audit itself.

### Definitions

| Term | Definition |
|---|---|
| Proven duplicate issue | Issues with identical or near-identical titles and bodies, or body-token similarity ≥ 0.60, indicating a shared root cause and materially equivalent desired outcome. |
| Symptom cluster | Issues sharing broad keywords and body-token similarity ≥ 0.30. These are **not** claimed as proven duplicates. |
| Substantive PR | A feature/fix PR with more than 8 changed files or a large diff. Routine version bumps and dependency updates are excluded. |
| Issue-less PR | A substantive PR with no linked tracking issue. |
| Duplicate/competing PR | PRs with identical titles (ignoring version numbers) or strong title similarity plus ≥ 50% changed-file overlap. |
| Substantive human validation | A human-authored review (APPROVED / CHANGES_REQUESTED / COMMENTED with content) or a human comment that engages with the change, excluding stale-bot warnings and meta questions. |
| Automation indicator | Bot authorship, bot-only reviews, `Co-Authored-By` automation lines, or self-reported refinery markers. These are indicators, not proof of low quality. |

### Confidence levels

| Level | Meaning |
|---|---|
| High | Objective structural evidence (identical titles, > 0.60 body similarity, > 50% file overlap, or direct code concern). |
| Medium | Strong pattern match requiring human confirmation before action. |
| Low | Routine or low-risk item; documented for completeness. |

## 3. Reconciled counts

| Category | Count |
|---|---|
| Open issues | 284 |
| Open pull requests | 64 |
| High-confidence duplicate issue groups | 10 groups (21 issues) |
| Open issues already labeled `kilo-duplicate` | 6 |
| PRs referencing open issues without a closing keyword | 0 |
| Substantive issue-less PRs | 36 |
| Duplicate/competing PR groups | 2 groups (3 PRs) |
| Medium-confidence symptom clusters | 5 clusters (16 issues) |
| Bot-authored open PRs | 14 |
| Open PRs with no substantive human validation | 45 |

## 4. Duplicate open issues (high confidence)

Each row states a **proven** duplicate relationship based on title/body identity or ≥ 0.60 body-token similarity. The recommended action is to close the duplicate(s) in favor of the canonical issue.

| Group | Canonical issue | Duplicate(s) | Evidence | Confidence | Recommended action |
|---|---|---|---|---|---|
| 1 | [#4186](https://github.com/Kilo-Org/cloud/issues/4186) [Gastown] Update: patrol triage role mismatch loop is unfixable from mayor side + self-feeding on escalations | [#4187](https://github.com/Kilo-Org/cloud/issues/4187) | Identical title; consolidated group of 2 with shared rig/symptom/outcome and pairwise body similarity ≥ 0.60. | High | Close #4187 as duplicate of #4186. |
| 2 | [#4147](https://github.com/Kilo-Org/cloud/issues/4147) [Gastown] Triage dispatch loop: patrol creates triage beads for non-triage-role poles, infinite retry with no back-off | [#4148](https://github.com/Kilo-Org/cloud/issues/4148) | Identical title; consolidated group of 2 with shared rig/symptom/outcome and pairwise body similarity ≥ 0.60. | High | Close #4148 as duplicate of #4147. |
| 3 | [#2019](https://github.com/Kilo-Org/cloud/issues/2019) [Gastown] Create PRs at start of refinery step with full review status visibility | [#2020](https://github.com/Kilo-Org/cloud/issues/2020) | Identical title; consolidated group of 2 with shared rig/symptom/outcome and pairwise body similarity ≥ 0.60. | High | Close #2020 as duplicate of #2019. |
| 4 | [#2016](https://github.com/Kilo-Org/cloud/issues/2016) [Gastown] Feature request: Allow custom Docker image mount for agents | [#2017](https://github.com/Kilo-Org/cloud/issues/2017) | Identical title; consolidated group of 2 with shared rig/symptom/outcome and pairwise body similarity ≥ 0.60. | High | Close #2017 as duplicate of #2016. |
| 5 | [#2014](https://github.com/Kilo-Org/cloud/issues/2014) [Gastown] Convoy dependency enforcement bypassed: beads dispatched despite failed merge requests | [#2015](https://github.com/Kilo-Org/cloud/issues/2015) | Identical title; consolidated group of 2 with shared rig/symptom/outcome and pairwise body similarity ≥ 0.60. | High | Close #2015 as duplicate of #2014. |
| 6 | [#2004](https://github.com/Kilo-Org/cloud/issues/2004) [Gastown] Dispatch system stalled - all agents idle despite open beads in active convoys | [#2005](https://github.com/Kilo-Org/cloud/issues/2005) | Identical title; consolidated group of 2 with shared rig/symptom/outcome and pairwise body similarity ≥ 0.60. | High | Close #2005 as duplicate of #2004. |
| 7 | [#1980](https://github.com/Kilo-Org/cloud/issues/1980) [Gastown] Phantom escalation loop: "Duplicated code in VoiceJoin handler" fires repeatedly with no valid escalation ID | [#1981](https://github.com/Kilo-Org/cloud/issues/1981) | Identical title; consolidated group of 2 with shared rig/symptom/outcome and pairwise body similarity ≥ 0.60. | High | Close #1981 as duplicate of #1980. |
| 8 | [#1882](https://github.com/Kilo-Org/cloud/issues/1882) [Gastown] Recurring GitHub token expiration blocking git push on rig ef798611 (thegent-shm) | [#1883](https://github.com/Kilo-Org/cloud/issues/1883) | Identical title; consolidated group of 2 with shared rig/symptom/outcome and pairwise body similarity ≥ 0.60. | High | Close #1883 as duplicate of #1882. |
| 9 | [#1807](https://github.com/Kilo-Org/cloud/issues/1807) [Gastown] Polecat agents get 403 permission error when resolving triage requests | [#1808](https://github.com/Kilo-Org/cloud/issues/1808) | Identical title; consolidated group of 2 with shared rig/symptom/outcome and pairwise body similarity ≥ 0.60. | High | Close #1808 as duplicate of #1807. |
| 10 | [#1961](https://github.com/Kilo-Org/cloud/issues/1961) [Gastown] Critical infinite loop: Polecat agent continuously dispatched to triage | [#1962](https://github.com/Kilo-Org/cloud/issues/1962), [#1963](https://github.com/Kilo-Org/cloud/issues/1963) | Consolidated group of 3 with shared rig/symptom/outcome and pairwise body similarity ≥ 0.60. | High | Close #1962 and #1963 as duplicates of #1961. |

## 5. Missing issue-PR relationships

### 5.1 PRs referencing open issues without a closing keyword

No open PRs were found that reference an open issue without an explicit closing keyword. The only PRs with issue links use closing keywords:

- [#4137](https://github.com/Kilo-Org/cloud/pull/4137) closes [#4136](https://github.com/Kilo-Org/cloud/issues/4136).
- [#1432](https://github.com/Kilo-Org/cloud/pull/1432) closes [#1297](https://github.com/Kilo-Org/cloud/issues/1297).

### 5.2 Substantive PRs without a tracking issue

The following 36 PRs are substantive feature or fix work with no linked issue. These are **recommendations** to create a tracking issue or document why none is needed.

| PR | Title | Author | Files | Approx. line changes | Evidence | Confidence | Recommended action |
|---|---|---|---|---|---|---|---|
| [#4220](https://github.com/Kilo-Org/cloud/pull/4220) | feat(coding-plans): expose managed plan usage | Human | 9 | +666 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#4218](https://github.com/Kilo-Org/cloud/pull/4218) | Bitbucket - Add Bitbucket Integration | Human | 105 | +39,150 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#4211](https://github.com/Kilo-Org/cloud/pull/4211) | feat(api): add usage email filters and members endpoint | Human | 11 | +1,208 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#4206](https://github.com/Kilo-Org/cloud/pull/4206) | feat(usage): add ask usage | Human | 72 | +37,872 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#4199](https://github.com/Kilo-Org/cloud/pull/4199) | fix(cloud-agent-next): persist kilo import diagnostics | Bot | 13 | +789 | Substantive fix PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#4197](https://github.com/Kilo-Org/cloud/pull/4197) | feat(headroom): add compress worker | Human | 21 | +1,834 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#4168](https://github.com/Kilo-Org/cloud/pull/4168) | feat(mcp): add native /mcp for cost control | Human | 39 | +36,198 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#4164](https://github.com/Kilo-Org/cloud/pull/4164) | feat(extension): add browser agent side panel | Human | 100 | +16,158 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#4134](https://github.com/Kilo-Org/cloud/pull/4134) | feat(mcp-gateway): durable per-client OAuth grants and Authorized Clients UI | Human | 172 | +8,983 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#4133](https://github.com/Kilo-Org/cloud/pull/4133) | chore(dev): cloud reviews local testing E2E | Human | 20 | +1,528 | Substantive tooling PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#4056](https://github.com/Kilo-Org/cloud/pull/4056) | feat(ai-gateway): add organization auto model routing | Human | 42 | +5,004 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#4035](https://github.com/Kilo-Org/cloud/pull/4035) | feat: AgentCard OAuth integration + agent skill | Human | 33 | +34,050 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#4005](https://github.com/Kilo-Org/cloud/pull/4005) | feat(auto-routing): Morph model router decisions for kilo-auto tiers | Human | 15 | +1,130 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3980](https://github.com/Kilo-Org/cloud/pull/3980) | Cloud Agent Next - Add Guarded PR Staging Deployments | Human | 10 | +729 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3974](https://github.com/Kilo-Org/cloud/pull/3974) | feat(cloud-agent): cache prepared workspaces | Human | 25 | +2,350 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3973](https://github.com/Kilo-Org/cloud/pull/3973) | fix(code-reviews): expire stale reviews | Human | 8 | +269 | Substantive fix PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3957](https://github.com/Kilo-Org/cloud/pull/3957) | refactor(cloud-agent): remove legacy runtime | Human | 189 | +13,635 | Substantive refactor PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3919](https://github.com/Kilo-Org/cloud/pull/3919) | fix(cloud-agent-next): refresh generic git credentials | Human | 13 | +508 | Substantive fix PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3908](https://github.com/Kilo-Org/cloud/pull/3908) | fix(cloud-agent): recover sessions after runtime starvation | Human | 22 | +1,363 | Substantive fix PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3860](https://github.com/Kilo-Org/cloud/pull/3860) | feat(cloud-agent): expand Kilo facade session API | Human | 90 | +42,344 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3817](https://github.com/Kilo-Org/cloud/pull/3817) | fix(ai-gateway): make SSE rewriting stream-safe | Human | 8 | +591 | Substantive fix PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3649](https://github.com/Kilo-Org/cloud/pull/3649) | fix(gastown): stop logging town config secrets | Bot | 9 | +522 | Substantive fix PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3632](https://github.com/Kilo-Org/cloud/pull/3632) | fix(cloud-agent-next): diagnose kilo import failures | Bot | 5 | +685 | Substantive fix PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3623](https://github.com/Kilo-Org/cloud/pull/3623) | fix(kilo-pass): remove grandfathered second-month 50% bonus promo | Bot | 17 | +483 | Substantive billing/promo PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3459](https://github.com/Kilo-Org/cloud/pull/3459) | fix(users): populate derived emails for bots and deletions | Human | 10 | +202 | Substantive fix PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3432](https://github.com/Kilo-Org/cloud/pull/3432) | feat(gastown): show admin bead failure reasons | Bot | 27 | +1,145 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3428](https://github.com/Kilo-Org/cloud/pull/3428) | fix(gastown): tag structured logs with town IDs | Bot | 26 | +1,210 | Substantive fix PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3424](https://github.com/Kilo-Org/cloud/pull/3424) | feat(ui): add Gastown badge to SessionsList | Human | 18 | +933 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3353](https://github.com/Kilo-Org/cloud/pull/3353) | chore(gastown): stage release updates | Human | 61 | +4,395 | Substantive release chore with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3327](https://github.com/Kilo-Org/cloud/pull/3327) | feat(teams): add Microsoft Teams bot integration | Human | 31 | +25,694 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3311](https://github.com/Kilo-Org/cloud/pull/3311) | feat(kilo-chat): auto-open chat conversations | Human | 8 | +773 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#3209](https://github.com/Kilo-Org/cloud/pull/3209) | feat(github): MVP commit-as-user via GitHub App user-to-server tokens | Bot | 40 | +24,510 | Substantive security feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#2851](https://github.com/Kilo-Org/cloud/pull/2851) | feat(emails): transactional emails for top-up and KiloClaw purchase | Bot | 12 | +20,104 | Substantive billing feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#1646](https://github.com/Kilo-Org/cloud/pull/1646) | adding bulk trial extension dash | Human | 12 | +15,689 | Substantive feature PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#1528](https://github.com/Kilo-Org/cloud/pull/1528) | fix(cloud-agent): surface setup stderr during preparation | Human | 13 | +219 | Substantive fix PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |
| [#1401](https://github.com/Kilo-Org/cloud/pull/1401) | fix(cloud-agent): return 4xx for branch-not-found instead of 500 | Human | 10 | +543 | Substantive fix PR with no issue reference. | Medium | Create a tracking issue or document why none is needed. |

## 6. Duplicate or competing PRs

Duplicate/competing PRs were identified by identical title pattern or strong title similarity plus ≥ 50% changed-file overlap. The recommendation considers correctness, scope, review state, and maintainability rather than age alone.

| Group | Preferred PR | Duplicate/competing PR(s) | Overlap evidence | Check/review state | Recommended action | Confidence |
|---|---|---|---|---|---|---|
| A | [#4231](https://github.com/Kilo-Org/cloud/pull/4231) `feat(kiloclaw): bump openclaw to version 2026.6.10` | [#4145](https://github.com/Kilo-Org/cloud/pull/4145) `feat(kiloclaw): bump openclaw to version 2026.6.9` | Identical title pattern; both bump the same dependency in the same package. #4231 targets the newer version (2026.6.10); #4145 targets 2026.6.9. | Both draft; no reviews or comments; both authored by `github-actions[bot]`. No failing required checks. | Retain #4231 as the more current version bump. Close #4145 once #4231 is merged or confirmed to supersede it. | High |
| B | [#4199](https://github.com/Kilo-Org/cloud/pull/4199) `fix(cloud-agent-next): persist kilo import diagnostics` | [#3632](https://github.com/Kilo-Org/cloud/pull/3632) `fix(cloud-agent-next): diagnose kilo import failures` | 60% changed-file overlap in `services/cloud-agent-next/wrapper/src/restore-session.test.ts`, `restore-session.ts`, and `utils.ts`; title similarity 0.60. | Neither PR has substantive human review. #4199 is more recent and broader in scope (persist diagnostics vs. diagnose failures). | Review both together. If #4199 covers the same problem and includes the diagnostics persistence logic, close #3632 in favor of #4199. | High |

## 7. Symptom clusters (medium confidence, not proven duplicates)

These clusters group issues that share broad symptom keywords and body-token similarity ≥ 0.30. They are **not** proven duplicates; human review is needed to determine whether they are distinct manifestations of the same root cause or should be consolidated.

| Canonical issue | Cluster members | Evidence | Confidence | Recommended action |
|---|---|---|---|---|
| [#4147](https://github.com/Kilo-Org/cloud/issues/4147) [Gastown] Triage dispatch loop: patrol creates triage beads for non-triage-role poles, infinite retry with no back-off | [#4147](https://github.com/Kilo-Org/cloud/issues/4147), [#4148](https://github.com/Kilo-Org/cloud/issues/4148), [#4186](https://github.com/Kilo-Org/cloud/issues/4186), [#4187](https://github.com/Kilo-Org/cloud/issues/4187) | 4 issues sharing broad symptom keywords and body similarity ≥ 0.30; may share root cause. #4147/#4148 and #4186/#4187 are already flagged as high-confidence duplicates in §4. | Medium | Review cluster to identify true duplicates vs. distinct manifestations; consolidate where appropriate. |
| [#3883](https://github.com/Kilo-Org/cloud/issues/3883) [Gastown] Patrol agent in infinite escalation loop on missing bead references | [#3883](https://github.com/Kilo-Org/cloud/issues/3883), [#3884](https://github.com/Kilo-Org/cloud/issues/3884), [#3885](https://github.com/Kilo-Org/cloud/issues/3885) | 3 issues sharing broad symptom keywords and body similarity ≥ 0.30. | Medium | Review cluster to identify true duplicates vs. distinct manifestations; consolidate where appropriate. |
| [#3780](https://github.com/Kilo-Org/cloud/issues/3780) [Gastown] Patrol assigned gt:triage batch to polecat instead of triage-capable agent | [#3780](https://github.com/Kilo-Org/cloud/issues/3780), [#3785](https://github.com/Kilo-Org/cloud/issues/3785), [#3786](https://github.com/Kilo-Org/cloud/issues/3786) | 3 issues sharing broad symptom keywords and body similarity ≥ 0.30. | Medium | Review cluster to identify true duplicates vs. distinct manifestations; consolidate where appropriate. |
| [#2009](https://github.com/Kilo-Org/cloud/issues/2009) [Gastown] Git push authentication failures blocking bead completion | [#2009](https://github.com/Kilo-Org/cloud/issues/2009), [#2010](https://github.com/Kilo-Org/cloud/issues/2010), [#2018](https://github.com/Kilo-Org/cloud/issues/2018) | 3 issues sharing broad symptom keywords and body similarity ≥ 0.30. | Medium | Review cluster to identify true duplicates vs. distinct manifestations; consolidate where appropriate. |
| [#1957](https://github.com/Kilo-Org/cloud/issues/1957) [Gastown] Polecat agent stuck in triage role mismatch loop | [#1957](https://github.com/Kilo-Org/cloud/issues/1957), [#1962](https://github.com/Kilo-Org/cloud/issues/1962), [#1965](https://github.com/Kilo-Org/cloud/issues/1965) | 3 issues sharing broad symptom keywords and body similarity ≥ 0.30. #1962 is already flagged as a high-confidence duplicate of #1961 in §4. | Medium | Review cluster to identify true duplicates vs. distinct manifestations; consolidate where appropriate. |

## 8. Issues already labeled `kilo-duplicate`

These issues already carry the `kilo-duplicate` label. The recommended action assumes the referenced open issue is the canonical one.

| Issue | References open issue(s) | Evidence | Recommended action |
|---|---|---|---|
| [#1515](https://github.com/Kilo-Org/cloud/issues/1515) fix(gastown): PTY sessions disconnect when switching agents — should persist in background | [#1489](https://github.com/Kilo-Org/cloud/issues/1489) | Carries `kilo-duplicate` label and references open issue #1489. | Close #1515 as duplicate of #1489 if #1489 is canonical. |
| [#1512](https://github.com/Kilo-Org/cloud/issues/1512) feat(gastown): Per-role model configuration in town settings — mayor, refinery, polecat | None found | Carries `kilo-duplicate` label; no open issue references found in body/comments. | Locate the canonical issue and close #1512 as duplicate, or remove the label if no duplicate exists. |
| [#1489](https://github.com/Kilo-Org/cloud/issues/1489) fix(gastown): Terminal PTY view corrupts intermittently — blacked out rows/columns until TUI redraw | None found | Carries `kilo-duplicate` label; no open issue references found in body/comments. | Locate the canonical issue and close #1489 as duplicate, or remove the label if no duplicate exists. |
| [#1402](https://github.com/Kilo-Org/cloud/issues/1402) feat(gastown): Billing integration — usage metering, limits, and cost visibility | [#1297](https://github.com/Kilo-Org/cloud/issues/1297) | Carries `kilo-duplicate` label and references open issue #1297. | Close #1402 as duplicate of #1297 if #1297 is canonical. |
| [#1136](https://github.com/Kilo-Org/cloud/issues/1136) Gastown Sync Update: 2026-03-16 — v0.7.0 through v0.12.1 | [#447](https://github.com/Kilo-Org/cloud/issues/447), [#1040](https://github.com/Kilo-Org/cloud/issues/1040) | Carries `kilo-duplicate` label and references open issues #447 and #1040. | Close #1136 as duplicate of the appropriate canonical issue, or remove the label if it is not a duplicate. |
| [#1073](https://github.com/Kilo-Org/cloud/issues/1073) Parallel Refinery: Per-Convoy Refinery Agents | None found | Carries `kilo-duplicate` label; no open issue references found in body/comments. | Locate the canonical issue and close #1073 as duplicate, or remove the label if no duplicate exists. |

## 9. PR quality and human-validation gaps

### 9.1 High-confidence findings

High-confidence findings combine concrete quality concerns with absent substantive human validation.

#### 9.1.1 Bot-authored repository policy changes with no human approval

| PR | Title | Author | Changed files | Quality concern | Automation indicator | Human validation | Confidence | Recommended action |
|---|---|---|---|---|---|---|---|---|
| [#3420](https://github.com/Kilo-Org/cloud/pull/3420) | docs(review): enforce rule against challenging PR's stated intent | `app/kilo-code-bot` / `kiloconnect[bot]` | `REVIEW.md` (+17/-0) | Adds an "ABSOLUTE RULE" that reviewers must not challenge a PR's stated goal, scope, or design decisions unless the approach is "objectively unsafe." This weakens review standards and could suppress legitimate architectural or correctness concerns. | Bot-authored; commit message and body match an automation-generated policy draft. | None. Latest review and only comments are from `kilo-code-bot` and a stale-bot warning. | High | Block merge until a human maintainer reviews and either rejects or heavily revises the rule. |
| [#4105](https://github.com/Kilo-Org/cloud/pull/4105) | docs(review): update REVIEW.md guidance | `app/kilo-code-bot` / `kilo-code-bot[bot]` | `REVIEW.md` (+1/-0) | Adds a bullet claiming three "maintainer-accepted fixes" relate to audit-log correctness, but provides no links, issue references, or evidence of maintainer acceptance. The PR body contains `<!-- kilo-review-memory-change-request -->`, suggesting it originated from an automated memory mechanism. | Bot-authored with an automated-change-request marker. | None. No reviews or human comments. | High | Request the bot author or a human to cite the maintainer discussions or issue links that justify the guidance change. |

#### 9.1.2 Large bot-authored feature PRs with no human validation

| PR | Title | Author | Size | Quality concern | Automation indicator | Human validation | Confidence | Recommended action |
|---|---|---|---|---|---|---|---|---|
| [#3209](https://github.com/Kilo-Org/cloud/pull/3209) | feat(github): MVP commit-as-user via GitHub App user-to-server tokens | `app/kilo-code-bot` | +24,510 / -59, 40 files, 15 commits | Adds a new database table (`user_github_app_tokens`), encryption-key plumbing, OAuth callback routes, a migration, GDPR soft-delete handling, and worker utilities. A feature of this security sensitivity should not land without human security review. | Entirely bot-authored; multiple self-reported "Refinery code review passed" comments from the same bot. | None. Reviews are exclusively from `kilo-code-bot`, and the only other activity is from bots. | High | Require human security and domain review before merge. Do not rely solely on bot self-review. |
| [#2851](https://github.com/Kilo-Org/cloud/pull/2851) | feat(emails): transactional emails for top-up and KiloClaw purchase | `app/kilo-code-bot` / `kiloconnect[bot]` | +20,100 / -4, 12 files, 11 commits | Introduces billing-related transactional emails with idempotency logic tied to `credit_transactions.stripe_payment_id` and a new `kiloclaw_email_log` table. Sensitive to duplicate sends and subscription lifecycle edge cases. | Bot-authored. | Minimal. `jobrietbergen` asked "@evanjacobson this is already finished right? Can we close this?" — a meta question, not a review. Stale-bot warning present. No approving or change-requesting human review. | High | Either close as abandoned or route to a human reviewer for billing/email correctness validation. |

### 9.2 Medium-confidence findings

Medium-confidence findings have either a quality concern or a clear validation gap, but the evidence is less severe.

#### 9.2.1 Bot-authored code changes with missing tests and no human review

| PR | Title | Author | Size | Quality concern | Human validation | Confidence | Recommended action |
|---|---|---|---|---|---|---|---|
| [#3854](https://github.com/Kilo-Org/cloud/pull/3854) | fix(auto-triage): avoid regex code fence parsing | `app/kilo-code-bot` | +53 / -9, 1 file | Rewrites code-block extraction with a custom state machine; no new tests added. | None (only bot `<!-- kilo-review -->`). | Medium | Require a human reviewer or add targeted tests before merge. |
| [#3384](https://github.com/Kilo-Org/cloud/pull/3384) | feat(posthog): add Redis-backed flag definition cache for local evaluation | `app/kilo-code-bot` | +154 / -23, 7 files | New distributed-lock cache implementation; no tests for lock contention, failure, or TTL edge cases. | None (bot + stale-bot only). | Medium | Require a human reviewer or add targeted tests before merge. |
| [#3658](https://github.com/Kilo-Org/cloud/pull/3658) | feat(bot): include Slack unfurled link previews in conversation context | `app/kilo-code-bot` | +63 / -5, 1 file | New attachment parsing logic; no tests. | None (only bot). | Medium | Require a human reviewer or add targeted tests before merge. |
| [#3812](https://github.com/Kilo-Org/cloud/pull/3812) | fix(admin): default trial org plan to enterprise when created from admin dashboard | `app/kilo-code-bot` | +7 / -1, 1 file | Single hard-coded `'enterprise'` string passed to `createOrganization`; no test coverage for the new default. | None (only bot). | Medium | Require a human reviewer or add targeted tests before merge. |
| [#3623](https://github.com/Kilo-Org/cloud/pull/3623) | fix(kilo-pass): remove grandfathered second-month 50% bonus promo | `app/kilo-code-bot` | +53 / -430, 17 files | Removes promo logic and updates tests accordingly; appears correct but is a billing/promotional change with no human review. | None (only bot). | Medium | Require a human reviewer or add targeted tests before merge. |

#### 9.2.2 Large human-authored feature PRs with no human review

These PRs are authored by humans but have no independent human review. Author self-comments and follow-up commits may be present. The absence of human review for large architectural changes is itself a risk.

| PR | Author | Title | Size | Notes | Confidence | Recommended action |
|---|---|---|---|---|---|---|
| [#4134](https://github.com/Kilo-Org/cloud/pull/4134) | `pandemicsyn` | feat(mcp-gateway): durable per-client OAuth grants and Authorized Clients UI | +74,612 / -1,763, 172 files | Adds new table, migration, OAuth grant lifecycle, UI. Author self-reported follow-up commits, but no human reviewer. Verification checklist is empty. | Medium | Assign human security and domain reviewers before merge. |
| [#4218](https://github.com/Kilo-Org/cloud/pull/4218) | `eshurakov` | Bitbucket - Add Bitbucket Integration | +40,093 / -229, 105 files | Large new integration. Only bot review. | Medium | Assign human domain reviewers before merge. |
| [#4206](https://github.com/Kilo-Org/cloud/pull/4206) | `alex-alecu` | feat(usage): add ask usage | +37,537 / -335, 72 files | New usage telemetry. Only bot review. | Medium | Assign human domain reviewers before merge. |
| [#4168](https://github.com/Kilo-Org/cloud/pull/4168) | `alex-alecu` | feat(mcp): add native /mcp for cost control | +35,994 / -204, 39 files | Draft. Only bot + author self-comment. | Medium | Assign human domain reviewers before merge. |
| [#4035](https://github.com/Kilo-Org/cloud/pull/4035) | `keyserfaty` | feat: AgentCard OAuth integration + agent skill | +33,909 / -141, 33 files | Includes `Co-Authored-By: Claude Opus 4.8` in commit. Only bot review. | Medium | Assign human security and domain reviewers before merge. |
| [#3327](https://github.com/Kilo-Org/cloud/pull/3327) | `RSO` | feat(teams): add Microsoft Teams bot integration | +25,578 / -116, 31 files | Stale; only bot + stale-bot. | Medium | Assign human domain reviewers or close as abandoned. |
| [#4164](https://github.com/Kilo-Org/cloud/pull/4164) | `iscekic` | feat(extension): add browser agent side panel | +16,070 / -88, 100 files | New `apps/extension` package. Only bot review. | Medium | Assign human domain reviewers before merge. |

#### 9.2.3 Unchecked verification claims

| PR | Claim | Issue | Confidence | Recommended action |
|---|---|---|---|---|
| [#4134](https://github.com/Kilo-Org/cloud/pull/4134) | Verification checklist is empty (`- [ ]`). | Author did not confirm manual testing in the PR template. | Medium | Require verification evidence or independent reproduction. |
| [#4168](https://github.com/Kilo-Org/cloud/pull/4168) | Author commented "Manual test passed." | Self-reported only; no independent verification. | Medium | Require verification evidence or independent reproduction. |
| [#4105](https://github.com/Kilo-Org/cloud/pull/4105) | Claims "Three maintainer-accepted fixes" with no citations. | Unverified assertion in a policy doc. | Medium | Require verification evidence or independent reproduction. |

### 9.3 Low-confidence / routine findings

| PR | Title | State | Notes | Confidence | Recommended action |
|---|---|---|---|---|---|
| [#4231](https://github.com/Kilo-Org/cloud/pull/4231) | feat(kiloclaw): bump openclaw to version 2026.6.10 | Draft, no reviews/comments | Routine dependency bump by `github-actions[bot]`. Low risk but unvalidated. | Low | Close stale duplicates (#4145 vs #4231) and merge or route active drafts to reviewers when ready. |
| [#4145](https://github.com/Kilo-Org/cloud/pull/4145) | feat(kiloclaw): bump openclaw to version 2026.6.9 | Draft, no reviews/comments | Same as above; superseded by #4231. | Low | Close in favor of #4231 if redundant. |
| [#4220](https://github.com/Kilo-Org/cloud/pull/4220) | feat(coding-plans): expose managed plan usage | Draft, no reviews/comments | Well-tested; validation gap only. | Low | Route to reviewers when ready. |
| [#4197](https://github.com/Kilo-Org/cloud/pull/4197) | feat(headroom): add compress worker | Draft, no reviews/comments | New worker; no review. | Low | Route to reviewers when ready. |
| [#4005](https://github.com/Kilo-Org/cloud/pull/4005) | feat(auto-routing): Morph model router decisions for kilo-auto tiers | Draft, no reviews/comments | New routing logic; no review. | Low | Route to reviewers when ready. |
| [#2120](https://github.com/Kilo-Org/cloud/pull/2120) | feat(cloud-agent): prompt autocomplete (ghost text) | Draft, only author self-comment + stale-bot | Long-running draft. | Low | Route to reviewers or close as abandoned. |
| [#1582](https://github.com/Kilo-Org/cloud/pull/1582) | fix(claw): add Upgrade option to all toasts when adding secrets | Draft, human comments | Human comments present; not a validation gap. | Low | Continue existing review. |
| [#1379](https://github.com/Kilo-Org/cloud/pull/1379) | Add initial churnkey implementation spec | Draft, human comments | Spec-only; human discussion present. | Low | Continue existing review. |

## 10. Cross-references and consistency notes

The following issues appear in more than one section. The report resolves each consistently:

| Issue | Sections | Resolution |
|---|---|---|
| #4147, #4148 | §4 (high-confidence duplicates) and §7 (symptom cluster) | Treated as proven duplicates in §4; the cluster in §7 is the broader medium-confidence grouping from which they were promoted. |
| #4186, #4187 | §4 (high-confidence duplicates) and §7 (symptom cluster) | Same as above: proven duplicates in §4, broader cluster in §7. |
| #1962 | §4 (duplicate of #1961) and §7 (cluster with #1957/#1965) | Treated as a proven duplicate of #1961 in §4; the cluster in §7 notes the related symptom set. |
| #4199, #3632 | §5.2 (issue-less PRs) and §6 (competing PRs) | Both lack tracking issues; #4199 is preferred in §6 due to broader scope, but both need human review. |

No issue or PR is assigned contradictory actions across sections.

## 11. Prioritized action checklist

1. **Block or human-review policy PRs** [#3420](https://github.com/Kilo-Org/cloud/pull/3420) and [#4105](https://github.com/Kilo-Org/cloud/pull/4105) before merge.
2. **Require human security review** for [#3209](https://github.com/Kilo-Org/cloud/pull/3209) (GitHub App user-to-server tokens).
3. **Close proven duplicate issues** listed in §4 (10 groups, 21 issues).
4. **Resolve already-labeled duplicate issues** in §8: confirm canonical issues and close or relabel.
5. **Close or actively triage** [#2851](https://github.com/Kilo-Org/cloud/pull/2851) (questioned as finished) and [#4145](https://github.com/Kilo-Org/cloud/pull/4145) (superseded by #4231).
6. **Assign human reviewers** to large unaudited feature PRs in §9.2.2.
7. **Resolve competing PRs** in §6: merge or close #3632 and #4145 based on scope overlap with #4199 and #4231.
8. **Create tracking issues** for the 36 substantive issue-less PRs in §5.2, or document why none is needed.
9. **Add tests or human review** for the bot-authored changes in §9.2.1.
10. **Investigate symptom clusters** in §7 to identify additional duplicates or root-cause groupings.
11. **Update process guidance** so that bot-authored reviews are not treated as sufficient for non-trivial code, security, billing, or policy changes.

## 12. Limitations

- This audit inspected issue/PR metadata, diffs, comments, and reviews but did not execute tests or fully trace every code path.
- Automation indicators are based on authorship, bot-only activity, and explicit markers (e.g., `<!-- kilo-review -->`, `Co-Authored-By`), not on prose-style heuristics.
- The analysis did not re-query live GitHub state during consolidation; counts reflect the snapshot taken on 2026-06-24.
- Body-token similarity thresholds (0.60 for duplicates, 0.30 for clusters) are conservative; some near-duplicates may fall below the threshold.
- Recommendations are reversible and intended for human review before any GitHub mutation.
