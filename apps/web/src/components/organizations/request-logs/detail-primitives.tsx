import type { ReactNode } from 'react';
import { CopyButton } from '@/components/shared/CopyButton';
import { cn } from '@/lib/utils';
import { ABSENT } from './format';
import type { StepTone } from './routing-labels';

export function DetailSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="text-muted-foreground text-xs">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** `copyValue` adds a copy button and a tooltip with the full value, for values that truncate. */
export type DetailItem = { label: string; value: ReactNode; mono?: boolean; copyValue?: string };

export function DetailGrid({ items }: { items: DetailItem[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
      {items.map(item => (
        <div key={item.label} className="group flex min-w-0 flex-col gap-0.5">
          <dt className="text-muted-foreground text-xs">{item.label}</dt>
          <dd className="flex min-w-0 items-center gap-1">
            <span
              className={cn(
                'text-sm',
                item.copyValue ? 'truncate' : 'min-w-0 break-words',
                item.mono && 'font-mono text-xs leading-5'
              )}
              title={item.copyValue}
            >
              {item.value}
            </span>
            {item.copyValue && (
              <CopyButton
                text={item.copyValue}
                label={item.label.toLowerCase()}
                className="shrink-0 p-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100 [&_svg]:size-3.5"
              />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export const TONE_CLASSNAMES: Record<StepTone, string> = {
  selected: 'border-status-success-border bg-status-success-surface text-status-success',
  skipped: 'border-border bg-muted text-muted-foreground',
  rejected:
    'border-status-destructive-border bg-status-destructive-surface text-status-destructive',
  deferred: 'border-status-warning-border bg-status-warning-surface text-status-warning',
  info: 'border-status-neutral-border bg-status-neutral-surface text-status-neutral',
};

export function ToneBadge({ tone, children }: { tone: StepTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE_CLASSNAMES[tone]
      )}
    >
      {children}
    </span>
  );
}

/** For table cells; `font-sans` keeps the dash identical inside monospace cells. */
export const ABSENT_CELL = <span className="text-muted-foreground font-sans">{ABSENT}</span>;

export function yesNo(value: boolean | null): string {
  if (value === null) return ABSENT;
  return value ? 'Yes' : 'No';
}
