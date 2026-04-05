'use client';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Copy, Check, Activity, User, Clock, FileText } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

type AuditLogEntry = {
  id: string;
  action: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
  message: string;
  created_at: string;
};

type AuditLogDetailModalProps = {
  isOpen: boolean;
  onClose: () => void;
  log: AuditLogEntry | null;
};

function formatActionName(action: string): string {
  // Convert action like "organization.user.invite_sent" to "User Invite Sent"
  const parts = action.split('.');
  const actionPart = parts[parts.length - 1];
  return actionPart
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getActionBadgeVariant(
  action: string
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (action.includes('delete') || action.includes('remove')) {
    return 'destructive';
  }
  if (action.includes('invite') || action.includes('create') || action.includes('accept')) {
    return 'default';
  }
  if (action.includes('change') || action.includes('update')) {
    return 'secondary';
  }
  return 'outline';
}

export function AuditLogDetailModal({ isOpen, onClose, log }: AuditLogDetailModalProps) {
  const [copied, setCopied] = useState(false);

  if (!log) return null;

  const handleCopyToClipboard = async () => {
    try {
      const logJson = JSON.stringify(log, null, 2);
      await navigator.clipboard.writeText(logJson);
      setCopied(true);
      toast.success('Audit log copied to clipboard');

      // Reset the copied state after 2 seconds
      setTimeout(() => setCopied(false), 2000);
    } catch (_error) {
      toast.error('Failed to copy to clipboard');
    }
  };

  const actionName = formatActionName(log.action);
  const badgeVariant = getActionBadgeVariant(log.action);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="flex h-[80vh] max-h-[80vh] w-full max-w-[600px] flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Audit Log Details
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-2">
          {/* Action */}
          <div className="flex items-center gap-2">
            <div className="text-muted-foreground min-w-0 flex-shrink-0 text-sm font-medium">
              Action:
            </div>
            <Badge variant={badgeVariant} className="text-xs">
              {actionName}
            </Badge>
            <code className="text-muted-foreground ml-2 text-xs">{log.action}</code>
          </div>

          {/* Timestamp */}
          <div className="flex items-center gap-2">
            <Clock className="text-muted-foreground h-4 w-4 flex-shrink-0" />
            <div className="text-muted-foreground min-w-0 flex-shrink-0 text-sm font-medium">
              Time:
            </div>
            <div className="text-sm">{new Date(log.created_at).toLocaleString()}</div>
          </div>

          {/* Actor */}
          <div className="flex items-start gap-2">
            <User className="text-muted-foreground mt-0.5 h-4 w-4 flex-shrink-0" />
            <div className="text-muted-foreground min-w-0 flex-shrink-0 text-sm font-medium">
              Actor:
            </div>
            <div className="min-w-0 flex-1">
              {log.actor_name && <div className="font-medium">{log.actor_name}</div>}
              {log.actor_email && (
                <div className="text-muted-foreground text-sm">{log.actor_email}</div>
              )}
              {log.actor_id && (
                <div className="text-muted-foreground font-mono text-xs">ID: {log.actor_id}</div>
              )}
              {!log.actor_name && !log.actor_email && !log.actor_id && (
                <div className="text-muted-foreground italic">System</div>
              )}
            </div>
          </div>

          {/* Message */}
          <div className="flex items-start gap-2">
            <FileText className="text-muted-foreground mt-0.5 h-4 w-4 flex-shrink-0" />
            <div className="text-muted-foreground min-w-0 flex-shrink-0 text-sm font-medium">
              Message:
            </div>
            <div className="bg-muted min-w-0 flex-1 rounded-md p-3 text-sm">{log.message}</div>
          </div>

          {/* ID */}
          <div className="flex items-center gap-2">
            <div className="text-muted-foreground min-w-0 flex-shrink-0 text-sm font-medium">
              ID:
            </div>
            <code className="text-muted-foreground text-xs">{log.id}</code>
          </div>
        </div>

        <DialogFooter className="flex flex-shrink-0 gap-2">
          <Button
            variant="outline"
            onClick={handleCopyToClipboard}
            className="flex items-center gap-2"
          >
            {copied ? (
              <>
                <Check className="h-4 w-4" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" />
                Copy JSON
              </>
            )}
          </Button>

          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
