import { describe, expect, it } from 'vitest';
import { createSseDecoder, isolatedKiloEnvironment } from '../../e2e/local-kilo.js';

describe('isolatedKiloEnvironment', () => {
  it('isolates the home and copies only the allowlisted parent variables', () => {
    const env = isolatedKiloEnvironment({
      home: '/tmp/kilo-home',
      password: 'pw',
      web: 'http://web',
      worker: 'http://worker',
      gateway: 'http://gateway',
      parent: { PATH: '/usr/bin', AWS_SECRET_ACCESS_KEY: 'leak', NEXTAUTH_SECRET: 'leak' },
    });
    expect(env.HOME).toBe('/tmp/kilo-home');
    expect(env.XDG_CONFIG_HOME).toBe('/tmp/kilo-home/config');
    expect(env.KILO_DB).toBe('/tmp/kilo-home/kilo.db');
    expect(env.PATH).toBe('/usr/bin');
    expect('AWS_SECRET_ACCESS_KEY' in env).toBe(false);
    expect('NEXTAUTH_SECRET' in env).toBe(false);
  });

  it('omits the credential when no token is supplied', () => {
    const env = isolatedKiloEnvironment({
      home: '/tmp/a',
      password: 'pw',
      web: 'http://web',
      worker: 'http://worker',
      gateway: 'http://gateway',
      parent: {},
    });
    expect('KILO_AUTH_CONTENT' in env).toBe(false);
  });

  it('embeds the supplied token as an in-memory api credential', () => {
    const env = isolatedKiloEnvironment({
      home: '/tmp/b',
      token: 'tok_123',
      password: 'pw',
      web: 'http://web',
      worker: 'http://worker',
      gateway: 'http://gateway',
      parent: {},
    });
    expect(JSON.parse(env.KILO_AUTH_CONTENT ?? '{}')).toEqual({
      kilo: { type: 'api', key: 'tok_123' },
    });
  });
});

describe('createSseDecoder', () => {
  it('decodes a frame arriving across chunk boundaries', () => {
    const decode = createSseDecoder();
    expect(decode('data: {"type":"a","prope')).toEqual([]);
    expect(decode('rties":{"x":1}}\n\n')).toEqual([{ type: 'a', properties: { x: 1 } }]);
  });

  it('decodes multiple frames in one chunk and skips keep-alives', () => {
    const decode = createSseDecoder();
    expect(
      decode(
        ': keep-alive\n\ndata: {"type":"one","properties":{}}\n\r\ndata: {"type":"two","properties":{"k":"v"}}\n\n'
      )
    ).toEqual([
      { type: 'one', properties: {} },
      { type: 'two', properties: { k: 'v' } },
    ]);
  });

  it('rejects a frame without a typed event', () => {
    const decode = createSseDecoder();
    expect(() => decode('data: {"properties":{}}\n\n')).toThrow();
  });
});
