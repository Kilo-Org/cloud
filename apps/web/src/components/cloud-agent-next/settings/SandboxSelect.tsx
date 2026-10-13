'use client';

import { useId } from 'react';
import { TriangleAlert } from 'lucide-react';
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
          className="w-full pointer-coarse:min-h-11"
          aria-labelledby={labelledBy}
          aria-describedby={warning ? noteId : undefined}
        >
          <SelectValue className="min-w-0">
            <span className={cn('truncate tabular-nums', !selected && 'text-muted-foreground')}>
              {selected?.summary ?? noneText(noneLabel, noneDescription)}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE} textValue={noneLabel}>
            <span className="tabular-nums">{noneText(noneLabel, noneDescription)}</span>
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

function noneText(label: string, description: DefaultSandboxDescription | undefined): string {
  return description ? `${label} · ${description.summary}` : label;
}
