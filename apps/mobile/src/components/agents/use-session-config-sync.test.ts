import { describe, expect, it, vi } from 'vitest';

import { resolveSessionConfigSelection } from './use-session-config-sync';

vi.mock('@/components/agents/mode-options', () => ({
  normalizeAgentMode: (mode: string | null | undefined) => mode ?? 'code',
}));

const gatewayModels = [
  {
    id: 'gateway/first',
    name: 'First Gateway Model',
    displayId: 'gateway/first',
    variants: ['high'],
    isPreferred: true,
    showGatewayMetadata: true,
  },
];

describe('resolveSessionConfigSelection', () => {
  it('does not auto-select the first Gateway model for a remote session without an override', () => {
    expect(
      resolveSessionConfigSelection({
        activeSessionType: 'remote',
        fetchedData: {},
        sessionConfig: { model: 'gateway/from-assistant', variant: 'high' },
        modelOptions: gatewayModels,
        selectedModel: '',
        selectedVariant: '',
      })
    ).toEqual({ model: '', variant: '' });
  });

  it('preserves the existing first-model default for Cloud Agent sessions', () => {
    expect(
      resolveSessionConfigSelection({
        activeSessionType: 'cloud-agent',
        fetchedData: {},
        sessionConfig: null,
        modelOptions: gatewayModels,
        selectedModel: '',
        selectedVariant: '',
      })
    ).toEqual({ model: 'gateway/first', variant: 'high' });
  });

  it('prefers the cloud-agent model override over stored session config', () => {
    expect(
      resolveSessionConfigSelection({
        activeSessionType: 'cloud-agent',
        fetchedData: { model: 'stored/from-fetch', variant: 'low' },
        sessionConfig: { model: 'stored/from-session', variant: 'medium' },
        modelOptions: gatewayModels,
        selectedModel: '',
        selectedVariant: '',
        cloudAgentModelOverride: { model: 'user/picked', variant: 'high' },
      })
    ).toEqual({ model: 'user/picked', variant: 'high' });
  });

  it('falls back to stored session model when there is no cloud-agent override', () => {
    expect(
      resolveSessionConfigSelection({
        activeSessionType: 'cloud-agent',
        fetchedData: { model: 'stored/from-fetch', variant: 'low' },
        sessionConfig: { model: 'stored/from-session', variant: 'medium' },
        modelOptions: gatewayModels,
        selectedModel: '',
        selectedVariant: '',
        cloudAgentModelOverride: null,
      })
    ).toEqual({ model: 'stored/from-session', variant: 'medium' });
  });

  it('ignores cloud-agent override on remote sessions', () => {
    expect(
      resolveSessionConfigSelection({
        activeSessionType: 'remote',
        fetchedData: {},
        sessionConfig: null,
        modelOptions: gatewayModels,
        selectedModel: 'remote/selected',
        selectedVariant: 'max',
        cloudAgentModelOverride: { model: 'should/not/win', variant: 'high' },
      })
    ).toEqual({ model: 'remote/selected', variant: 'max' });
  });
});
