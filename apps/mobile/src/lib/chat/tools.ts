import { type Tool } from '@kilocode/harness-sdk';
import { timeTool } from '@kilocode/harness-sdk/plugins/tools';

import { dateTimeFormat } from '@/lib/intl-cache';

/**
 * What a chat can do besides talk.
 *
 * One tool: the clock. A model does not have one — it answers "what day is it"
 * from the date it was trained on, confidently and wrong — and a phone is where
 * that question gets asked. The rest of the SDK's tools are for a harness
 * driving work: asking the person something is what the composer is already
 * for, delegating to a second session costs a second session, and a to-do list
 * is working memory for a long run that a chat does not have.
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
