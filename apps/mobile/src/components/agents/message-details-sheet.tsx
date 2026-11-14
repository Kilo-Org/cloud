import { type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';

import { getLanguageSnapshot } from '@/i18n';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetHeader } from '@/components/sheet-header';
import { Text } from '@/components/ui/text';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { useConfirmDialog } from '@/components/ui/dialog';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { DetailsCopyAction } from './message-details-copy-action';
import { getMessageDetailsContent } from './message-details-content';
import { type MessageDeliveryStatement } from './message-failure-state';
import { MessageTextSelectSheet } from './message-text-select-sheet';
import { Row, TokenRow } from './session-detail-rows';
import { SessionPageSheet } from './session-page-sheet';
import { useMessageReport } from './use-message-report';

type MessageDetailsSheetProps = {
  visible: boolean;
  message: StoredMessage | null;
  modelOptions: SessionModelOption[];
  /** The selected message's delivery state; a failed one adds the transport detail to Copy. */
  deliveryState?: MessageDeliveryStatement;
  onClose: () => void;
  canCancelQueued?: boolean;
  isCancelingQueued?: boolean;
  onCancelQueued?: (message: StoredMessage) => void | Promise<void>;
  cancelQueuedFeedback?: { message: string; attempt: number } | null;
  cancelQueuedGuidance?: string | null;
  /**
   * Opens Continue with a cut at this message. Omitted when the message offers
   * no fork (streaming, queued, failed, or the first user message).
   */
  onForkFromHere?: () => void;
};

export function MessageDetailsSheet({
  visible,
  message,
  modelOptions,
  deliveryState,
  onClose,
  canCancelQueued = false,
  isCancelingQueued = false,
  onCancelQueued,
  cancelQueuedFeedback,
  cancelQueuedGuidance,
  onForkFromHere,
}: Readonly<MessageDetailsSheetProps>) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const { showReport, handleReport } = useMessageReport(message, confirm);
  const [selectVisible, setSelectVisible] = useState(false);
  const content = useMemo(
    () => (message ? getMessageDetailsContent(message, modelOptions, deliveryState) : null),
    // `getLanguageSnapshot()` re-resolves the captured copy (role labels,
    // token rows) when the app language changes while the sheet is mounted;
    // the content is otherwise stable on its message inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- language drives the resolved copy inside getMessageDetailsContent
    [message, modelOptions, deliveryState, getLanguageSnapshot()]
  );
  return (
    <SessionPageSheet
      dismissible
      visible={visible}
      onClose={
        selectVisible
          ? () => {
              setSelectVisible(false);
            }
          : onClose
      }
    >
      <AccessibleStatus
        key={cancelQueuedFeedback?.attempt}
        message={visible ? (cancelQueuedFeedback?.message ?? null) : null}
        tone="error"
        className="px-6 pt-4 text-sm"
      />
      {/* Keep recovery guidance readable without replaying the outcome announcement. */}
      {visible &&
      message &&
      cancelQueuedGuidance &&
      cancelQueuedFeedback?.message !== cancelQueuedGuidance ? (
        <Text className="px-6 pt-4 text-sm text-destructive">{cancelQueuedGuidance}</Text>
      ) : null}
      {selectVisible ? (
        <MessageTextSelectSheet
          text={content?.copyableText ?? ''}
          onClose={() => {
            setSelectVisible(false);
          }}
        />
      ) : (
        <>
          <SheetHeader
            title={t('agentChat.messageDetails.title')}
            onDone={onClose}
            doneLabel={t('common.done')}
            topInset="ios-page-sheet"
          />

          {content ? (
            <ScrollView className="flex-1" contentContainerClassName="px-6 pb-6 pt-2">
              {/* The two actions are independent: Copy is scoped to the message
                  text, while Select text also offers the thinking block and tool
                  output, so a message with only those parts still renders the
                  select affordance. Gate the block on either and each action on
                  its own payload. */}
              {content.copyText || content.canSelectText ? (
                <View className="mb-6 gap-2">
                  {content.copyText ? (
                    <DetailsCopyAction
                      // A new message and a hide/show each get a fresh feedback
                      // owner, which is what the deleted reset effect did.
                      key={`${message?.info.id ?? 'none'}:${visible ? 'shown' : 'hidden'}`}
                      copyText={content.copyText}
                    />
                  ) : null}

                  {content.canSelectText ? (
                    <Pressable
                      onPress={() => {
                        setSelectVisible(true);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={t('agentChat.messageDetails.selectText')}
                      className="rounded-md border border-border px-4 py-3 active:opacity-70"
                      testID="message-details-select-text"
                    >
                      <Text className="text-center text-base font-medium text-foreground">
                        {t('agentChat.messageDetails.selectText')}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}

              {visible && onForkFromHere ? (
                <Pressable
                  onPress={onForkFromHere}
                  accessibilityRole="button"
                  accessibilityLabel={t('agentChat.messageDetails.forkFromHere')}
                  className="mb-6 rounded-md border border-border px-4 py-3 active:opacity-70"
                  testID="message-details-fork"
                >
                  <Text className="text-center text-base font-medium text-foreground">
                    {t('agentChat.messageDetails.forkFromHere')}
                  </Text>
                </Pressable>
              ) : null}

              {visible && message && onCancelQueued && (canCancelQueued || isCancelingQueued) ? (
                <Pressable
                  onPress={() => {
                    if (canCancelQueued && !isCancelingQueued) {
                      void onCancelQueued(message);
                    }
                  }}
                  disabled={!canCancelQueued || isCancelingQueued}
                  accessibilityRole="button"
                  accessibilityLabel={t('agentChat.messageBubble.cancelQueuedAccessibility')}
                  accessibilityState={{
                    disabled: !canCancelQueued || isCancelingQueued,
                    busy: isCancelingQueued,
                  }}
                  className="mb-6 min-h-12 flex-row items-center justify-center gap-2 rounded-md border border-destructive px-4 py-3 active:opacity-70 disabled:opacity-50"
                  testID="message-details-cancel-queued"
                >
                  {isCancelingQueued ? (
                    <ActivityIndicator size="small" color={colors.mutedForeground} />
                  ) : null}
                  <Text className="text-center text-base font-medium text-destructive">
                    {t('agentChat.messageBubble.cancelQueued')}
                  </Text>
                </Pressable>
              ) : null}

              {showReport ? (
                <Pressable
                  onPress={handleReport}
                  accessibilityRole="button"
                  accessibilityLabel={t('agentChat.messageDetails.reportAiResponse')}
                  className="mb-6 rounded-md border border-border px-4 py-3 active:opacity-70"
                  testID="message-details-report"
                >
                  <Text className="text-center text-base font-medium text-foreground">
                    {t('agentChat.messageDetails.reportAiResponse')}
                  </Text>
                </Pressable>
              ) : null}

              <View className="gap-4">
                <Row label={t('common.role')}>
                  <Text className="text-base font-medium text-foreground">{content.roleLabel}</Text>
                </Row>

                {content.sentTimeLabel ? (
                  <Row label={t('agentChat.messageDetails.sent')}>
                    <Text className="text-base font-medium text-foreground tabular-nums">
                      {content.sentTimeLabel}
                    </Text>
                  </Row>
                ) : null}

                {content.modelLabel ? (
                  <Row label={t('common.model')}>
                    <Text className="text-base font-medium text-foreground">
                      {content.modelLabel}
                    </Text>
                  </Row>
                ) : null}
              </View>

              {content.costLabel && content.tokenRows ? (
                <View className="mt-8 gap-4">
                  <Text className="text-sm font-semibold text-foreground">
                    {t('agentChat.messageDetails.costAndTokens')}
                  </Text>
                  <Row label={t('common.cost')}>
                    <Text className="text-base font-medium text-foreground tabular-nums">
                      {content.costLabel}
                    </Text>
                  </Row>
                  <View className="gap-3">
                    {content.tokenRows.map(row => (
                      <TokenRow key={row.label} label={row.label} value={row.value} />
                    ))}
                  </View>
                </View>
              ) : null}
            </ScrollView>
          ) : null}

          <View style={{ height: insets.bottom }} className="bg-background" />
        </>
      )}
      {dialog}
    </SessionPageSheet>
  );
}
