import {
  type BriefingDocumentSection,
  type BriefingSourceStatus,
  buildConnectMoreLines,
} from './briefing-utils';

/**
 * Welcome intro for the user's very first briefing. This is the in-chat
 * onboarding briefing, so it greets the user and sets the daily rhythm
 * rather than leading with a dated header like the recurring brief.
 */
const ONBOARDING_BRIEFING_WELCOME =
  "Welcome to KiloClaw! 👋 Here is your first daily briefing. I'll have a fresh one ready for you every morning.";

/**
 * Assemble a generated briefing into a single chat message for the in-chat
 * onboarding briefing (PR-6).
 *
 * The message is one bot bubble: a welcome intro (and, when present, the
 * TL;DR line), then each populated section in the canonical order
 * `generateBriefing` produced, then a closing "Connect more" block when any
 * source is unconfigured. Sections with no lines are skipped, matching
 * `buildBriefingMarkdown`.
 *
 * `settingsHref` links each "Connect more" source to the instance's Settings
 * page. It is org-aware — the worker derives `/claw/settings` for a personal
 * instance and `/organizations/<id>/claw/settings` for an org instance and
 * threads it down. When absent, the items render as plain text.
 *
 * Posted directly as a bot message — no agent in the loop — so the content
 * here is exactly what the user sees, modulo the chat client's Markdown
 * rendering.
 */
export function buildBriefingMessage(params: {
  sections: BriefingDocumentSection[];
  statuses: BriefingSourceStatus[];
  tldr: string;
  settingsHref?: string;
}): string {
  const blocks: string[] = [];

  const greeting = [ONBOARDING_BRIEFING_WELCOME];
  const tldr = params.tldr.trim();
  if (tldr) {
    greeting.push('');
    greeting.push(`**TL;DR:** ${tldr}`);
  }
  blocks.push(greeting.join('\n'));

  for (const section of params.sections) {
    if (section.lines.length === 0) {
      continue;
    }
    blocks.push([`## ${section.title}`, ...section.lines].join('\n'));
  }

  const connectMore = buildConnectMoreLines(params.statuses, { itemHref: params.settingsHref });
  if (connectMore.length > 0) {
    blocks.push(connectMore.join('\n'));
  }

  return blocks.join('\n\n');
}
