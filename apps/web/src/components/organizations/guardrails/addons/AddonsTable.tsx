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
  ADDON_TYPE_LABELS,
  configIdentity,
  configKindLabel,
  minVersionLabel,
  sourceLabel,
} from './addon-display';
import type { OrganizationAddonRow } from './addon-types';

export function AddonsTable({
  organizationId,
  addons,
  onEdit,
}: {
  organizationId: string;
  addons: OrganizationAddonRow[];
  onEdit: (addon: OrganizationAddonRow) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.organizations.addons.list.queryKey({ organizationId }),
    });

  const deleteMutation = useMutation(
    trpc.organizations.addons.delete.mutationOptions({
      onSuccess: async () => {
        await invalidate();
        toast.success('MCP server removed.');
      },
      onError: error => {
        toast.error(error.message || 'The MCP server couldn’t be removed. Try again.');
      },
    })
  );

  const deleteAddon = async (addon: OrganizationAddonRow) => {
    const confirmed = await confirm({
      title: `Stop allowing ${addon.name}?`,
      description:
        'While MCP guardrails are on, members can no longer use it, unless another entry allows it.',
      confirmLabel: 'Remove MCP server',
      destructive: true,
    });
    if (confirmed) deleteMutation.mutate({ organizationId, addonId: addon.id });
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
          {addons.map(addon => {
            const removePending =
              deleteMutation.isPending && deleteMutation.variables?.addonId === addon.id;
            return (
              <TableRow key={addon.id}>
                <TableCell className="max-w-sm">
                  <div className="grid gap-1">
                    <span className="truncate font-medium">{addon.name}</span>
                    <span className="flex items-center gap-2">
                      <Badge variant="outline">{configKindLabel(addon.config)}</Badge>
                      <code className="text-muted-foreground truncate font-mono text-xs">
                        {configIdentity(addon.config)}
                      </code>
                    </span>
                    {addon.description && (
                      <span className="text-muted-foreground line-clamp-1 text-xs">
                        {addon.description}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>{ADDON_TYPE_LABELS[addon.type]}</TableCell>
                <TableCell>{sourceLabel(addon.source)}</TableCell>
                <TableCell className="tabular-nums">{minVersionLabel(addon.config)}</TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    {addon.source.registry === 'custom' && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${addon.name}`}
                        onClick={() => onEdit(addon)}
                      >
                        <Pencil />
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={removePending}
                      aria-label={`Remove ${addon.name}`}
                      onClick={() => void deleteAddon(addon)}
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
