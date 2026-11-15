import { Effect } from 'effect';
import { vi } from 'vitest';

import { type Tool } from '@kilocode/harness-sdk';
import {
  type RemoteMcpClientDeps,
  type RemoteMcpError,
  type RemoteMcpServer,
} from '@kilocode/harness-sdk/plugins/remote-mcp';

import { tool } from './remote-mcp.test-helpers';
import { type StoredRemoteMcpServer } from './remote-mcp-store';

/**
 * The world the remote-MCP discovery suites run in: the stored list, the one
 * discovery function, and the modules `remote-mcp.ts` reads both through, faked
 * so the module's own subscription — the thing that drops a disabled server's
 * tools — can be driven without a device.
 */

const world = vi.hoisted(() => ({
  servers: [] as StoredRemoteMcpServer[],
  epoch: 0,
  calls: [] as {
    readonly server: RemoteMcpServer;
    readonly deps: RemoteMcpClientDeps;
  }[],
  listeners: [] as (() => void)[],
  /** Whether the stored list has been read, and what reading it later does. */
  loaded: true,
  load: undefined as (() => void) | undefined,
  connectivity: 'online' as 'online' | 'offline' | 'unknown',
}));

vi.mock('./remote-mcp-store', () => ({
  listRemoteMcpServers: () => world.servers,
  subscribeRemoteMcpServers: (listener: () => void) => {
    world.listeners.push(listener);
    return () => {
      world.listeners = world.listeners.filter(current => current !== listener);
    };
  },
  getRemoteMcpServersHasLoaded: () => world.loaded,
  whenRemoteMcpServersLoaded: async () => {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    world.load = () => {
      resolve(undefined);
    };
    await promise;
  },
}));

vi.mock('@/lib/auth/auth-epoch', () => ({ currentAuthEpoch: () => world.epoch }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => world.connectivity,
  connectionRefusesWrites: () => world.connectivity === 'offline',
}));

/** The provider an OAuth server is discovered with; its storage is its own module's. */
const { oauthProvider } = vi.hoisted(() => ({ oauthProvider: { redirectUrl: 'kiloapp:///x' } }));
export { oauthProvider };
vi.mock('./remote-mcp-oauth-provider', () => ({ remoteMcpOAuthProvider: () => oauthProvider }));

/** The one discovery function: an answer for each server asked. */
type DiscoveryAnswer = (target: RemoteMcpServer) => Effect.Effect<readonly Tool[], RemoteMcpError>;

/** The one discovery function, answering from an object so a case can change it. */
const discovery: { answer: DiscoveryAnswer } = {
  answer: () => Effect.succeed([tool('mcp_alpha_read')]),
};

vi.mock('@kilocode/harness-sdk/plugins/remote-mcp', () => ({
  RemoteMcpError: class FakeRemoteMcpError extends Error {
    readonly kind: string;
    constructor(fields: {
      readonly serverId: string;
      readonly kind: string;
      readonly cause: unknown;
    }) {
      super(`${fields.serverId}: ${fields.kind}`);
      this.name = 'RemoteMcpError';
      this.kind = fields.kind;
    }
  },
  remoteMcpTools: (target: RemoteMcpServer, deps: RemoteMcpClientDeps) => {
    world.calls.push({ server: target, deps });
    return discovery.answer(target);
  },
}));

/* Loaded here, after the mocks above, so no static import of the module under
   test can reach its dependencies before they are faked. */
export const {
  ensureRemoteMcp,
  forgetRemoteMcp,
  remoteMcpState,
  remoteServerToolNames,
  remoteServerTools,
} = await import('./remote-mcp');

export { discovery, world };

/** The default answer, kept aside so every case starts from the same world. */
const answerWithAlphaTool = discovery.answer;

/** What the app does when the stored list changes. */
export function emitServers(): void {
  for (const listener of world.listeners) {
    listener();
  }
}

/** The world a case starts in. */
export function resetWorld(): void {
  world.servers = [];
  world.epoch = 0;
  world.calls.length = 0;
  world.loaded = true;
  world.load = undefined;
  world.connectivity = 'online';
  discovery.answer = answerWithAlphaTool;
  forgetRemoteMcp();
}

/** An answer that settles only when the case releases the promise it holds. */
export function whenReleased(
  held: Promise<void>,
  tools: readonly Tool[]
): Effect.Effect<readonly Tool[], RemoteMcpError> {
  return Effect.promise(async () => {
    await held;
  }).pipe(Effect.map(() => tools));
}

/** Lets everything a released gate unblocked run before the case asserts. */
export function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(() => {
    resolve(undefined);
  }, 0);
  return promise;
}
