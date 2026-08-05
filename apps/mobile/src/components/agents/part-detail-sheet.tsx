import { type Part } from '@kilocode/cloud-agent-sdk';
import { type ReactNode } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetHeader } from '@/components/sheet-header';
import { SelectableText } from '@/components/ui/selectable-text';
import { Text } from '@/components/ui/text';

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
      <SelectableText className="text-sm leading-5 text-muted-foreground">
        {part.text}
      </SelectableText>
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
 */
export function PartDetailSheet({ visible, part, onClose }: Readonly<PartDetailSheetProps>) {
  const insets = useSafeAreaInsets();

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

        <ScrollView contentContainerClassName="gap-2 px-4 pb-6 pt-3">
          {renderPartContent(part)}
        </ScrollView>

        <View style={{ height: insets.bottom }} className="bg-background" />
      </View>
    </Modal>
  );
}
