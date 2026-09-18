import { i18n } from '@/i18n';

/**
 * The `@kilocode/cloud-agent-sdk` writes a fixed set of English strings into a
 * session's status indicator: the autocommit, preparation and interrupt lines
 * on the progress/info kinds, and a few error lines. The web app and the
 * extension render those same strings verbatim, so the SDK cannot translate
 * them without changing those surfaces too.
 *
 * Mobile pins each literal to a catalog key instead — the same pattern
 * `chat-composer-slash-commands.ts` uses for the SDK's slash-command
 * descriptions and `exit-remote-session-with-feedback.ts` for its exit errors.
 * The literals are a producer/consumer contract: changing one in the SDK
 * requires updating this table (each entry names its SDK source line).
 * `TRANSCRIPT_CLEARED_INDICATOR` is deliberately absent — the mobile app never
 * calls the SDK's `clearTranscript`, so that indicator cannot reach mobile — as
 * are the delivery-failure strings, which `session-terminal-error.ts` already
 * maps to `agentChat.messageFailure.deliveryTitle`.
 */
const SDK_MESSAGE_KEYS = {
  // `session-manager.ts:709,712` — the `preparing`/`finalizing` progress lines.
  'Setting up environment…': 'agentChat.composer.preparingPlaceholder',
  'Wrapping up…': 'agentChat.composer.finalizingPlaceholder',
  // `service-state.ts:577,601,609` — the autocommit status.
  'Committing…': 'agentChat.status.committing',
  Committed: 'agentChat.status.committed',
  'Commit failed': 'agentChat.status.commitFailed',
  // `session-manager.ts:734,2473` — the info line after an interrupt.
  'Session stopped': 'agentChat.status.sessionStopped',
  // `service-state.ts:223`, surfaced as the `error` status message at
  // `session-manager.ts:733`.
  'Session terminated': 'agentChat.status.sessionTerminated',
  // `session-manager.ts:732,2483` — the SDK's own error lines.
  'Agent connection lost': 'agentChat.session.connectionTrouble',
  'Failed to stop execution': 'agentChat.session.failedToStopExecution',
} as const satisfies Record<string, string>;

/** Looks up a possibly-unknown key in a literal dictionary without widening its type. */
function lookup<V>(dictionary: Readonly<Record<string, V>>, key: string): V | undefined {
  // The message is untrusted SDK output, so match own properties only:
  // inherited members like 'constructor' would otherwise resolve to a
  // function and get handed to i18n.t instead of falling back to the raw text.
  return Object.hasOwn(dictionary, key)
    ? (dictionary as Readonly<Record<string, V | undefined>>)[key]
    : undefined;
}

/**
 * Catalog copy for a pinned SDK message, or `null` when the string is not one
 * the SDK writes itself. Text the SDK merely forwards (a provider's or the
 * transport's English) stays `null` so the caller can classify or keep it.
 */
export function sdkMessageCopy(raw: string): string | null {
  const key = lookup(SDK_MESSAGE_KEYS, raw);
  return key === undefined ? null : i18n.t(key);
}

/**
 * The reader's copy for a status message. A pinned SDK string resolves through
 * the catalog; anything else is returned unchanged so the indicator never
 * blanks or swallows an unrecognized line.
 */
export function localizeSdkMessage(raw: string): string {
  return sdkMessageCopy(raw) ?? raw;
}
