import { describe, expect, it } from 'vitest';
import { ProviderStateSchema } from '../../schemas/instance-config';
import { createMutableState } from './state';
import {
  applyProviderState,
  getFlyProviderState,
  getNorthflankProviderState,
  getProviderRegion,
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

  it('parses Northflank provider state with null defaults', () => {
    expect(ProviderStateSchema.parse({ provider: 'northflank' })).toEqual({
      provider: 'northflank',
      projectId: null,
      projectName: null,
      serviceId: null,
      serviceName: null,
      volumeId: null,
      volumeName: null,
      secretId: null,
      secretName: null,
      secretContentHash: null,
      ingressHost: null,
      region: null,
    });
  });

  it('builds Northflank providerState defaults when providerState is absent', () => {
    const state = createMutableState();

    expect(getNorthflankProviderState(state)).toEqual({
      provider: 'northflank',
      projectId: null,
      projectName: null,
      serviceId: null,
      serviceName: null,
      volumeId: null,
      volumeName: null,
      secretId: null,
      secretName: null,
      secretContentHash: null,
      ingressHost: null,
      region: null,
    });
  });

  it('uses Northflank runtime, storage, and region identifiers', () => {
    const state = createMutableState();

    applyProviderState(state, {
      provider: 'northflank',
      projectId: 'project-1',
      projectName: 'kc-ki-test',
      serviceId: 'service-1',
      serviceName: 'kc-ki-test',
      volumeId: 'volume-1',
      volumeName: 'kc-ki-test',
      secretId: 'secret-1',
      secretName: 'kc-ki-test',
      secretContentHash: null,
      ingressHost: 'kc-ki-test.code.run',
      region: 'us-central',
    });

    expect(state.flyAppName).toBeNull();
    expect(state.flyMachineId).toBeNull();
    expect(state.flyVolumeId).toBeNull();
    expect(state.flyRegion).toBeNull();
    expect(getRuntimeId(state)).toBe('service-1');
    expect(getStorageId(state)).toBe('volume-1');
    expect(getProviderRegion(state)).toBe('us-central');
  });

  it('falls back to Northflank names when IDs are not known yet', () => {
    const state = createMutableState();

    applyProviderState(state, {
      provider: 'northflank',
      projectId: null,
      projectName: 'kc-ki-test',
      serviceId: null,
      serviceName: 'kc-ki-test',
      volumeId: null,
      volumeName: 'kc-ki-test',
      secretId: null,
      secretName: 'kc-ki-test',
      secretContentHash: null,
      ingressHost: null,
      region: null,
    });

    expect(getRuntimeId(state)).toBe('kc-ki-test');
    expect(getStorageId(state)).toBe('kc-ki-test');
    expect(getProviderRegion(state)).toBeNull();
  });
});
