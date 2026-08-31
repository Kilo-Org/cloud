import { useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';
import { Sparkles, X } from '@/components/ui/icons';
import { type StandaloneSuggestion, type SuggestionAction } from '@kilocode/cloud-agent-sdk';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { createSuggestionActionLock, suggestionActionError } from './suggestion-card-state';

type SuggestionCardProps = {
  text: string;
  actions: StandaloneSuggestion['actions'];
  onAccept: (index: number) => Promise<void>;
  onDismiss: () => Promise<void>;
};

type PendingState = { kind: 'accept'; index: number } | { kind: 'dismiss' };

export function SuggestionCard({
  text,
  actions,
  onAccept,
  onDismiss,
}: Readonly<SuggestionCardProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const lockRef = useRef(createSuggestionActionLock());
  const [pending, setPending] = useState<PendingState | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleAccept(index: number) {
    if (!lockRef.current.tryAcquire()) {
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPending({ kind: 'accept', index });
    setError(null);
    try {
      await onAccept(index);
    } catch {
      lockRef.current.release();
      setPending(null);
      setError(suggestionActionError('accept'));
    }
  }

  async function handleDismiss() {
    if (!lockRef.current.tryAcquire()) {
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPending({ kind: 'dismiss' });
    setError(null);
    try {
      await onDismiss();
    } catch {
      lockRef.current.release();
      setPending(null);
      setError(suggestionActionError('dismiss'));
    }
  }

  function handleShowDetails() {
    Alert.alert(
      t('agentChat.suggestion.title'),
      [
        text,
        ...actions.map(action =>
          action.description ? `${action.label}\n${action.description}` : action.label
        ),
      ].join('\n\n'),
      [{ text: t('common.done') }]
    );
  }

  const isPending = pending !== null;

  return (
    <View className="px-3 py-2.5">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="items-center gap-2"
      >
        <Pressable
          onPress={handleShowDetails}
          accessibilityRole="button"
          accessibilityLabel={text}
          accessibilityHint={t('agentChat.partDetail.showDetails')}
          hitSlop={4}
          className="max-w-[240px] flex-row items-center gap-2 rounded-full bg-secondary px-3 py-2 active:opacity-70"
        >
          <Sparkles size={15} color={colors.mutedForeground} />
          <Text className="shrink text-sm text-foreground" numberOfLines={1}>
            {text}
          </Text>
        </Pressable>

        {actions.map((action: SuggestionAction, index: number) => (
          <Button
            key={`${action.label}-${index}`}
            variant={index === 0 ? 'default' : 'outline'}
            size="sm"
            onPress={() => {
              void handleAccept(index);
            }}
            disabled={isPending}
            loading={pending?.kind === 'accept' && pending.index === index}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityHint={action.description}
          >
            <Text className="text-sm" numberOfLines={1}>
              {action.label}
            </Text>
          </Button>
        ))}

        <Button
          variant="ghost"
          size="sm"
          onPress={() => {
            void handleDismiss();
          }}
          disabled={isPending}
          loading={pending?.kind === 'dismiss'}
          accessibilityRole="button"
          accessibilityLabel={t('agentChat.suggestion.dismiss')}
          className="px-2"
        >
          <X size={16} color={colors.mutedForeground} />
        </Button>
      </ScrollView>
      {error ? <AccessibleStatus message={error} className="pt-1 text-xs" /> : null}
    </View>
  );
}
