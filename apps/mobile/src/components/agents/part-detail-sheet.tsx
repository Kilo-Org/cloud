import { type Part } from '@kilocode/cloud-agent-sdk';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetHeader } from '@/components/sheet-header';
import { Text } from '@/components/ui/text';
import { SegmentedControl } from '@/components/ui/segmented-control';

import { MONO_SCROLL_TEXT_MODE_OPTIONS, type MonoScrollTextMode } from './mono-scroll-block-model';
import { MonoScrollSheetProvider } from './mono-scroll-block';
import { getPartDetailTitle } from './part-detail-model';
import { isReasoningPart, isToolPart } from './part-types';
import { ToolPartDetailBody } from './tool-part-detail-body';

type PartDetailSheetProps = {
  visible: boolean;
  part: Part | null;
  onClose: () => void;
};

function renderPartContent(part: Part | null): ReactNode {
  if (part === null) {
    return <Text className="text-sm text-muted-foreground">Details unavailable</Text>;
  }
  if (isToolPart(part)) {
    return <ToolPartDetailBody part={part} />;
  }
  if (isReasoningPart(part)) {
    return (
      <Text selectable className="text-sm leading-5 text-muted-foreground">
        {part.text}
      </Text>
    );
  }
  return null;
}

/**
 * Detail sheet for a non-message transcript part. Follows the message-details
 * sheet: a pageSheet modal with a SheetHeader, scroll content, and a safe-area
 * footer. A vanished part shows a muted "Details unavailable" line; tool parts
 * render the shared body dispatcher; reasoning parts render full selectable
 * text. Reasoning and mono blocks are selectable here because the sheet is
 * outside `InMessageBubbleContext`.
 *
 * Mono text display mode: defaults to `wrap`, delivered to mounted mono blocks
 * through `MonoScrollSheetContext` with a presence tracker that shows the
 * `Text display` segmented control only while mono content is mounted. The
 * mode survives stream-driven re-renders and resets to `wrap` when the sheet
 * closes (visible -> false), because the host keeps the sheet mounted.
 */
export function PartDetailSheet({ visible, part, onClose }: Readonly<PartDetailSheetProps>) {
  const insets = useSafeAreaInsets();
  const [textMode, setTextMode] = useState<MonoScrollTextMode>('wrap');
  const [monoCount, setMonoCount] = useState(0);
  const trackMonoBlock = useCallback(() => {
    setMonoCount(count => count + 1);
    return () => {
      setMonoCount(count => count - 1);
    };
  }, []);
  useEffect(() => {
    if (!visible) {
      setTextMode('wrap');
    }
  }, [visible]);
  const sheetContext = useMemo(
    () => ({ mode: textMode, track: trackMonoBlock }),
    [textMode, trackMonoBlock]
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View className="flex-1 bg-background">
        <SheetHeader
          title={part ? getPartDetailTitle(part) : 'Details'}
          onDone={onClose}
          doneLabel="Done"
        />

        {monoCount > 0 ? (
          <View className="px-4 pb-2 pt-3">
            <SegmentedControl<MonoScrollTextMode>
              accessibilityLabel="Text display"
              options={MONO_SCROLL_TEXT_MODE_OPTIONS}
              value={textMode}
              onChange={setTextMode}
            />
          </View>
        ) : null}

        <ScrollView contentContainerClassName="gap-2 px-4 pb-6 pt-3">
          <MonoScrollSheetProvider value={sheetContext}>
            {renderPartContent(part)}
          </MonoScrollSheetProvider>
        </ScrollView>

        <View style={{ height: insets.bottom }} className="bg-background" />
      </View>
    </Modal>
  );
}
