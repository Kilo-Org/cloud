import type { SecurityFinding } from '@kilocode/db/schema';

export const DISMISS_REASONS = [
  {
    value: 'fix_started',
    label: 'Fix started',
    description: 'A fix for this vulnerability has been started',
  },
  {
    value: 'no_bandwidth',
    label: 'No bandwidth',
    description: 'No bandwidth to fix this vulnerability at this time',
  },
  {
    value: 'tolerable_risk',
    label: 'Tolerable risk',
    description: 'The risk is tolerable for this project',
  },
  {
    value: 'inaccurate',
    label: 'Inaccurate',
    description: 'This alert is inaccurate or incorrect',
  },
  {
    value: 'not_used',
    label: 'Not used',
    description: 'This vulnerable code is not actually used',
  },
] as const;

export type DismissReason = (typeof DISMISS_REASONS)[number]['value'];

type DismissFindingFormDefaults = {
  reason: DismissReason;
  comment: string;
};

export const MAX_DISMISS_COMMENT_LENGTH = 280;

const EMPTY_DISMISS_FORM: DismissFindingFormDefaults = {
  reason: 'not_used',
  comment: '',
};

function truncateDismissComment(comment: string): string {
  if (comment.length <= MAX_DISMISS_COMMENT_LENGTH) return comment;
  return `${comment.slice(0, MAX_DISMISS_COMMENT_LENGTH - 1)}…`;
}

export function getDismissFindingFormDefaults(
  analysis: SecurityFinding['analysis'] | undefined
): DismissFindingFormDefaults {
  const sandbox = analysis?.sandboxAnalysis;
  if (sandbox) {
    if (sandbox.isExploitable === false) {
      return {
        reason: 'not_used',
        comment: truncateDismissComment(sandbox.exploitabilityReasoning),
      };
    }
    return EMPTY_DISMISS_FORM;
  }

  const triage = analysis?.triage;
  if (triage?.needsSandboxAnalysis === false && triage.suggestedAction === 'dismiss') {
    return {
      reason: 'not_used',
      comment: truncateDismissComment(triage.needsSandboxReasoning),
    };
  }

  return EMPTY_DISMISS_FORM;
}
