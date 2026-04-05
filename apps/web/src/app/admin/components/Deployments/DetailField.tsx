'use client';

import { ExternalLink } from 'lucide-react';
import { CopyButton } from '@/components/admin/CopyButton';
import { cn } from '@/lib/utils';

type DetailFieldProps = {
  label: string;
  value: string | null | undefined;
  fallback?: string;
  copyable?: boolean;
  copyLabel?: string;
  fullWidth?: boolean;
  monospace?: boolean;
  smallText?: boolean;
  capitalize?: boolean;
  asLink?: boolean;
  children?: React.ReactNode;
};

export function DetailField({
  label,
  value,
  fallback = 'N/A',
  copyable = false,
  copyLabel,
  fullWidth = false,
  monospace = false,
  smallText = false,
  capitalize = false,
  asLink = false,
  children,
}: DetailFieldProps) {
  const displayValue = value || fallback;
  const hasCopyableValue = copyable && value;

  return (
    <div className={cn('flex items-baseline gap-2', fullWidth && 'col-span-2')}>
      <dt className="text-muted-foreground shrink-0">{label}:</dt>
      <dd
        className={cn(
          'font-medium',
          monospace && 'font-mono',
          smallText && 'text-xs',
          capitalize && 'capitalize',
          (fullWidth || asLink) && 'min-w-0 flex-1',
          !fullWidth && !asLink && 'truncate'
        )}
        title={value || undefined}
      >
        {children ??
          (asLink && value ? (
            <a
              href={value}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
              title={value}
            >
              <span className="truncate">{value}</span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
          ) : (
            displayValue
          ))}
      </dd>
      {hasCopyableValue && (
        <CopyButton
          text={value}
          label={copyLabel || label}
          className="hover:bg-muted size-5 shrink-0"
        />
      )}
    </div>
  );
}
