/* eslint-disable eslint/id-length -- fragment keys are the wire names `t` and `v` */
import { describe, expect, it } from 'vitest';
import { isUsableStoredEndpoint, parseLoopbackSocketUrl, parsePairingUrl } from './pairing';

const HUB_ID = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const TOKEN = 'EBESExQVFhcYGRobHB0eHw';
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const WS = 'ws://127.0.0.1:47917/__kilo_browser';

const pairingUrl = (overrides: Record<string, string> = {}, base = 'http://127.0.0.1:47917') => {
  const fields = { hub: HUB_ID, t: TOKEN, v: '1', ws: WS, ...overrides };

  return `${base}/__kilo_browser_pair#${Object.entries(fields)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&')}`;
};

describe('pairing fragment parsing', () => {
  it('accepts the documented loopback pairing URL and carries no key', () => {
    expect(parsePairingUrl(pairingUrl())).toStrictEqual({
      hubId: HUB_ID,
      token: TOKEN,
      ws: WS,
    });
  });

  it('accepts localhost as the pairing page host', () => {
    expect(parsePairingUrl(pairingUrl({}, 'http://localhost:47917'))).not.toBeNull();
  });

  it('rejects a non-loopback pairing page', () => {
    expect(parsePairingUrl(pairingUrl({}, 'http://192.168.0.10:47917'))).toBeNull();
    expect(parsePairingUrl(pairingUrl({}, 'https://example.com'))).toBeNull();
  });

  it('rejects the wrong path, scheme, or a missing port', () => {
    expect(parsePairingUrl(pairingUrl().replace('__kilo_browser_pair', '__kilo_other'))).toBeNull();
    expect(parsePairingUrl(pairingUrl().replace('http://', 'https://'))).toBeNull();
    expect(parsePairingUrl(pairingUrl({}, 'http://127.0.0.1'))).toBeNull();
  });

  it('rejects a protocol version other than 1', () => {
    expect(parsePairingUrl(pairingUrl({ v: '2' }))).toBeNull();
    expect(parsePairingUrl(pairingUrl({ v: '' }))).toBeNull();
  });

  it('rejects a non-UUID hub id', () => {
    expect(parsePairingUrl(pairingUrl({ hub: 'hub-1' }))).toBeNull();
  });

  it('rejects a token that is not 16 bytes', () => {
    expect(parsePairingUrl(pairingUrl({ t: 'EBESExQVFhcYGRobHB0eH' }))).toBeNull();
    expect(parsePairingUrl(pairingUrl({ t: `${TOKEN}AA` }))).toBeNull();
    expect(parsePairingUrl(pairingUrl({ t: 'not!base64url' }))).toBeNull();
  });

  it('rejects the retired key-bearing fragment', () => {
    expect(parsePairingUrl(pairingUrl({ k: KEY, t: '' }))).toBeNull();
  });

  it('rejects duplicate fragment parameters and an empty fragment', () => {
    expect(parsePairingUrl(`${pairingUrl()}&t=${TOKEN}`)).toBeNull();
    expect(parsePairingUrl('http://127.0.0.1:47917/__kilo_browser_pair')).toBeNull();
    expect(parsePairingUrl('http://127.0.0.1:47917/__kilo_browser_pair#')).toBeNull();
  });
});

describe('loopback-only socket validation', () => {
  it('accepts loopback ws URLs and canonicalizes them', () => {
    expect(parseLoopbackSocketUrl(WS)).toBe(WS);
    expect(parseLoopbackSocketUrl('ws://localhost:47917/__kilo_browser')).toBe(
      'ws://localhost:47917/__kilo_browser'
    );
    expect(parseLoopbackSocketUrl('ws://[::1]:47917/__kilo_browser')).toBe(
      'ws://[::1]:47917/__kilo_browser'
    );
  });

  it('rejects every non-loopback socket URL', () => {
    for (const url of [
      'wss://127.0.0.1:47917/__kilo_browser',
      'ws://example.com:47917/__kilo_browser',
      'ws://192.168.0.10:47917/__kilo_browser',
      'ws://127.0.0.1/__kilo_browser',
      'ws://127.0.0.1:47917/other',
      'ws://user:pass@127.0.0.1:47917/__kilo_browser',
      'ws://127.0.0.1:47917/__kilo_browser?x=1',
      'ws://127.0.0.1:47917/__kilo_browser#x',
      'http://127.0.0.1:47917/__kilo_browser',
    ]) {
      expect(parseLoopbackSocketUrl(url)).toBeNull();
    }
  });

  it('rejects a pairing fragment that carries a non-loopback socket', () => {
    expect(parsePairingUrl(pairingUrl({ ws: 'wss://hub.kilo.ai/__kilo_browser' }))).toBeNull();
    expect(parsePairingUrl(pairingUrl({ ws: 'ws://10.0.0.5:47917/__kilo_browser' }))).toBeNull();
  });

  it('refuses stored endpoints that fail the loopback rules', () => {
    expect(isUsableStoredEndpoint({ hubId: HUB_ID, key: KEY, ws: WS })).toBe(true);
    expect(
      isUsableStoredEndpoint({ hubId: HUB_ID, key: KEY, ws: 'ws://hub.kilo.ai/__kilo_browser' })
    ).toBe(false);
    expect(isUsableStoredEndpoint({ hubId: 'nope', key: KEY, ws: WS })).toBe(false);
    expect(isUsableStoredEndpoint({ hubId: HUB_ID, key: 'short', ws: WS })).toBe(false);
  });
});
