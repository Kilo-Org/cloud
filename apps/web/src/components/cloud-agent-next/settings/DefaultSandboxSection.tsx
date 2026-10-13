'use client';

import { useId } from 'react';
import { Info } from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  useSetContextAllocationMutation,
  type CloudAgentSettingsData,
} from '@/hooks/useCloudAgentSettings';
import { SandboxSelect } from './SandboxSelect';
import {
  describeDefaultSandbox,
  getEligibleAllocationChoices,
  toSelectableAllocation,
} from './settings-options';

type DefaultSandboxSectionProps = {
  organizationId?: string;
  settings: CloudAgentSettingsData;
};

export function DefaultSandboxSection({ organizationId, settings }: DefaultSandboxSectionProps) {
  const headingId = useId();
  const setContextAllocation = useSetContextAllocationMutation(organizationId);
  const canChoose = settings.capabilities.enabled;
  const value = setContextAllocation.isPending
    ? (setContextAllocation.variables?.allocation ?? null)
    : toSelectableAllocation(settings.contextAllocation);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <h3 id={headingId} className="text-sm font-medium">
            Default sandbox
          </h3>
          {canChoose && <SandboxRulesHint />}
        </div>
        <p className="text-muted-foreground text-xs">
          {canChoose
            ? `Used for new sessions ${organizationId ? 'in this organization ' : ''}unless a repository overrides it.`
            : `New sessions ${organizationId ? 'in this organization ' : ''}run on this sandbox.`}
        </p>
      </div>
      <SandboxSelect
        className="sm:max-w-sm"
        value={value}
        choices={getEligibleAllocationChoices(settings.capabilities)}
        unavailableReason={settings.contextUnavailableReason}
        noneLabel="Platform default"
        noneDescription={describeDefaultSandbox(settings.capabilities.defaultDestination)}
        labelledBy={headingId}
        disabled={!settings.canManage || setContextAllocation.isPending}
        onChange={allocation =>
          setContextAllocation.mutate(
            { organizationId, allocation },
            { onError: error => toast.error(error.message) }
          )
        }
      />
    </section>
  );
}

function SandboxRulesHint() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="How a sandbox is chosen"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex size-6 items-center justify-center rounded-full outline-none focus-visible:ring-[3px] pointer-coarse:-m-2.5 pointer-coarse:size-11"
        >
          <Info className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex flex-col gap-2 text-xs">
        <p>
          A sandbox chosen when a session starts always wins. Otherwise a repository override
          applies, then this default, then the platform default.
        </p>
        <p className="text-muted-foreground">
          If a session cannot use the selected sandbox, it runs on the next available default.
        </p>
      </PopoverContent>
    </Popover>
  );
}
