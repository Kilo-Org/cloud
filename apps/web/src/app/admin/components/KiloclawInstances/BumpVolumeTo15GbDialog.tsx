/**
 *
 * This is a temporary feature to assist Customer Support.
 * To be deleted after user-facing file deletion is launched.
 *
 * All changes for this feature are in PR #2302.
 *
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, HardDriveDownload, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { toast } from 'sonner';

type BumpVolumeTo15GbButtonProps = {
  userId: string;
  instanceId: string;
  appName: string | null | undefined;
  volumeId: string | null | undefined;
  userLabel: string;
  disabled?: boolean;
};

export function BumpVolumeTo15GbButton({
  userId,
  instanceId,
  appName,
  volumeId,
  userLabel,
  disabled = false,
}: BumpVolumeTo15GbButtonProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const wasExtendingRef = useRef(false);

  const { mutate: extendVolume, isPending: isExtending } = useMutation(
    trpc.admin.kiloclawInstances.extendVolume.mutationOptions({
      onSuccess: result => {
        if (result.needsRestart) {
          toast.warning(
            'Volume extended to 15 GB — machine needs a redeploy for the change to take effect'
          );
        } else {
          toast.success('Volume extended to 15 GB');
        }
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.get.queryKey(),
        });
      },
      onError: err => {
        toast.error(`Failed to extend volume: ${err.message}`);
      },
    })
  );

  useEffect(() => {
    if (!open) setAcknowledged(false);
  }, [open]);

  useEffect(() => {
    if (wasExtendingRef.current && !isExtending) {
      setOpen(false);
    }
    wasExtendingRef.current = isExtending;
  }, [isExtending]);

  const buttonDisabled = !volumeId || isExtending || disabled;

  const handleConfirm = () => {
    if (!appName || !volumeId) {
      toast.error('Missing app name or volume ID');
      return;
    }
    extendVolume({ userId, instanceId, appName, volumeId });
  };

  return (
    <>
      <Button size="sm" variant="outline" disabled={buttonDisabled} onClick={() => setOpen(true)}>
        {isExtending ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <HardDriveDownload className="mr-1 h-4 w-4" />
        )}
        Bump Volume to 15 GB
      </Button>
      <Dialog open={open} onOpenChange={isExtending ? () => {} : setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-500">
              <AlertTriangle className="h-5 w-5" />
              Confirm 15 GB Volume Workaround
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 pt-3">
                <p>
                  This temporary workaround extends the current Fly volume to exactly 15 GB so the
                  user can export data to an external backup.
                </p>
                <p className="text-foreground font-medium">
                  If Fly cannot set this volume to exactly 15 GB, the operation will fail.
                </p>
                <div className="bg-muted rounded border p-3 text-xs">
                  <div>User: {userLabel}</div>
                  <div>
                    App: <code>{appName ?? '—'}</code>
                  </div>
                  <div>
                    Volume: <code>{volumeId ?? '—'}</code>
                  </div>
                  <div>Target size: 15 GB</div>
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={event => setAcknowledged(event.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    I confirm this is only to re-grant temporary access and the user has been told
                    to export their data.
                  </span>
                </label>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <DialogClose asChild>
              <Button variant="secondary" disabled={isExtending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={isExtending || !acknowledged || !appName || !volumeId}
              onClick={handleConfirm}
            >
              {isExtending ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  Extending...
                </>
              ) : (
                'Extend to 15 GB'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
