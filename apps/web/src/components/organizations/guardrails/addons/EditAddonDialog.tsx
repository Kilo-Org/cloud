'use client';

import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useTRPC } from '@/lib/trpc/utils';
import type { OrganizationAddonRow } from './addon-types';
import { CustomMcpForm } from './CustomMcpForm';

export function EditAddonDialog({
  organizationId,
  addon,
  onClose,
}: {
  organizationId: string;
  addon: OrganizationAddonRow;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit server</DialogTitle>
          <DialogDescription>
            Packages are matched by name, so members can’t run a different program through an
            allowed launcher.
          </DialogDescription>
        </DialogHeader>
        <CustomMcpForm
          organizationId={organizationId}
          addon={addon}
          onCancel={onClose}
          onSaved={async () => {
            await queryClient.invalidateQueries({
              queryKey: trpc.organizations.addons.list.queryKey({ organizationId }),
            });
            toast.success('MCP server saved.');
            onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
