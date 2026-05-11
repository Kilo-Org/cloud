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

type ExtendVolumeButtonProps = {
  userId: string;
  instanceId: string;
  appName: string | null | undefined;
  volumeId: string | null | undefined;
  currentSizeGb: number | null | undefined;
  userLabel: string;
  disabled?: boolean;
};

const FALLBACK_CURRENT_SIZE_GB = 10;

export function ExtendVolumeButton({
  userId,
  instanceId,
  appName,
  volumeId,
  currentSizeGb,
  userLabel,
  disabled = false,
}: ExtendVolumeButtonProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const wasExtendingRef = useRef(false);

  const effectiveCurrent = currentSizeGb ?? FALLBACK_CURRENT_SIZE_GB;
  const [targetSizeGb, setTargetSizeGb] = useState<number>(effectiveCurrent + 5);

  const { mutate: extendVolume, isPending: isExtending } = useMutation(
    trpc.admin.kiloclawInstances.extendVolume.mutationOptions({
      onSuccess: result => {
        if (result.needsRestart) {
          toast.warning(
            `Volume extended to ${targetSizeGb} GB — machine needs a redeploy for the change to take effect`
          );
        } else {
          toast.success(`Volume extended to ${targetSizeGb} GB`);
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
    if (!open) {
      setAcknowledged(false);
      setTargetSizeGb(effectiveCurrent + 5);
    }
  }, [open, effectiveCurrent]);

  useEffect(() => {
    if (wasExtendingRef.current && !isExtending) {
      setOpen(false);
    }
    wasExtendingRef.current = isExtending;
  }, [isExtending]);

  const buttonDisabled = !volumeId || isExtending || disabled;
  const targetIsValid =
    Number.isInteger(targetSizeGb) && targetSizeGb > effectiveCurrent && targetSizeGb <= 500;

  const handleConfirm = () => {
    if (!appName || !volumeId) {
      toast.error('Missing app name or volume ID');
      return;
    }
    if (!targetIsValid) {
      toast.error(
        `Target size must be an integer greater than ${effectiveCurrent} GB and at most 500 GB`
      );
      return;
    }
    extendVolume({ userId, instanceId, appName, volumeId, targetSizeGb });
  };

  return (
    <>
      <Button size="sm" variant="outline" disabled={buttonDisabled} onClick={() => setOpen(true)}>
        {isExtending ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <HardDriveDownload className="mr-1 h-4 w-4" />
        )}
        Extend Volume
      </Button>
      <Dialog open={open} onOpenChange={isExtending ? () => {} : setOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-500">
              <AlertTriangle className="h-5 w-5" />
              Extend Fly Volume
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 pt-3">
                <p>
                  Extend the Fly volume to a larger size. Fly volumes can grow but cannot be shrunk;
                  once extended, this instance is pinned to at least the new size and cannot be
                  downgraded below it.
                </p>
                <p className="text-foreground font-medium">
                  This will mark the instance as <code>Custom</code> tier. Subsequent tier resizes
                  remain available as long as the target tier&apos;s storage is at least as large.
                </p>
                <div className="bg-muted rounded border p-3 text-xs">
                  <div>User: {userLabel}</div>
                  <div>
                    App: <code>{appName ?? '—'}</code>
                  </div>
                  <div>
                    Volume: <code>{volumeId ?? '—'}</code>
                  </div>
                  <div>Current size: {effectiveCurrent} GB</div>
                </div>
                <label className="block text-sm">
                  <span className="font-medium">New size (GB)</span>
                  <input
                    type="number"
                    min={effectiveCurrent + 1}
                    max={500}
                    step={1}
                    className="bg-background border-input mt-1 w-full rounded-md border px-3 py-2 text-sm"
                    value={targetSizeGb}
                    onChange={e => setTargetSizeGb(Number(e.target.value))}
                    disabled={isExtending}
                  />
                  <span className="text-muted-foreground mt-1 block text-xs">
                    Must be greater than {effectiveCurrent} GB and at most 500 GB.
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={event => setAcknowledged(event.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    I understand the volume cannot be shrunk and the instance will be pinned to at
                    least this storage size.
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
              disabled={isExtending || !acknowledged || !targetIsValid || !appName || !volumeId}
              onClick={handleConfirm}
            >
              {isExtending ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  Extending...
                </>
              ) : (
                `Extend to ${targetSizeGb} GB`
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
