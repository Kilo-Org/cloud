'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTRPC } from '@/lib/trpc/utils';
import {
  GUARDRAIL_TYPE_LABELS,
  configIdentity,
  configKindLabel,
  minVersionLabel,
  sourceLabel,
} from './guardrail-display';
import type { OrganizationGuardrailRow } from './guardrail-types';

export function McpGuardrailsTable({
  organizationId,
  guardrails,
  onEdit,
}: {
  organizationId: string;
  guardrails: OrganizationGuardrailRow[];
  onEdit: (guardrail: OrganizationGuardrailRow) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.organizations.mcpGuardrails.list.queryKey({ organizationId }),
    });

  const deleteMutation = useMutation(
    trpc.organizations.mcpGuardrails.delete.mutationOptions({
      onSuccess: async () => {
        await invalidate();
        toast.success('MCP server removed.');
      },
      onError: error => {
        toast.error(error.message || 'The MCP server couldn’t be removed. Try again.');
      },
    })
  );

  const deleteGuardrail = async (guardrail: OrganizationGuardrailRow) => {
    const confirmed = await confirm({
      title: `Stop allowing ${guardrail.name}?`,
      description:
        'While MCP guardrails are on, members can no longer use it, unless another entry allows it.',
      confirmLabel: 'Remove MCP server',
      destructive: true,
    });
    if (confirmed) deleteMutation.mutate({ organizationId, guardrailId: guardrail.id });
  };

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>MCP server</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Minimum version</TableHead>
            <TableHead className="w-24">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {guardrails.map(guardrail => {
            const removePending =
              deleteMutation.isPending && deleteMutation.variables?.guardrailId === guardrail.id;
            return (
              <TableRow key={guardrail.id}>
                <TableCell className="max-w-sm">
                  <div className="grid gap-1">
                    <span className="truncate font-medium">{guardrail.name}</span>
                    <span className="flex items-center gap-2">
                      <Badge variant="outline">{configKindLabel(guardrail.config)}</Badge>
                      <code className="text-muted-foreground truncate font-mono text-xs">
                        {configIdentity(guardrail.config)}
                      </code>
                    </span>
                    {guardrail.description && (
                      <span className="text-muted-foreground line-clamp-1 text-xs">
                        {guardrail.description}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>{GUARDRAIL_TYPE_LABELS[guardrail.type]}</TableCell>
                <TableCell>{sourceLabel(guardrail.source)}</TableCell>
                <TableCell className="tabular-nums">{minVersionLabel(guardrail.config)}</TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    {guardrail.source.registry === 'custom' && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${guardrail.name}`}
                        onClick={() => onEdit(guardrail)}
                      >
                        <Pencil />
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={removePending}
                      aria-label={`Remove ${guardrail.name}`}
                      onClick={() => void deleteGuardrail(guardrail)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
