import { createMessageId } from '../../src/shared/message-id.js';
import type { IngestEvent } from '../../src/shared/protocol.js';
import type { WrapperPromptAgent } from '../../src/shared/wrapper-bootstrap.js';
import type { WrapperKiloClient } from './kilo-api.js';
import { logToFile } from './utils.js';

export const PUBLICATION_SELF_CHECK_PROMPT =
  'Before you wrap up, take a moment to check your work against the review workflow. ' +
  'Did you finish every step, including posting or updating the summary comment on the PR? ' +
  'If anything is still outstanding, please complete it now; if the summary is already posted, do not post it again. ' +
  'If you deliberately skipped something, say why in one line.';

// The code-review command guard (CODE_REVIEW_ALLOWED_COMMANDS in src/session-service.ts) only
// lets the summary be written in these endpoint-first shapes, so matching them covers every
// summary write that can succeed.
const GITHUB_SUMMARY_WRITE_COMMANDS = [
  /(?:^|[\s;&|(])gh\s+api\s+repos\/\S+\/issues\/\d+\/comments\b[^\n]*\s--input\b/,
  /(?:^|[\s;&|(])gh\s+api\s+repos\/\S+\/issues\/comments\/\d+\b[^\n]*\s(?:-X|--method)[\s=]+PATCH\b/i,
];
// Only the created or updated comment's html_url carries this fragment; GitHub error bodies do not.
const GITHUB_ISSUE_COMMENT_URL = /https?:\/\/[^\s"']+#issuecomment-\d+/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isGitHubSummaryWriteCommand(command: string): boolean {
  return GITHUB_SUMMARY_WRITE_COMMANDS.some(pattern => pattern.test(command));
}

/**
 * Whether a Kilo `message.part.updated` part is a summary write that GitHub accepted. Requires
 * the created or updated comment's URL in the output: a zero exit code alone is not evidence,
 * because an allowed pipeline such as `… | jq` exits 0 even when the write failed.
 */
export function isSuccessfulGitHubSummaryWrite(part: unknown): boolean {
  if (!isRecord(part) || part.type !== 'tool' || part.tool !== 'bash') return false;
  const toolState = part.state;
  if (!isRecord(toolState) || toolState.status !== 'completed') return false;
  const input = toolState.input;
  const command = isRecord(input) && typeof input.command === 'string' ? input.command : undefined;
  if (!command || !isGitHubSummaryWriteCommand(command)) return false;

  const exit = isRecord(toolState.metadata) ? toolState.metadata.exit : undefined;
  if (typeof exit === 'number' && exit !== 0) return false;
  return typeof toolState.output === 'string' && GITHUB_ISSUE_COMMENT_URL.test(toolState.output);
}

export type PublicationSelfCheckOptions = {
  kiloSessionId: string;
  agent?: WrapperPromptAgent;
  kiloClient: WrapperKiloClient;
  onEvent: (event: IngestEvent) => void;
};

/**
 * Send the self-check prompt into the same Kilo session. The resulting Kilo activity is part
 * of the current turn, so the turn's normal idle and liveness handling decides when it ends.
 * Returns false, after reporting a non-fatal error, when the prompt could not be sent.
 */
export async function sendPublicationSelfCheck(
  opts: PublicationSelfCheckOptions
): Promise<boolean> {
  const messageId = createMessageId();
  try {
    await opts.kiloClient.sendPromptAsync({
      sessionId: opts.kiloSessionId,
      messageId,
      prompt: PUBLICATION_SELF_CHECK_PROMPT,
      agent: opts.agent?.mode,
      model: opts.agent?.model,
      variant: opts.agent?.variant,
      system: opts.agent?.system,
      tools: opts.agent?.tools,
    });
    logToFile(`publication self-check: sent messageId=${messageId}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logToFile(`publication self-check: send failed - ${message}`);
    opts.onEvent({
      streamEventType: 'error',
      data: { error: `Publication self-check failed: ${message}`, fatal: false },
      timestamp: new Date().toISOString(),
    });
    return false;
  }
}
