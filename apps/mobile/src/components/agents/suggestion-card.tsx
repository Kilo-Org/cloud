import { useCallback, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import * as Haptics from 'expo-haptics';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

// Minimal shape of `StandaloneSuggestion['actions'][number]`. We re-declare
// the relevant fields here (rather than importing the SDK type) so the
// card stays a pure presentational component and can be rendered in tests
// with a small literal. The runtime shape comes from the SDK manager.
type SuggestionAction = {
  label: string;
  description?: string;
  prompt: string;
};

type SuggestionCardProps = {
  text: string;
  actions: SuggestionAction[];
  onAccept: (index: number) => Promise<void>;
  onDismiss: () => Promise<void>;
};

type PendingState = { kind: 'accept'; index: number } | { kind: 'dismiss' };

// Friendly inline error copy. Keep these user-facing strings local to the
// card so retries stay actionable without exposing upstream error text.
const ACCEPT_ERROR_COPY = "Couldn't apply this suggestion. Try again.";
const DISMISS_ERROR_COPY = "Couldn't dismiss this suggestion. Try again.";

export function SuggestionCard({
  text,
  actions,
  onAccept,
  onDismiss,
}: Readonly<SuggestionCardProps>) {
  const [pending, setPending] = useState<PendingState | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pendingRef = useRef<PendingState | null>(null);

  const handleAccept = useCallback(
    async (index: number) => {
      // Immediate ref lock prevents same-frame double-taps
      if (pendingRef.current) {
        return;
      }
      pendingRef.current = { kind: 'accept', index };
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setPending({ kind: 'accept', index });
      setErrorMessage(null);
      try {
        await onAccept(index);
        // Success: the manager resolves activeSuggestion and the parent
        // unmounts this card, so we don't need to clear pending here.
      } catch {
        pendingRef.current = null;
        setErrorMessage(ACCEPT_ERROR_COPY);
        setPending(null);
      }
    },
    [onAccept]
  );

  const handleDismiss = useCallback(async () => {
    // Immediate ref lock prevents same-frame double-taps
    if (pendingRef.current) {
      return;
    }
    pendingRef.current = { kind: 'dismiss' };
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPending({ kind: 'dismiss' });
    setErrorMessage(null);
    try {
      await onDismiss();
    } catch {
      pendingRef.current = null;
      setErrorMessage(DISMISS_ERROR_COPY);
      setPending(null);
    }
  }, [onDismiss]);

  const isDismissing = pending?.kind === 'dismiss';
  const isPending = pending !== null;

  return (
    <View
      className="mx-4 my-2 shrink overflow-hidden rounded-xl border border-border bg-card"
      accessibilityRole="alert"
    >
      <View className="border-b border-border bg-secondary px-4 py-3">
        <Text className="text-sm font-medium">Agent suggestion</Text>
      </View>

      <ScrollView className="max-h-96 shrink">
        <View className="gap-3 p-4">
          <Text className="text-sm text-foreground">{text}</Text>

          {actions.length > 0 ? (
            <View className="gap-1.5">
              {actions.map((action, index) => (
                <View key={`${action.label}-${index}`} className="gap-1">
                  <Button
                    variant={index === 0 ? 'default' : 'outline'}
                    onPress={() => {
                      void handleAccept(index);
                    }}
                    loading={pending?.kind === 'accept' && pending.index === index}
                    disabled={isPending}
                    accessibilityRole="button"
                    accessibilityLabel={action.label}
                    accessibilityHint={action.description}
                    className="h-auto justify-start py-2.5"
                  >
                    <Text
                      className={cn(
                        'text-left text-sm',
                        index === 0 ? 'text-primary-foreground' : 'text-foreground'
                      )}
                    >
                      {action.label}
                    </Text>
                  </Button>
                  {action.description ? (
                    <Text className="px-1 text-xs text-muted-foreground" accessible={false}>
                      {action.description}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}

          {errorMessage ? (
            <Text className="text-xs text-destructive" accessibilityLiveRegion="polite">
              {errorMessage}
            </Text>
          ) : null}
        </View>
      </ScrollView>

      <View className="flex-row gap-2 border-t border-border p-3">
        <Button
          variant="ghost"
          className="flex-1"
          onPress={() => {
            void handleDismiss();
          }}
          loading={isDismissing}
          disabled={isPending}
          accessibilityRole="button"
          accessibilityLabel="Dismiss suggestion"
        >
          <Text className="text-sm text-foreground">Dismiss suggestion</Text>
        </Button>
      </View>
    </View>
  );
}
