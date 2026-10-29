'use client';

import { useId, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { OrganizationAddonEnforcement } from '@kilocode/db/schema-types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm';
import { Switch } from '@/components/ui/switch';
import { useTRPC } from '@/lib/trpc/utils';

function useSaveAccess(organizationId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.organizations.addons.setEnforcement.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.addons.list.queryKey({ organizationId }),
        });
        toast.success('Access saved.');
      },
      onError: error => {
        toast.error(error.message || 'Access couldn’t be saved. Try again.');
      },
    })
  );
}

export function McpGuardrailsCard({
  organizationId,
  enforcement,
  allowedCount,
  children,
}: {
  organizationId: string;
  enforcement: OrganizationAddonEnforcement;
  allowedCount: number;
  children: ReactNode;
}) {
  const confirm = useConfirm();
  const mutation = useSaveAccess(organizationId);
  const titleId = useId();
  const descriptionId = useId();
  const auditTitleId = useId();
  const auditDescriptionId = useId();

  const current =
    mutation.isPending && mutation.variables.type === 'mcp'
      ? mutation.variables.enforcement
      : enforcement;
  const enabled = current !== 'off';
  const auditMode = current === 'shadow';

  const save = (next: OrganizationAddonEnforcement) =>
    mutation.mutate({ organizationId, type: 'mcp', enforcement: next });

  const setAuditMode = async (nextAuditMode: boolean) => {
    if (!nextAuditMode && allowedCount === 0) {
      const confirmed = await confirm({
        title: 'Block all MCP servers?',
        description:
          'No MCP servers are allowed, so members won’t be able to use any MCP server. Add the servers your team needs first, or continue to block them all.',
        confirmLabel: 'Block all MCP servers',
        destructive: true,
      });
      if (!confirmed) return;
    }
    save(nextAuditMode ? 'shadow' : 'enforce');
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <CardTitle id={titleId}>MCP guardrails</CardTitle>
            <CardDescription id={descriptionId}>
              Control which MCP servers members can connect Kilo to. When guardrails are on, members
              can only use the MCP servers you allow.
            </CardDescription>
          </div>
          <Switch
            checked={enabled}
            disabled={mutation.isPending}
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onCheckedChange={checked => save(checked ? 'shadow' : 'off')}
          />
        </div>
      </CardHeader>
      {enabled && (
        <CardContent className="grid gap-6">
          <div className="flex items-start justify-between gap-4 rounded-md border p-3">
            <div className="grid gap-1">
              <span id={auditTitleId} className="text-sm font-medium">
                Audit mode
              </span>
              <p id={auditDescriptionId} className="text-muted-foreground text-sm">
                Detect server violations, but still allow any MCP server.
              </p>
            </div>
            <Switch
              checked={auditMode}
              disabled={mutation.isPending}
              aria-labelledby={auditTitleId}
              aria-describedby={auditDescriptionId}
              onCheckedChange={checked => void setAuditMode(checked)}
            />
          </div>
          {children}
        </CardContent>
      )}
    </Card>
  );
}

export function SkillGuardrailsCard({
  organizationId,
  guardrails,
}: {
  organizationId: string;
  guardrails: { enabled: boolean; scanBeforeUse: boolean };
}) {
  const mutation = useSaveAccess(organizationId);
  const titleId = useId();
  const descriptionId = useId();
  const scanTitleId = useId();
  const scanDescriptionId = useId();

  const current =
    mutation.isPending && mutation.variables.type === 'skill' ? mutation.variables : guardrails;
  const { enabled, scanBeforeUse } = current;

  const save = (next: { enabled: boolean; scanBeforeUse: boolean }) =>
    mutation.mutate({ organizationId, type: 'skill', ...next });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <CardTitle id={titleId}>Skill guardrails</CardTitle>
            <CardDescription id={descriptionId}>
              Skills give Kilo reusable instructions and workflows. Add guardrails to skill usage.
            </CardDescription>
          </div>
          <Switch
            checked={enabled}
            disabled={mutation.isPending}
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onCheckedChange={checked => save({ enabled: checked, scanBeforeUse })}
          />
        </div>
      </CardHeader>
      {enabled && (
        <CardContent>
          <div className="flex items-start justify-between gap-4 rounded-md border p-3">
            <div className="grid gap-1">
              <span id={scanTitleId} className="text-sm font-medium">
                Scan skills before usage
              </span>
              <p id={scanDescriptionId} className="text-muted-foreground text-sm">
                Scanned skills check for policy violations before using it
              </p>
            </div>
            <Switch
              checked={scanBeforeUse}
              disabled={mutation.isPending}
              aria-labelledby={scanTitleId}
              aria-describedby={scanDescriptionId}
              onCheckedChange={checked => save({ enabled, scanBeforeUse: checked })}
            />
          </div>
        </CardContent>
      )}
    </Card>
  );
}
