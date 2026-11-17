import { describe, expect, it } from 'vitest';
import {
  createCompactionErrorEvent,
  createTurnErrorEvent,
  describeFetchError,
} from './agent-turn-error';
import {
  KiloGatewayHttpError,
  KiloGatewayStreamStalledError,
} from './kilo-gateway-chat-stream-client';

describe('describing a failed request', () => {
  it('reports an unreachable server as retryable without leaking the fetch failure', () => {
    const described = describeFetchError(new TypeError('Failed to fetch'));

    expect(described.retryable).toBe(true);
    expect(described.detail).toBeUndefined();
    expect(described.title).not.toContain('Failed to fetch');
    expect(described.title).toContain('connection');
  });

  it('keeps the server reason for a rejected key and offers no retry', () => {
    const described = describeFetchError(
      new KiloGatewayHttpError(401, { error: { message: 'Invalid API key' } })
    );

    expect(described).toMatchObject({ detail: 'Invalid API key', retryable: false });
    expect(described.title).not.toContain('401');
    expect(described.action).toBeUndefined();
  });

  it('links the credits page when the balance is exhausted', () => {
    const described = describeFetchError(new KiloGatewayHttpError(402, { error: 'Insufficient' }));

    expect(described).toMatchObject({ detail: 'Insufficient', retryable: false });
    expect(described.action?.label).toBe('Add credits');
    expect(described.action?.href).toMatch(/\/credits$/u);
  });

  it('treats a busy or failing server as retryable', () => {
    for (const status of [408, 429, 500, 503]) {
      const described = describeFetchError(new KiloGatewayHttpError(status, { message: 'busy' }));

      expect(described.retryable).toBe(true);
      expect(described.detail).toBe('busy');
    }
  });

  it('treats a stalled stream as retryable', () => {
    expect(
      describeFetchError(new KiloGatewayStreamStalledError('Gateway stream stalled.'))
    ).toStrictEqual({
      retryable: true,
      title: 'Kilo stopped responding.',
    });
  });

  it('maps a bare status and body when the caller has no error type', () => {
    expect(
      describeFetchError(undefined, 403, { error: { message: 'Organization required' } })
    ).toMatchObject({ detail: 'Organization required', retryable: false });
  });

  it('never turns an unknown failure into raw internal wording', () => {
    const described = describeFetchError(
      new Error('Gateway chat completion stream did not include a body.')
    );

    expect(described.detail).toBeUndefined();
    expect(described.title).not.toContain('body');
    expect(described.retryable).toBe(true);
  });
});

describe('error events', () => {
  it('marks a retryable turn failure as a turn retry', () => {
    expect(createTurnErrorEvent(new KiloGatewayHttpError(503))).toMatchObject({
      retry: 'turn',
      type: 'error',
    });
  });

  it('leaves the retry out when repeating the request cannot help', () => {
    expect(createTurnErrorEvent(new KiloGatewayHttpError(401))).not.toHaveProperty('retry');
  });

  it('marks a failed compaction as a compaction retry', () => {
    expect(createCompactionErrorEvent(new TypeError('Failed to fetch'))).toMatchObject({
      retry: 'compaction',
      type: 'error',
    });
  });
});
