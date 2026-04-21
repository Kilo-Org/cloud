import { describe, expect, it } from 'vitest';
import { createMutableState } from './state';
import {
  applyProviderState,
  getFlyProviderState,
  getRuntimeId,
  getStorageId,
  syncProviderStateForStorage,
} from './state';

describe('provider state helpers', () => {
  it('hydrates legacy Fly fields from canonical providerState', () => {
    const state = createMutableState();

    applyProviderState(state, {
      provider: 'fly',
      appName: 'acct-test',
      machineId: 'machine-1',
      volumeId: 'vol-1',
      region: 'ord',
    });

    expect(state.provider).toBe('fly');
    expect(state.providerState).toEqual({
      provider: 'fly',
      appName: 'acct-test',
      machineId: 'machine-1',
      volumeId: 'vol-1',
      region: 'ord',
    });
    expect(state.flyAppName).toBe('acct-test');
    expect(state.flyMachineId).toBe('machine-1');
    expect(state.flyVolumeId).toBe('vol-1');
    expect(state.flyRegion).toBe('ord');
  });

  it('mirrors explicit providerState patches back to legacy Fly fields for storage', () => {
    const state = createMutableState();

    const patch = syncProviderStateForStorage(state, {
      provider: 'fly',
      providerState: {
        provider: 'fly',
        appName: 'acct-test',
        machineId: 'machine-1',
        volumeId: 'vol-1',
        region: 'ord',
      },
    });

    expect(patch).toEqual({
      provider: 'fly',
      providerState: {
        provider: 'fly',
        appName: 'acct-test',
        machineId: 'machine-1',
        volumeId: 'vol-1',
        region: 'ord',
      },
      flyAppName: 'acct-test',
      flyMachineId: 'machine-1',
      flyVolumeId: 'vol-1',
      flyRegion: 'ord',
    });
  });

  it('mirrors legacy Fly machine-id clears back into providerState for storage', () => {
    const state = createMutableState();

    applyProviderState(state, {
      provider: 'fly',
      appName: 'acct-test',
      machineId: 'machine-1',
      volumeId: 'vol-1',
      region: 'ord',
    });

    const patch = syncProviderStateForStorage(state, {
      flyMachineId: null,
      status: 'stopped',
    });

    expect(patch).toEqual({
      flyMachineId: null,
      status: 'stopped',
      provider: 'fly',
      providerState: {
        provider: 'fly',
        appName: 'acct-test',
        machineId: null,
        volumeId: 'vol-1',
        region: 'ord',
      },
    });
    expect(state.providerState).toEqual({
      provider: 'fly',
      appName: 'acct-test',
      machineId: null,
      volumeId: 'vol-1',
      region: 'ord',
    });
  });

  it('derives Fly providerState from legacy fields when providerState is absent', () => {
    const state = createMutableState();
    state.flyAppName = 'acct-test';
    state.flyMachineId = 'machine-1';
    state.flyVolumeId = 'vol-1';
    state.flyRegion = 'ord';

    expect(getFlyProviderState(state)).toEqual({
      provider: 'fly',
      appName: 'acct-test',
      machineId: 'machine-1',
      volumeId: 'vol-1',
      region: 'ord',
    });
  });

  it('clears legacy Fly fields when applying a non-Fly provider state', () => {
    const state = createMutableState();
    state.flyAppName = 'acct-old';
    state.flyMachineId = 'machine-old';
    state.flyVolumeId = 'vol-old';
    state.flyRegion = 'ord';

    applyProviderState(state, {
      provider: 'docker-local',
      containerName: 'kiloclaw-sandbox-1',
      volumeName: 'kiloclaw-root-sandbox-1',
      hostPort: 45001,
    });

    expect(state.flyAppName).toBeNull();
    expect(state.flyMachineId).toBeNull();
    expect(state.flyVolumeId).toBeNull();
    expect(state.flyRegion).toBeNull();
    expect(getRuntimeId(state)).toBe('kiloclaw-sandbox-1');
    expect(getStorageId(state)).toBe('kiloclaw-root-sandbox-1');
  });

  it('clears legacy Fly fields in storage when writing non-Fly providerState', () => {
    const state = createMutableState();
    state.flyAppName = 'acct-old';
    state.flyMachineId = 'machine-old';
    state.flyVolumeId = 'vol-old';
    state.flyRegion = 'ord';

    const patch = syncProviderStateForStorage(state, {
      provider: 'docker-local',
      providerState: {
        provider: 'docker-local',
        containerName: 'kiloclaw-sandbox-1',
        volumeName: 'kiloclaw-root-sandbox-1',
        hostPort: 45001,
      },
    });

    expect(patch).toEqual({
      provider: 'docker-local',
      providerState: {
        provider: 'docker-local',
        containerName: 'kiloclaw-sandbox-1',
        volumeName: 'kiloclaw-root-sandbox-1',
        hostPort: 45001,
      },
      flyAppName: null,
      flyMachineId: null,
      flyVolumeId: null,
      flyRegion: null,
    });
  });
});
