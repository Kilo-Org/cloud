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
import { tierLabel } from './permission-display';
import type { PermissionRuleRow } from './permission-types';

const SOURCE_LABELS: Record<PermissionRuleRow['source']['type'], string> = {
  admin_ui: 'Added by admin',
  event_approval: 'Allowed from usage',
  preset: 'Preset',
};

function ruleName(rule: PermissionRuleRow): string {
  return `${rule.permission} ${rule.pattern}`;
}

export function PermissionRulesTable({
  organizationId,
  rules,
  onEdit,
}: {
  organizationId: string;
  rules: PermissionRuleRow[];
  onEdit: (rule: PermissionRuleRow) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const deleteMutation = useMutation(
    trpc.organizations.permissionRules.delete.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.permissionRules.pathKey(),
        });
        toast.success('Rule removed.');
      },
      onError: error => {
        toast.error(error.message || 'The rule couldn’t be removed. Try again.');
      },
    })
  );

  const deleteRule = async (rule: PermissionRuleRow) => {
    const confirmed = await confirm({
      title: `Remove ${tierLabel(rule.tier).toLowerCase()} rule?`,
      description: `${ruleName(rule)} will no longer apply. Other matching rules, or the default, decide instead.`,
      confirmLabel: 'Remove rule',
      destructive: true,
    });
    if (confirmed) deleteMutation.mutate({ organizationId, ruleId: rule.id });
  };

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Rule type</TableHead>
            <TableHead>Permission</TableHead>
            <TableHead>Pattern</TableHead>
            <TableHead>Source</TableHead>
            <TableHead className="w-24">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.map(rule => {
            const removePending =
              deleteMutation.isPending && deleteMutation.variables?.ruleId === rule.id;
            return (
              <TableRow key={rule.id}>
                <TableCell>
                  <Badge variant={rule.action === 'deny' ? 'destructive' : 'outline'}>
                    {tierLabel(rule.tier)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <code className="font-mono text-xs">{rule.permission}</code>
                </TableCell>
                <TableCell className="max-w-sm">
                  <div className="grid gap-1">
                    <code className="truncate font-mono text-xs">{rule.pattern}</code>
                    {rule.description && (
                      <span className="text-muted-foreground line-clamp-1 text-xs">
                        {rule.description}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>{SOURCE_LABELS[rule.source.type]}</TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${ruleName(rule)}`}
                      onClick={() => onEdit(rule)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={removePending}
                      aria-label={`Remove ${ruleName(rule)}`}
                      onClick={() => void deleteRule(rule)}
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
