import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { ScreenHeader } from '@/components/screen-header';
import { asMessages } from '@/lib/chat/turns';

import { MessageBubble } from './message-bubble';
import { PartDetailSheetHost } from './part-detail-sheet-host';
import { SessionContextMetrics } from './session-context-metrics';

// Development-only visual fixture, opened through the development fixture path.
// Uses the Quick Chat adapter and the shared transcript renderer; sends no requests.
const turns = asMessages({
  sessionId: 'transcript-style-fixture',
  asked: null,
  askedImages: [],
  answering: [],
  waiting: [],
  turns: [
    {
      id: 'question',
      sessionId: 'transcript-style-fixture',
      role: 'user',
      parts: [{ id: 'question-text', kind: 'text', body: 'What time is it in Tokyo?' }],
    },
    {
      id: 'answer',
      sessionId: 'transcript-style-fixture',
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
      sessionId: 'transcript-style-fixture',
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
      sessionId: 'transcript-style-fixture',
      role: 'user',
      parts: [{ id: 'hello-there-text', kind: 'text', body: 'Hello there' }],
    },
  ],
});

/**
 * The turn the provider refused: a contentless assistant row carrying the
 * gateway's verdict for the failure. A retryable one (the default) is what the
 * transcript shows after a transient upstream failure, and its row draws the
 * one recovery action; a terminal one is what a non-retryable refusal looks
 * like, and its row offers no resend. The fixture never sends anything.
 */
function failedAnswer(isRetryable: boolean): StoredMessage {
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
      error: {
        name: 'APIError',
        data: {
          message: 'Upstream provider returned HTTP 500',
          statusCode: 500,
          isRetryable,
        },
      },
    },
    parts: [],
  };
}

const retryableMessages = [...turns, failedAnswer(true)];
const terminalMessages = [...turns, failedAnswer(false)];

/** The fixture never sends a retry; the row only needs the handler to draw its action. */
const ignoreRetry = (): void => undefined;

export function TranscriptStyleFixture({
  terminalFailure = false,
}: Readonly<{ terminalFailure?: boolean }> = {}) {
  const { t } = useTranslation();
  const messages = terminalFailure ? terminalMessages : retryableMessages;

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
          <MessageBubble key={message.info.id} message={message} onRetryMessage={ignoreRetry} />
        ))}
      </PartDetailSheetHost>
    </View>
  );
}
