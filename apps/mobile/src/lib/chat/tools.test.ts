import { beforeEach, describe, expect, it, vi } from 'vitest';

import { chatToolNames, chatToolNamesStarting, chatTools, chatToolsWithMcp } from './tools';

// The base tool formats through the app's own `Intl` cache and the settings
// tools are wired to the device stores; what is under test is the gate over
// them, so the device-only parts are stubbed.
vi.mock('@/lib/intl-cache', () => ({
  dateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/Amsterdam' }) }),
}));
vi.mock('@/lib/settings/registry', () => ({
  settingsService: () => ({ settings: [], read: () => undefined, write: () => undefined }),
}));
vi.mock('@/lib/settings/confirm', () => ({ confirmSettingChange: () => undefined }));

// The one group switch, so the suite can move it.
const settings = vi.hoisted(() => ({ enabled: true }));
vi.mock('./settings-tools-switch', () => ({ isSettingsToolsEnabled: () => settings.enabled }));

// The servers' tools are discovered while the app runs and read through these;
// what is under test is what the gates do with them.
const mcp = vi.hoisted(() => ({
  tools: [] as { readonly definition: { readonly name: string } }[],
  enabled: new Map<string, boolean>(),
}));
vi.mock('./kilo-mcp', () => ({
  kiloMcpTools: () => mcp.tools,
  kiloMcpToolNames: () => mcp.tools.map(tool => tool.definition.name),
  mcpEnabledFor: async (sessionId: string) => {
    await Promise.resolve();
    return mcp.enabled.get(sessionId) ?? true;
  },
}));

const remote = vi.hoisted(() => ({
  tools: [] as { readonly definition: { readonly name: string } }[],
}));
vi.mock('./remote-mcp', () => ({
  remoteServerTools: () => remote.tools,
  remoteServerToolNames: () => remote.tools.map(tool => tool.definition.name),
}));

// The chat's own web search choice; absent means on, as for a Kilo model.
const webSearch = vi.hoisted(() => ({ enabled: new Map<string, boolean>() }));
vi.mock('./web-search', () => ({
  WEB_SEARCH_TOOL_NAME: 'web_search',
  webSearchTool: () => ({ definition: { name: 'web_search' }, run: () => undefined }),
}));
vi.mock('./web-search-setting', () => ({
  webSearchEnabledFor: async (sessionId: string) => {
    await Promise.resolve();
    return webSearch.enabled.get(sessionId) ?? true;
  },
}));

const namesOf = (tools: readonly { readonly definition: { readonly name: string } }[]) =>
  tools.map(tool => tool.definition.name);

const KILO = { definition: { name: 'mcp_kilo_read-file' } };
const REMOTE = { definition: { name: 'mcp_notes_list' } };

beforeEach(() => {
  settings.enabled = true;
  mcp.tools.length = 0;
  mcp.enabled.clear();
  remote.tools.length = 0;
  webSearch.enabled.clear();
});

/**
 * What a chat offers the model.
 *
 * Two tools of its own, the clock and web search, and the app-settings tools
 * behind one group switch. The switch is the whole of the gate: off means the
 * names are not in the list at all, so the model is never offered a tool that
 * would refuse it.
 */

describe('the tools a chat offers', () => {
  it('is the clock, web search and the settings tools while the group switch is on', () => {
    expect(namesOf(chatTools())).toEqual(['time', 'web_search', 'settings_list', 'settings_set']);
  });

  it('leaves the settings tools out when the group switch is off', () => {
    settings.enabled = false;

    const names = namesOf(chatTools());

    expect(names).toEqual(['time', 'web_search']);
    expect(names.filter(name => name.startsWith('settings_'))).toEqual([]);
  });

  it('answers with the tool itself, ready to run', () => {
    const [tool] = chatTools();
    expect(tool?.definition.name).toBe('time');
    expect(tool?.run).toBeTypeOf('function');
  });
});

describe('the tools the registry holds', () => {
  it('is the base set, the Kilo server and every enabled remote server', () => {
    mcp.tools.push(KILO);
    remote.tools.push(REMOTE);

    expect(namesOf(chatToolsWithMcp())).toEqual([
      'time',
      'web_search',
      'settings_list',
      'settings_set',
      'mcp_kilo_read-file',
      'mcp_notes_list',
    ]);
  });

  it('holds the servers without the settings tools when the group switch is off', () => {
    settings.enabled = false;
    mcp.tools.push(KILO);

    expect(namesOf(chatToolsWithMcp())).toEqual(['time', 'web_search', 'mcp_kilo_read-file']);
  });
});

describe('the names a chat is opened with', () => {
  it('is the gates as they stand, with the discovered names behind them', async () => {
    mcp.tools.push(KILO);
    remote.tools.push(REMOTE);

    expect(await chatToolNames(undefined, 's1', 'kilo/one')).toEqual([
      'time',
      'web_search',
      'settings_list',
      'settings_set',
      'mcp_kilo_read-file',
      'mcp_notes_list',
    ]);
  });

  it('names no web search for a chat that turned it off', async () => {
    webSearch.enabled.set('s1', false);

    expect(await chatToolNames(undefined, 's1', 'kilo/one')).toEqual([
      'time',
      'settings_list',
      'settings_set',
    ]);
  });

  it('names no Kilo tool for a chat that turned the server off', async () => {
    mcp.tools.push(KILO);
    mcp.enabled.set('s1', false);

    expect(await chatToolNames(undefined, 's1', 'kilo/one')).toEqual([
      'time',
      'web_search',
      'settings_list',
      'settings_set',
    ]);
  });

  it('names no settings tool once the group switch is off', async () => {
    settings.enabled = false;
    mcp.tools.push(KILO);

    const names = await chatToolNames(undefined, 's1', 'kilo/one');

    expect(names).toEqual(['time', 'web_search', 'mcp_kilo_read-file']);
    expect(names).not.toContain('settings_list');
    expect(names).not.toContain('settings_set');
  });

  it('takes the Kilo and web search settings from the caller for a chat that does not exist yet', () => {
    mcp.tools.push(KILO);

    expect(
      chatToolNamesStarting(undefined, { kiloEnabled: false, webSearchEnabled: false })
    ).toEqual(['time', 'settings_list', 'settings_set']);
    expect(chatToolNamesStarting(undefined, { kiloEnabled: true, webSearchEnabled: true })).toEqual(
      ['time', 'web_search', 'settings_list', 'settings_set', 'mcp_kilo_read-file']
    );
  });
});
