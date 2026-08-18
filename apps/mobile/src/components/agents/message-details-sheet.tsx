import { type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetHeader } from '@/components/sheet-header';
import { Text } from '@/components/ui/text';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { formatExactTokens } from './context-usage-display';
import { handleMessageDetailsCopy } from './message-details-copy';
import { getMessageDetailsContent } from './message-details-content';
import { MessageTextSelectSheet } from './message-text-select-sheet';

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
  const [selectVisible, setSelectVisible] = useState(false);
  const content = useMemo(
    () => (message ? getMessageDetailsContent(message, modelOptions) : null),
    [message, modelOptions]
  );

  useEffect(() => {
    if (!visible) {
      setSelectVisible(false);
    }
  }, [visible]);

  const handleCopy = () => {
    handleMessageDetailsCopy(content?.copyableText);
  };

  return (
    <>
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
                <View className="mb-6 gap-2">
                  <Pressable
                    onPress={handleCopy}
                    accessibilityRole="button"
                    accessibilityLabel="Copy message"
                    className="rounded-md border border-border px-4 py-3 active:opacity-70"
                    testID="message-details-copy"
                  >
                    <Text className="text-center text-base font-medium text-foreground">
                      Copy message
                    </Text>
                  </Pressable>

                  {content.canSelectText ? (
                    <Pressable
                      onPress={() => {
                        setSelectVisible(true);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="Select text"
                      className="rounded-md border border-border px-4 py-3 active:opacity-70"
                      testID="message-details-select-text"
                    >
                      <Text className="text-center text-base font-medium text-foreground">
                        Select text
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
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

      <MessageTextSelectSheet
        visible={selectVisible}
        text={content?.copyableText ?? ''}
        onClose={() => {
          setSelectVisible(false);
        }}
      />
    </>
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
