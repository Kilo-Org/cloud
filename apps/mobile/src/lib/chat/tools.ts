import { type Tool } from '@kilocode/harness-sdk';
import { timeTool } from '@kilocode/harness-sdk/plugins/tools';

import { dateTimeFormat } from '@/lib/intl-cache';
import { kiloMcpToolNames, kiloMcpTools } from './kilo-mcp';

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
 * On top of that set sit the tools of the Kilo MCP server, when the chat has it
 * on. They are not written here: they are discovered from the server while the
 * app runs, which is why the functions below read them at the moment a session
 * opens rather than holding a set of their own.
 */

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
export function chatTools(): readonly Tool[] {
  const zone = deviceZone();
  return [timeTool(zone === undefined ? undefined : { zone })];
}

/** The names of those tools, which is what a session is opened with. */
export const CHAT_TOOL_NAMES: readonly string[] = chatTools().map(tool => tool.definition.name);

/**
 * The base tools plus the Kilo MCP tools discovered so far.
 *
 * This is the registry's view of what a session may name. It is read when a
 * session opens, not when the runtime is built, because the server's tools
 * arrive while the app runs: a tool discovered after the runtime was built
 * still reaches the next session.
 */
export function chatToolsWithMcp(): readonly Tool[] {
  return [...chatTools(), ...kiloMcpTools()];
}

/**
 * The names a chat is opened with.
 *
 * A chat with the Kilo MCP off names the base tools alone, and one that has it
 * on but has discovered nothing yet names the same: a session is never opened
 * with a name the registry cannot resolve.
 */
export function chatToolNames(mcpEnabled: boolean): readonly string[] {
  return mcpEnabled && kiloMcpTools().length > 0
    ? [...CHAT_TOOL_NAMES, ...kiloMcpToolNames()]
    : CHAT_TOOL_NAMES;
}
