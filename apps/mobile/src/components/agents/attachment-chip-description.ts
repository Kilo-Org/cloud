import { i18n } from '@/i18n';
import { formatFileSize, formatPercent } from '@/lib/format';

export type ChipStateInput = {
  filename: string;
  size: number;
  status: 'pending' | 'uploading' | 'uploaded' | 'error';
  progress: number | null;
  terminal?: boolean;
};

type ChipDescription = {
  /** Always present — the original filename. */
  filename: string;
  /** Human-readable file size (e.g. "1 KB"). Always present. */
  sizeText: string;
  /**
   * Progress label for in-flight and uploaded states (e.g. "42%" or
   * "Uploaded"). Empty string when no progress is surfaced.
   */
  progressText: string;
  /**
   * Error message for failed states. `null` for non-error states — the
   * chip renders the message in place of the size/progress secondary
   * text and never both.
   */
  message: string | null;
  /**
   * Composed screen-reader label for the chip body: `<filename>, <message>`
   * for failed chips, `<filename>, <progressText>` otherwise. Covers both
   * file and image chips so the strip's single accessible body element is
   * labeled in every FSM state.
   */
  accessibilityLabel: string;
  /** True ONLY for retryable error chips — drives the tap-to-retry affordance. */
  showRetry: boolean;
  /** True for every rendered chip — drives the X remove affordance. */
  showRemove: boolean;
};

/**
 * Human-readable progress label. `progress` is `null` when the upload task
 * could not determine a total (server did not advertise Content-Length);
 * we surface that honestly instead of fabricating a percentage.
 */
export function progressLabel(progress: number | null): string {
  if (progress === null) {
    return i18n.t('agentChat.attachmentPreview.uploading');
  }
  if (progress >= 1) {
    return i18n.t('agentChat.attachmentPreview.uploaded');
  }
  return formatPercent(progress * 100, i18n.language);
}

/**
 * Pure projection of the document-kind attachment chip. Kept separate
 * from the React component so every feature state (happy, retryable,
 * terminal, indeterminate progress) can be unit-tested without a
 * renderer. The image-kind chip is a thumbnail overlay and shares no
 * state-dependent text; the description below covers the document chip.
 */
export function describeAttachmentChip(state: ChipStateInput): ChipDescription {
  const { filename, size, status, progress, terminal } = state;
  const isErrored = status === 'error';
  // Explicit `terminal === false` check: a chip is only retryable when
  // the server-side flag is set to `false` (transient failure). An
  // undefined `terminal` flag defaults to the conservative non-retryable
  // bucket so a stray missing field cannot silently enable retry on a
  // server-rejected file.
  const isRetryable = isErrored && terminal === false;

  let message: string | null = null;
  if (isErrored) {
    message = isRetryable
      ? i18n.t('agentChat.attachmentPreview.uploadFailedRetry')
      : i18n.t('agentChat.attachmentPreview.uploadFailedTerminal');
  }

  let progressText = '';
  if (status === 'pending' || status === 'uploading' || status === 'uploaded') {
    progressText = progressLabel(progress);
  }

  return {
    filename,
    sizeText: formatFileSize(size, i18n.language),
    progressText,
    message,
    accessibilityLabel:
      message !== null ? `${filename}, ${message}` : `${filename}, ${progressText}`,
    showRetry: isRetryable,
    showRemove: true,
  };
}
