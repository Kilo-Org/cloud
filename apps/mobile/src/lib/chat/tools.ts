import { type Tool } from '@kilocode/harness-sdk';

import { kiloMcpToolNames, kiloMcpTools, mcpEnabledFor } from './kilo-mcp';
import { remoteServerToolNames, remoteServerTools } from './remote-mcp';
import { isSettingsToolsEnabled } from './settings-tools-switch';
import { chatToolsFor, toolNamesFor } from './tool-set';

/**
 * What a chat can do besides talk.
 *
 * One tool of its own: the clock. A model does not have one — it answers "what
 * day is it" from the date it was trained on, confidently and wrong — and a
 * phone is where that question gets asked. The rest of the SDK's tools are for
 * a harness driving work: asking the person something is what the composer is
 * already for, delegating to a second session costs a second session, and a
 * to-do list is working memory for a long run that a chat does not have.
 *
 * On top of that set sit the app-settings tools, the tools of the Kilo MCP
 * server, and the tools of the remote servers the person added — each behind
 * its own gate. They are not written here: the servers' tools are discovered
 * while the app runs, which is why the functions below read them at the moment
 * a session opens rather than holding a set of their own.
 *
 * The gates themselves live in `tool-set.ts`, so the names a session is opened
 * with and the tools the registry holds are decided in one place.
 */

/** The tools every chat offers: the clock, plus the settings tools when the group switch is on. */
export function chatTools(organizationId?: string): readonly Tool[] {
  return chatToolsFor({
    organizationId,
    settingsEnabled: isSettingsToolsEnabled(),
    kiloEnabled: false,
    kiloNames: [],
    remoteNames: [],
    remoteTools: [],
  });
}

/**
 * The base tools, the Kilo MCP tools, and every enabled remote server's tools.
 *
 * This is the registry's view of what a session may name. It is read when a
 * session opens, not when the runtime is built, because the servers' tools
 * arrive while the app runs: a tool discovered after the runtime was built
 * still reaches the next session.
 */
export function chatToolsWithMcp(organizationId?: string): readonly Tool[] {
  return [...chatTools(organizationId), ...kiloMcpTools(), ...remoteServerTools()];
}

/**
 * The names a chat is opened with, from the group switch and the chat's own
 * server flags.
 *
 * The settings names are absent — not merely unresolved — when the switch is
 * off, so the model is never offered a tool that would refuse it. A chat with
 * the Kilo MCP off names no Kilo tool, and one that has it on but has discovered
 * nothing yet names none either: a session is never opened with a name the
 * registry cannot resolve.
 */
export async function chatToolNames(
  organizationId: string | undefined,
  sessionId: string
): Promise<readonly string[]> {
  return chatToolNamesStarting(organizationId, await mcpEnabledFor(sessionId));
}

/**
 * The same, for a chat that does not exist yet.
 *
 * Starting a chat opens a session before there is an id to read a setting from,
 * so the caller says whether it opens with the Kilo server. Every later open
 * and move reads the stored setting through `chatToolNames`.
 */
export function chatToolNamesStarting(
  organizationId: string | undefined,
  kiloEnabled: boolean
): readonly string[] {
  return toolNamesFor({
    organizationId,
    settingsEnabled: isSettingsToolsEnabled(),
    kiloEnabled,
    kiloNames: kiloMcpToolNames(),
    remoteNames: remoteServerToolNames(),
    remoteTools: [],
  });
}
