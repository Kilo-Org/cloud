import { describe, expect, it } from 'vitest';
import { sandboxControlWebSocketUrl } from './control-url.js';

describe('sandboxControlWebSocketUrl', () => {
  it('converts https worker URLs to wss', () => {
    expect(sandboxControlWebSocketUrl('https://example.test/', 'ses-abc')).toBe(
      'wss://example.test/sandbox-control/ses-abc'
    );
  });

  it('converts http worker URLs to ws', () => {
    expect(sandboxControlWebSocketUrl('http://127.0.0.1:8794', 'ses-abc')).toBe(
      'ws://127.0.0.1:8794/sandbox-control/ses-abc'
    );
  });

  it('encodes the sandbox id', () => {
    expect(sandboxControlWebSocketUrl('https://example.test', 'ses/a b')).toBe(
      'wss://example.test/sandbox-control/ses%2Fa%20b'
    );
  });
});
