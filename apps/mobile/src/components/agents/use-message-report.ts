import { type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { announcingToast } from '@/lib/a11y/announcing-toast';
import { useKeyedSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { useTRPC } from '@/lib/trpc';

import {
  buildReportAiResponseErrorToast,
  buildReportAiResponseInput,
  classifyReportAiResponseFailure,
  type ReportAiResponseInput,
  reportAiResponseSubmittedToast,
  shouldShowReportAiResponse,
} from './report-ai-response';

/** The report's own refusal; the toast owns the copy, the phase only the button. */
type ReportFailure = { readonly kind: 'report-failed' };

/** What the sheet's confirm surface needs to ask before reporting. */
export type ReportConfirmRequest = Readonly<{
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
}>;

/**
 * One report's phase on the details sheet, keyed by the message it reports.
 *
 * Keyed and awaited: the sheet can switch messages while a report is in flight,
 * so two reports overlap, and a per-call callback would be replaced by a later
 * mutation on the same hook. The invocation that started a report is the one
 * that settles its attempt.
 */
/** What the sheet's Report control renders and calls. */
export type MessageReport = Readonly<{ showReport: boolean; handleReport: () => void }>;

export function useMessageReport(
  message: StoredMessage | null,
  requestConfirm: (request: ReportConfirmRequest) => void
): MessageReport {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const report = useKeyedSurfaceFeedback<string, ReportFailure>();

  const reportMutation = useMutation(
    trpc.moderation.reportContent.mutationOptions({
      onSuccess: result => {
        announcingToast.success(reportAiResponseSubmittedToast(result.receiptId));
      },
    })
  );

  const startReport = (input: ReportAiResponseInput) => {
    const attempt = report.begin(input.targetId);
    if (attempt === null) {
      // This message is already reporting.
      return;
    }
    void (async () => {
      try {
        await reportMutation.mutateAsync(input);
        // The button staying hidden is the rendered outcome of a report.
        attempt.succeed();
      } catch (error) {
        attempt.fail({ kind: 'report-failed' });
        const failure = classifyReportAiResponseFailure(error);
        const errorToast = buildReportAiResponseErrorToast(failure, () => {
          startReport(input);
        });
        announcingToast.error(
          errorToast.message,
          errorToast.action ? { action: errorToast.action } : undefined
        );
      }
    })();
  };

  const phase = message === null ? undefined : report.snapshot.states.get(message.info.id);
  return {
    showReport:
      message !== null &&
      shouldShowReportAiResponse(message) &&
      phase?.status !== 'pending' &&
      phase?.status !== 'succeeded',
    handleReport: () => {
      if (message === null) {
        return;
      }
      const input = buildReportAiResponseInput(message);
      if (input === null) {
        return;
      }
      requestConfirm({
        title: t('agentChat.messageDetails.reportAiResponse'),
        message: t('agentChat.messageDetails.reportAiResponseConfirm'),
        confirmLabel: t('agentChat.messageDetails.report'),
        onConfirm: () => {
          startReport(input);
        },
      });
    },
  };
}
