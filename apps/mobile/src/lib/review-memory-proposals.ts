import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { type TFunction } from 'i18next';

export type ReviewMemoryProposal =
  inferRouterOutputs<MobileRouter>['reviewMemory']['listProposalsPage']['proposals'][number];

export const ACTIVE_PROPOSAL_STATUSES = [
  'open',
  'edited',
  'opening_change_request',
  'change_request_opened',
  'change_request_failed',
] satisfies ReviewMemoryProposal['status'][];

export function isProposalActionable(status: ReviewMemoryProposal['status']) {
  return status === 'open' || status === 'edited' || status === 'change_request_failed';
}

export function proposalStatusLabel(status: ReviewMemoryProposal['status'], t: TFunction) {
  switch (status) {
    case 'open': {
      return t('prReview.entry.open');
    }
    case 'edited': {
      return t('codeReviewer.reviewMemory.status.edited');
    }
    case 'opening_change_request': {
      return t('codeReviewer.reviewMemory.status.opening_change_request');
    }
    case 'change_request_opened': {
      return t('securityAgent.auditReport.eventActions.remediationPrOpened');
    }
    case 'change_request_failed': {
      return t('codeReviewer.reviewMemory.status.change_request_failed');
    }
    case 'rejected': {
      return t('common.dismissed');
    }
    case 'superseded': {
      return t('codeReviewer.reviewMemory.status.superseded');
    }
    default: {
      return t('common.unknown');
    }
  }
}

export type ProposalDraft = {
  title: string;
  rationale: string;
  proposedMarkdown: string;
};

export function proposalDraft(proposal: ReviewMemoryProposal): ProposalDraft {
  return {
    title: proposal.title,
    rationale: proposal.rationale,
    proposedMarkdown: proposal.proposed_markdown,
  };
}

export function sameProposalDraft(left: ProposalDraft, right: ProposalDraft) {
  return (
    left.title === right.title &&
    left.rationale === right.rationale &&
    left.proposedMarkdown === right.proposedMarkdown
  );
}

export function validProposalDraft(draft: ProposalDraft) {
  return (
    draft.title.trim().length > 0 &&
    draft.title.length <= 140 &&
    draft.rationale.trim().length > 0 &&
    draft.rationale.length <= 1_500 &&
    draft.proposedMarkdown.trim().length > 0 &&
    draft.proposedMarkdown.length <= 4_000
  );
}
