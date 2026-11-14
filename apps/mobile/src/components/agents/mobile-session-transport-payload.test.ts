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

  it('returns only the command fields for a slash command payload', () => {
    const result = normalizeTransportPayload({
      type: 'command',
      command: 'review',
      arguments: 'src',
    });
    expect(result).toEqual({ type: 'command', command: 'review', arguments: 'src' });
  });

  it('throws when a prompt payload has no model', () => {
    expect(() =>
      normalizeTransportPayload({ type: 'prompt', prompt: 'hello', mode: 'code' })
    ).toThrow('Model is required');
  });

  it('throws when a prompt payload selects a non-Kilo provider', () => {
    expect(() =>
      normalizeTransportPayload({
        type: 'prompt',
        prompt: 'hello',
        mode: 'code',
        model: { providerID: 'openrouter', modelID: 'x' },
      })
    ).toThrow('Cloud Agent only supports Kilo models');
  });
});
