import { usePreventRemove } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSheetDismissGuard } from '@/components/ui/use-sheet-dismiss-guard';
import { type PermissionState } from '@/lib/code-reviewer-status';
import {
  reviewMemoryOrganizationId,
  useReviewMemoryProposalActions,
} from '@/lib/hooks/use-review-memory';
import { isLeaveAction } from '@/lib/navigation/leave-actions';
import {
  isProposalActionable,
  proposalDraft,
  type ProposalDraft,
  type ReviewMemoryProposal,
  sameProposalDraft,
  validProposalDraft,
} from '@/lib/review-memory-proposals';
import { isTrialExpiredRefusal, knownServerErrorMessage } from '@/lib/server-error-copy';
import { useCanManageBilling, useTrialRefusalAction } from '@/lib/trial-refusal';

type ProposalAction = 'save' | 'reject' | 'approve';
type ProposalFailure = {
  action: ProposalAction;
  /**
   * The rejection as the mutation delivered it. The copy and the step under it
   * are derived from this and the reader's current role on every render: a
   * refusal that lands before the membership list settles would otherwise keep
   * the copy the then-unknown role produced beside a step the settled role
   * offers.
   */
  error: unknown;
};

export type ProposalEditorInput = Readonly<{
  scope: string;
  proposal: ReviewMemoryProposal;
  permission: PermissionState;
  available: boolean;
  /**
   * Dismiss the presented sheet. The sheet stays up until its native dismissal
   * reports, then calls this; `after` runs at that same point, so a step that
   * leaves for another route pushes it above a sheet that is already gone.
   */
  onClose: (after?: () => void) => void;
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
  const organizationId = reviewMemoryOrganizationId(scope);
  const canManageBilling = useCanManageBilling(organizationId);
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

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // A step that leaves this sheet (the billing step) parks its navigation here
  // and the sheet runs it from the native dismissal report. The guard's discard
  // question sits in between, so a dirty draft is never thrown away to reach it.
  const afterCloseRef = useRef<(() => void) | null>(null);
  const guard = useSheetDismissGuard({
    isDirty: () => !sameProposalDraft(draft.current, baseline.current),
    onDiscard: () => {
      const after = afterCloseRef.current;
      afterCloseRef.current = null;
      onCloseRef.current(after ?? undefined);
    },
  });

  // The sheet is a native sheet in its own window, so the route below it is out
  // of sight but still live: without this, a system Back (the iOS edge swipe has
  // no handler of its own here, and the sheet's own `interactiveDismissDisabled`
  // only blocks its drag) removed the review-memory route and left the sheet
  // presented over whatever screen the app fell back to. Back belongs to the
  // sheet instead: a mutation in flight keeps the sheet and the outcome it
  // awaits, and an idle sheet closes through the same keep-editing / discard
  // path as its Close control, so the user stays on the proposal list.
  //
  // Only a leave action is the sheet's to answer. Forward navigation — a
  // `replace` or `RESET` such as the sign-out, consent-required and
  // force-update redirects — must still run: the sheet closes with it and the
  // intercepted action is replayed, so the app goes where it was sent.
  const [leaveAllowed, setLeaveAllowed] = useState(false);
  const [leaveCount, setLeaveCount] = useState(0);
  const replayRef = useRef<(() => void) | null>(null);
  usePreventRemove(!leaveAllowed, ({ data, repeat }) => {
    if (!isLeaveAction(data.action.type)) {
      // The replay runs from the effect below, so this sheet is still mounted
      // when the intercepted action is dispatched; closing it here would drop
      // the replay with the unmounted guard.
      replayRef.current = repeat;
      setLeaveAllowed(true);
      setLeaveCount(count => count + 1);
      return;
    }
    if (pendingRef.current) {
      return;
    }
    guard.requestClose();
  });
  useEffect(() => {
    const replay = replayRef.current;
    replayRef.current = null;
    if (replay === null) {
      return;
    }
    replay();
    onCloseRef.current();
  }, [leaveCount]);

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
        afterCloseRef.current = null;
        onCloseRef.current();
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
      setFailure({ action, error });
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  // The refusal's sentence and the step under it are both opaque to the state:
  // they are derived here, on every render, from the one raw rejection and the
  // role the membership list currently reports. A refusal that lands before the
  // list settles therefore gains the billing sentence and the step together, and
  // a later role change moves both, instead of the sentence freezing the role
  // the refusal happened to see.
  const failureMessage =
    failure === null
      ? null
      : (knownServerErrorMessage(failure.error, canManageBilling) ??
        t('common.somethingWentWrong'));
  // Only the trial refusal offers a step, and the hook withholds it from a role
  // the server would refuse.
  const failureAction = useTrialRefusalAction(
    failure !== null && isTrialExpiredRefusal(failure.error),
    organizationId
  );

  return {
    record,
    draft,
    revision,
    dirty,
    valid,
    failure,
    failureMessage,
    failureAction,
    pending,
    canEdit,
    busy,
    changeField,
    perform,
    dialog: guard.dialog,
    requestClose: () => {
      if (!pendingRef.current) {
        afterCloseRef.current = null;
        guard.requestClose();
      }
    },
    /**
     * The step of a refusal that leaves for another route: the sheet closes
     * first (asking about a dirty draft), and `after` runs once its native
     * dismissal reports. Pushing before that would put the route in the stack
     * behind a sheet that is still presented, where the tap looks dead.
     */
    requestCloseThen: (after: () => void) => {
      if (!pendingRef.current) {
        afterCloseRef.current = after;
        guard.requestClose();
      }
    },
    requestDismiss: () => !pendingRef.current && guard.requestDismiss(),
  };
}
