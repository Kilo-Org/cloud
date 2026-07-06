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
});
