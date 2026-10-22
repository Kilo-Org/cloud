'use client';

import { useId } from 'react';
import { Box, TriangleAlert } from 'lucide-react';
import type { SelectableSandboxAllocation } from '@kilocode/worker-utils/sandbox-allocation';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  describeUnavailableSandbox,
  groupChoicesByProvider,
  toSelectableAllocation,
  withSavedChoice,
  type DefaultSandboxDescription,
  type SandboxAllocationChoice,
} from './settings-options';

const NONE = 'none';

type SandboxSelectProps = {
  value: SelectableSandboxAllocation | null;
  choices: SandboxAllocationChoice[];
  unavailableReason: string | undefined;
  noneLabel: string;
  /** What `noneLabel` resolves to. Shown beside it so the default is not a mystery. */
  noneDescription?: DefaultSandboxDescription;
  labelledBy: string;
  disabled: boolean;
  className?: string;
  layout?: 'compact' | 'detailed';
  onChange: (allocation: SelectableSandboxAllocation | null) => void;
};

export function SandboxSelect({
  value,
  choices,
  unavailableReason,
  noneLabel,
  noneDescription,
  labelledBy,
  disabled,
  className,
  layout = 'detailed',
  onChange,
}: SandboxSelectProps) {
  const noteId = useId();
  const options = withSavedChoice(choices, value, unavailableReason);
  const selected = options.find(choice => choice.allocation === value);
  const warning = selected?.unavailableReason;

  // Nothing to choose from and nothing saved: show where sessions run instead
  // of a control that cannot be used.
  if (!value && options.length === 0) {
    return (
      <p className={cn('text-sm tabular-nums', className)}>{noneDescription?.full ?? noneLabel}</p>
    );
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Select
        value={value ?? NONE}
        onValueChange={next => onChange(next === NONE ? null : toSelectableAllocation(next))}
        disabled={disabled}
      >
        <SelectTrigger
          className={cn(
            'text-foreground w-full text-left *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:line-clamp-none *:data-[slot=select-value]:block',
            layout === 'detailed' && 'py-2 whitespace-normal data-[size=default]:h-auto'
          )}
          title={layout === 'compact' ? selected?.provider : undefined}
          aria-labelledby={labelledBy}
          aria-describedby={warning ? noteId : undefined}
        >
          <SelectValue className="min-w-0">
            <span className="flex min-w-0 items-center gap-3">
              <Box className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
              <span className="block min-w-0 space-y-1">
                <span
                  className={cn(
                    'block font-medium tabular-nums',
                    layout === 'compact' && 'truncate'
                  )}
                >
                  {selected?.instance ?? noneLabel}
                </span>
                {layout === 'detailed' && (selected?.provider || noneDescription) && (
                  <span className="text-muted-foreground block text-xs leading-5">
                    {selected?.provider ?? noneDescription?.summary}
                  </span>
                )}
              </span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="max-w-[calc(100vw-2rem)]">
          <SelectItem value={NONE} textValue={noneLabel}>
            <span className="block min-w-0 py-1">
              <span className="block">{noneLabel}</span>
              {noneDescription && (
                <span className="text-muted-foreground block text-xs tabular-nums">
                  {noneDescription.summary}
                </span>
              )}
            </span>
          </SelectItem>
          {options.length > 0 && <SelectSeparator />}
          {groupChoicesByProvider(options).map(group => (
            <SelectGroup key={group.provider}>
              <SelectLabel>{group.provider}</SelectLabel>
              {group.choices.map(choice => (
                <SelectItem
                  key={choice.allocation}
                  value={choice.allocation}
                  textValue={choice.instance}
                  disabled={!!choice.unavailableReason}
                >
                  <span className="tabular-nums">{choice.instance}</span>
                  {choice.unavailableReason && (
                    <span className="text-muted-foreground"> · Unavailable</span>
                  )}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {warning && (
        <p id={noteId} className="text-status-warning flex items-start gap-1.5 text-xs">
          <TriangleAlert className="text-status-warning-icon mt-px size-3.5 shrink-0" aria-hidden />
          {describeUnavailableSandbox(warning)}
        </p>
      )}
    </div>
  );
}
