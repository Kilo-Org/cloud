import { type StoredMessage, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { useEffect } from 'react';
import { View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { ScreenHeader } from '@/components/screen-header';

import { ChatComposer } from './chat-composer';
import { MessageBubble } from './message-bubble';
import { useOpenPartDetail } from './open-part-detail-context';
import { PartDetailSheetHost } from './part-detail-sheet-host';
import { SessionMessageList } from './session-message-list';
import { cacheToolAttachment } from './tool-card-image-cache';

const SESSION = 'part-detail-transition-fixture';
const PART = 'part-detail-transition-file';

function userMessage(id: string, text: string): StoredMessage {
  return {
    info: {
      id,
      sessionID: SESSION,
      role: 'user',
      time: { created: 0 },
      agent: 'fixture',
      model: { providerID: '', modelID: '' },
    },
    parts: [{ id: `${id}-text`, sessionID: SESSION, messageID: id, type: 'text', text }],
  };
}

const filePart: ToolPart = {
  id: PART,
  sessionID: SESSION,
  messageID: 'file-answer',
  type: 'tool',
  callID: 'file-call',
  tool: 'send_file',
  state: {
    status: 'completed',
    input: { path: '/tmp/random.txt' },
    output:
      'File random.txt delivered to the app.\nKeep this output visible until the sheet finishes closing.',
    title: 'Sent file: random.txt',
    metadata: {},
    time: { start: 0, end: 1 },
    attachments: [
      {
        id: 'fixture-file',
        sessionID: SESSION,
        messageID: 'file-answer',
        type: 'file',
        filename: 'random.txt',
        mime: 'text/plain',
        url: '',
      },
    ],
  },
};

const messages: StoredMessage[] = [
  ...Array.from({ length: 6 }, (_, index) =>
    userMessage(`history-${index}`, 'Earlier message in the conversation.')
  ),
  userMessage('file-question', 'Generate a random file and send it to me'),
  {
    info: {
      id: 'file-answer',
      sessionID: SESSION,
      role: 'assistant',
      time: { created: 0, completed: 1 },
      parentID: 'file-question',
      modelID: '',
      providerID: '',
      mode: 'code',
      agent: 'fixture',
      path: { cwd: '', root: '' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      filePart,
      {
        id: 'file-answer-text',
        sessionID: SESSION,
        messageID: 'file-answer',
        type: 'text',
        text: 'Sent random.txt to your app.',
      },
    ],
  },
];
const items = messages.map(message => ({ type: 'message' as const, message }));
const unavailableCommand = () => Promise.resolve(false);
const ignoreAction = () => undefined;
const ignoreExit = () => Promise.resolve();

function OpenInitialPart({ partId }: Readonly<{ partId: string | undefined }>) {
  const open = useOpenPartDetail();
  useEffect(() => {
    if (partId !== undefined) {
      open?.(partId);
    }
  }, [open, partId]);
  return null;
}

/** Opens at kiloapp:///dev/part-detail-transition-fixture. Uses real transcript, composer and sheet; sends nothing. */
export function PartDetailTransitionFixture({
  initialPartId,
}: Readonly<{ initialPartId?: string }> = {}) {
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  useEffect(() => {
    cacheToolAttachment(PART, {
      mime: 'text/plain',
      filename: 'random.txt',
      dataUrl: 'data:text/plain;base64,SGVsbG8K',
    });
  }, []);

  return (
    <PartDetailSheetHost messages={messages}>
      <OpenInitialPart partId={initialPartId} />
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('common.chat')} />
        <KeyboardAvoidingView className="flex-1" behavior="padding">
          <SessionMessageList
            sessionId={SESSION}
            items={items}
            keyExtractor={item => item.message.info.id}
            hasOlderMessages={false}
            isLoadingOlderMessages={false}
            olderMessagesError={null}
            olderMessagesOmittedItemCount={0}
            onLoadOlderMessages={ignoreAction}
            renderItem={({ item }) => <MessageBubble message={item.message} />}
          />
          <ChatComposer
            onSend={ignoreAction}
            onSendCommand={unavailableCommand}
            onCreateSession={unavailableCommand}
            onRestartSession={unavailableCommand}
            onExitSession={ignoreExit}
            sendDisabled
            model="fixture"
            variant=""
            modelOptions={[]}
            onModelSelect={ignoreAction}
            modelLocked
            attachmentsEnabled={false}
          />
        </KeyboardAvoidingView>
        <View style={{ height: bottom }} />
      </View>
    </PartDetailSheetHost>
  );
}
