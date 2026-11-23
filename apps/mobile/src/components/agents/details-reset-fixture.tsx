/* eslint-disable no-literal-copy/no-literal-copy -- Development-only transcript recycle fixture; its copy never ships. */
import { type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';

import { MessageBubble } from './message-bubble';
import { SessionMessageList } from './session-message-list';
import {
  getSessionTranscriptItemKey,
  getSessionTranscriptItemType,
  type SessionTranscriptItem,
} from './session-transcript';

const SESSION = 'details-reset-fixture';

/**
 * One assistant turn holding a single markdown text part. Neither details
 * element carries `open`, so each block must render collapsed on its own
 * merits.
 */
function detailsMessage(id: string, partId: string, text: string): StoredMessage {
  return {
    info: {
      id,
      sessionID: SESSION,
      role: 'assistant',
      time: { created: 0, completed: 1 },
      parentID: `${id}-question`,
      modelID: '',
      providerID: '',
      mode: 'code',
      agent: 'fixture',
      path: { cwd: '', root: '' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: partId, sessionID: SESSION, messageID: id, type: 'text', text }],
  };
}

const FIRST_MESSAGE = detailsMessage(
  'details-first',
  'details-first-text',
  '<details>\n<summary>First block</summary>\n\nFirst body text.\n\n</details>\n\nAfter the first block.'
);

const SECOND_MESSAGE = detailsMessage(
  'details-second',
  'details-second-text',
  '<details>\n<summary>Second block</summary>\n\nSecond body text.\n\n</details>\n\nAfter the second block.'
);

const ignoreLoadOlderMessages = () => undefined;

/**
 * Development fixture for the details reset, reached through the app's dev
 * deep link and its development fixture page.
 *
 * It represents one recycled transcript cell whose message is replaced: a
 * scrolled-out row in the real transcript is handed a different message while
 * FlashList keeps the cell's React key — the list recycles the key of a row
 * whose stable id changed into a per-item-type pool and takes it straight back
 * for the same index — so the new message renders into the previous message's
 * component instances.
 *
 * The list holds exactly one item, an assistant message with one collapsed
 * `<details>`. Expanding that block and pressing the swap row replaces the item
 * with the second message, which also renders collapsed on its own merits. A
 * cell that keeps its subtree therefore keeps the first block's expansion: the
 * defect this fixture exists to show on a device. Both messages are the same
 * item type (`message-assistant`), so the cell is recycled rather than
 * remounted.
 */
export function DetailsResetFixture() {
  const insets = useSafeAreaInsets();
  const [showing, setShowing] = useState<'first' | 'second'>('first');
  const message = showing === 'first' ? FIRST_MESSAGE : SECOND_MESSAGE;
  const items: SessionTranscriptItem[] = [{ type: 'message', message }];
  // The row names the block the next press brings in, so the swap stays
  // readable after it lands.
  const nextLabel = showing === 'first' ? 'Second block' : 'First block';

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Details reset" />
      <SessionMessageList
        sessionId={SESSION}
        items={items}
        keyExtractor={getSessionTranscriptItemKey}
        getItemType={getSessionTranscriptItemType}
        hasOlderMessages={false}
        isLoadingOlderMessages={false}
        olderMessagesError={null}
        olderMessagesOmittedItemCount={0}
        onLoadOlderMessages={ignoreLoadOlderMessages}
        renderItem={({ item }) =>
          item.type === 'message' ? <MessageBubble message={item.message} /> : null
        }
      />
      <Pressable
        accessibilityRole="button"
        testID="details-reset-swap"
        onPress={() => {
          setShowing(current => (current === 'first' ? 'second' : 'first'));
        }}
        className="mx-4 mb-4 items-center rounded-lg border border-border bg-card px-4 py-3 active:opacity-70"
      >
        <Text>{nextLabel}</Text>
      </Pressable>
      <View style={{ height: insets.bottom }} />
    </View>
  );
}
