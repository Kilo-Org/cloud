import { useRef, useState } from 'react';
import { View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Sparkles } from 'lucide-react-native';
import { type StandaloneSuggestion, type SuggestionAction } from 'cloud-agent-sdk';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

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
    <View className="mx-4 my-2 shrink overflow-hidden rounded-xl border border-border bg-card">
      <View className="flex-row items-center gap-2 border-b border-border bg-secondary px-4 py-3">
        <Sparkles size={16} color={colors.mutedForeground} />
        <Text className="text-sm font-medium">Suggestion</Text>
      </View>

      <View className="gap-3 p-4">
        <Text className="text-sm leading-5 text-foreground">{text}</Text>

        {error ? (
          <Text accessibilityLiveRegion="polite" className="text-xs text-destructive">
            {error}
          </Text>
        ) : null}

        {actions.length > 0 ? (
          <View className="gap-2">
            {actions.map((action: SuggestionAction, index: number) => {
              const isLoading = pending?.kind === 'accept' && pending.index === index;
              return (
                <View key={`${action.label}-${index}`} className="gap-1">
                  <Button
                    variant={index === 0 ? 'default' : 'outline'}
                    onPress={() => {
                      void handleAccept(index);
                    }}
                    disabled={isPending}
                    loading={isLoading}
                    accessibilityRole="button"
                    accessibilityLabel={action.label}
                    accessibilityHint={action.description}
                  >
                    <Text className="text-sm">{action.label}</Text>
                  </Button>
                  {action.description ? (
                    <Text className="text-xs leading-5 text-muted-foreground">
                      {action.description}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}

        <Button
          variant="ghost"
          size="sm"
          onPress={() => {
            void handleDismiss();
          }}
          disabled={isPending}
          loading={pending?.kind === 'dismiss'}
          accessibilityRole="button"
          accessibilityLabel="Dismiss suggestion"
          className={cn(actions.length > 0 && 'self-start')}
        >
          <Text className="text-sm">Dismiss suggestion</Text>
        </Button>
      </View>
    </View>
  );
}
