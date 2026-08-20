import { describe, expect, it } from 'vitest';

import { normalizeTransportPayload } from './mobile-session-transport-payload';

describe('normalizeTransportPayload', () => {
  it('keeps a custom slug on a prompt payload', () => {
    const result = normalizeTransportPayload({
      type: 'prompt',
      prompt: 'hello',
      mode: 'reviewer',
      model: { providerID: 'kilo', modelID: 'kilo-auto/efficient' },
    });
    expect(result).toMatchObject({
      type: 'prompt',
      prompt: 'hello',
      mode: 'reviewer',
      model: 'kilo-auto/efficient',
    });
  });

  it('aliases build to code on a prompt payload', () => {
    const result = normalizeTransportPayload({
      type: 'prompt',
      prompt: 'hello',
      mode: 'build',
      model: { providerID: 'kilo', modelID: 'kilo-auto/efficient' },
    });
    expect(result).toMatchObject({
      type: 'prompt',
      prompt: 'hello',
      mode: 'code',
      model: 'kilo-auto/efficient',
    });
  });
});
