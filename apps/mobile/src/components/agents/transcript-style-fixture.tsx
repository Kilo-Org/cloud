import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { type PreparationAttempt, type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { ScreenHeader } from '@/components/screen-header';
import { askedMessageId, asMessages } from '@/lib/chat/turns';
import { type AddCreditsDestination } from '@/lib/credits/add-credits-destination';

import { MessageBubble } from './message-bubble';
import { PartDetailSheetHost } from './part-detail-sheet-host';
import { PreparationGroup } from './preparation-group';
import { SessionContextMetrics } from './session-context-metrics';

// Development-only visual fixture, opened through the development fixture path.
// Uses the Quick Chat adapter and the shared transcript renderer; sends no requests.
const SESSION = 'transcript-style-fixture';

const transcriptTurns = [
  {
    id: 'question',
    sessionId: SESSION,
    role: 'user',
    parts: [{ id: 'question-text', kind: 'text', body: 'What time is it in Tokyo?' }],
  },
  {
    id: 'answer',
    sessionId: SESSION,
    role: 'assistant',
    parts: [
      {
        id: 'reasoning-before',
        kind: 'reasoning',
        body: 'Read the current time before answering.',
      },
      { id: 'clock', kind: 'toolCall', callId: 'clock-call', name: 'time', body: '{}' },
      {
        id: 'reasoning-after',
        kind: 'reasoning',
        body: 'Convert the clock result to Tokyo time.',
      },
      { id: 'answer-text', kind: 'text', body: 'It is Thursday afternoon in Tokyo.' },
    ],
  },
  {
    id: 'result',
    sessionId: SESSION,
    role: 'user',
    parts: [
      {
        id: 'clock-result',
        kind: 'toolResult',
        callId: 'clock-call',
        body: 'Thursday morning UTC',
        failed: false,
      },
    ],
  },
  {
    id: 'hello-there',
    sessionId: SESSION,
    role: 'user',
    parts: [{ id: 'hello-there-text', kind: 'text', body: 'Hello there' }],
  },
] as const;

const turns = asMessages({
  sessionId: SESSION,
  asked: null,
  askedImages: [],
  answering: [],
  waiting: [],
  turns: [...transcriptTurns],
});

/** The error payload of the failed turn the fixture draws. */
type AssistantFailure = NonNullable<Extract<StoredMessage['info'], { role: 'assistant' }>['error']>;

/**
 * The turn the provider refused: a contentless assistant row carrying the
 * gateway's verdict for the failure. A retryable one (the default) is what the
 * transcript shows after a transient upstream failure, and its row draws the
 * one recovery action; a terminal one is what a non-retryable refusal looks
 * like, and its row offers no resend. The fixture never sends anything.
 */
function failedAnswer(isRetryable: boolean): StoredMessage {
  return failedAnswerWith({
    name: 'APIError',
    data: {
      message: 'Upstream provider returned HTTP 500',
      statusCode: 500,
      isRetryable,
    },
  });
}

function failedAnswerWith(error: AssistantFailure): StoredMessage {
  return {
    info: {
      id: 'failed-answer',
      sessionID: 'transcript-style-fixture',
      role: 'assistant',
      time: { created: 0, completed: 0 },
      parentID: 'hello-there',
      modelID: 'fixture',
      providerID: 'fixture',
      mode: 'code',
      agent: 'build',
      path: { cwd: '/workspace', root: '/workspace' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error,
    },
    parts: [],
  };
}

const retryableMessages = [...turns, failedAnswer(true)];
const terminalMessages = [...turns, failedAnswer(false)];

/**
 * The question whose answer failed, drawn the way the chat screen draws it: the
 * asked question is the row that carries the failure, and it holds the same
 * message the composer's recovery hands it — the `execution` delivery state,
 * Retry, and Copy to composer. A language switch reloads the runtime and the
 * chat screen restores a failure as `null`, so this state cannot be opened by a
 * link afterwards; the fixture is how the design gate measures it in each cell.
 */
const executionFailureMessages = asMessages({
  sessionId: SESSION,
  asked: 'And what time is it in Lisbon?',
  askedImages: [],
  answering: [],
  waiting: [],
  turns: [...transcriptTurns],
});

const EXECUTION_FAILURE = { status: 'failed', error: '', reason: 'execution' } as const;

/**
 * The question whose send the account's balance refused, drawn the way the chat
 * screen draws it: the asked question is the row that carries the statement, and
 * it holds the same delivery state the chat hands it — the credits cause, Add
 * credits, and Copy to composer, with no Retry. A runtime reload restores the
 * chat from its stored records, so this state cannot be opened by a link
 * afterwards; the fixture is how the design gate measures it in each cell.
 */
const creditsDeliveryMessages = asMessages({
  sessionId: SESSION,
  asked: 'And what time is it in Lisbon?',
  askedImages: [],
  answering: [],
  waiting: [],
  turns: [...transcriptTurns],
});

const CREDITS_DELIVERY_FAILURE = { status: 'failed', error: '', reason: 'credits' } as const;

/**
 * The question whose sandbox preparation failed, drawn the way the chat screen
 * draws it: the asked question carries the run's failure and the preparation
 * group under it names the stage that stopped and the reason. The group states
 * the failure, so the question's row keeps only its recovery actions. A runtime
 * reload restores a settled failure from its stored records, so this state
 * cannot be re-opened by a link afterwards; the fixture is how the design gate
 * measures it in each cell.
 */
const preparationFailureMessages = asMessages({
  sessionId: SESSION,
  asked: 'And what time is it in Lisbon?',
  askedImages: [],
  answering: [],
  waiting: [],
  turns: [...transcriptTurns],
});

const PREPARATION_FAILURE = { status: 'failed', error: '', reason: 'execution' } as const;

/**
 * The failed attempt the group renders: the sandbox stage stopped on a
 * configuration the provider refused, which is the reason the control plane
 * reports for it.
 */
const PREPARATION_FAILURE_ATTEMPT: PreparationAttempt = {
  id: 'fixture-attempt',
  triggerMessageId: askedMessageId(SESSION),
  status: 'failed',
  startedAt: 0,
  completedAt: 1,
  safeError: 'invalid_configuration',
  revision: 2,
  steps: [
    {
      id: 'fixture-sandbox-step',
      key: 'sandbox_provision',
      kind: 'phase',
      label: 'sandbox provision',
      status: 'failed',
      startedAt: 0,
      completedAt: 1,
      revision: 1,
      latestDetail: 'Creating sandbox',
      safeError: 'invalid_configuration',
    },
  ],
};

/**
 * The message the transport gave up on after several attempts. It never
 * reached the agent, so the failure belongs to the message's own column rather
 * than the response's; the SDK stores it on a queued row of the transcript.
 */
const UNDELIVERED_FAILURE = {
  status: 'failed',
  error: 'Delivery exhausted after several attempts',
  reason: 'exhausted',
} as const;

const askedId = askedMessageId(SESSION);

/** The transcript row a failed delivery rides on, and the copy the row states. */
const failedRowByFailure = {
  execution: { id: askedId, deliveryState: EXECUTION_FAILURE },
  creditsDelivery: { id: askedId, deliveryState: CREDITS_DELIVERY_FAILURE },
  undelivered: { id: 'hello-there', deliveryState: UNDELIVERED_FAILURE },
  preparation: { id: askedId, deliveryState: PREPARATION_FAILURE },
} as const;

/** The fixture never sends a retry; the row only needs the handler to draw its action. */
const ignoreRetry = (): void => undefined;

/** The fixture copies into a composer it does not draw, so the action stays inert. */
const ignoreCopy = (): void => undefined;

/** The fixture has no purchase screen behind it, so the action stays inert. */
const ignoreAddCredits = (): void => undefined;

/** The in-app destination the fixture's inert action carries. */
const FIXTURE_ADD_CREDITS: AddCreditsDestination = { kind: 'inApp', onPress: ignoreAddCredits };

/**
 * The failure the fixture draws: the retryable answer, the terminal one, the
 * one the account's balance refused to send, or the asked question's.
 */
type FixtureFailure =
  | 'retryable'
  | 'terminal'
  | 'creditsDelivery'
  | 'execution'
  | 'preparation'
  | 'undelivered';

const MESSAGES_BY_FAILURE = {
  retryable: retryableMessages,
  terminal: terminalMessages,
  creditsDelivery: creditsDeliveryMessages,
  execution: executionFailureMessages,
  preparation: preparationFailureMessages,
  undelivered: turns,
} satisfies Record<FixtureFailure, readonly StoredMessage[]>;

export function TranscriptStyleFixture({
  failure = 'retryable',
  retryAvailable = true,
}: Readonly<{ failure?: FixtureFailure; retryAvailable?: boolean }> = {}) {
  const { t } = useTranslation();
  const messages = MESSAGES_BY_FAILURE[failure];
  const failedRow =
    failure === 'execution' ||
    failure === 'creditsDelivery' ||
    failure === 'undelivered' ||
    failure === 'preparation'
      ? failedRowByFailure[failure]
      : undefined;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('common.chat')}
        headerRight={
          <SessionContextMetrics
            info={{
              contextTokens: 1000,
              contextWindow: 200_000,
              percentage: 0.5,
              providerID: 'fixture',
              modelID: 'fixture',
            }}
            totalCostMicrodollars={500}
            hasMessages
          />
        }
      />
      <PartDetailSheetHost messages={messages}>
        {messages.map(message => (
          <MessageBubble
            key={message.info.id}
            message={message}
            onRetryMessage={retryAvailable ? ignoreRetry : undefined}
            addCredits={FIXTURE_ADD_CREDITS}
            retryAvailable={retryAvailable}
            failureStatedByPreparation={failure === 'preparation'}
            {...(failedRow !== undefined && message.info.id === failedRow.id
              ? { deliveryState: failedRow.deliveryState, onCopyToComposer: ignoreCopy }
              : {})}
          />
        ))}
        {/* The transcript emits a failed attempt right after the question that
            triggered it, so the group closes this turn. */}
        {failure === 'preparation' ? (
          <PreparationGroup attempt={PREPARATION_FAILURE_ATTEMPT} />
        ) : null}
      </PartDetailSheetHost>
    </View>
  );
}
