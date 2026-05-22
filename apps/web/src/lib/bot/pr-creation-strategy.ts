export type PrCreationStrategy = 'default' | 'force-new';

const NEW_PR_OR_MR_PATTERNS = [
  /\b(?:open|create|start)\s+(?:a\s+)?new\s+(?:pr|pull\s+request|mr|merge\s+request)\b/i,
  /\b(?:open|create|start)\s+(?:a\s+)?(?:separate|fresh)\s+(?:pr|pull\s+request|mr|merge\s+request)\b/i,
  /\bnew\s+(?:pr|pull\s+request|mr|merge\s+request)\b/i,
  /\b(?:separate|fresh)\s+(?:pr|pull\s+request|mr|merge\s+request)\b/i,
  /\b(?:pr|pull\s+request|mr|merge\s+request)\s+separately\b/i,
];

const NEGATED_NEW_PR_OR_MR_PATTERNS = [
  /\b(?:do\s+not|don't|dont)\s+(?:open|create|start)\s+(?:a\s+)?new\s+(?:pr|pull\s+request|mr|merge\s+request)\b/i,
  /\bwithout\s+(?:opening|creating|starting)\s+(?:a\s+)?new\s+(?:pr|pull\s+request|mr|merge\s+request)\b/i,
  /\bno\s+new\s+(?:pr|pull\s+request|mr|merge\s+request)\b/i,
  /\b(?:update|use|keep)\s+(?:the\s+)?existing\s+(?:pr|pull\s+request|mr|merge\s+request)\b/i,
];

export function detectPrCreationStrategy(text: string): PrCreationStrategy {
  if (NEGATED_NEW_PR_OR_MR_PATTERNS.some(pattern => pattern.test(text))) {
    return 'default';
  }

  return NEW_PR_OR_MR_PATTERNS.some(pattern => pattern.test(text)) ? 'force-new' : 'default';
}

export function buildForceNewPrInstruction(chatPlatform: string): string {
  const platformLabel = chatPlatform === 'gitlab' ? 'MR' : 'PR';
  const baseBranchGuidance =
    chatPlatform === 'gitlab'
      ? 'For GitLab MR-origin comments, base the new MR on the original MR target branch and avoid pushing to or modifying the original MR source branch unless the user explicitly names a different target.'
      : 'For GitHub PR-origin comments, base the new PR on the original PR base branch and avoid pushing to or modifying the original PR head branch unless the user explicitly names a different target.';

  return `\n\n<Kilo enforced instruction>\nThe original requester explicitly asked for a separate new ${platformLabel}. You must create a fresh branch, open a separate ${platformLabel}, and must not push to or modify the branch of the PR/MR where the comment was made. ${baseBranchGuidance}\n</Kilo enforced instruction>`;
}
