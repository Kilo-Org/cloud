import { describe, expect, test } from '@jest/globals';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import {
  getCreateModelOptions,
  getKiloCodeModelOptions,
  getSettingsModelOptions,
  OPENCLAW_DYNAMIC_MODEL_DISCOVERY_VERSION,
  supportsDynamicGatewayModels,
} from '@/app/(app)/claw/components/modelSupport';

const modelOptions: ModelOption[] = [
  { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
  { id: 'openai/o4-mini', name: 'o4-mini' },
];

describe('supportsDynamicGatewayModels', () => {
  test('returns false below the OpenClaw dynamic model discovery version', () => {
    expect(supportsDynamicGatewayModels('2026.03.07')).toBe(false);
  });

  test('returns true at the OpenClaw dynamic model discovery version', () => {
    expect(supportsDynamicGatewayModels(OPENCLAW_DYNAMIC_MODEL_DISCOVERY_VERSION)).toBe(true);
  });

  test('returns true when the version string includes build quotes', () => {
    expect(supportsDynamicGatewayModels('"2026.03.09"')).toBe(true);
  });

  test('returns true when the version string includes a label and commit hash', () => {
    expect(supportsDynamicGatewayModels('OpenClaw 2026.3.8 (3caab92)')).toBe(true);
  });
});

describe('getKiloCodeModelOptions', () => {
  test('filters to the baked-in catalog on older OpenClaw versions', () => {
    expect(getKiloCodeModelOptions(modelOptions, '2026.03.07')).toEqual([
      { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
    ]);
  });

  test('returns all gateway models when dynamic discovery is supported', () => {
    expect(getKiloCodeModelOptions(modelOptions, '2026.03.08')).toEqual(modelOptions);
  });
});

describe('getSettingsModelOptions', () => {
  test('waits for the running OpenClaw version before deriving options', () => {
    expect(
      getSettingsModelOptions({
        models: modelOptions,
        trackedOpenClawVersion: '2026.03.07',
        runningOpenClawVersion: undefined,
        isRunning: true,
        isLoadingRunningVersion: true,
        hasRunningVersionError: false,
      })
    ).toEqual([]);
  });

  test('uses the running OpenClaw version once it resolves', () => {
    expect(
      getSettingsModelOptions({
        models: modelOptions,
        trackedOpenClawVersion: '2026.03.07',
        runningOpenClawVersion: '2026.03.08',
        isRunning: true,
        isLoadingRunningVersion: false,
        hasRunningVersionError: false,
      })
    ).toEqual(modelOptions);
  });

  test('blocks options when running-version lookup fails', () => {
    expect(
      getSettingsModelOptions({
        models: modelOptions,
        trackedOpenClawVersion: '2026.03.07',
        runningOpenClawVersion: '2026.03.08',
        isRunning: true,
        isLoadingRunningVersion: false,
        hasRunningVersionError: true,
      })
    ).toEqual([]);
  });

  test('prefers the tracked image version when the instance is stopped', () => {
    expect(
      getSettingsModelOptions({
        models: modelOptions,
        trackedOpenClawVersion: '2026.03.07',
        runningOpenClawVersion: '2026.03.08',
        isRunning: false,
        isLoadingRunningVersion: false,
        hasRunningVersionError: false,
      })
    ).toEqual([{ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' }]);
  });
});

describe('getCreateModelOptions', () => {
  test('waits for the user pin before deriving provision-time options', () => {
    expect(
      getCreateModelOptions({
        models: modelOptions,
        hasPin: false,
        hasPinLookupError: false,
        pinnedOpenClawVersion: undefined,
        latestOpenClawVersion: '2026.03.08',
        isLoadingPin: true,
        isLoadingLatestVersion: false,
      })
    ).toEqual([]);
  });

  test('waits for latest version when the user has no pin yet', () => {
    expect(
      getCreateModelOptions({
        models: modelOptions,
        hasPin: false,
        hasPinLookupError: false,
        pinnedOpenClawVersion: null,
        latestOpenClawVersion: undefined,
        isLoadingPin: false,
        isLoadingLatestVersion: true,
      })
    ).toEqual([]);
  });

  test('blocks when pin lookup fails', () => {
    expect(
      getCreateModelOptions({
        models: modelOptions,
        hasPin: false,
        hasPinLookupError: true,
        pinnedOpenClawVersion: null,
        latestOpenClawVersion: '2026.03.08',
        isLoadingPin: false,
        isLoadingLatestVersion: false,
      })
    ).toEqual([]);
  });

  test('blocks when a pin exists but its OpenClaw version is unknown', () => {
    expect(
      getCreateModelOptions({
        models: modelOptions,
        hasPin: true,
        hasPinLookupError: false,
        pinnedOpenClawVersion: null,
        latestOpenClawVersion: '2026.03.08',
        isLoadingPin: false,
        isLoadingLatestVersion: false,
      })
    ).toEqual([]);
  });

  test('uses the pinned OpenClaw version when present', () => {
    expect(
      getCreateModelOptions({
        models: modelOptions,
        hasPin: true,
        hasPinLookupError: false,
        pinnedOpenClawVersion: '2026.03.07',
        latestOpenClawVersion: '2026.03.08',
        isLoadingPin: false,
        isLoadingLatestVersion: false,
      })
    ).toEqual([{ id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' }]);
  });

  test('falls back to latest OpenClaw version when no pin exists', () => {
    expect(
      getCreateModelOptions({
        models: modelOptions,
        hasPin: false,
        hasPinLookupError: false,
        pinnedOpenClawVersion: null,
        latestOpenClawVersion: '2026.03.08',
        isLoadingPin: false,
        isLoadingLatestVersion: false,
      })
    ).toEqual(modelOptions);
  });
});
