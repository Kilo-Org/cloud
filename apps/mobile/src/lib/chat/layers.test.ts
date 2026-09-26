import { Effect } from 'effect';
import { ToolRegistry } from '@kilocode/harness-sdk';
import { describe, expect, it, vi } from 'vitest';

import { layerToolsFor, modelFactsFor, RELAYED_SHAPE } from './layers';

// The catalog is read here without the device plugins the runtime builds around
// it, so the ones that only exist on a device are stubbed.
vi.mock('expo-crypto', () => ({ getRandomBytes: (count: number) => new Uint8Array(count) }));
vi.mock('@kilocode/harness-sdk/plugins/store/expo', () => ({ layerExpoStore: () => undefined }));
vi.mock('@/lib/auth/token-owner', () => ({ getAuthTokenForRequest: vi.fn() }));
vi.mock('@/lib/config', () => ({ API_BASE_URL: 'http://localhost:4700' }));
vi.mock('./fetch', () => ({ chatFetch: () => undefined }));
vi.mock('@/lib/intl-cache', () => ({
  dateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/Amsterdam' }) }),
}));
// The settings tools are built from the app's settings registry and confirmed
// through a device dialog, and the remote servers' tools are discovered from
// the person's own servers; the registry's live view is what is under test.
vi.mock('@/lib/settings/registry', () => ({
  settingsService: () => ({ settings: [], read: () => undefined, write: () => undefined }),
}));
vi.mock('@/lib/settings/confirm', () => ({ confirmSettingChange: () => undefined }));
vi.mock('./settings-tools-switch', () => ({ isSettingsToolsEnabled: () => true }));
vi.mock('./remote-mcp', () => ({ remoteServerTools: () => [], remoteServerToolNames: () => [] }));
// The Kilo MCP tools are discovered while the app runs; what is under test is
// that the registry reads them when a session opens, not the discovery itself.
const mcp = vi.hoisted(() => ({
  tools: [] as { readonly definition: { readonly name: string } }[],
}));
vi.mock('./kilo-mcp', () => ({
  kiloMcpTools: () => mcp.tools,
  kiloMcpToolNames: () => mcp.tools.map(tool => tool.definition.name),
}));

/**
 * What the app tells a session a gateway model can speak.
 *
 * The gateway resolves a model's shapes from the serving provider and refuses a
 * request on a shape that provider does not speak. The app cannot know them per
 * model, so the shape it asserts has to be the one every provider accepts —
 * otherwise a model served over `chat_completions` alone is refused with
 * "This model does not support the messages API" and the question fails to
 * deliver.
 */

describe('the shape a gateway model is asked over', () => {
  it('is chat_completions, which every provider the gateway relays speaks', () => {
    expect(modelFactsFor({ id: 'fake-deterministic' }).apiKinds).toEqual(['chat_completions']);
  });

  it('never claims the messages shape a chat_completions-only model is refused on', () => {
    expect(RELAYED_SHAPE.apiKinds).not.toContain('messages');
    expect(RELAYED_SHAPE.apiKinds).not.toContain('responses');
  });

  it('keeps the context window the gateway named for the model', () => {
    expect(modelFactsFor({ id: 'any', context_length: 200_000 })).toEqual({
      apiKinds: ['chat_completions'],
      contextWindow: 200_000,
    });
  });

  it('answers with a shape even when the gateway named no window', () => {
    expect(modelFactsFor({ id: 'unwindowed', context_length: null }).contextWindow).toBeUndefined();
  });
});

/**
 * The tools the registry holds.
 *
 * A session resolves the names it was opened with against this at open, so a
 * tool discovered after the runtime was built has to be in it — otherwise a
 * chat would need a new runtime every time the server's list arrived.
 */
const namesHeld = async (): Promise<readonly string[]> => {
  const names = await Effect.runPromise(
    Effect.gen(function* held() {
      const registry = yield* ToolRegistry;
      return registry.tools.map(tool => tool.definition.name);
    }).pipe(Effect.provide(layerToolsFor()))
  );
  return names;
};

describe('the tools the registry holds', () => {
  it('is a live view, so a tool discovered after the runtime was built is in it', async () => {
    mcp.tools.length = 0;
    expect(await namesHeld()).toEqual(['time', 'settings_list', 'settings_set']);

    mcp.tools.push({ definition: { name: 'mcp_kilo_read-file' } });

    expect(await namesHeld()).toEqual([
      'time',
      'settings_list',
      'settings_set',
      'mcp_kilo_read-file',
    ]);
  });
});
