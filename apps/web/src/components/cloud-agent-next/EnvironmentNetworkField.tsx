'use client';

import { useId } from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  getSandboxAllocationProvider,
  type SelectableSandboxAllocation,
} from '@kilocode/worker-utils/sandbox-allocation';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { NetworkAccessDraft, NetworkAccessMode } from './environment-form';

const NETWORK_ACCESS_OPTIONS: readonly {
  value: NetworkAccessMode;
  label: string;
  description: string;
}[] = [
  { value: 'none', label: 'None', description: 'No additional internet access' },
  { value: 'limited', label: 'Limited', description: 'Only the additional domains listed below' },
  { value: 'full', label: 'Full', description: 'Any domain' },
];

function labelForMode(mode: NetworkAccessMode): string {
  return NETWORK_ACCESS_OPTIONS.find(option => option.value === mode)?.label ?? 'Full';
}

type EnvironmentNetworkFieldProps = {
  value: NetworkAccessDraft;
  /** Current draft allocation, used only for advisory compatibility guidance. */
  sandboxAllocation: SelectableSandboxAllocation | null;
  error: string | null;
  disabled: boolean;
  onChange: (value: NetworkAccessDraft) => void;
};

/**
 * Which destinations sessions in this repository may reach. The server keeps the
 * Kilo, Git, and repository-host baseline in every mode.
 */
export function EnvironmentNetworkField({
  value,
  sandboxAllocation,
  error,
  disabled,
  onChange,
}: EnvironmentNetworkFieldProps) {
  const modeId = useId();
  const helpId = useId();
  const domainsId = useId();
  const domainsHelpId = useId();
  const domainsErrorId = useId();
  const warning = describeRestrictionSupport(value.mode, sandboxAllocation);

  return (
    <div className="grid gap-2">
      <Label id={modeId} className="text-xs">
        Network access
      </Label>
      <Select
        value={value.mode}
        onValueChange={mode => onChange({ ...value, mode: mode as NetworkAccessMode })}
        disabled={disabled}
      >
        <SelectTrigger className="w-full" aria-labelledby={modeId} aria-describedby={helpId}>
          <SelectValue>{labelForMode(value.mode)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {NETWORK_ACCESS_OPTIONS.map(option => (
            <SelectItem key={option.value} value={option.value} textValue={option.label}>
              <div className="flex flex-col gap-0.5 py-0.5">
                <span>{option.label}</span>
                <span className="text-muted-foreground text-xs font-normal">
                  {option.description}
                </span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={helpId} className="text-muted-foreground text-xs leading-5">
        Kilo services, supported Git services, and the repository host stay reachable in every mode.
      </p>
      {warning && (
        <p role="status" className="text-status-warning flex items-start gap-1.5 text-xs leading-5">
          <TriangleAlert className="text-status-warning-icon mt-px size-3.5 shrink-0" aria-hidden />
          {warning}
        </p>
      )}
      {value.mode === 'limited' && (
        <div className="grid gap-1.5 pt-1">
          <Label htmlFor={domainsId} className="text-xs">
            Additional allowed domains
          </Label>
          <Textarea
            id={domainsId}
            value={value.domains}
            onChange={event => onChange({ ...value, domains: event.target.value })}
            rows={4}
            placeholder={'registry.npmjs.org\napi.example.com'}
            className="min-h-24 resize-y font-mono text-sm leading-6"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            data-1p-ignore="true"
            data-form-type="other"
            aria-invalid={!!error}
            aria-describedby={`${domainsHelpId}${error ? ` ${domainsErrorId}` : ''}`}
          />
          <p id={domainsHelpId} className="text-muted-foreground text-xs leading-5">
            One exact hostname per line. Do not use a scheme, path, wildcard, or IP address.
          </p>
          {error && (
            <p id={domainsErrorId} role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function describeRestrictionSupport(
  mode: NetworkAccessMode,
  allocation: SelectableSandboxAllocation | null
): string | null {
  if (mode === 'full') return null;
  if (!allocation) {
    return 'Restricted access needs an isolated Cloudflare Containers sandbox. The default sandbox may not support it.';
  }
  if (getSandboxAllocationProvider(allocation) === 'cloudflare-containers') return null;
  return 'Restricted access needs an isolated Cloudflare Containers sandbox. This sandbox cannot enforce it, so sessions will fail to start.';
}
