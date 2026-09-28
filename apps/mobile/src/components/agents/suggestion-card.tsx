import { useRef, useState } from 'react';
import { View } from 'react-native';
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

  const isPending = pending !== null;

  return (
    <View className="gap-2 px-3 py-2.5">
      {/* The suggestion is context, not a control: it wraps in full so the
          offered actions below stay the row's only affordances. */}
      <View className="flex-row items-start gap-2">
        <Sparkles size={15} color={colors.mutedForeground} />
        <Text className="flex-1 text-sm text-foreground">{text}</Text>
      </View>

      <View className="flex-row flex-wrap items-center gap-2">
        {actions.map((action: SuggestionAction, index: number) => (
          <Button
            key={`${action.label}-${index}`}
            variant={index === 0 ? 'default' : 'outline'}
            size="sm"
            // The row no longer scrolls, so a model-generated label wider than
            // the card cannot be reached by scrolling. The button is clamped to
            // the row and its label shrinks and wraps instead of overflowing.
            className="max-w-full shrink"
            onPress={() => {
              void handleAccept(index);
            }}
            disabled={isPending}
            loading={pending?.kind === 'accept' && pending.index === index}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityHint={action.description}
          >
            <Text className="shrink text-sm">{action.label}</Text>
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
      </View>
      {error ? <AccessibleStatus message={error} className="pt-1 text-xs" /> : null}
    </View>
  );
}
