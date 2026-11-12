import type { JSX } from 'react';
import { AlertTriangle } from 'lucide-react';
import { describeFetchError } from '@/src/shared/agent-turn-error';

export { describeFetchError };
export type { DescribedFetchError } from '@/src/shared/agent-turn-error';

// eslint-disable-next-line typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface in new code.
export type ErrorNoticeAction = {
  readonly href: string;
  readonly label: string;
};

// eslint-disable-next-line typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface in new code.
export type ErrorNoticeProps = {
  readonly action?: ErrorNoticeAction | undefined;
  /** Disables Retry while a retry is in flight. */
  readonly busy?: boolean | undefined;
  /** The server's own reason, never a raw status code or fetch failure. */
  readonly detail?: string | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly retryable: boolean;
  readonly title: string;
};

const secondaryControlClassName =
  'inline-flex h-8 shrink-0 items-center rounded-md border border-border bg-surface-overlay px-2 type-label text-foreground-on-secondary outline-none transition hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand-primary-ring ring-offset-2 ring-offset-surface-background disabled:cursor-not-allowed disabled:opacity-50';

export const ErrorNotice = ({
  action,
  busy = false,
  detail,
  onRetry,
  retryable,
  title,
}: ErrorNoticeProps): JSX.Element => {
  const showRetry = retryable && onRetry !== undefined;

  return (
    <div
      className="min-w-0 rounded-lg border border-status-red-500/30 bg-status-red-500/10 px-3 py-2"
      role="alert"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-status-red-400"
        />
        <div className="min-w-0 flex-1">
          <p className="type-label font-semibold text-status-red-300">{title}</p>
          {detail === undefined ? null : (
            <p className="mt-1 break-words text-xs leading-4 text-foreground-muted">{detail}</p>
          )}
        </div>
      </div>
      {showRetry || action !== undefined ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-5.5">
          {showRetry ? (
            <button
              aria-busy={busy}
              className={secondaryControlClassName}
              disabled={busy}
              onClick={onRetry}
              type="button"
            >
              {busy ? 'Retrying…' : 'Retry'}
            </button>
          ) : null}
          {action === undefined ? null : (
            <a
              className={secondaryControlClassName}
              href={action.href}
              rel="noopener noreferrer"
              target="_blank"
            >
              {action.label}
            </a>
          )}
        </div>
      ) : null}
    </div>
  );
};
