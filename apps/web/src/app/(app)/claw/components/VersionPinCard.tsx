'use client';

import React, { useState } from 'react';
import { Pin, PinOff, Info } from 'lucide-react';
import { toast } from 'sonner';
import { toastPinMutationResult } from '@/lib/kiloclaw/pin-sync-toast';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

function truncateTag(tag: string) {
  if (tag.length <= 20) return tag;
  return `${tag.slice(0, 8)}...${tag.slice(-8)}`;
}

/**
 * One row in the compact image table: a label plus the OpenClaw version and
 * the (truncated) image tag/hash. Either piece may be missing — a row renders
 * whatever it has, falling back to "Unknown" only when both are absent.
 */
function ImageRow({
  label,
  openclawVersion,
  imageTag,
  tooltip,
  spaced = false,
}: {
  label: string;
  openclawVersion: string | null | undefined;
  imageTag: string | null | undefined;
  /** Optional explanatory text surfaced via an info icon next to the label. */
  tooltip?: string;
  spaced?: boolean;
}) {
  return (
    <tr>
      <td className={`text-muted-foreground pr-3 align-top${spaced ? ' pt-1' : ''}`}>
        <span className="inline-flex items-center gap-1">
          {label}
          {tooltip && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label={tooltip} className="inline-flex cursor-help">
                  <Info className="size-3.5 shrink-0" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{tooltip}</TooltipContent>
            </Tooltip>
          )}
        </span>
      </td>
      <td className={spaced ? 'pt-1' : undefined}>
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {openclawVersion && <span className="text-foreground">OpenClaw {openclawVersion}</span>}
          {imageTag ? (
            <code className="bg-muted rounded px-1.5 py-0.5 text-xs" title={imageTag}>
              {truncateTag(imageTag)}
            </code>
          ) : (
            !openclawVersion && <span className="text-muted-foreground">Unknown</span>
          )}
        </span>
      </td>
    </tr>
  );
}

/**
 * The "Active" and "Latest" image rows shown to an unpinned instance. Each
 * pairs the OpenClaw version with its image tag/hash so the two columns read
 * e.g. "Active  OpenClaw 2026.6.5  img-5f02b9408089". Rendered inside a
 * <tbody>; a row is omitted only when both its version and tag are absent.
 */
export function VersionImageMetadata({
  currentOpenClawVersion,
  trackedImageTag,
  latestOpenClawVersion,
  latestImageTag,
}: {
  currentOpenClawVersion: string | null | undefined;
  trackedImageTag: string | null | undefined;
  latestOpenClawVersion: string | null | undefined;
  latestImageTag: string | null | undefined;
}) {
  // The active and latest images can share the same OpenClaw version while
  // still being different builds (the image tag differs). In that case the
  // "Update available" framing would be confusing, so explain that the latest
  // image carries non-version changes rather than a newer OpenClaw release.
  const sameOpenClawVersionDifferentImage =
    !!currentOpenClawVersion &&
    !!latestOpenClawVersion &&
    currentOpenClawVersion === latestOpenClawVersion &&
    !!trackedImageTag &&
    !!latestImageTag &&
    trackedImageTag !== latestImageTag;

  return (
    <>
      {(trackedImageTag || currentOpenClawVersion) && (
        <ImageRow
          label="Active"
          openclawVersion={currentOpenClawVersion}
          imageTag={trackedImageTag}
        />
      )}
      {(latestImageTag || latestOpenClawVersion) && (
        <ImageRow
          label="Latest"
          openclawVersion={latestOpenClawVersion}
          imageTag={latestImageTag}
          tooltip={
            sameOpenClawVersionDifferentImage
              ? 'Both images run the same OpenClaw version, but the latest image includes additional fixes, improvements, and features.'
              : undefined
          }
          spaced
        />
      )}
    </>
  );
}

export function VersionPinCard({
  trackedImageTag,
  trackedOpenClawVersion,
  latestImageTag,
  latestOpenClawVersion,
  mutations,
}: {
  trackedImageTag: string | null;
  trackedOpenClawVersion: string | null;
  latestImageTag: string | null;
  latestOpenClawVersion: string | null;
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
      const result = await mutations.setMyPin.mutateAsync({
        imageTag: selectedImageTag,
        reason: reason.trim() || undefined,
      });
      toastPinMutationResult(
        result,
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
      const result = await mutations.removeMyPin.mutateAsync();
      toastPinMutationResult(
        result,
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

  return (
    <div>
      <h3 className="text-foreground mb-1 flex items-center gap-2 text-sm font-medium">
        <Pin className="size-4" />
        Pin a version
      </h3>
      <div className="grid grid-cols-1 items-start gap-6 sm:grid-cols-2">
        {/* Left: description + controls (or pinned status) */}
        <div className="space-y-3">
          <p className="text-muted-foreground text-sm">
            Lock your instance to a specific OpenClaw version. No automatic updates until you unpin.
          </p>

          {!isPinned ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="version-select" className="text-sm">
                  Select version
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
          ) : (
            <div className="space-y-1.5 text-sm">
              <div>
                <span className="text-muted-foreground">Pinned to: </span>
                <code className="bg-muted rounded px-1.5 py-0.5 text-xs">
                  {myPin.openclaw_version ?? 'Unknown'} / {myPin.variant ?? 'Unknown'}
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
              <div className="pt-2">
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
                    <p className="text-muted-foreground mt-1.5 flex items-start gap-1 text-xs">
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
          )}
        </div>

        {/* Right: compact image hash list. No redundant heading and no
            "Following latest" pill — those live in the OpenClaw Instance row
            above. */}
        <div className="text-sm">
          <table>
            <tbody>
              {isPinned ? (
                <ImageRow
                  label="Pinned image"
                  openclawVersion={myPin.openclaw_version}
                  imageTag={myPin.image_tag}
                />
              ) : (
                <VersionImageMetadata
                  currentOpenClawVersion={trackedOpenClawVersion}
                  trackedImageTag={trackedImageTag}
                  latestOpenClawVersion={latestOpenClawVersion}
                  latestImageTag={latestImageTag}
                />
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
