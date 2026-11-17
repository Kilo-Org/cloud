import { describe, expect, it } from 'vitest';
import { selectSessionModelPicker } from './agents-session-controls';
describe('pinned Cloud Agent model', () => {
  it('shows and locks the pin over an explicit override', () => {
    const result = selectSessionModelPicker({
      activeSessionType: 'cloud-agent',
      cloudOverride: { model: 'user/model' },
      gatewayModels: [],
      observedModel: null,
      remoteModelOverride: null,
      remoteModelState: { ownerConnectionId: null, protocol: 'unknown', refresh: 'idle' },
      sessionConfig: {
        mode: 'custom',
        runtimeAgents: [{ model: ' pinned/model ', name: 'Custom', slug: 'custom' }],
      },
      sessionModel: null,
    });
    expect(result.selectedId).toBe('pinned/model');
    expect(result.disabledReason).toBe('Model set by agent');
  });
});
