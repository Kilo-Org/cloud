# Cloud Duplicate Issues and Missing Issue-PR Relationships Findings

**Scope:** Kilo-Org/cloud open issues and pull requests
**Date:** 2026-06-24
**Counts:** 284 open issues, 64 open PRs

## Methodology

- Duplicate issues require identical or near-identical titles and bodies, or body token similarity ≥0.60, indicating shared root cause and materially equivalent desired outcome.
- Symptom clusters group issues that share broad keywords and body similarity ≥0.30 but are explicitly not claimed as proven duplicates.
- Missing PR links are detected when a PR explicitly mentions an open issue without a closing keyword. Semantic PR/issue similarity did not surface any additional high-confidence matches.
- Issue-less PRs are substantive feature/fix PRs (>8 files or large diffs) with no issue reference; routine version bumps and dependency updates are excluded.
- Duplicate/competing PRs require identical titles (ignoring version numbers) or strong title similarity plus ≥50% changed-file overlap.
- No action was taken on GitHub; all findings are recommendations for human review.

## Summary counts

- Highly confident duplicate open issues: 10
- PRs related to open issues but lacking explicit closing link: 0
- Substantive PRs without tracking issue: 36
- Duplicate or competing PRs: 2
- Symptom clusters (medium confidence): 5
- Issues already labeled `kilo-duplicate`: 6

## 1. Highly confident duplicate open issues

**Confidence:** high  
**Canonical:** [#4186](https://github.com/Kilo-Org/cloud/issues/4186) [Gastown] Update: patrol triage role mismatch loop is unfixable from mayor side + self-feeding on escalations  
**Duplicate(s):** [#4187](https://github.com/Kilo-Org/cloud/issues/4187) [Gastown] Update: patrol triage role mismatch loop is unfixable from mayor side + self-feeding on escalations  
**Evidence:** Consolidated group of 2 issues with shared rig/symptom/outcome; pairwise body similarity ≥0.60 or identical.  
**Suggested action:** Close #4187 as duplicate of #4186.  

**Confidence:** high  
**Canonical:** [#4147](https://github.com/Kilo-Org/cloud/issues/4147) [Gastown] Triage dispatch loop: patrol creates triage beads for non-triage-role poles, infinite retry with no back-off  
**Duplicate(s):** [#4148](https://github.com/Kilo-Org/cloud/issues/4148) [Gastown] Triage dispatch loop: patrol creates triage beads for non-triage-role poles, infinite retry with no back-off  
**Evidence:** Consolidated group of 2 issues with shared rig/symptom/outcome; pairwise body similarity ≥0.60 or identical.  
**Suggested action:** Close #4148 as duplicate of #4147.  

**Confidence:** high  
**Canonical:** [#2019](https://github.com/Kilo-Org/cloud/issues/2019) [Gastown] Create PRs at start of refinery step with full review status visibility  
**Duplicate(s):** [#2020](https://github.com/Kilo-Org/cloud/issues/2020) [Gastown] Create PRs at start of refinery step with full review status visibility  
**Evidence:** Consolidated group of 2 issues with shared rig/symptom/outcome; pairwise body similarity ≥0.60 or identical.  
**Suggested action:** Close #2020 as duplicate of #2019.  

**Confidence:** high  
**Canonical:** [#2016](https://github.com/Kilo-Org/cloud/issues/2016) [Gastown] Feature request: Allow custom Docker image mount for agents  
**Duplicate(s):** [#2017](https://github.com/Kilo-Org/cloud/issues/2017) [Gastown] Feature request: Allow custom Docker image mount for agents  
**Evidence:** Consolidated group of 2 issues with shared rig/symptom/outcome; pairwise body similarity ≥0.60 or identical.  
**Suggested action:** Close #2017 as duplicate of #2016.  

**Confidence:** high  
**Canonical:** [#2014](https://github.com/Kilo-Org/cloud/issues/2014) [Gastown] Convoy dependency enforcement bypassed: beads dispatched despite failed merge requests  
**Duplicate(s):** [#2015](https://github.com/Kilo-Org/cloud/issues/2015) [Gastown] Convoy dependency enforcement bypassed: beads dispatched despite failed merge requests  
**Evidence:** Consolidated group of 2 issues with shared rig/symptom/outcome; pairwise body similarity ≥0.60 or identical.  
**Suggested action:** Close #2015 as duplicate of #2014.  

**Confidence:** high  
**Canonical:** [#2004](https://github.com/Kilo-Org/cloud/issues/2004) [Gastown] Dispatch system stalled - all agents idle despite open beads in active convoys  
**Duplicate(s):** [#2005](https://github.com/Kilo-Org/cloud/issues/2005) [Gastown] Dispatch system stalled - all agents idle despite open beads in active convoys  
**Evidence:** Consolidated group of 2 issues with shared rig/symptom/outcome; pairwise body similarity ≥0.60 or identical.  
**Suggested action:** Close #2005 as duplicate of #2004.  

**Confidence:** high  
**Canonical:** [#1980](https://github.com/Kilo-Org/cloud/issues/1980) [Gastown] Phantom escalation loop: "Duplicated code in VoiceJoin handler" fires repeatedly with no valid escalation ID  
**Duplicate(s):** [#1981](https://github.com/Kilo-Org/cloud/issues/1981) [Gastown] Phantom escalation loop: "Duplicated code in VoiceJoin handler" fires repeatedly with no valid escalation ID  
**Evidence:** Consolidated group of 2 issues with shared rig/symptom/outcome; pairwise body similarity ≥0.60 or identical.  
**Suggested action:** Close #1981 as duplicate of #1980.  

**Confidence:** high  
**Canonical:** [#1882](https://github.com/Kilo-Org/cloud/issues/1882) [Gastown] Recurring GitHub token expiration blocking git push on rig ef798611 (thegent-shm)  
**Duplicate(s):** [#1883](https://github.com/Kilo-Org/cloud/issues/1883) [Gastown] Recurring GitHub token expiration blocking git push on rig ef798611 (thegent-shm)  
**Evidence:** Consolidated group of 2 issues with shared rig/symptom/outcome; pairwise body similarity ≥0.60 or identical.  
**Suggested action:** Close #1883 as duplicate of #1882.  

**Confidence:** high  
**Canonical:** [#1807](https://github.com/Kilo-Org/cloud/issues/1807) [Gastown] Polecat agents get 403 permission error when resolving triage requests  
**Duplicate(s):** [#1808](https://github.com/Kilo-Org/cloud/issues/1808) [Gastown] Polecat agents get 403 permission error when resolving triage requests  
**Evidence:** Consolidated group of 2 issues with shared rig/symptom/outcome; pairwise body similarity ≥0.60 or identical.  
**Suggested action:** Close #1808 as duplicate of #1807.  

**Confidence:** high  
**Canonical:** [#1961](https://github.com/Kilo-Org/cloud/issues/1961) [Gastown] Critical infinite loop: Polecat agent continuously dispatched to triage  
**Duplicate(s):** [#1962](https://github.com/Kilo-Org/cloud/issues/1962) [Gastown] Critical infinite escalation loop: Rig cannot be recovered; [#1963](https://github.com/Kilo-Org/cloud/issues/1963) [Gastown] Infinite critical escalation loop renders rig completely unusable  
**Evidence:** Consolidated group of 3 issues with shared rig/symptom/outcome; pairwise body similarity ≥0.60 or identical.  
**Suggested action:** Close #1962, #1963 as duplicate of #1961.  

## 2. PRs related to existing open issues but lacking explicit closing link

_Only two open PRs reference open issues using a closing keyword: #4137 closes #4136, and #1432 closes #1297. No PRs reference open issues without an explicit closing link._

## 3. Substantive PRs that should have a tracking issue

The following substantive feature/fix PRs have no linked issue. The list excludes routine version bumps and dependency updates.

**Confidence:** medium  
**PR:** [#4220](https://github.com/Kilo-Org/cloud/pull/4220) feat(coding-plans): expose managed plan usage  
**Evidence:** Substantive feature/fix PR (9 files changed, 666 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#4218](https://github.com/Kilo-Org/cloud/pull/4218) Bitbucket - Add Bitbucket Integration  
**Evidence:** Substantive feature/fix PR (105 files changed, 39150 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#4211](https://github.com/Kilo-Org/cloud/pull/4211) feat(api): add usage email filters and members endpoint  
**Evidence:** Substantive feature/fix PR (11 files changed, 1208 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#4206](https://github.com/Kilo-Org/cloud/pull/4206) feat(usage): add ask usage  
**Evidence:** Substantive feature/fix PR (72 files changed, 37872 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#4199](https://github.com/Kilo-Org/cloud/pull/4199) fix(cloud-agent-next): persist kilo import diagnostics  
**Evidence:** Substantive feature/fix PR (13 files changed, 789 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#4197](https://github.com/Kilo-Org/cloud/pull/4197) feat(headroom): add compress worker  
**Evidence:** Substantive feature/fix PR (21 files changed, 1834 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#4168](https://github.com/Kilo-Org/cloud/pull/4168) feat(mcp): add native /mcp for cost control  
**Evidence:** Substantive feature/fix PR (39 files changed, 36198 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#4164](https://github.com/Kilo-Org/cloud/pull/4164) feat(extension): add browser agent side panel  
**Evidence:** Substantive feature/fix PR (100 files changed, 16158 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#4134](https://github.com/Kilo-Org/cloud/pull/4134) feat(mcp-gateway): durable per-client OAuth grants and Authorized Clients UI  
**Evidence:** Substantive feature/fix PR (172 files changed, 8983 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#4133](https://github.com/Kilo-Org/cloud/pull/4133) chore(dev): cloud reviews local testing E2E  
**Evidence:** Substantive feature/fix PR (20 files changed, 1528 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#4056](https://github.com/Kilo-Org/cloud/pull/4056) feat(ai-gateway): add organization auto model routing  
**Evidence:** Substantive feature/fix PR (42 files changed, 5004 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#4035](https://github.com/Kilo-Org/cloud/pull/4035) feat: AgentCard OAuth integration + agent skill  
**Evidence:** Substantive feature/fix PR (33 files changed, 34050 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#4005](https://github.com/Kilo-Org/cloud/pull/4005) feat(auto-routing): Morph model router decisions for kilo-auto tiers  
**Evidence:** Substantive feature/fix PR (15 files changed, 1130 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#3980](https://github.com/Kilo-Org/cloud/pull/3980) Cloud Agent Next - Add Guarded PR Staging Deployments  
**Evidence:** Substantive feature/fix PR (10 files changed, 729 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#3974](https://github.com/Kilo-Org/cloud/pull/3974) feat(cloud-agent): cache prepared workspaces  
**Evidence:** Substantive feature/fix PR (25 files changed, 2350 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#3973](https://github.com/Kilo-Org/cloud/pull/3973) fix(code-reviews): expire stale reviews  
**Evidence:** Substantive feature/fix PR (8 files changed, 269 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#3957](https://github.com/Kilo-Org/cloud/pull/3957) refactor(cloud-agent): remove legacy runtime  
**Evidence:** Substantive feature/fix PR (189 files changed, 13635 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#3919](https://github.com/Kilo-Org/cloud/pull/3919) fix(cloud-agent-next): refresh generic git credentials  
**Evidence:** Substantive feature/fix PR (13 files changed, 508 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#3908](https://github.com/Kilo-Org/cloud/pull/3908) fix(cloud-agent): recover sessions after runtime starvation  
**Evidence:** Substantive feature/fix PR (22 files changed, 1363 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#3860](https://github.com/Kilo-Org/cloud/pull/3860) feat(cloud-agent): expand Kilo facade session API  
**Evidence:** Substantive feature/fix PR (90 files changed, 42344 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#3817](https://github.com/Kilo-Org/cloud/pull/3817) fix(ai-gateway): make SSE rewriting stream-safe  
**Evidence:** Substantive feature/fix PR (8 files changed, 591 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#3649](https://github.com/Kilo-Org/cloud/pull/3649) fix(gastown): stop logging town config secrets  
**Evidence:** Substantive feature/fix PR (9 files changed, 522 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#3632](https://github.com/Kilo-Org/cloud/pull/3632) fix(cloud-agent-next): diagnose kilo import failures  
**Evidence:** Substantive feature/fix PR (5 files changed, 685 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#3623](https://github.com/Kilo-Org/cloud/pull/3623) fix(kilo-pass): remove grandfathered second-month 50% bonus promo  
**Evidence:** Substantive feature/fix PR (17 files changed, 483 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#3459](https://github.com/Kilo-Org/cloud/pull/3459) fix(users): populate derived emails for bots and deletions  
**Evidence:** Substantive feature/fix PR (10 files changed, 202 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#3432](https://github.com/Kilo-Org/cloud/pull/3432) feat(gastown): show admin bead failure reasons  
**Evidence:** Substantive feature/fix PR (27 files changed, 1145 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#3428](https://github.com/Kilo-Org/cloud/pull/3428) fix(gastown): tag structured logs with town IDs  
**Evidence:** Substantive feature/fix PR (26 files changed, 1210 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.

**Confidence:** medium  
**PR:** [#3424](https://github.com/Kilo-Org/cloud/pull/3424) feat(ui): add Gastown badge to SessionsList  
**Evidence:** Substantive feature/fix PR (18 files changed, 933 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.

**Confidence:** medium  
**PR:** [#3353](https://github.com/Kilo-Org/cloud/pull/3353) chore(gastown): stage release updates  
**Evidence:** Substantive feature/fix PR (61 files changed, 4395 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.

**Confidence:** medium  
**PR:** [#3327](https://github.com/Kilo-Org/cloud/pull/3327) feat(teams): add Microsoft Teams bot integration  
**Evidence:** Substantive feature/fix PR (31 files changed, 25694 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.

**Confidence:** medium  
**PR:** [#3311](https://github.com/Kilo-Org/cloud/pull/3311) feat(kilo-chat): auto-open chat conversations  
**Evidence:** Substantive feature/fix PR (8 files changed, 773 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.

**Confidence:** medium  
**PR:** [#3209](https://github.com/Kilo-Org/cloud/pull/3209) feat(github): MVP commit-as-user via GitHub App user-to-server tokens  
**Evidence:** Substantive feature/fix PR (40 files changed, 24569 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#2851](https://github.com/Kilo-Org/cloud/pull/2851) feat(emails): transactional emails for top-up and KiloClaw purchase  
**Evidence:** Substantive feature/fix PR (12 files changed, 20104 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#1646](https://github.com/Kilo-Org/cloud/pull/1646) adding bulk trial extension dash  
**Evidence:** Substantive feature/fix PR (12 files changed, 15689 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#1528](https://github.com/Kilo-Org/cloud/pull/1528) fix(cloud-agent): surface setup stderr during preparation  
**Evidence:** Substantive feature/fix PR (13 files changed, 219 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

**Confidence:** medium  
**PR:** [#1401](https://github.com/Kilo-Org/cloud/pull/1401) fix(cloud-agent): return 4xx for branch-not-found instead of 500  
**Evidence:** Substantive feature/fix PR (10 files changed, 543 line changes) with no issue reference.  
**Suggested action:** Create a tracking issue and link it in the PR description, or document why none is needed.  

## 4. Duplicate or competing PRs

**Confidence:** high  
**Preferred PR:** [#4231](https://github.com/Kilo-Org/cloud/pull/4231) feat(kiloclaw): bump openclaw to version 2026.6.10  
**Duplicate/competing PR(s):** [#4145](https://github.com/Kilo-Org/cloud/pull/4145) feat(kiloclaw): bump openclaw to version 2026.6.9  
**Evidence:** Identical PR titles (2 PRs). Newer version bump is preferred.  
**Suggested action:** Review both; consider closing #4145 in favor of #4231 if redundant.  

**Confidence:** high  
**Preferred PR:** [#4199](https://github.com/Kilo-Org/cloud/pull/4199) fix(cloud-agent-next): persist kilo import diagnostics  
**Duplicate/competing PR(s):** [#3632](https://github.com/Kilo-Org/cloud/pull/3632) fix(cloud-agent-next): diagnose kilo import failures  
**Evidence:** 60% changed-file overlap (3 files: services/cloud-agent-next/wrapper/src/restore-session.test.ts, services/cloud-agent-next/wrapper/src/restore-session.ts, services/cloud-agent-next/wrapper/src/utils.ts), title similarity 0.60.  
**Suggested action:** Review both; consider closing #3632 in favor of #4199 if redundant.  

## Appendix A: Symptom clusters (medium confidence, not proven duplicates)

**Confidence:** medium  
**Canonical issue:** [#4147](https://github.com/Kilo-Org/cloud/issues/4147) [Gastown] Triage dispatch loop: patrol creates triage beads for non-triage-role poles, infinite retry with no back-off  
**Cluster members (4):** [#4147](https://github.com/Kilo-Org/cloud/issues/4147), [#4148](https://github.com/Kilo-Org/cloud/issues/4148), [#4186](https://github.com/Kilo-Org/cloud/issues/4186), [#4187](https://github.com/Kilo-Org/cloud/issues/4187)  
**Evidence:** Cluster of 4 issues sharing broad symptom keywords and body similarity ≥0.30; may share root cause or be duplicates.  
**Suggested action:** Review cluster to identify true duplicates vs. distinct manifestations; consolidate if appropriate.  

**Confidence:** medium  
**Canonical issue:** [#3883](https://github.com/Kilo-Org/cloud/issues/3883) [Gastown] Patrol agent in infinite escalation loop on missing bead references  
**Cluster members (3):** [#3883](https://github.com/Kilo-Org/cloud/issues/3883), [#3884](https://github.com/Kilo-Org/cloud/issues/3884), [#3885](https://github.com/Kilo-Org/cloud/issues/3885)  
**Evidence:** Cluster of 3 issues sharing broad symptom keywords and body similarity ≥0.30; may share root cause or be duplicates.  
**Suggested action:** Review cluster to identify true duplicates vs. distinct manifestations; consolidate if appropriate.  

**Confidence:** medium  
**Canonical issue:** [#3780](https://github.com/Kilo-Org/cloud/issues/3780) [Gastown] Patrol assigned gt:triage batch to polecat instead of triage-capable agent  
**Cluster members (3):** [#3780](https://github.com/Kilo-Org/cloud/issues/3780), [#3785](https://github.com/Kilo-Org/cloud/issues/3785), [#3786](https://github.com/Kilo-Org/cloud/issues/3786)  
**Evidence:** Cluster of 3 issues sharing broad symptom keywords and body similarity ≥0.30; may share root cause or be duplicates.  
**Suggested action:** Review cluster to identify true duplicates vs. distinct manifestations; consolidate if appropriate.  

**Confidence:** medium  
**Canonical issue:** [#2009](https://github.com/Kilo-Org/cloud/issues/2009) [Gastown] Git push authentication failures blocking bead completion  
**Cluster members (3):** [#2009](https://github.com/Kilo-Org/cloud/issues/2009), [#2010](https://github.com/Kilo-Org/cloud/issues/2010), [#2018](https://github.com/Kilo-Org/cloud/issues/2018)  
**Evidence:** Cluster of 3 issues sharing broad symptom keywords and body similarity ≥0.30; may share root cause or be duplicates.  
**Suggested action:** Review cluster to identify true duplicates vs. distinct manifestations; consolidate if appropriate.  

**Confidence:** medium  
**Canonical issue:** [#1957](https://github.com/Kilo-Org/cloud/issues/1957) [Gastown] Polecat agent stuck in triage role mismatch loop  
**Cluster members (3):** [#1957](https://github.com/Kilo-Org/cloud/issues/1957), [#1962](https://github.com/Kilo-Org/cloud/issues/1962), [#1965](https://github.com/Kilo-Org/cloud/issues/1965)  
**Evidence:** Cluster of 3 issues sharing broad symptom keywords and body similarity ≥0.30; may share root cause or be duplicates.  
**Suggested action:** Review cluster to identify true duplicates vs. distinct manifestations; consolidate if appropriate.  

## Appendix B: Issues already labeled `kilo-duplicate`

These issues already carry the `kilo-duplicate` label. Cross-check that the open references below are intentional and that duplicates are still open.

**Issue:** [#1515](https://github.com/Kilo-Org/cloud/issues/1515) fix(gastown): PTY sessions disconnect when switching agents — should persist in background  
**Evidence:** Issue already carries the `kilo-duplicate` label. References open issue(s): #1489.  
**Suggested action:** If the referenced open issue is the canonical one, close #1515 as duplicate.  

**Issue:** [#1512](https://github.com/Kilo-Org/cloud/issues/1512) feat(gastown): Per-role model configuration in town settings — mayor, refinery, polecat  
**Evidence:** Issue already carries the `kilo-duplicate` label. No open issue references found in body/comments.  
**Suggested action:** If the referenced open issue is the canonical one, close #1512 as duplicate.  

**Issue:** [#1489](https://github.com/Kilo-Org/cloud/issues/1489) fix(gastown): Terminal PTY view corrupts intermittently — blacked out rows/columns until TUI redraw  
**Evidence:** Issue already carries the `kilo-duplicate` label. No open issue references found in body/comments.  
**Suggested action:** If the referenced open issue is the canonical one, close #1489 as duplicate.  

**Issue:** [#1402](https://github.com/Kilo-Org/cloud/issues/1402) feat(gastown): Billing integration — usage metering, limits, and cost visibility  
**Evidence:** Issue already carries the `kilo-duplicate` label. References open issue(s): #1297.  
**Suggested action:** If the referenced open issue is the canonical one, close #1402 as duplicate.  

**Issue:** [#1136](https://github.com/Kilo-Org/cloud/issues/1136) Gastown Sync Update: 2026-03-16 — v0.7.0 through v0.12.1  
**Evidence:** Issue already carries the `kilo-duplicate` label. References open issue(s): #447, #1040.  
**Suggested action:** If the referenced open issue is the canonical one, close #1136 as duplicate.  

**Issue:** [#1073](https://github.com/Kilo-Org/cloud/issues/1073) Parallel Refinery: Per-Convoy Refinery Agents  
**Evidence:** Issue already carries the `kilo-duplicate` label. No open issue references found in body/comments.  
**Suggested action:** If the referenced open issue is the canonical one, close #1073 as duplicate.  

## Appendix C: Lower-confidence or excluded candidates

_Pairs below the similarity/overlap thresholds were excluded to keep findings conservative. Where issues share only thematic overlap (e.g., many unrelated Gastown operational incidents), they were not flagged as duplicates._

