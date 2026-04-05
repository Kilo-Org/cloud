'use client';

import { useState } from 'react';
import { Pin, PinOff, Info } from 'lucide-react';
import { toast } from 'sonner';
import { useClawAvailableVersions, useClawMyPin } from '../hooks/useClawHooks';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

export function VersionPinCard({
  trackedImageTag,
  latestImageTag,
  mutations,
}: {
  trackedImageTag: string | null;
  latestImageTag: string | null;
  mutations: ClawMutations;
}) {
  const { data: myPin, isLoading: pinLoading } = useClawMyPin();
  const { data: versions, isLoading: versionsLoading } = useClawAvailableVersions(0, 50);

  const [selectedImageTag, setSelectedImageTag] = useState<string>('');
  const [reason, setReason] = useState('');

  const isPinned = !!myPin;
  const isLoading = pinLoading || versionsLoading;
  const isPinning = mutations.setMyPin.isPending;
  const isUnpinning = mutations.removeMyPin.isPending;

  const pinnedBySelf = myPin?.pinnedBySelf ?? false;
  const pinnedByLabel = pinnedBySelf ? 'You' : 'Kilo Admin';

  const handlePin = async () => {
    if (!selectedImageTag) {
      toast.error('Please select a version to pin');
      return;
    }

    try {
      await mutations.setMyPin.mutateAsync({
        imageTag: selectedImageTag,
        reason: reason.trim() || undefined,
      });
      toast.success(
        'Version pinned successfully. Use the "Redeploy or Upgrade" button to apply this version.'
      );
      setSelectedImageTag('');
      setReason('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to pin version';
      toast.error(message);
    }
  };

  const handleUnpin = async () => {
    try {
      await mutations.removeMyPin.mutateAsync();
      toast.success(
        'Version pin removed. Use the "Redeploy or Upgrade" button to return to the latest version.'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove pin';
      toast.error(message);
    }
  };

  if (isLoading) {
    return (
      <div>
        <h3 className="text-foreground mb-1 flex items-center gap-2 text-sm font-medium">
          <Pin className="size-4" />
          Version Pinning
        </h3>
        <p className="text-muted-foreground text-xs">Loading version information...</p>
      </div>
    );
  }

  const truncateTag = (tag: string) => {
    if (tag.length <= 20) return tag;
    return `${tag.slice(0, 8)}...${tag.slice(-8)}`;
  };

  return (
    <div>
      <h3 className="text-foreground mb-1 flex items-center gap-2 text-sm font-medium">
        <Pin className="size-4" />
        Version Pinning
      </h3>
      <div className="grid grid-cols-1 items-start gap-6 sm:grid-cols-2">
        {/* Left: Description + Pinning Controls */}
        <div className="space-y-3">
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm">
              Pin your instance to a specific OpenClaw version or follow the latest
            </p>
            <div className="text-muted-foreground flex items-start gap-1 text-xs">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                Pinning locks your instance to a specific version. You won&apos;t receive automatic
                updates until you unpin.
              </span>
            </div>
          </div>

          {!isPinned ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="version-select" className="text-sm">
                  Select Version
                </Label>
                <div className="flex items-center gap-2">
                  <Select value={selectedImageTag} onValueChange={setSelectedImageTag}>
                    <SelectTrigger id="version-select" className="min-w-0 flex-1 h-10">
                      <SelectValue placeholder="Choose version..." />
                    </SelectTrigger>
                    <SelectContent>
                      {versions?.items.map(version => (
                        <SelectItem key={version.image_tag} value={version.image_tag}>
                          <div className="flex flex-col">
                            <span className="font-medium">
                              {version.openclaw_version} / {version.variant}
                            </span>
                            <span
                              className="text-muted-foreground text-xs"
                              title={version.image_tag}
                            >
                              {truncateTag(version.image_tag)}
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={handlePin}
                    disabled={!selectedImageTag || isPinning}
                    size="sm"
                    className="ml-auto shrink-0"
                  >
                    {isPinning ? 'Pinning...' : 'Pin'}
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="pin-reason" className="text-sm">
                  Reason (optional)
                </Label>
                <Textarea
                  id="pin-reason"
                  placeholder="Why are you pinning to this version?"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  rows={3}
                  maxLength={500}
                />
              </div>
            </div>
          ) : null}
        </div>

        {/* Right: Current Status */}
        <div>
          <h3 className="text-muted-foreground mb-2 text-sm font-medium">Current Status</h3>
          {isPinned ? (
            <div className="space-y-1.5 text-sm">
              <div>
                <span className="text-muted-foreground">Pinned to: </span>
                <code className="bg-muted rounded px-1.5 py-0.5 text-xs">
                  {myPin.openclaw_version ?? 'Unknown'} / {myPin.variant ?? 'Unknown'}
                </code>
              </div>
              <div>
                <span className="text-muted-foreground">Image tag: </span>
                <code className="bg-muted rounded px-1.5 py-0.5 text-xs" title={myPin.image_tag}>
                  {truncateTag(myPin.image_tag)}
                </code>
              </div>
              {myPin.reason && (
                <div>
                  <span className="text-muted-foreground">Reason: </span>
                  <span>{myPin.reason}</span>
                </div>
              )}
              <div>
                <span className="text-muted-foreground">Pinned by: </span>
                <span>{pinnedByLabel}</span>
              </div>
              <div className="space-y-1.5 pt-2">
                {pinnedBySelf ? (
                  <>
                    <Button
                      onClick={handleUnpin}
                      disabled={isUnpinning}
                      variant="outline"
                      size="sm"
                    >
                      <PinOff className="mr-2 size-4" />
                      {isUnpinning ? 'Unpinning...' : 'Unpin'}
                    </Button>
                    <p className="text-muted-foreground flex items-start gap-1 text-xs">
                      <Info className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>
                        Unpinning returns to following latest. Use the Upgrade button to upgrade
                        your instance.
                      </span>
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground flex items-start gap-1 text-xs">
                    <Info className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      This pin was set by a Kilo admin. Contact your admin to change or remove it.
                    </span>
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-green-100 px-3 py-0.5 text-center text-xs font-medium text-green-800 dark:bg-green-900 dark:text-green-100">
                  Following latest
                </span>
                <span className="text-muted-foreground text-xs">
                  Automatically uses newest version
                </span>
              </div>
              {(trackedImageTag || latestImageTag) && (
                <table className="text-sm">
                  <tbody>
                    {trackedImageTag && (
                      <tr>
                        <td className="text-muted-foreground pr-3 align-top">Current image</td>
                        <td>
                          <code
                            className="bg-muted rounded px-1.5 py-0.5 text-xs"
                            title={trackedImageTag}
                          >
                            {truncateTag(trackedImageTag)}
                          </code>
                        </td>
                      </tr>
                    )}
                    {latestImageTag && (
                      <tr>
                        <td className="text-muted-foreground pr-3 pt-1 align-top">Latest image</td>
                        <td className="pt-1">
                          <code
                            className="bg-muted rounded px-1.5 py-0.5 text-xs"
                            title={latestImageTag}
                          >
                            {truncateTag(latestImageTag)}
                          </code>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
