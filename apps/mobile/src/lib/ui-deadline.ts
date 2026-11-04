import { i18n } from '@/i18n';

const noopDeadlineRejection = (_error: Error) => undefined;

/** Name carried by the rejection this module raises, so callers can tell a
 * deadline apart from the operation's own failure. */
const UI_DEADLINE_ERROR_NAME = 'UiDeadlineError';

/** True for the rejection `withUiDeadline` raises when the operation overruns. */
export function isUiDeadlineError(error: unknown): boolean {
  return error instanceof Error && error.name === UI_DEADLINE_ERROR_NAME;
}

export async function withUiDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let rejectDeadline: (error: Error) => void = noopDeadlineRejection;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timeoutId = setTimeout(() => {
    const error = new Error(i18n.t('common.takingLonger'));
    error.name = UI_DEADLINE_ERROR_NAME;
    rejectDeadline(error);
  }, timeoutMs);

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}
