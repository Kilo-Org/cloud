import { afterEach, describe, expect, it, vi } from 'vitest';

import { reconnectHint, socketProtocol, socketTicket } from './protocol';

afterEach(() => vi.restoreAllMocks());

describe('jittered reconnect hints', () => {
  it('spreads independent connections across the full one-minute window', () => {
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(1 - Number.EPSILON);
    expect([reconnectHint(), reconnectHint(), reconnectHint()]).toEqual([1000, 30_500, 60_000]);
  });
});

describe('socket credential transport', () => {
  it('accepts bearer tickets without putting credentials in URLs', () => {
    const request = new Request('https://session-sync.test/live', {
      headers: { authorization: ['Bearer', 'synthetic-ticket'].join(' ') },
    });
    expect(socketTicket(request)).toBe('synthetic-ticket');
    expect(socketProtocol(request)).toBeUndefined();
  });

  it('selects the browser subprotocol ticket for authentication and response echo', () => {
    const protocol = 'kilo-session-ticket.test.ticket.signature';
    const request = new Request('https://session-sync.test/live', {
      headers: { 'sec-websocket-protocol': `json, ${protocol}` },
    });
    expect(socketTicket(request)).toBe('test.ticket.signature');
    expect(socketProtocol(request)).toBe(protocol);
  });

  it('rejects query tickets even when a valid bearer header is also supplied', () => {
    expect(
      socketTicket(
        new Request('https://session-sync.test/live?ticket=secret', {
          headers: { authorization: ['Bearer', 'synthetic-ticket'].join(' ') },
        })
      )
    ).toBeUndefined();
  });

  it('rejects ambiguous subprotocol tickets and malformed authorization without fallback', () => {
    const protocol = 'kilo-session-ticket.test.ticket.signature';
    expect(
      socketTicket(
        new Request('https://session-sync.test/live', {
          headers: { 'sec-websocket-protocol': `${protocol}, ${protocol}` },
        })
      )
    ).toBeUndefined();
    expect(
      socketTicket(
        new Request('https://session-sync.test/live', {
          headers: { authorization: 'Basic invalid', 'sec-websocket-protocol': protocol },
        })
      )
    ).toBeUndefined();
  });
});
