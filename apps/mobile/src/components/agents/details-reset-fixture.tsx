/* eslint-disable no-literal-copy/no-literal-copy -- Development-only details fixture; its copy never ships. */
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';

import { ToolPartDetailBody } from './tool-part-detail-body';

const SESSION = 'details-reset-fixture';
const FIRST_PART = 'details-fixture-first';
const SECOND_PART = 'details-fixture-second';

/**
 * A completed markdown read whose body is one collapsed `<details>` element.
 * Every field matches what the read tool reports, so the body renders through
 * the same parse and the same markdown surfaces as a real read.
 */
function detailsReadPart(id: string, summary: string, body: string): ToolPart {
  const text = `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
  return {
    id,
    sessionID: SESSION,
    messageID: 'details-fixture-answer',
    type: 'tool',
    callID: `${id}-call`,
    tool: 'read',
    state: {
      status: 'completed',
      input: { filePath: `/workspace/${summary}.md` },
      output: text,
      title: `Read ${summary}.md`,
      metadata: {
        display: {
          type: 'file',
          path: `/workspace/${summary}.md`,
          text,
          lineStart: 1,
          lineEnd: 3,
          totalLines: 3,
          truncated: false,
        },
      },
      time: { start: 0, end: 1 },
    },
  };
}

const FIRST = detailsReadPart(FIRST_PART, 'First block', 'First body text.');
const SECOND = detailsReadPart(SECOND_PART, 'Second block', 'Second body text.');

/**
 * Development fixture for the details reset, reached through the app's dev
 * deep link and its development fixture page.
 *
 * It represents the detail sheet presenting one part after another. The sheet
 * body is not keyed by the part it shows, so the second part renders into the
 * first part's component instances — the same reuse a recycled transcript row
 * produces — and both parts put their `<details>` at the same place in the tree
 * the HTML engine renders. This fixture renders that same body component
 * directly, so the swap stays reachable while the reuse is unchanged.
 *
 * Expanding the first block and pressing the swap row shows the second part,
 * whose block carries no `open` and must therefore render collapsed. An
 * instance that keeps its state shows the second body instead: the defect this
 * fixture exists to show on a device.
 */
export function DetailsResetFixture() {
  const insets = useSafeAreaInsets();
  const [showing, setShowing] = useState<'first' | 'second'>('first');
  const part = showing === 'first' ? FIRST : SECOND;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Details reset" />
      <ScrollView contentContainerClassName="gap-2 p-4">
        <ToolPartDetailBody part={part} />
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        testID="details-reset-swap"
        onPress={() => {
          setShowing(current => (current === 'first' ? 'second' : 'first'));
        }}
        className="mx-4 mb-4 items-center rounded-lg border border-border bg-card px-4 py-3 active:opacity-70"
      >
        <Text>{showing === 'first' ? 'Second block' : 'First block'}</Text>
      </Pressable>
      <View style={{ height: insets.bottom }} />
    </View>
  );
}
