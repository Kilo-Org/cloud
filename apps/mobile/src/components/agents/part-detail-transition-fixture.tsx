import { File, Paths } from 'expo-file-system';
import { type StoredMessage, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { useEffect } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { KeyboardFollowPane } from '@/components/keyboard-follow-pane';
import { ScreenHeader } from '@/components/screen-header';

import { ChatComposer } from './chat-composer';
import { MessageBubble } from './message-bubble';
import { useOpenPartDetail } from './open-part-detail-context';
import { PartDetailSheetHost } from './part-detail-sheet-host';
import { SessionMessageList } from './session-message-list';
import { cacheToolAttachment, clearToolCardImageCache } from './tool-card-image-cache';

const SESSION = 'part-detail-transition-fixture';
const PART = 'part-detail-transition-file';
const MEDIA_PART = 'part-detail-transition-image';

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

/**
 * The same call while the file is still being written: no attachment and no
 * output yet, so the card and the sheet have only the input path to name the
 * file with.
 */
const pendingFilePart: ToolPart = {
  ...filePart,
  state: { status: 'running', input: { path: '/tmp/random.txt' }, time: { start: 0 } },
};

/**
 * A 96 by 72 blue gradient with a white disc, 8-bit RGB: visible at card size,
 * under a kilobyte, and decodable by every platform image loader. The tool card
 * paints the file these bytes are written to, so the fixture needs real image
 * bytes rather than a placeholder URI.
 */
const IMAGE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABICAIAAACGBWc0AAADOElEQVR42u2bPUxTURTH' +
  'z73vtZUPNamipICpRpIKhDjIR4IDiCS6mLigiU7sJLro7ujkpouGwTiKYUHDYOJXQZem' +
  'VYJBSmO1KWAgNgoU3n3XoYkL2GPL67mEnF86vnffyb//8399592KnjurwPwbW5iuYJdj' +
  'C1aoKCwQAguEYEsWqCjsIAQWCIEFQuAMQmAHIdiCFSoKOwiBMwiBHYTAAiGwQAicQQg8' +
  'MEPgFkNggRBsyQoVxbyDLAlNQdHeJNsbZfiwqA3Arzykfuh42o1/c9PLWrkmyxNX7q+b' +
  'unaVH863WNe67eKHPZl0JqbV2oaZIsXVB2YE6jwhbw74/v/4exObU0kDXjLQYpaEobN2' +
  'X8Qq6awbA76XM+rRG4e446h/KEoJty742hpkGef2Ray6/eLu802XUCMpBFB+hnrs8tQp' +
  '0NYgh3psyoJJW6wjLHtL7Kyt9EasxHf3Q4rIRXQOqvaL4f4SUrkIw/2+ar8gchBZBp07' +
  'VX5nbbNaRI5/VARlE82kLQGDZ+ydr/OXwQ57YtpVuuKVE2VQY9D7yzQGxdfliitEJFBr' +
  'yPvLtIVEeqXyAtFkUGvIywAq0BKSL6Yrfi8jctCxCrRYU5AiP4kmitV+79esDVB8uUQO' +
  'Wt2AmoDHa/7OawoH0WRQekVH6j2+UnpFExRP5KCZrI7Ue78mSQaRCPR5wQXY6VPY1jVp' +
  'BKJQKJuryJoExRNlkNYwFleX2j0z0VhcaQ17J4MAIJp0PRQomqToL6Acd+QdGIk6nhQ9' +
  'EnXyzl4cmCUyenLe7T6+o8eOyXk3kaG4fxWgnkmPxtShGmg+UqZGs4vuaExR1kz9VkMD' +
  'PHynLp+GrnDJGk2l3NGY0gCUNRt47aMBnsbU7KK+3llCZj9+rxIZF2jVAQBx+5mhV5YA' +
  '+2zRFRYXWxGZxj+pqZRedyo/PdwOk+/m80q/mtNvk+7RA6K5TpysE6GDosoHa5uQ+am/' +
  'LOnZJb2Q04W5qqk6ze/u0ADZHGRz+vXcth4RZvfAmd/dscthgRB4jyIC73JF4BZDYIEQ' +
  'WCAEziAEdhAC/+MQgR2EwBmEwA5CYIEQWCAEziAEdhACC4TAAiGYn0nvcv4AwOzZeiEt' +
  'ufMAAAAASUVORK5CYII=';

/**
 * The image-send variant of `filePart`: a completed call whose one attachment
 * is an image, the only shape that renders the tool card image surface.
 */
const imagePart: ToolPart = {
  id: MEDIA_PART,
  sessionID: SESSION,
  messageID: 'file-answer',
  type: 'tool',
  callID: 'image-call',
  tool: 'send_file',
  state: {
    status: 'completed',
    input: { path: '/tmp/screenshot.png' },
    output: 'Screenshot delivered to the app.',
    title: 'Sent image: screenshot.png',
    metadata: {},
    time: { start: 0, end: 1 },
    attachments: [
      {
        id: 'fixture-image',
        sessionID: SESSION,
        messageID: 'file-answer',
        type: 'file',
        filename: 'screenshot.png',
        mime: 'image/png',
        url: '',
      },
    ],
  },
};

function buildMessages(part: ToolPart, reply: string): StoredMessage[] {
  return [
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
        part,
        {
          id: 'file-answer-text',
          sessionID: SESSION,
          messageID: 'file-answer',
          type: 'text',
          text: reply,
        },
      ],
    },
  ];
}
const messages = buildMessages(filePart, 'Sent random.txt to your app.');
// The unfinished variant carries no delivery claim, so the transcript agrees
// with its running tool row.
const runningMessages = buildMessages(pendingFilePart, 'Writing the file to send you.');
const mediaMessages = buildMessages(imagePart, 'Sent screenshot.png to your app.');
const unavailableCommand = () => Promise.resolve(false);
const ignoreAction = () => undefined;
const ignoreExit = () => Promise.resolve();

/**
 * Put the tool card image cache behind `MEDIA_PART` into one settled state.
 *
 * `loaded` writes a real PNG and records its URI. `failed` makes the cache
 * directory uncreatable by leaving a regular file at its path, so the write
 * throws and the part id stays latched. `superseded` resets the cache while the
 * base64 write is still in flight, so that attempt publishes nothing (no URI,
 * no pending mark, no latch) into the next generation.
 */
function seedMediaState(media: 'loaded' | 'failed' | 'superseded'): void {
  // A fresh generation: one target can run twice in one app process.
  clearToolCardImageCache();
  let blocker: File | undefined = undefined;
  if (media === 'failed') {
    // A regular file where the cache directory belongs is a real device fault:
    // the directory creation throws and the sink latches the part id.
    blocker = new File(Paths.cache, 'tool-card-images');
    // Overwrite: a leftover blocker from an earlier run in this process must not
    // fail the seeding itself.
    blocker.create({ intermediates: true, overwrite: true });
  }
  cacheToolAttachment(MEDIA_PART, {
    mime: 'image/png',
    filename: 'screenshot.png',
    dataUrl: `data:image/png;base64,${IMAGE_PNG_BASE64}`,
  });
  if (media === 'superseded') {
    // Reset while the base64 write is still in flight: the attempt must publish
    // nothing into the next generation.
    clearToolCardImageCache();
  }
  if (blocker) {
    blocker.delete();
  }
}

function OpenInitialPart({ partId }: Readonly<{ partId: string | undefined }>) {
  const open = useOpenPartDetail();
  useEffect(() => {
    if (partId !== undefined) {
      open?.(partId);
    }
  }, [open, partId]);
  return null;
}

/**
 * Development fixture for the part-detail transition, opened through the app's
 * dev deep link. Uses the real transcript, composer and sheet; sends nothing.
 * `state: 'running'` renders the same call before its file exists, so the sheet
 * and the row have only the input path to name the file with.
 *
 * `media` swaps the transcript for a completed image send and opens the sheet on
 * it, so the tool card's three settled image surfaces are reachable without a
 * live session: `loaded` paints the cached PNG, `failed` shows the unavailable
 * row. Both `failed` and `superseded` render that same row; they differ only in
 * cache state, and only a device can produce either one, because a failed write
 * latches the part id while a write superseded by a cache reset publishes
 * nothing at all — no URI, no pending mark, no latch.
 */
export function PartDetailTransitionFixture({
  initialPartId,
  state = 'completed',
  media,
}: Readonly<{
  initialPartId?: string;
  state?: 'completed' | 'running';
  media?: 'loaded' | 'failed' | 'superseded';
}> = {}) {
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const running = state === 'running';
  useEffect(() => {
    if (running) {
      return;
    }
    cacheToolAttachment(PART, {
      mime: 'text/plain',
      filename: 'random.txt',
      dataUrl: 'data:text/plain;base64,SGVsbG8K',
    });
  }, [running]);
  useEffect(() => {
    if (media !== undefined) {
      seedMediaState(media);
    }
  }, [media]);
  let shownMessages = messages;
  if (state === 'running') {
    shownMessages = runningMessages;
  }
  if (media !== undefined) {
    shownMessages = mediaMessages;
  }
  const openedPartId = media !== undefined ? MEDIA_PART : initialPartId;

  return (
    <PartDetailSheetHost messages={shownMessages}>
      <OpenInitialPart partId={openedPartId} />
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('common.chat')} />
        <KeyboardFollowPane>
          <SessionMessageList
            sessionId={SESSION}
            items={shownMessages.map(message => ({ type: 'message' as const, message }))}
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
        </KeyboardFollowPane>
        <View style={{ height: bottom }} />
      </View>
    </PartDetailSheetHost>
  );
}
