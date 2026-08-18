import { type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { announcingToast } from '@/lib/a11y/announcing-toast';
import { useTRPC } from '@/lib/trpc';
import { SheetHeader } from '@/components/sheet-header';
import { Text } from '@/components/ui/text';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { formatExactTokens } from './context-usage-display';
import { handleMessageDetailsCopy } from './message-details-copy';
import { getMessageDetailsContent } from './message-details-content';
import {
  buildReportAiResponseErrorToast,
  buildReportAiResponseInput,
  classifyReportAiResponseFailure,
  reportAiResponseSubmittedToast,
  shouldShowReportAiResponse,
} from './report-ai-response';

type MessageDetailsSheetProps = {
  visible: boolean;
  message: StoredMessage | null;
  modelOptions: SessionModelOption[];
  onClose: () => void;
};

export function MessageDetailsSheet({
  visible,
  message,
  modelOptions,
  onClose,
}: Readonly<MessageDetailsSheetProps>) {
  const insets = useSafeAreaInsets();
  const trpc = useTRPC();
  const [reportedMessageId, setReportedMessageId] = useState<string | null>(null);
  const content = useMemo(
    () => (message ? getMessageDetailsContent(message, modelOptions) : null),
    [message, modelOptions]
  );

  const reportMutation = useMutation(
    trpc.moderation.reportContent.mutationOptions({
      onSuccess: (result, input) => {
        setReportedMessageId(input.targetId);
        announcingToast.success(reportAiResponseSubmittedToast(result.receiptId));
      },
      onError: (error, input) => {
        const failure = classifyReportAiResponseFailure(error);
        const errorToast = buildReportAiResponseErrorToast(failure, () => {
          reportMutation.mutate(input);
        });
        announcingToast.error(
          errorToast.message,
          errorToast.action ? { action: errorToast.action } : undefined
        );
      },
    })
  );

  const showReport =
    message !== null &&
    shouldShowReportAiResponse(message) &&
    message.info.id !== reportedMessageId;

  const handleCopy = () => {
    handleMessageDetailsCopy(content?.copyableText);
  };

  const handleReport = () => {
    if (!message) {
      return;
    }
    const input = buildReportAiResponseInput(message);
    if (!input) {
      return;
    }
    Alert.alert('Report AI response', 'Report this response for review?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Report',
        style: 'destructive',
        onPress: () => {
          reportMutation.mutate(input);
        },
      },
    ]);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View className="flex-1 bg-background">
        <SheetHeader title="Message details" onDone={onClose} doneLabel="Done" />

        {content ? (
          <ScrollView contentContainerClassName="px-6 pb-6 pt-2">
            {content.copyableText ? (
              <Pressable
                onPress={handleCopy}
                accessibilityRole="button"
                accessibilityLabel="Copy message"
                className="mb-6 rounded-md border border-border px-4 py-3 active:opacity-70"
                testID="message-details-copy"
              >
                <Text className="text-center text-base font-medium text-foreground">
                  Copy message
                </Text>
              </Pressable>
            ) : null}

            {showReport ? (
              <Pressable
                onPress={handleReport}
                accessibilityRole="button"
                accessibilityLabel="Report AI response"
                className="mb-6 rounded-md border border-border px-4 py-3 active:opacity-70"
                testID="message-details-report"
              >
                <Text className="text-center text-base font-medium text-foreground">
                  Report AI response
                </Text>
              </Pressable>
            ) : null}

            <View className="gap-4">
              <Row label="Role">
                <Text className="text-base font-medium text-foreground">{content.roleLabel}</Text>
              </Row>

              {content.sentTimeLabel ? (
                <Row label="Sent">
                  <Text className="text-base font-medium text-foreground tabular-nums">
                    {content.sentTimeLabel}
                  </Text>
                </Row>
              ) : null}

              {content.modelLabel ? (
                <Row label="Model">
                  <Text className="text-base font-medium text-foreground">
                    {content.modelLabel}
                  </Text>
                </Row>
              ) : null}
            </View>

            {content.costLabel && content.tokenRows ? (
              <View className="mt-8 gap-4">
                <Text className="text-sm font-semibold text-foreground">Cost & tokens</Text>
                <Row label="Cost">
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
      </View>
    </Modal>
  );
}

function Row({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <View className="gap-1">
      <Text className="text-xs uppercase tracking-wide text-muted-foreground">{label}</Text>
      {children}
    </View>
  );
}

function TokenRow({ label, value }: Readonly<{ label: string; value: number }>) {
  return (
    <View className="flex-row items-center justify-between">
      <Text className="text-sm text-muted-foreground">{label}</Text>
      <Text className="text-sm font-medium text-foreground tabular-nums">
        {formatExactTokens(value)}
      </Text>
    </View>
  );
}
