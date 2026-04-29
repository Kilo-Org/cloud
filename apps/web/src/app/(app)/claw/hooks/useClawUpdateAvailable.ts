'use client';

import { calverAtLeast, cleanVersion, getRunningVersionBadge } from '@/lib/kiloclaw/version';
import { useClawControllerVersion, useClawLatestVersion } from './useClawHooks';

/**
 * Centralised version / upgrade detection for a KiloClaw instance.
 *
 * Consumed by both ClawDashboard (page-level upgrade banner) and
 * SettingsTab (inline badge + OpenClaw Instance card).
 */
export function useClawUpdateAvailable(status: {
  status: string | null;
  openclawVersion: string | null;
  imageVariant: string | null;
  trackedImageTag: string | null;
}) {
  const isRunning = status.status === 'running';

  const {
    data: controllerVersion,
    isLoading: isLoadingControllerVersion,
    isError: isControllerVersionError,
  } = useClawControllerVersion(isRunning);
  // Pass the instance's current trackedImageTag to the resolver. Without it
  // the resolver can return :latest as an "upgrade" for an instance that's
  // actually on the (newer) candidate — surfacing as a misleading downgrade
  // banner.
  const { data: latestVersion } = useClawLatestVersion(status.trackedImageTag);

  const trackedVersion = cleanVersion(status.openclawVersion);
  const runningVersion = cleanVersion(controllerVersion?.openclawVersion);
  const latestAvailableVersion = cleanVersion(latestVersion?.openclawVersion);

  const needsImageUpgrade = isRunning && !!controllerVersion && !controllerVersion.version;
  const isModified = getRunningVersionBadge(runningVersion, trackedVersion) === 'modified';
  const catalogNewerThanImage =
    !!trackedVersion &&
    !!latestAvailableVersion &&
    latestAvailableVersion !== trackedVersion &&
    calverAtLeast(latestAvailableVersion, trackedVersion);
  const hasVersionInfo = isRunning && !!trackedVersion && trackedVersion !== ':latest';
  // Only compare image tags when variants match — latestVersion is always
  // for the "default" variant, so skip for non-default instances to avoid
  // false "Update available" badges that would switch their variant.
  const variantsMatch =
    !status.imageVariant ||
    status.imageVariant === 'default' ||
    status.imageVariant === latestVersion?.variant;
  const imageTagDiffers =
    hasVersionInfo &&
    variantsMatch &&
    !!status.trackedImageTag &&
    !!latestVersion?.imageTag &&
    status.trackedImageTag !== latestVersion.imageTag;
  const updateAvailable = catalogNewerThanImage
    ? !isModified ||
      (!!runningVersion &&
        calverAtLeast(latestAvailableVersion, runningVersion) &&
        latestAvailableVersion !== runningVersion)
    : imageTagDiffers;

  return {
    updateAvailable,
    catalogNewerThanImage,
    needsImageUpgrade,
    isModified,
    hasVersionInfo,
    variantsMatch,
    trackedVersion,
    runningVersion,
    latestAvailableVersion,
    latestVersion,
    controllerVersion,
    isLoadingControllerVersion,
    isControllerVersionError,
  };
}
