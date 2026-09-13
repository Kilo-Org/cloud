import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { CenteredState } from '@/components/centered-state';
import { SheetHeader } from '@/components/sheet-header';
import { Text } from '@/components/ui/text';

import { MessageErrorBoundary } from './message-error-boundary';
import { SessionPageSheet } from './session-page-sheet';
import { ToolOneLineRow } from './tool-run-rows';

type ToolRunSheetProps = {
  visible: boolean;
  parts: readonly ToolPart[];
  onClose: () => void;
  onOpenPart: (partId: string) => void;
};

/**
 * Sheet listing every tool call of a condensed run, in run order, each rendered
 * one-line exactly as it would appear on the session page. A vanished run (no
 * live parts left) shows the shared "Details unavailable" state. The sheet does
 * no I/O: a failed call's surface lives in its own part detail sheet.
 */
export function ToolRunSheet({ visible, parts, onClose, onOpenPart }: Readonly<ToolRunSheetProps>) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  return (
    <SessionPageSheet visible={visible} onClose={onClose}>
      <SheetHeader
        title={t('agentChat.toolRun.sheetTitle')}
        onDone={onClose}
        doneLabel={t('common.done')}
      />

      {parts.length === 0 ? (
        <CenteredState className="px-4">
          <View className="items-center py-6">
            <Text className="text-sm text-muted-foreground">
              {t('agentChat.partDetail.detailsUnavailable')}
            </Text>
          </View>
        </CenteredState>
      ) : (
        <ScrollView className="flex-1" contentContainerClassName="gap-2 px-4 pb-6 pt-3">
          {parts.map(part => (
            <MessageErrorBoundary key={part.id}>
              <ToolOneLineRow
                part={part}
                onPress={() => {
                  onOpenPart(part.id);
                }}
              />
            </MessageErrorBoundary>
          ))}
        </ScrollView>
      )}

      <View style={{ height: insets.bottom }} className="bg-background" />
    </SessionPageSheet>
  );
}
