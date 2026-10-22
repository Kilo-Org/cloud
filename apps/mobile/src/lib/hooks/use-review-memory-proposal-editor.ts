import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSheetDismissGuard } from '@/components/ui/use-sheet-dismiss-guard';
import { type PermissionState } from '@/lib/code-reviewer-status';
import { useReviewMemoryProposalActions } from '@/lib/hooks/use-review-memory';
import {
  isProposalActionable,
  proposalDraft,
  type ProposalDraft,
  type ReviewMemoryProposal,
  sameProposalDraft,
  validProposalDraft,
} from '@/lib/review-memory-proposals';

type ProposalAction = 'save' | 'reject' | 'approve';
type ProposalFailure = { action: ProposalAction; message: string };

export type ProposalEditorInput = Readonly<{
  scope: string;
  proposal: ReviewMemoryProposal;
  permission: PermissionState;
  available: boolean;
  onClose: () => void;
}>;

export function useReviewMemoryProposalEditor({
  scope,
  proposal,
  permission,
  available,
  onClose,
}: ProposalEditorInput) {
  const { t } = useTranslation();
  const actions = useReviewMemoryProposalActions(scope);
  const [record, setRecord] = useState(proposal);
  const baseline = useRef(proposalDraft(proposal));
  const draft = useRef(baseline.current);
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [valid, setValid] = useState(validProposalDraft(draft.current));
  const [failure, setFailure] = useState<ProposalFailure | null>(null);
  const [pending, setPending] = useState<ProposalAction | null>(null);
  const pendingRef = useRef(false);
  const canEdit =
    available &&
    permission.status === 'ready' &&
    permission.canEdit &&
    isProposalActionable(proposal.status) &&
    isProposalActionable(record.status);
  const busy = pending !== null || actions.isPending;

  useEffect(() => {
    setRecord(proposal);
    if (!sameProposalDraft(draft.current, baseline.current)) {
      return;
    }
    const next = proposalDraft(proposal);
    baseline.current = next;
    draft.current = next;
    setRevision(value => value + 1);
    setDirty(false);
    setValid(validProposalDraft(next));
  }, [proposal]);

  const guard = useSheetDismissGuard({
    isDirty: () => !sameProposalDraft(draft.current, baseline.current),
    onDiscard: onClose,
  });

  const changeField = (field: keyof ProposalDraft, value: string) => {
    draft.current = { ...draft.current, [field]: value };
    setDirty(!sameProposalDraft(draft.current, baseline.current));
    setValid(validProposalDraft(draft.current));
  };

  const perform = async (action: ProposalAction) => {
    if (!canEdit || busy || pendingRef.current) {
      return;
    }
    const unsaved = !sameProposalDraft(draft.current, baseline.current);
    if (
      (action === 'save' && (!unsaved || !validProposalDraft(draft.current))) ||
      (action === 'approve' && unsaved)
    ) {
      return;
    }
    pendingRef.current = true;
    setPending(action);
    setFailure(null);
    try {
      if (action === 'reject') {
        await actions.reject(record.id);
        onClose();
        return;
      }
      const updated =
        action === 'save'
          ? await actions.save(record.id, { ...draft.current })
          : await actions.approve(record.id);
      setRecord(updated);
      const next = proposalDraft(updated);
      baseline.current = next;
      draft.current = next;
      setRevision(value => value + 1);
      setDirty(false);
      setValid(validProposalDraft(next));
    } catch (error) {
      setFailure({
        action,
        message: error instanceof Error ? error.message : t('common.somethingWentWrong'),
      });
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  return {
    record,
    draft,
    revision,
    dirty,
    valid,
    failure,
    pending,
    canEdit,
    busy,
    changeField,
    perform,
    dialog: guard.dialog,
    requestClose: () => {
      if (!pendingRef.current) {
        guard.requestClose();
      }
    },
    requestDismiss: () => !pendingRef.current && guard.requestDismiss(),
  };
}
