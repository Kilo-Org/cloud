import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';

import { useTranscriptTextSelectable } from './bubble-text-selection-context';
import { FixedPartRow } from './fixed-part-row';
import { useOpenPartDetail } from './open-part-detail-context';

type ReasoningPartRendererProps = {
  partId: string;
  text: string;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
};

export function ReasoningPartRenderer({
  partId,
  text,
  isStreaming,
  defaultExpanded = false,
}: Readonly<ReasoningPartRendererProps>) {
  const openPartDetail = useOpenPartDetail();
  const textSelectable = useTranscriptTextSelectable();
  const { t } = useTranslation();

  if (text.trim() === '') {
    return null;
  }

  const label = isStreaming
    ? t('agentChat.partDetail.thinking')
    : t('agentChat.partDetail.thought');

  if (defaultExpanded) {
    // Static, not collapsible: dashed container, Eyebrow label, full text.
    // No Pressable, no chevron, no collapse state.
    return (
      <View className="rounded-xl border-[1.5px] border-dashed border-border p-3">
        <Eyebrow>{label}</Eyebrow>
        <View className="mt-2">
          <Text selectable={textSelectable} className="text-sm leading-5 text-muted-foreground">
            {text}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <FixedPartRow
      variant="dashed"
      labelKind="eyebrow"
      label={label}
      accessibilityLabel={label}
      onPress={
        openPartDetail
          ? () => {
              openPartDetail(partId);
            }
          : undefined
      }
    />
  );
}
