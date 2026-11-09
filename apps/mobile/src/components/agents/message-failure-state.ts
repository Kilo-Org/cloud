import { type MessageDeliveryState, type MessageInfo } from '@kilocode/cloud-agent-sdk';
import { z } from 'zod';

import { i18n } from '@/i18n';

/**
 * Fixed, safe copy for a failed user-message delivery, keyed by the delivery
 * `reason`. Never surfaces raw provider or transport text.
 */
type DeliveryReason = Extract<MessageDeliveryState, { status: 'failed' }>['reason'];

/**
 * The row a delivery failure draws, keyed by its `reason`. A message the person
 * stopped states that it stopped and nothing more. A message the transport gave
 * up on says it was not sent, and a second line says how many attempts it took;
 * that is the only failure drawn on a failed bubble, because the message itself
 * is what did not arrive.
 *
 * `execution` is the response failing, not the message: the message reached the
 * agent, so the row states the response's failure in the assistant column, and
 * its second line names the run as the thing that failed.
 *
 * `error` marks a row that reports an error, so the row carries the destructive
 * marker beside its title. A message the person stopped reports a neutral
 * status rather than an error, so it carries none.
 */
const DELIVERY_FAILURE_ROW = {
  interrupted: {
    side: 'user',
    error: false,
    titleKey: 'agentChat.messageFailure.deliveryInterrupted',
    detailKey: null,
  },
  exhausted: {
    side: 'user',
    error: true,
    titleKey: 'agentChat.messageFailure.deliveryTitle',
    detailKey: 'agentChat.messageFailure.deliveryExhausted',
  },
  execution: {
    side: 'assistant',
    error: true,
    titleKey: 'agentChat.messageFailure.assistantTitle',
    detailKey: 'agentChat.messageFailure.deliveryExecution',
  },
} as const satisfies Record<
  DeliveryReason,
  { side: 'user' | 'assistant'; error: boolean; titleKey: string; detailKey: string | null }
>;

/**
 * The one delivery reason that is an agent run failing, not the transport: the
 * message was delivered and the agent could not run it. The row states it in
 * the assistant-failure copy ("Response failed") in the assistant's column,
 * with one line naming what failed; the session's status indicator for this
 * reason is the delivery line, which that row already supersedes (see
 * `statusIndicatorDuplicatesMessageFailure`). Retry and Copy-to-composer keep
 * working: the transport text stays reachable behind the copy action.
 */
const AGENT_EXECUTION_DELIVERY_REASON = 'execution' satisfies DeliveryReason;

/**
 * Assistant error names that can never be retried. Pinned to the exact names
 * in `packages/app-shared/src/opencode.gen.ts`.
 */
export const NON_RETRYABLE_ASSISTANT_ERRORS: readonly string[] = [
  'ProviderAuthError',
  'MessageAbortedError',
  'ContextOverflowError',
];

/**
 * Whether the gateway itself marked the failure terminal. An `APIError` carries
 * the retryability it decided (a billing refusal, a rejected credential), so a
 * Retry on it only spends another round trip on the same refusal. Only an
 * explicit `false` is terminal: a session written before the field existed has
 * no value, and unknown retryability keeps the row's only recovery action
 * rather than silently removing it.
 */
function assistantErrorMarkedNonRetryable(
  error: Extract<MessageInfo, { role: 'assistant' }>['error']
): boolean {
  if (error?.name !== 'APIError') {
    return false;
  }
  return Object.is(error.data.isRetryable, false);
}

/**
 * The HTTP status the Kilo AI gateway answers a paid request with when the
 * account cannot pay (no balance, no allowance). See
 * `usageLimitExceededResponse` in packages/web-shared (`llm-proxy-helpers.ts`).
 */
const PAYMENT_REQUIRED = 402;

/**
 * What a gateway credit block names in the refusal body. A 402 alone does not
 * say whose bill it is: an upstream provider's payment refusal passes through
 * the gateway with the same status and names no credit type of its own.
 */
const gatewayCreditRefusalSchema = z.object({
  error_type: z.enum(['usage_limit_exceeded', 'insufficient_credits']),
});

/**
 * Whether this `APIError` is the gateway's own block on the account's credits,
 * rather than a provider refusal passed through: the same rule
 * `paymentRequired` in `lib/chat/backend-target.ts` applies to a model send.
 * Only this failure resolves without spending — the account's balance is the
 * recovery, not the request — so it is the one non-retryable refusal that
 * offers an action that can settle it.
 */
function assistantCreditsRefusal(
  error: Extract<MessageInfo, { role: 'assistant' }>['error']
): boolean {
  if (error?.name !== 'APIError' || error.data.statusCode !== PAYMENT_REQUIRED) {
    return false;
  }
  const body = error.data.responseBody;
  if (body === undefined) {
    return false;
  }
  try {
    return gatewayCreditRefusalSchema.safeParse(JSON.parse(body)).success;
  } catch {
    // A body that is not JSON names no gateway credit block.
    return false;
  }
}

/**
 * The catalog key for a known assistant error name's fixed, safe detail line.
 * An unknown name has no line of its own: the title already states that the
 * response failed, so the footer adds no detail rather than repeating the title
 * in a sentence (`messageFailure.assistantFailed` is the fixed footer's line,
 * not the message row's). `UnknownError` is the name with nothing more to say:
 * its only content is provider text, so the title is the most specific safe
 * statement. Never surfaces `error.data` or provider message text.
 *
 * `nonRetryableByProvider` is the gateway's verdict on an `APIError`: a terminal
 * one loses the row's only recovery action, so its line states that the refusal
 * is final. Without it the row reads exactly like a transient failure that
 * happens to be missing its Retry button (UX-DEFECT final refusal copy).
 */
function assistantDetailKey(errorName: string, nonRetryableByProvider: boolean): string | null {
  switch (errorName) {
    case 'ProviderAuthError': {
      return 'agentChat.messageFailure.assistantProviderRejected';
    }
    case 'MessageAbortedError': {
      return 'agentChat.messageFailure.assistantStopped';
    }
    case 'ContextOverflowError': {
      return 'agentChat.messageFailure.assistantContextOverflow';
    }
    case 'APIError': {
      // One line for every retryable provider API failure: the status code and
      // the retryability are provider metadata, not something the row states.
      // A terminal verdict is different: the row has no Retry, so the line says
      // the refusal is final instead of leaving the missing action unexplained.
      return nonRetryableByProvider
        ? 'agentChat.messageFailure.assistantProviderRefused'
        : 'agentChat.messageFailure.assistantProviderError';
    }
    case 'MessageOutputLengthError': {
      return 'agentChat.messageFailure.assistantOutputLimit';
    }
    case 'StructuredOutputError': {
      return 'agentChat.messageFailure.assistantStructuredOutput';
    }
    default: {
      return null;
    }
  }
}

export type MessageFailure = {
  kind: 'delivery' | 'assistant';
  /**
   * The column the footer occupies, which is the column of the turn that
   * failed rather than of the row that carries it. A delivery failure of the
   * transport is the user's own message not arriving, so its footer sits under
   * that bubble. Every failure of the response — the assistant's own error, and
   * an agent-execution failure carried by the question, whose copy already
   * names the response — takes the assistant's leading column (see
   * `AGENT_EXECUTION_DELIVERY_REASON`). `kind` cannot carry this: the execution
   * failure is a delivery record with the assistant's statement.
   */
  side: 'user' | 'assistant';
  /**
   * Whether the row reports an error, so it carries the destructive marker
   * beside its title. Every failure does except a message the person stopped:
   * stopping is a neutral status, not an error. The message bubble itself keeps
   * the same fill and ink in every state, so the marker does not touch the ink
   * its 15px copy reads at.
   */
  error: boolean;
  /**
   * The catalog key behind `title`. The duplicate check compares keys, not the
   * resolved copy: `selectMessageFailure` runs inside a memo keyed on the
   * message arrays, so an in-place language switch would otherwise leave a
   * stale-language title that no longer matches the footer copy resolved at
   * render time.
   */
  titleKey: string;
  title: string;
  /**
   * The catalog key behind `detail`, or `null` when the title alone says it (an
   * assistant failure with no classified reason, or a message the person
   * stopped). The footer then shows one statement plus the action rather than
   * the same sentence twice.
   */
  detailKey: string | null;
  /**
   * `detailKey` resolved at selection time, for rendering. `null` exactly when
   * `detailKey` is `null`.
   */
  detail: string | null;
  /**
   * The untranslated transport text for a failed delivery ("Unauthorized:
   * Unauthorized"), for the copy action only — same split as the terminal
   * error's untranslated original. Never rendered; empty for an assistant
   * failure, whose `error.data` is provider text with no diagnostic value.
   */
  copyDetail: string;
  canRetry: boolean;
  /**
   * The account's own balance caused this failure, so the row offers the action
   * that settles it: opening the credit purchase screen. Independent of
   * `canRetry` (which reads the request's retryability) and of the session's
   * ability to re-send.
   */
  canAddCredits: boolean;
  canCopy: boolean;
};

/**
 * The characters the failure titles and the footer templates end a sentence
 * with: the Latin `.` `!` `?`, the ellipsis, the Arabic and Persian `؟`, the
 * Devanagari `।` and `॥`, the CJK `。`, `．`, `！`, `？` and `｡`, the Khmer `។`,
 * the Ethiopic `።`, the Myanmar `။`, the Urdu `۔`, and the Armenian `։`.
 *
 * Spelled out rather than `\p{Sentence_Terminal}` because Hermes does not
 * promise Unicode binary property escapes. Non-ASCII members are escapes so a
 * look-alike character cannot slip in, and the catalog test judges them with
 * Unicode's own `Sentence_Terminal` property: a terminator this set misses
 * lands next to the template's own and fails that test.
 */
const TERMINATORS =
  '.!?\u061F\u2026\u0964\u0965\u3002\uFF61\uFF0E\uFF01\uFF1F\u1362\u17D4\u104B\u06D4\u0589';
const TERMINATOR_CLASS = `[${TERMINATORS}]`;
const TRAILING_TERMINATORS = new RegExp(`${TERMINATOR_CLASS}+$`);
const LEADING_TERMINATOR = new RegExp(`^${TERMINATOR_CLASS}`);
const PLACEHOLDER = '{{title}}';

/**
 * The label for one catalog entry: the template with its title replaced by
 * `title`, ending the sentence exactly once.
 *
 * The titles are whole sentences in most catalogs and carry their language's
 * own terminator (`de` "Die Zustellung ist fehlgeschlagen."), while the footer
 * templates add the terminator themselves (`{{title}}. Du kannst es erneut
 * versuchen.`). Interpolating the title unchanged therefore printed it twice
 * ("fehlgeschlagen.. Du kannst …"). The title's own terminator is dropped only
 * when the template supplies one; a template that is a bare `{{title}}`, as
 * `th` has, keeps whatever the title carries.
 */
export function composeFailureLabel(title: string, template: string): string {
  const placeholder = template.indexOf(PLACEHOLDER);
  if (placeholder === -1) {
    return template;
  }
  const head = template.slice(0, placeholder);
  const tail = template.slice(placeholder + PLACEHOLDER.length);
  const stem = LEADING_TERMINATOR.test(tail) ? title.replace(TRAILING_TERMINATORS, '') : title;
  return `${head}${stem}${tail}`;
}

/**
 * The failed row's accessibility label: the failure title, then the retry line
 * when the row offers one.
 *
 * The catalog value is read before interpolation (`getResource`), so the
 * decision to drop the title's terminator is made against the template as
 * translated rather than against a copy of the rule.
 *
 * Both keys and the title are resolved at call time, so the label follows a
 * language switch even when a caller holds a failure selected earlier.
 */
export function messageFailureLabel(
  failure: Pick<MessageFailure, 'titleKey' | 'canRetry'>
): string {
  const key = failure.canRetry
    ? 'agentChat.messageBubble.failureRetryAvailable'
    : 'agentChat.messageBubble.failure';
  const title = i18n.t(failure.titleKey);
  // The catalogs hold a string at every key they define; an absent one falls
  // back to i18next's own interpolation, which then keeps the title unchanged.
  const template =
    (i18n.getResource(i18n.language, 'translation', key) as string | undefined) ?? '';
  return template === '' ? i18n.t(key, { title }) : composeFailureLabel(title, template);
}

export function selectMessageFailure(input: {
  deliveryState?: MessageDeliveryState;
  info: MessageInfo;
  /**
   * Whether this row's session can accept a re-send right now. A read-only
   * stored transcript and a session without a live transport cannot, so the
   * failure keeps its copy and drops the Retry that could never send.
   * Defaults to true.
   */
  retryAvailable?: boolean;
}): MessageFailure | null {
  const { deliveryState, info } = input;
  const retryAvailable = input.retryAvailable ?? true;

  if (info.role === 'user' && deliveryState?.status === 'failed') {
    if (deliveryState.reason === AGENT_EXECUTION_DELIVERY_REASON) {
      const copy = DELIVERY_FAILURE_ROW.execution;
      return {
        kind: 'delivery',
        side: copy.side,
        error: copy.error,
        titleKey: copy.titleKey,
        title: i18n.t(copy.titleKey),
        detailKey: copy.detailKey,
        detail: i18n.t(copy.detailKey),
        copyDetail: deliveryState.error,
        canRetry: retryAvailable,
        canAddCredits: false,
        canCopy: true,
      };
    }
    // The SDK maps every transport failure that is not a person stopping the
    // message onto the give-up copy, so a state that names no known reason
    // takes the same branch instead of drawing an unlabelled row.
    const copy =
      deliveryState.reason === 'interrupted'
        ? DELIVERY_FAILURE_ROW.interrupted
        : DELIVERY_FAILURE_ROW.exhausted;
    return {
      kind: 'delivery',
      side: copy.side,
      error: copy.error,
      titleKey: copy.titleKey,
      title: i18n.t(copy.titleKey),
      detailKey: copy.detailKey,
      detail: copy.detailKey === null ? null : i18n.t(copy.detailKey),
      copyDetail: deliveryState.error,
      canRetry: retryAvailable,
      canAddCredits: false,
      canCopy: true,
    };
  }

  if (info.role === 'assistant' && info.error) {
    const { error } = info;
    const errorName = error.name;
    // A terminal gateway verdict drops the Retry and changes the detail line;
    // the name set still covers the errors whose class is terminal on every
    // transport.
    const retryableByProvider = !assistantErrorMarkedNonRetryable(error);
    const creditsRefusal = assistantCreditsRefusal(error);
    // A credits refusal names its cause, like the session's terminal error does
    // for the same gateway block (`messageForClass('credits')` in
    // session-terminal-error.ts). The row says only the cause: the action under
    // it carries the recovery, so the line does not repeat it.
    const detailKey = creditsRefusal
      ? 'agentChat.messageFailure.assistantCreditsRefusal'
      : assistantDetailKey(errorName, !retryableByProvider);
    return {
      kind: 'assistant',
      side: 'assistant',
      error: true,
      titleKey: 'agentChat.messageFailure.assistantTitle',
      title: i18n.t('agentChat.messageFailure.assistantTitle'),
      detailKey,
      detail: detailKey === null ? null : i18n.t(detailKey),
      copyDetail: '',
      canRetry:
        retryAvailable &&
        retryableByProvider &&
        !NON_RETRYABLE_ASSISTANT_ERRORS.includes(errorName),
      // Adding credits does not need the session to accept a re-send, so it is
      // independent of `retryAvailable`: a stored transcript keeps the action
      // that settles the failure it states.
      canAddCredits: creditsRefusal,
      canCopy: false,
    };
  }

  return null;
}
