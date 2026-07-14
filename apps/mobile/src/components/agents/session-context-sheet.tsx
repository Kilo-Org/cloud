import { Modal, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SheetHeader } from '@/components/sheet-header';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { type SessionContextInfo } from '@/lib/session-context-info';

import { ContextUsageRing } from './context-usage-ring';
import {
  type ContextTone,
  getArcFraction,
  getContextSheetContent,
  getContextTone,
} from './context-usage-display';

type SessionContextSheetProps = {
  visible: boolean;
  info: SessionContextInfo;
  modelDisplay: string;
  providerDisplay: string;
  totalCost: number;
  onClose: () => void;
};

const SHEET_RING_SIZE = 96;
const SHEET_RING_STROKE = 8;

const TONE_TEXT_CLASS: Record<ContextTone, string> = {
  destructive: 'text-destructive',
  warning: 'text-warn',
  primary: 'text-foreground',
  neutral: 'text-foreground',
};

function toneTextClass(tone: ContextTone): string {
  return TONE_TEXT_CLASS[tone];
}

export function SessionContextSheet({
  visible,
  info,
  modelDisplay,
  providerDisplay,
  totalCost,
  onClose,
}: Readonly<SessionContextSheetProps>) {
  const insets = useSafeAreaInsets();
  const content = getContextSheetContent(info, totalCost);
  const tone = getContextTone(info.percentage);
  const arcFraction = getArcFraction(info.percentage);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View className="flex-1 bg-background">
        <SheetHeader title="Context usage" onDone={onClose} doneLabel="Done" />

        {/* Rows below are exposed individually to screen readers; collapsing
            them behind a single ScrollView accessibilityLabel would shadow the
            natural read order. */}
        <ScrollView contentContainerClassName="px-6 pb-6 pt-2">
          <View className="items-center gap-3 pt-2">
            <ContextUsageRing
              size={SHEET_RING_SIZE}
              strokeWidth={SHEET_RING_STROKE}
              arcFraction={arcFraction}
              tone={tone}
              testID="session-context-sheet-ring"
            />
            {content.percentage ? (
              <Text className={cn('text-2xl font-semibold tabular-nums', toneTextClass(tone))}>
                {content.percentage}
              </Text>
            ) : (
              <Text className="text-base text-muted-foreground">
                {content.windowUnavailableLabel}
              </Text>
            )}
          </View>

          <View className="mt-6 gap-4">
            <Row label="Used">
              <Text className="text-base font-medium text-foreground tabular-nums">
                {content.usedTokens}
                {content.capacityKnown && content.windowTokens ? (
                  <Text className="text-sm text-muted-foreground">
                    {' '}
                    of {content.windowTokens} tokens
                  </Text>
                ) : (
                  <Text className="text-sm text-muted-foreground"> tokens</Text>
                )}
              </Text>
            </Row>

            {content.capacityKnown ? (
              <Row label="Remaining">
                <Text className="text-base font-medium text-foreground tabular-nums">
                  {content.remainingTokens}
                  <Text className="text-sm text-muted-foreground">
                    {' '}
                    tokens ({content.remainingPercentage})
                  </Text>
                </Text>
              </Row>
            ) : null}

            <Row label="Model">
              <Text className="text-base font-medium text-foreground">{modelDisplay}</Text>
            </Row>

            <Row label="Provider">
              <Text className="text-base font-medium text-foreground">{providerDisplay}</Text>
            </Row>

            {content.cost ? (
              <Row label="Total cost">
                <Text className="text-base font-medium text-foreground tabular-nums">
                  {content.cost}
                </Text>
              </Row>
            ) : null}

            <Text className="text-xs text-muted-foreground">
              Usage reflects the latest completed assistant response.
            </Text>
          </View>
        </ScrollView>

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
