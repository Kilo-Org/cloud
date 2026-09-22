import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handler: undefined as undefined | ((req: unknown, res: unknown) => void),
  spawn: vi.fn(),
}));

vi.mock('node:http', () => ({
  createServer: (handler: typeof mocks.handler) => {
    mocks.handler = handler;
    return { listen: vi.fn() };
  },
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs/promises', () => ({
  mkdtemp: async () => '/tmp/benchmark-auth-test',
  rm: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.resetModules();
  mocks.spawn.mockReset();
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    setTimeout(() => child.emit('close', 0), 0);
    return child;
  });
});

it.each(['/warmup', '/run'])(
  '%s disables automatic ingest while preserving API/gateway authentication',
  async url => {
    const serverPath = '../container/server.mjs';
    await import(serverPath);
    const req = Object.assign(
      Readable.from([
        Buffer.from(
          JSON.stringify({
            model: 'test-model',
            prompt: 'test prompt',
            kiloToken: 'test-benchmark-token',
            kiloApiUrl: 'https://example.test',
            orgId: 'test-org',
          })
        ),
      ]),
      { method: 'POST', url }
    );
    await new Promise<void>(resolve => {
      if (!mocks.handler) throw new Error('Container handler was not installed');
      mocks.handler(req, { writeHead: vi.fn(), end: () => resolve() });
    });
    expect(mocks.spawn).toHaveBeenCalledOnce();
    const options = mocks.spawn.mock.calls[0][2];
    expect(options.env.KILO_DISABLE_SESSION_INGEST).toBe('1');
    expect(options.env.KILO_API_URL).toBe('https://example.test');
    expect(JSON.parse(options.env.KILO_AUTH_CONTENT)).toEqual({
      kilo: { type: 'api', key: 'test-benchmark-token', organizationId: 'test-org' },
    });
  }
);
