import { type MessageDeliveryState, type MessageInfo } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';

/**
 * Fixed, safe copy for a failed user-message delivery, keyed by the delivery
 * `reason`. Never surfaces raw provider or transport text.
 */
type DeliveryReason = Extract<MessageDeliveryState, { status: 'failed' }>['reason'];

const DELIVERY_DETAIL_KEY_BY_REASON = {
  interrupted: 'agentChat.messageFailure.deliveryInterrupted',
  exhausted: 'agentChat.messageFailure.deliveryExhausted',
  // `execution` is the response failure, not a delivery one (the message
  // reached the agent): the row shows the assistant-failure title instead of the
  // delivery one, and this line says the agent run itself failed.
  execution: 'agentChat.messageFailure.deliveryExecution',
} as const satisfies Record<DeliveryReason, string>;

/**
 * The one delivery reason that is an agent run failing, not the transport: the
 * message was delivered and the agent could not run it. The row states it in
 * the assistant-failure copy ("Response failed") with the execution line under
 * it, the same shape the interrupted and exhausted failures have (title, then
 * one small gray sentence). Switching the title to the delivery copy instead
 * would state the transport failure twice, once in the title and once in the
 * line (UX-DEFECT session-detail failed turn); the status indicator's
 * duplicate of the transport line is dropped in
 * `statusIndicatorDuplicatesMessageFailure`. Retry and Copy-to-composer keep
 * working: the transport text stays reachable behind the copy action.
 */
const AGENT_EXECUTION_DELIVERY_REASON: DeliveryReason = 'execution';

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
   * assistant failure with no classified reason). The footer then shows one
   * statement plus the action rather than the same sentence twice. An
   * agent-execution delivery failure is not that case: its response-failure
   * title carries the execution line under it, like every other delivery
   * failure's, so the two failure states read the same way.
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
}): MessageFailure | null {
  const { deliveryState, info } = input;

  if (info.role === 'user' && deliveryState?.status === 'failed') {
    if (deliveryState.reason === AGENT_EXECUTION_DELIVERY_REASON) {
      // The response-failure title, then the line that says the run was the
      // part that failed. A delivery reason with no title of its own would read
      // as a transport failure; an execution failure with no line of its own
      // reads as unfinished next to the interrupted/exhausted states, which do
      // carry one.
      const executionDetailKey = DELIVERY_DETAIL_KEY_BY_REASON[AGENT_EXECUTION_DELIVERY_REASON];
      return {
        kind: 'delivery',
        titleKey: 'agentChat.messageFailure.assistantTitle',
        title: i18n.t('agentChat.messageFailure.assistantTitle'),
        detailKey: executionDetailKey,
        detail: i18n.t(executionDetailKey),
        copyDetail: deliveryState.error,
        canRetry: true,
        canCopy: true,
      };
    }
    const detailKey = DELIVERY_DETAIL_KEY_BY_REASON[deliveryState.reason];
    return {
      kind: 'delivery',
      titleKey: 'agentChat.messageFailure.deliveryTitle',
      title: i18n.t('agentChat.messageFailure.deliveryTitle'),
      detailKey,
      detail: i18n.t(detailKey),
      copyDetail: deliveryState.error,
      canRetry: true,
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
    const detailKey = assistantDetailKey(errorName, !retryableByProvider);
    return {
      kind: 'assistant',
      titleKey: 'agentChat.messageFailure.assistantTitle',
      title: i18n.t('agentChat.messageFailure.assistantTitle'),
      detailKey,
      detail: detailKey === null ? null : i18n.t(detailKey),
      copyDetail: '',
      canRetry: retryableByProvider && !NON_RETRYABLE_ASSISTANT_ERRORS.includes(errorName),
      canCopy: false,
    };
  }

  return null;
}
