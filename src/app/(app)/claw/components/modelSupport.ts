'use client';

import type { ModelOption } from '@/components/shared/ModelCombobox';
import { calverAtLeast, cleanVersion } from '@/lib/kiloclaw/version';

/**
 * Models available via the kilocode gateway's baked-in catalog in OpenClaw.
 * Older OpenClaw builds cannot discover arbitrary gateway models dynamically.
 */
export const KILOCODE_CATALOG_IDS = new Set([
  'anthropic/claude-opus-4.6',
  'z-ai/glm-5:free',
  'minimax/minimax-m2.5:free',
  'anthropic/claude-sonnet-4.5',
  'openai/gpt-5.2',
  'google/gemini-3-pro-preview',
  'google/gemini-3-flash-preview',
  'x-ai/grok-code-fast-1',
  'moonshotai/kimi-k2.5',
]);

export const OPENCLAW_DYNAMIC_MODEL_DISCOVERY_VERSION = '2026.03.08';

export function supportsDynamicGatewayModels(openclawVersion: string | null | undefined): boolean {
  return calverAtLeast(cleanVersion(openclawVersion), OPENCLAW_DYNAMIC_MODEL_DISCOVERY_VERSION);
}

export function getKiloCodeModelOptions(
  models: ModelOption[],
  openclawVersion: string | null | undefined
): ModelOption[] {
  if (supportsDynamicGatewayModels(openclawVersion)) {
    return models;
  }

  return models.filter(model => KILOCODE_CATALOG_IDS.has(model.id));
}

export function getSettingsModelOptions({
  models,
  trackedOpenClawVersion,
  runningOpenClawVersion,
  isRunning,
  isLoadingRunningVersion,
  hasRunningVersionError,
}: {
  models: ModelOption[];
  trackedOpenClawVersion: string | null | undefined;
  runningOpenClawVersion: string | null | undefined;
  isRunning: boolean;
  isLoadingRunningVersion: boolean;
  hasRunningVersionError: boolean;
}): ModelOption[] {
  if (isRunning && (hasRunningVersionError || isLoadingRunningVersion)) {
    return [];
  }

  return getKiloCodeModelOptions(
    models,
    isRunning ? (runningOpenClawVersion ?? trackedOpenClawVersion) : trackedOpenClawVersion
  );
}

export function getCreateModelOptions({
  models,
  hasPin,
  hasPinLookupError,
  pinnedOpenClawVersion,
  latestOpenClawVersion,
  isLoadingPin,
  isLoadingLatestVersion,
}: {
  models: ModelOption[];
  hasPin: boolean;
  hasPinLookupError: boolean;
  pinnedOpenClawVersion: string | null | undefined;
  latestOpenClawVersion: string | null | undefined;
  isLoadingPin: boolean;
  isLoadingLatestVersion: boolean;
}): ModelOption[] {
  if (
    hasPinLookupError ||
    isLoadingPin ||
    (hasPin && !pinnedOpenClawVersion) ||
    (!hasPin && isLoadingLatestVersion)
  ) {
    return [];
  }

  return getKiloCodeModelOptions(models, pinnedOpenClawVersion ?? latestOpenClawVersion);
}
