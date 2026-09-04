import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createWrapperKiloClient, type WrapperKiloClient } from '../../../wrapper/src/kilo-api.js';
import {
  createWorktreeKiloRuntimes,
  type WorktreeKiloAuth,
  type WorktreeKiloRuntimes,
} from '../../../wrapper/src/control/worktree-runtime.js';
import { startSandboxControlEventFeed } from '../../../wrapper/src/control/sandbox-control-runtime.js';
import type * as ControlRuntimeModule from '../../../wrapper/src/control/sandbox-control-runtime.js';

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  },
}));
vi.mock('@kilocode/sdk', () => ({ createKiloClient: vi.fn(() => ({})) }));
vi.mock('../../../wrapper/src/kilo-api.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../wrapper/src/kilo-api.js')>()),
  createWrapperKiloClient: vi.fn(),
}));
vi.mock('../../../wrapper/src/control/sandbox-control-runtime.js', async importOriginal => ({
  ...(await importOriginal<typeof ControlRuntimeModule>()),
  startSandboxControlEventFeed: vi.fn(async () => ({ isFresh: () => true })),
}));

const first = {
  sessionId: 'workspace_first',
  kiloSessionId: 'ses_first',
  directory: '/workspace/test-refresh',
};
const sibling = { ...first, sessionId: 'workspace_sibling', kiloSessionId: 'ses_sibling' };
const auth: WorktreeKiloAuth = {
  scopeId: 'worktree_refresh',
  token: 'real-kilo-original',
  containmentEnabled: false,
  targets: {
    backendBaseUrl: 'https://backend.example.test',
    providerBaseUrl: 'https://provider.example.test',
    sessionIngestBaseUrl: 'https://ingest.example.test',
  },
};
const registries: WorktreeKiloRuntimes[] = [];

function fixture() {
  const clients: WrapperKiloClient[] = [];
  vi.mocked(createWrapperKiloClient).mockImplementation((_client, serverUrl) => {
    const client = {
      serverUrl,
      getSessionStatuses: async () => ({}),
      createPty: async () => {
        throw new Error('Unexpected PTY');
      },
    } as WrapperKiloClient;
    clients.push(client);
    return client;
  });
  const stops: Array<() => void> = [];
  const startServer = vi.fn(async () => {
    const stopped = Promise.withResolvers<void>();
    const close = () => stopped.resolve();
    stops.push(close);
    return { url: `http://127.0.0.1:${10_000 + stops.length}`, stopped: stopped.promise, close };
  });
  const registry = createWorktreeKiloRuntimes({
    homeRoot: '/test-homes',
    inheritedEnv: {},
    startServer,
    onUnexpectedClose: () => {},
  });
  registries.push(registry);
  async function attach(
    identity = first,
    requestedAuth = auth,
    environment = { GH_TOKEN: 'github-original' }
  ) {
    const attachment = registry.attach(identity, requestedAuth, environment, () => true);
    const runtime = await attachment.ready;
    attachment.commit();
    attachment.release();
    return runtime;
  }
  return { registry, attach, clients, startServer, stops };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json([]))
  );
});

afterEach(() => {
  for (const registry of registries.splice(0)) registry.shutdown();
  vi.unstubAllGlobals();
});

describe('direct per-session worktree credential refresh', () => {
  it('starts sibling roots in one directory with independent servers, clients, homes, and auth', async () => {
    const f = fixture();
    const [firstRuntime, siblingRuntime] = await Promise.all([f.attach(first), f.attach(sibling)]);

    expect(f.startServer).toHaveBeenCalledTimes(2);
    expect(firstRuntime).not.toBe(siblingRuntime);
    expect(firstRuntime.kiloClient).not.toBe(siblingRuntime.kiloClient);
    expect(firstRuntime.env.HOME).not.toBe(siblingRuntime.env.HOME);
    expect(firstRuntime.env.KILOCODE_TOKEN).toBe(auth.token);
    expect(siblingRuntime.env.KILOCODE_TOKEN).toBe(auth.token);
    expect(f.registry.get(first)).toBe(firstRuntime);
    expect(f.registry.get(sibling)).toBe(siblingRuntime);
    expect(f.registry.getAll(first.directory)).toEqual(
      expect.arrayContaining([firstRuntime, siblingRuntime])
    );
    expect(fs.writeFile).toHaveBeenCalledTimes(2);
  });

  it('refreshes only the requested root and never blocks its sibling', async () => {
    const f = fixture();
    const firstRuntime = await f.attach(first);
    const siblingRuntime = await f.attach(sibling);
    const originalSiblingClient = siblingRuntime.kiloClient;

    const refreshed = await f.attach(
      first,
      { ...auth, token: 'real-kilo-renewed' },
      {
        GH_TOKEN: 'github-renewed',
      }
    );

    expect(refreshed).toBe(firstRuntime);
    expect(refreshed.kiloClient).not.toBe(f.clients[0]);
    expect(refreshed.env.GH_TOKEN).toBe('github-renewed');
    expect(siblingRuntime.signal.aborted).toBe(false);
    expect(siblingRuntime.kiloClient).toBe(originalSiblingClient);
    expect(siblingRuntime.env.GH_TOKEN).toBe('github-original');
    expect(f.registry.get(sibling)).toBe(siblingRuntime);
    expect(f.startServer).toHaveBeenCalledTimes(3);
  });

  it('keeps a sibling alive through detach, replacement, and directory-wide deletion', async () => {
    const f = fixture();
    const firstRuntime = await f.attach(first);
    const siblingRuntime = await f.attach(sibling);

    expect(f.registry.detach(first)).toBe(true);
    expect(firstRuntime.signal.aborted).toBe(true);
    expect(siblingRuntime.signal.aborted).toBe(false);
    const replacement = await f.attach(first, { ...auth, token: 'replacement' });
    expect(replacement).not.toBe(firstRuntime);
    expect(siblingRuntime.signal.aborted).toBe(false);

    await f.registry.deleteDirectory(first.directory);
    expect(replacement.signal.aborted).toBe(true);
    expect(siblingRuntime.signal.aborted).toBe(true);
    expect(f.registry.getAll(first.directory)).toEqual([]);
  });

  it('does not let a retired root remove its replacement', async () => {
    const f = fixture();
    const original = await f.attach(first);
    expect(f.registry.detach(first)).toBe(true);
    const replacement = await f.attach(first, { ...auth, token: 'replacement' });
    await Promise.resolve();

    expect(original.signal.aborted).toBe(true);
    expect(f.registry.get(first)).toBe(replacement);
    expect(f.registry.isCurrent(replacement)).toBe(true);
    expect(vi.mocked(startSandboxControlEventFeed)).toHaveBeenCalledTimes(2);
  });
});
