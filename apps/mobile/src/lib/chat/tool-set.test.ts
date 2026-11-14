import { describe, expect, it, vi } from 'vitest';

import { type Tool } from '@kilocode/harness-sdk';

import { dateTimeFormat } from '@/lib/intl-cache';
import { discoveryOf, type RemoteMcpDiscovery, remoteServerToolsFor } from './remote-mcp-state';
import { tool as offeredTool, server } from './remote-mcp.test-helpers';
import {
  type ChatToolSetInput,
  chatToolsFor,
  deviceZone,
  SETTINGS_TOOL_NAMES,
  toolNamesFor,
} from './tool-set';

// The base tool formats through the app's own `Intl` cache, and the settings
// tools are wired to the device stores; none of that is what this suite is
// about, so the ones that only exist on a device are stubbed.
vi.mock('@/lib/intl-cache', () => ({
  dateTimeFormat: vi.fn(() => ({ resolvedOptions: () => ({ timeZone: 'Europe/Amsterdam' }) })),
}));
vi.mock('@/lib/settings/registry', () => ({
  settingsService: () => ({
    settings: [],
    read: () => undefined,
    write: () => undefined,
  }),
}));
vi.mock('@/lib/settings/confirm', () => ({ confirmSettingChange: () => undefined }));
vi.mock('./settings-tools-switch', () => ({ isSettingsToolsEnabled: () => true }));
// The search itself is proved in its own suite; this one reads the names.
vi.mock('./web-search', () => ({
  WEB_SEARCH_TOOL_NAME: 'web_search',
  webSearchTool: () => ({ definition: { name: 'web_search' }, run: () => undefined }),
}));

const input = (overrides: Partial<ChatToolSetInput> = {}): ChatToolSetInput => ({
  settingsEnabled: true,
  webSearchEnabled: false,
  kiloEnabled: false,
  kiloNames: [],
  remoteNames: [],
  remoteTools: [],
  ...overrides,
});

const namesOf = (tools: readonly { readonly definition: { readonly name: string } }[]) =>
  tools.map(tool => tool.definition.name);

/** A tool of that name: the suite reads the names, not the answers. */
const toolNamed = (name: string) => ({ definition: { name } }) as unknown as Tool;

/**
 * The names a chat is opened with.
 *
 * A session is opened with a frozen list, so the list has to be exactly what
 * the switches say and in the same order every time: a name the registry cannot
 * resolve would fail the open, and a list that reorders would throw the cached
 * prefix away for a chat that changed nothing.
 */
describe('the names a chat is opened with', () => {
  it('is the clock and the settings tools while the group switch is on', () => {
    expect(toolNamesFor(input())).toEqual(['time', ...SETTINGS_TOOL_NAMES]);
  });

  it('drops every settings name when the group switch is off', () => {
    const names = toolNamesFor(input({ settingsEnabled: false }));

    expect(names).toEqual(['time']);
    expect(names.filter(name => name.startsWith('settings_'))).toEqual([]);
  });

  it('drops the Kilo names when the server is off for the chat', () => {
    expect(toolNamesFor(input({ kiloNames: ['mcp_kilo_read-file'] }))).toEqual([
      'time',
      ...SETTINGS_TOOL_NAMES,
    ]);
    expect(toolNamesFor(input({ kiloEnabled: true, kiloNames: ['mcp_kilo_read-file'] }))).toEqual([
      'time',
      ...SETTINGS_TOOL_NAMES,
      'mcp_kilo_read-file',
    ]);
  });

  it('names web search only for a chat that has it on, right after the clock', () => {
    expect(toolNamesFor(input({ webSearchEnabled: true }))).toEqual([
      'time',
      'web_search',
      ...SETTINGS_TOOL_NAMES,
    ]);
  });

  it('holds no name of a disabled server, because the list it reads is built from the enabled ones', () => {
    /* The names arrive from `remoteServerToolsFor`, so the case supplies the
       servers and their discoveries rather than the names: a disabled server is
       stored with a discovery of its own and still reaches the model with no
       name at all. */
    const notes = server({ id: 'notes' });
    const calendar = server({ id: 'calendar', enabled: false });
    const discovered = new Map<string, RemoteMcpDiscovery>([
      ['notes', discoveryOf('notes', [offeredTool('mcp_notes_list')])],
      ['calendar', discoveryOf('calendar', [offeredTool('mcp_calendar_today')])],
    ]);

    const remoteNames = remoteServerToolsFor([notes, calendar], discovered).map(
      entry => entry.definition.name
    );
    const names = toolNamesFor(input({ remoteNames }));

    expect(names).toEqual(['time', ...SETTINGS_TOOL_NAMES, 'mcp_notes_list']);
    expect(names).not.toContain('mcp_calendar_today');
  });

  it('keeps one order, so the cached prefix does not move under an unchanged chat', () => {
    const full = input({
      kiloEnabled: true,
      kiloNames: ['mcp_kilo_read-file'],
      remoteNames: ['mcp_notes_list', 'mcp_calendar_today'],
    });

    expect(toolNamesFor(full)).toEqual([
      'time',
      ...SETTINGS_TOOL_NAMES,
      'mcp_kilo_read-file',
      'mcp_notes_list',
      'mcp_calendar_today',
    ]);
  });
});

/**
 * The tools behind those names.
 *
 * The registry holds these, and a session resolves the names against it at
 * open. The settings tools are built here rather than by the caller, so the
 * gate and the tool objects cannot disagree about whether they are offered.
 */
describe('the tools behind those names', () => {
  it('is the clock, web search and the settings tools while the group switch is on', () => {
    expect(namesOf(chatToolsFor(input()))).toEqual(['time', 'web_search', ...SETTINGS_TOOL_NAMES]);
  });

  it('leaves the settings tools out entirely when the group switch is off', () => {
    expect(namesOf(chatToolsFor(input({ settingsEnabled: false })))).toEqual([
      'time',
      'web_search',
    ]);
  });

  it('holds the discovered remote tools, in list order', () => {
    const remote = [toolNamed('mcp_notes_list'), toolNamed('mcp_calendar_today')];

    expect(namesOf(chatToolsFor(input({ remoteTools: remote })))).toEqual([
      'time',
      'web_search',
      ...SETTINGS_TOOL_NAMES,
      'mcp_notes_list',
      'mcp_calendar_today',
    ]);
  });

  it('answers with a tool that is ready to run', () => {
    const [tool] = chatToolsFor(input());

    expect(tool?.definition.name).toBe('time');
    expect(tool?.run).toBeTypeOf('function');
  });
});

describe('the zone local time is reported in', () => {
  it('is the one the formatter resolved, not the one the device is set to', () => {
    /* The module stub answers Europe/Amsterdam for every call, so a case that
       reads it cannot tell a reported zone from a fixed one. This call answers
       a different zone, which only a report of the resolved zone can return. */
    vi.mocked(dateTimeFormat).mockReturnValueOnce({
      resolvedOptions: () => ({ timeZone: 'Asia/Tokyo' }),
    } as unknown as Intl.DateTimeFormat);

    expect(deviceZone()).toBe('Asia/Tokyo');
  });

  it('is none when the runtime cannot name one, so the answer stays UTC', () => {
    vi.mocked(dateTimeFormat).mockReturnValueOnce({
      resolvedOptions: () => ({ timeZone: '' }),
    } as unknown as Intl.DateTimeFormat);

    expect(deviceZone()).toBeUndefined();
  });
});
