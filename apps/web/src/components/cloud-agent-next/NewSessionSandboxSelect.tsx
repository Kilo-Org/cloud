'use client';

import { getSandboxAllocationKey } from '@kilocode/worker-utils/sandbox-allocation';
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
import {
  DEFAULT_SANDBOX_VALUE,
  formatSandboxDestination,
  formatSandboxDestinationWithoutTier,
  formatSandboxInstance,
  type getSandboxSelectionGroups,
  type SandboxPickerState,
} from './sandbox-selection';

type NewSessionSandboxSelectProps = {
  picker: SandboxPickerState;
  groups: ReturnType<typeof getSandboxSelectionGroups>;
  invalid: boolean;
  describedBy: string | undefined;
  onChoose: (value: string) => void;
};

/** Sandbox picker of the new session composer. The default is a regular entry, marked as such. */
export function NewSessionSandboxSelect({
  picker,
  groups,
  invalid,
  describedBy,
  onChoose,
}: NewSessionSandboxSelectProps) {
  const { defaultDestination, defaultKey } = picker;
  const showSeparateDefault = defaultKey === undefined && defaultDestination !== undefined;

  return (
    <Select value={picker.value} onValueChange={onChoose}>
      <SelectTrigger
        id="new-session-sandbox"
        size="sm"
        className="text-muted-foreground hover:text-foreground hover:bg-accent data-[state=open]:bg-accent min-w-0 max-w-full border-transparent bg-transparent px-2 text-xs shadow-none sm:max-w-80 [@media(pointer:coarse)]:min-h-11"
        aria-label={`Run on ${formatSandboxDestination(picker.destination)}`}
        aria-describedby={describedBy}
        aria-invalid={invalid}
      >
        <SelectValue className="min-w-0">
          <span className="truncate">
            {formatSandboxDestinationWithoutTier(picker.destination)}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="max-w-[calc(100vw-2rem)]">
        {showSeparateDefault && (
          <>
            <SelectItem
              value={DEFAULT_SANDBOX_VALUE}
              textValue={formatSandboxDestination(defaultDestination)}
              className="[@media(pointer:coarse)]:min-h-11"
            >
              <span className="whitespace-normal tabular-nums">
                {formatSandboxDestination(defaultDestination)}
                <DefaultMark />
              </span>
            </SelectItem>
            {groups.length > 0 && <SelectSeparator />}
          </>
        )}
        {groups.map(group => (
          <SelectGroup key={group.key} className="py-1">
            <SelectLabel className="text-foreground font-semibold">{group.label}</SelectLabel>
            {group.options.map(option => {
              const key = getSandboxAllocationKey(option.allocation);
              return (
                <SelectItem
                  key={key}
                  value={key}
                  textValue={formatSandboxInstance(option.allocation)}
                  aria-label={`${formatSandboxDestination(option.allocation)}${key === defaultKey ? ' (default)' : ''}`}
                  className="[@media(pointer:coarse)]:min-h-11"
                >
                  <span className="whitespace-normal tabular-nums">
                    {formatSandboxInstance(option.allocation)}
                    {key === defaultKey && <DefaultMark />}
                  </span>
                </SelectItem>
              );
            })}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function DefaultMark() {
  return <span className="text-muted-foreground"> · Default</span>;
}
