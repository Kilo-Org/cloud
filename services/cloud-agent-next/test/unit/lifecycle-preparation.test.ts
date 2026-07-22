import { describe, expect, it } from 'vitest';

import { unexpectedColdPreparationSteps } from '../e2e/lifecycle.js';
import type { StreamEvent } from '../e2e/client.js';

function preparing(data: Record<string, unknown>): StreamEvent {
  return {
    eventId: 0,
    executionId: null,
    sessionId: 'agent_test',
    streamEventType: 'preparing',
    timestamp: new Date(0).toISOString(),
    data,
  };
}

describe('unexpectedColdPreparationSteps', () => {
  it('ignores snapshots, attempt events, and live warm verification steps', () => {
    const events = [
      preparing({ version: 2, action: 'attempt_snapshot', step: 'workspace_setup' }),
      preparing({ version: 2, action: 'step_snapshot', step: 'cloning' }),
      preparing({ version: 2, action: 'attempt_started', step: 'workspace_setup' }),
      preparing({ version: 2, action: 'step_started', step: 'sandbox_provision' }),
      preparing({ version: 2, action: 'step_started', step: 'sandbox_boot' }),
      preparing({ version: 2, action: 'step_started', step: 'kilo_server' }),
      preparing({ version: 2, action: 'attempt_completed', step: 'ready' }),
    ];

    expect(unexpectedColdPreparationSteps(events)).toEqual([]);
  });

  it('reports unique live cold-path steps', () => {
    const events = [
      preparing({ version: 2, action: 'step_started', step: 'workspace_setup' }),
      preparing({ version: 2, action: 'step_started', step: 'cloning' }),
      preparing({ version: 2, action: 'step_progress', step: 'cloning' }),
      preparing({ version: 2, action: 'step_started', step: 'cloning' }),
      preparing({ version: 2, action: 'step_started', step: 'kilo_session' }),
    ];

    expect(unexpectedColdPreparationSteps(events)).toEqual([
      'workspace_setup',
      'cloning',
      'kilo_session',
    ]);
  });

  it('fails closed for legacy and malformed live preparation events', () => {
    const events = [
      preparing({ step: 'cloning', message: 'Cloning repository' }),
      preparing({ version: 2, action: 'step_started' }),
    ];

    expect(unexpectedColdPreparationSteps(events)).toEqual(['legacy:cloning', 'unknown']);
  });
});
