import { type Tool } from '@kilocode/harness-sdk';
import { settingsTools, timeTool } from '@kilocode/harness-sdk/plugins/tools';

import { dateTimeFormat } from '@/lib/intl-cache';
import { confirmSettingChange } from '@/lib/settings/confirm';
import { settingsService } from '@/lib/settings/registry';

import { isSettingsToolsEnabled } from './settings-tools-switch';

/**
 * The tool set a chat offers, and the names it is opened with.
 *
 * A session freezes the tools it was opened with, so the set is computed from
 * the switches at the moment a session opens and recomputed when one of them
 * moves. Both halves live here so they cannot drift: `toolNamesFor` is the
 * ordered name list, `chatToolsFor` the tools behind it, and the two share one
 * order. A name the registry cannot resolve is never sent to the model.
 *
 * The decisions are values on the input rather than modules read here, so the
 * set can be reasoned about — and tested — without the device stores behind
 * them. The one exception is the settings tools' own switch, which is read at
 * the moment of a call: a call that raced the switch has to be refused rather
 * than applied.
 */

/** The one tool every chat has: the clock. */
const BASE_TOOL_NAME = 'time';

/** The names the settings tools are called by. Fixed: they are part of the cached prefix. */
const SETTINGS_LIST_TOOL = 'settings_list';
const SETTINGS_SET_TOOL = 'settings_set';

/** The names of the settings tools, in the order they are offered. */
export const SETTINGS_TOOL_NAMES: readonly string[] = [SETTINGS_LIST_TOOL, SETTINGS_SET_TOOL];

/** Everything that decides one chat's tool set. */
export type ChatToolSetInput = {
  /** The organization whose defaults the settings tools read and write, when there is one. */
  readonly organizationId?: string;
  /** The one group switch for the settings tools. */
  readonly settingsEnabled: boolean;
  /** Whether the Kilo MCP server is on for this chat. */
  readonly kiloEnabled: boolean;
  /** The names the Kilo MCP server's discovered tools are called by. */
  readonly kiloNames: readonly string[];
  /** The names of the enabled remote servers' discovered tools, in list order. */
  readonly remoteNames: readonly string[];
  /** The tools of the enabled remote servers, in list order. */
  readonly remoteTools: readonly Tool[];
};

/**
 * The zone to report local time in, or none.
 *
 * The tool formats through `Intl`, so a runtime that cannot name a zone gets
 * UTC alone rather than a wrong local time. What a phone answers is the zone
 * the person set, which is the one they mean when they ask what time it is.
 */
export function deviceZone(): string | undefined {
  const zone = dateTimeFormat(undefined, {}).resolvedOptions().timeZone;
  return zone === '' ? undefined : zone;
}

/** The tools every chat is opened with, in the order the model sees them. */
function baseTools(): readonly Tool[] {
  const zone = deviceZone();
  return [timeTool(zone === undefined ? undefined : { zone })];
}

/**
 * The settings tools, wired to the one group switch and to the person's own
 * confirmation. A destructive setting is never changed without that yes.
 */
function settingsToolsFor(organizationId?: string): readonly Tool[] {
  return settingsTools(settingsService(organizationId), {
    enabled: isSettingsToolsEnabled,
    confirm: confirmSettingChange,
    listName: SETTINGS_LIST_TOOL,
    setName: SETTINGS_SET_TOOL,
  });
}

/**
 * The names a chat is opened with, in the order the model sees them.
 *
 * The settings names are present only when the group switch is on, the Kilo
 * names only when the server is on for the chat, and the remote names only for
 * the servers that are enabled — each list arrives already filtered. The base
 * name is always first, so the same gates give the same order and the cached
 * prefix does not move under a chat that changed nothing.
 */
export function toolNamesFor(input: ChatToolSetInput): readonly string[] {
  return [
    BASE_TOOL_NAME,
    ...(input.settingsEnabled ? SETTINGS_TOOL_NAMES : []),
    ...(input.kiloEnabled ? input.kiloNames : []),
    ...input.remoteNames,
  ];
}

/**
 * The tools behind those names: the clock, the settings tools when the group
 * switch is on, and the remote servers' tools the caller passes.
 *
 * The Kilo server's tools are not part of the input: they are discovered as
 * tool objects rather than named, so `chatToolsWithMcp` composes the whole set
 * and places them where the Kilo names sit in the list.
 */
export function chatToolsFor(input: ChatToolSetInput): readonly Tool[] {
  return [
    ...baseTools(),
    ...(input.settingsEnabled ? settingsToolsFor(input.organizationId) : []),
    ...input.remoteTools,
  ];
}
