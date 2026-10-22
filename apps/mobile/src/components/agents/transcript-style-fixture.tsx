import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ScreenHeader } from '@/components/screen-header';
import { asMessages } from '@/lib/chat/turns';

import { MessageBubble } from './message-bubble';
import { PartDetailSheetHost } from './part-detail-sheet-host';
import { SessionContextMetrics } from './session-context-metrics';

// Development-only visual fixture: kiloapp:///dev/transcript-style-fixture.
// Uses the Quick Chat adapter and the shared transcript renderer; sends no requests.
const messages = asMessages({
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
  ],
});

export function TranscriptStyleFixture() {
  const { t } = useTranslation();

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
          <MessageBubble key={message.info.id} message={message} />
        ))}
      </PartDetailSheetHost>
    </View>
  );
}
