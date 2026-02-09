'use client';

import { memo, type ComponentType } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Copy, Pencil, Trash2, Check } from 'lucide-react';

export type TriggerItem = {
  id: string;
  triggerId: string;
  githubRepo: string;
  isActive: boolean;
  createdAt: string;
  webhookAuthConfigured?: boolean | null;
  webhookAuthHeader?: string | null;
};

type TriggersTableProps = {
  triggers: TriggerItem[];
  onCopyUrl: (triggerId: string) => void;
  onDelete?: (triggerId: string, githubRepo: string) => void;
  copiedTriggerId: string | null;
  getEditUrl: (triggerId: string) => string;
  showCopy?: boolean;
  showEdit?: boolean;
  showDelete?: boolean;
  editLabel?: string;
  editIcon?: ComponentType<{ className?: string }>;
};

/**
 * Table component displaying webhook triggers.
 */
export const TriggersTable = memo(function TriggersTable({
  triggers,
  onCopyUrl,
  onDelete,
  copiedTriggerId,
  getEditUrl,
  showCopy = true,
  showEdit = true,
  showDelete = true,
  editLabel = 'Edit Trigger',
  editIcon,
}: TriggersTableProps) {
  const hasActions = showCopy || showEdit || showDelete;
  const showAuthColumn = triggers.some(trigger => trigger.webhookAuthConfigured != null);

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Trigger Name</TableHead>
            <TableHead>GitHub Repo</TableHead>
            <TableHead>Status</TableHead>
            {showAuthColumn && <TableHead>Webhook Auth</TableHead>}
            <TableHead>Created</TableHead>
            {hasActions && <TableHead className="text-right">Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {triggers.map(trigger => (
            <TriggerRow
              key={trigger.id}
              trigger={trigger}
              onCopyUrl={onCopyUrl}
              onDelete={onDelete}
              isCopied={copiedTriggerId === trigger.triggerId}
              editUrl={getEditUrl(trigger.triggerId)}
              showAuthColumn={showAuthColumn}
              showCopy={showCopy}
              showEdit={showEdit}
              showDelete={showDelete}
              editLabel={editLabel}
              editIcon={editIcon}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
});

type TriggerRowProps = {
  trigger: TriggerItem;
  onCopyUrl: (triggerId: string) => void;
  onDelete?: (triggerId: string, githubRepo: string) => void;
  isCopied: boolean;
  editUrl: string;
  showAuthColumn: boolean;
  showCopy: boolean;
  showEdit: boolean;
  showDelete: boolean;
  editLabel: string;
  editIcon?: ComponentType<{ className?: string }>;
};

const TriggerRow = memo(function TriggerRow({
  trigger,
  onCopyUrl,
  onDelete,
  isCopied,
  editUrl,
  showAuthColumn,
  showCopy,
  showEdit,
  showDelete,
  editLabel,
  editIcon,
}: TriggerRowProps) {
  const EditIcon = editIcon ?? Pencil;
  const hasActions = showCopy || showEdit || showDelete;
  const showAuthStatus = showAuthColumn && trigger.webhookAuthConfigured !== undefined;

  return (
    <TableRow>
      <TableCell>
        <Link href={editUrl} className="font-mono text-sm hover:underline">
          {trigger.triggerId}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground font-mono text-sm">
        {trigger.githubRepo}
      </TableCell>
      <TableCell>
        <Badge variant={trigger.isActive ? 'default' : 'secondary'}>
          {trigger.isActive ? 'Active' : 'Inactive'}
        </Badge>
      </TableCell>
      {showAuthColumn && (
        <TableCell>
          {showAuthStatus ? (
            trigger.webhookAuthConfigured === true ? (
              <Badge variant="secondary">
                Enabled{trigger.webhookAuthHeader ? ` (${trigger.webhookAuthHeader})` : ''}
              </Badge>
            ) : trigger.webhookAuthConfigured === false ? (
              <Badge variant="outline">Disabled</Badge>
            ) : (
              <span className="text-muted-foreground text-sm">—</span>
            )
          ) : null}
        </TableCell>
      )}
      <TableCell className="text-muted-foreground">
        {formatDistanceToNow(new Date(trigger.createdAt), { addSuffix: true })}
      </TableCell>
      {hasActions && (
        <TableCell>
          <div className="flex items-center justify-end gap-1">
            {showCopy && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onCopyUrl(trigger.triggerId)}
                title="Copy Webhook URL"
              >
                {isCopied ? (
                  <Check className="h-4 w-4 text-green-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            )}

            {showEdit && (
              <Button variant="ghost" size="icon" asChild title={editLabel}>
                <Link href={editUrl}>
                  <EditIcon className="h-4 w-4" />
                </Link>
              </Button>
            )}

            {showDelete && onDelete && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onDelete(trigger.triggerId, trigger.githubRepo)}
                title="Delete Trigger"
              >
                <Trash2 className="text-destructive h-4 w-4" />
              </Button>
            )}
          </div>
        </TableCell>
      )}
    </TableRow>
  );
});
