import { describe, expect, it, vi } from 'vitest';

import { type Tool } from '@kilocode/harness-sdk';

import { dateTimeFormat } from '@/lib/intl-cache';
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

const input = (overrides: Partial<ChatToolSetInput> = {}): ChatToolSetInput => ({
  settingsEnabled: true,
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

  it('names only the servers that are enabled, because s4 already dropped the rest', () => {
    /* A disabled server contributes nothing to the list it is read from, so the
       builder adds exactly what it is given and no name of a server that is
       off reaches the model. */
    expect(toolNamesFor(input({ remoteNames: ['mcp_notes_list'] }))).toEqual([
      'time',
      ...SETTINGS_TOOL_NAMES,
      'mcp_notes_list',
    ]);
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
    expect(toolNamesFor(full)).toEqual(toolNamesFor(full));
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
  it('is the clock and the settings tools while the group switch is on', () => {
    expect(namesOf(chatToolsFor(input()))).toEqual(['time', ...SETTINGS_TOOL_NAMES]);
  });

  it('leaves the settings tools out entirely when the group switch is off', () => {
    expect(namesOf(chatToolsFor(input({ settingsEnabled: false })))).toEqual(['time']);
  });

  it('holds the discovered remote tools, in list order', () => {
    const remote = [toolNamed('mcp_notes_list'), toolNamed('mcp_calendar_today')];

    expect(namesOf(chatToolsFor(input({ remoteTools: remote })))).toEqual([
      'time',
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
  it('is the one the device is set to', () => {
    expect(deviceZone()).toBe('Europe/Amsterdam');
  });

  it('is none when the runtime cannot name one, so the answer stays UTC', () => {
    vi.mocked(dateTimeFormat).mockReturnValueOnce({
      resolvedOptions: () => ({ timeZone: '' }),
    } as unknown as Intl.DateTimeFormat);

    expect(deviceZone()).toBeUndefined();
  });
});
