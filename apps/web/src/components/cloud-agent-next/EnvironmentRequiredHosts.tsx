'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useCloudAgentEnvironmentMutations } from '@/hooks/useCloudAgentEnvironments';
import { EnvironmentSetupConfirmDialog } from './EnvironmentSetupConfirmDialog';

export function EnvironmentRequiredHosts({
  hosts,
  environmentId,
  organizationId,
  canManage,
  disabled,
}: {
  hosts: string[];
  environmentId: string;
  organizationId?: string;
  canManage: boolean;
  disabled: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { updateEnvironment } = useCloudAgentEnvironmentMutations();
  if (!hosts.length) return null;
  return (
    <section className="space-y-2 rounded-md border px-3 py-3 text-xs">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">Required by this environment</h3>
        {canManage && (
          <Button
            variant="outline"
            size="sm"
            className="pointer-coarse:min-h-11"
            disabled={disabled || updateEnvironment.isPending}
            onClick={() => setConfirmOpen(true)}
          >
            Clear
          </Button>
        )}
      </div>
      <ul className="space-y-1 font-mono">
        {hosts.map(host => (
          <li key={host} className="break-all">
            {host}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground leading-5">
        These hosts stay allowed under None and Limited so the environment&apos;s setup keeps
        working.
      </p>
      {confirmOpen && (
        <EnvironmentSetupConfirmDialog
          title="Clear required hosts"
          description="Remove all required hosts from this environment? Sessions with None or Limited network access can fail setup."
          onClose={() => setConfirmOpen(false)}
          onConfirm={async () => {
            if (!canManage) throw new Error('Only owners and admins can clear required hosts.');
            await updateEnvironment.mutateAsync({
              organizationId,
              environmentId,
              requiredHosts: [],
            });
          }}
        />
      )}
    </section>
  );
}
