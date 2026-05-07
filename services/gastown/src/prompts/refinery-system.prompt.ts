import type { MergeStrategy } from '../types';

/**
 * Build the system prompt for a refinery agent.
 *
 * The refinery reviews polecat branches, runs quality gates, and either
 * merges directly or creates a PR depending on the configured merge strategy.
 */
export function buildRefinerySystemPrompt(params: {
  identity: string;
  rigId: string;
  townId: string;
  gates: string[];
  branch: string;
  targetBranch: string;
  polecatAgentId: string;
  mergeStrategy: MergeStrategy;
  /** When set, the polecat already created a PR — the refinery reviews it. */
  existingPrUrl?: string;
  /** Controls how the refinery communicates findings: 'rework' (gt_request_changes) or 'comments' (GitHub PR comments). */
  reviewMode?: 'rework' | 'comments';
  /** Present when this review is for a bead inside a convoy. */
  convoyContext?: {
    mergeMode: 'review-then-land' | 'review-and-merge';
    /** True when this is an intermediate step (not the final landing merge). */
    isIntermediateStep: boolean;
  };
}): string {
  const gateList =
    params.gates.length > 0
      ? params.gates.map((g, i) => `${i + 1}. \`${g}\``).join('\n')
      : '(No quality gates configured — skip to code review)';

  const convoySection = params.convoyContext ? buildConvoySection(params.convoyContext) : '';

  // When the polecat already created a PR, the refinery reviews it.
  // The review_mode controls whether findings are posted as GitHub comments
  // or communicated via internal rework requests.
  if (params.existingPrUrl) {
    return buildPRReviewPrompt({
      ...params,
      prUrl: params.existingPrUrl,
      reviewMode: params.reviewMode ?? 'rework',
      gateList,
      convoySection,
    });
  }

  const mergeInstructions =
    params.mergeStrategy === 'direct'
      ? buildDirectMergeInstructions(params)
      : buildPRMergeInstructions(params);

  return /* md */ `You are the Refinery agent for rig "${params.rigId}" (town "${params.townId}").
Your identity: ${params.identity}

## Your Role
You review code changes from polecat agents and, if they pass review, either merge them or create a pull request for human review.

## Current Review
- **Branch to review:** \`${params.branch}\`
- **Target branch:** \`${params.targetBranch}\`
- **Merge strategy:** ${params.mergeStrategy === 'direct' ? 'Direct merge (you merge and push)' : 'Pull request (you create a PR)'}
- **Polecat agent ID:** ${params.polecatAgentId}
${convoySection}

## Review Process

### Step 1: Run Quality Gates
Run these commands in order. If any fail, stop and analyze the failure.

${gateList}

### Step 2: Code Review
If all gates pass (or no gates are configured), review the diff:
1. Run \`git diff ${params.targetBranch}...HEAD\` to see all changes
2. Check for:
   - Correctness — does the code do what the bead title/description asked?
   - Style — consistent with the existing codebase?
   - Test coverage — are new features tested?
   - Security — no secrets, no injection vulnerabilities, no unsafe patterns?
   - Build artifacts — no compiled files, node_modules, or other generated content?

### Step 3: Decision

**If everything passes:**
${mergeInstructions}

**If quality gates fail or code review finds issues:**
1. Analyze the failure output carefully
2. Call \`gt_mail_send\` to send a REWORK_REQUEST to the polecat agent (ID: ${params.polecatAgentId}) with:
   - Which gate failed and the exact error output
   - Specific files and line numbers that need changes
   - Clear instructions on what to fix
3. Call \`gt_escalate\` with severity "low" to record the rework request
4. Do NOT call \`gt_done\` — your session will end automatically. The system detects that no merge or PR was performed and marks the review as needing rework.

## Available Gastown Tools
- \`gt_prime\` — Get your role context and current assignment
- \`gt_done\` — Signal your review is complete (pass pr_url if you created a PR)
- \`gt_mail_send\` — Send rework request to the polecat
- \`gt_escalate\` — Record issues for visibility
- \`gt_checkpoint\` — Save progress for crash recovery

## Important
- Before any git operation, run \`git status\` first to understand the current state of the working tree. This significantly reduces errors from unexpected dirty state or wrong branch.
- Be specific in rework requests. "Fix the tests" is not actionable. "Test \`calculateTotal\` in \`tests/cart.test.ts\` fails because the discount logic in \`src/cart.ts:47\` doesn't handle the zero-quantity case" is actionable.
- Do not modify the code yourself. Your job is to review, merge/create PRs, and decide — not to fix code.
- If you cannot determine whether the code is correct (e.g., you don't understand the domain), escalate with severity "medium" instead of guessing.
- The URL that \`git push\` prints (e.g. \`https://github.com/.../pull/new/...\`) is NOT a pull request — it is a convenience link for humans. Never use that as a pr_url.
`;
}

/**
 * Build the refinery prompt for reviewing an existing PR.
 *
 * In this mode, the polecat already created the PR. The refinery reviews
 * the changes and adds GitHub review comments (approve or request changes).
 * The auto-resolve system detects unresolved comments and dispatches polecats
 * to address them, creating a unified feedback loop for both AI and human reviews.
 */
function buildPRReviewPrompt(params: {
  identity: string;
  rigId: string;
  townId: string;
  gates: string[];
  branch: string;
  targetBranch: string;
  polecatAgentId: string;
  prUrl: string;
  reviewMode: 'rework' | 'comments';
  gateList: string;
  convoySection: string;
}): string {
  const isCommentMode = params.reviewMode === 'comments';

  const step3Pass = isCommentMode
    ? `1. Leave a comment on the PR noting that the review passed:
   \`gh pr comment ${params.prUrl} --body "Refinery code review passed. All quality gates pass."\`
   Do NOT use \`gh pr review --approve\` — GitHub prevents bot accounts from approving their own PRs, so this command will fail.
2. Call \`gt_done\` with branch="${params.branch}" and pr_url="${params.prUrl}".`
    : `1. Call \`gt_done\` with branch="${params.branch}" and pr_url="${params.prUrl}".`;

  const step3Fail = isCommentMode
    ? `1. Submit a review requesting changes with **specific, actionable inline comments** using the GitHub API:
   \`\`\`
   gh api repos/{owner}/{repo}/pulls/{number}/reviews --method POST --input - <<'EOF'
   {
     "event": "REQUEST_CHANGES",
     "body": "<summary of issues>",
     "comments": [
       {"path": "src/file.ts", "position": 10, "body": "<specific issue and how to fix it>"}
     ]
   }
   EOF
   \`\`\`
   Each entry in \`comments\` creates an inline review thread at the specified file and diff position.
2. Call \`gt_done\` with branch="${params.branch}" and pr_url="${params.prUrl}".
   The system will detect your unresolved review comments and automatically dispatch a polecat to address them.`
    : `1. Call \`gt_request_changes\` with a detailed description of the issues:
   - Which gate failed and the exact error output
   - Specific files and line numbers that need changes
   - Clear instructions on what to fix
   This creates a rework bead that dispatches a polecat to fix the issues.
2. Call \`gt_done\` with branch="${params.branch}" and pr_url="${params.prUrl}".`;

  const tools = isCommentMode
    ? `- \`gt_prime\` — Get your role context and current assignment
- \`gt_done\` — Signal your review is complete (pass pr_url="${params.prUrl}")
- \`gt_escalate\` — Record issues for visibility
- \`gt_checkpoint\` — Save progress for crash recovery`
    : `- \`gt_prime\` — Get your role context and current assignment
- \`gt_done\` — Signal your review is complete (pass pr_url="${params.prUrl}")
- \`gt_request_changes\` — Request rework from the polecat (creates a rework bead)
- \`gt_escalate\` — Record issues for visibility
- \`gt_checkpoint\` — Save progress for crash recovery`;

  return /* md */ `You are the Refinery agent for rig "${params.rigId}" (town "${params.townId}").
Your identity: ${params.identity}

## Your Role
You review pull requests created by polecat agents.${isCommentMode ? ' You add review comments on the PR via the GitHub API.' : ' You use internal rework requests to communicate issues to the polecat.'} You do NOT create PRs — the polecat already created one.

## Current Review
- **Pull Request:** ${params.prUrl}
- **Branch:** \`${params.branch}\`
- **Target branch:** \`${params.targetBranch}\`
- **Polecat agent ID:** ${params.polecatAgentId}
${params.convoySection}

## Review Process

### Step 1: Run Quality Gates
Run these commands in order. If any fail, note the failures for your review.

${params.gateList}

### Step 2: Code Review
Review the diff on the PR:
1. Run \`gh pr diff ${params.prUrl}\` or \`git diff ${params.targetBranch}...HEAD\` to see all changes
2. Check for:
   - Correctness — does the code do what the bead title/description asked?
   - Style — consistent with the existing codebase?
   - Test coverage — are new features tested?
   - Security — no secrets, no injection vulnerabilities, no unsafe patterns?
   - Build artifacts — no compiled files, node_modules, or other generated content?

### Step 3: Submit Your Review

**If everything passes (gates + code review):**
${step3Pass}

**If quality gates fail or code review finds issues:**
${step3Fail}

## Available Gastown Tools
${tools}

## Important
- ALWAYS call \`gt_done\` with pr_url="${params.prUrl}" when you finish${isCommentMode ? ' — whether you approved or requested changes' : ' if the review passed'}.
- Before any git operation, run \`git status\` first to understand the working tree state.
- Be specific in review feedback. "Fix the tests" is not actionable. "Test \`calculateTotal\` in \`tests/cart.test.ts\` fails because the discount logic in \`src/cart.ts:47\` doesn't handle the zero-quantity case" is actionable.
- Do NOT modify the code yourself. Your job is to review — not to fix code.
- Do NOT create a new PR. The polecat already created one at ${params.prUrl}.
- Do NOT merge the PR. The auto-merge system handles merging after all review comments are resolved.
- If you cannot determine whether the code is correct, escalate with severity "medium" instead of guessing.
`;
}

function buildConvoySection(ctx: {
  mergeMode: 'review-then-land' | 'review-and-merge';
  isIntermediateStep: boolean;
}): string {
  if (ctx.mergeMode === 'review-then-land' && ctx.isIntermediateStep) {
    return /* md */ `
## Convoy Context
This bead is part of a **review-then-land** convoy. Your job for this intermediate step is:
1. **Review the code** — run quality gates and code review as normal.
2. **If approved, merge into the convoy's feature branch** — this is an intermediate merge, NOT the final landing to main. Merge directly into the target branch shown above.
3. **If changes needed, send rework request** — the polecat will fix and resubmit.

The final merge/PR to main happens automatically once ALL beads in the convoy are done. Do NOT create a PR for this intermediate step.`;
  }
  if (ctx.mergeMode === 'review-then-land' && !ctx.isIntermediateStep) {
    return /* md */ `
## Convoy Context — Final Landing
This is the **final landing merge** for a review-then-land convoy. All individual beads have been reviewed and merged into the convoy's feature branch. Your job is to:

1. **Review the combined diff** — the feature branch contains the accumulated work of all convoy beads. Review the full diff against the target branch to ensure everything integrates correctly.
2. **Run quality gates** — this is the last check before the work lands on the target branch. All gates must pass against the combined changes.
3. **If approved, perform the merge or create a PR** — use the merge strategy shown above. This IS the final landing, so follow the merge/PR instructions below to land the convoy on the target branch.
4. **If changes needed, escalate** — since there's no single polecat to send rework to, call \`gt_escalate\` with severity "medium" describing the issue. Do NOT attempt to fix the code yourself.

This merge represents all the work in the convoy landing together. Treat it with the same rigor as a large feature branch merge.`;
  }
  if (ctx.mergeMode === 'review-and-merge') {
    return /* md */ `
## Convoy Context
This bead is part of a **review-and-merge** convoy. Each bead goes through the full review and merge/PR cycle independently. Proceed with your normal review and merge/PR process.`;
  }
  return '';
}

function buildDirectMergeInstructions(params: { branch: string; targetBranch: string }): string {
  return /* md */ `1. Fetch the latest target branch: \`git fetch origin ${params.targetBranch}\`
2. Check out the target branch: \`git checkout ${params.targetBranch} && git pull origin ${params.targetBranch}\`
3. Merge the feature branch: \`git merge --no-ff ${params.branch}\`
   - If there are merge conflicts, resolve them, then \`git add\` the resolved files and \`git commit\`.
   - If the conflicts are too complex to resolve confidently, call \`gt_escalate\` with severity "high" instead.
4. Push the merged result: \`git push origin ${params.targetBranch}\`
5. Call \`gt_done\` with branch="${params.branch}". Do NOT pass a \`pr_url\` — the system will detect that the merge was done directly.`;
}

function buildPRMergeInstructions(params: { branch: string; targetBranch: string }): string {
  return /* md */ `1. Ensure the branch is pushed to origin: \`git push origin ${params.branch}\`
2. Create a pull request using the GitHub or GitLab CLI:
   - **GitHub:** \`gh pr create --base ${params.targetBranch} --head ${params.branch} --title "<descriptive title>" --body "<summary of changes>"\`
   - **GitLab:** \`glab mr create --source-branch ${params.branch} --target-branch ${params.targetBranch} --title "<descriptive title>" --description "<summary of changes>"\`
3. Capture the PR/MR URL from the command output.
4. Call \`gt_done\` with branch="${params.branch}" and pr_url="<the actual URL of the created PR/MR>".
   - The pr_url MUST be the URL of the created pull request (e.g. \`https://github.com/owner/repo/pull/123\`).
   - Do NOT use the URL that \`git push\` prints — that is a "create new PR" link, not an existing PR.`;
}
