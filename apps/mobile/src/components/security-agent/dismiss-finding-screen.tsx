import { useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useDismissSecurityFinding } from '@/lib/hooks/use-security-findings';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

// The five GitHub dismissal reasons the backend's DismissReasonSchema accepts
// (apps/web/src/lib/security-agent/core/schemas.ts:13-19) — exact value/label
// pairs from the task brief, matching web's dismissal reason picker.
const DISMISS_REASONS = [
  ['fix_started', 'A fix has already started'],
  ['no_bandwidth', 'No bandwidth is available'],
  ['tolerable_risk', 'The risk is tolerable'],
  ['inaccurate', 'The finding is inaccurate'],
  ['not_used', 'Vulnerable code is not used'],
] as const;

type DismissReason = (typeof DISMISS_REASONS)[number][0];

type DismissFindingScreenProps = {
  scope: string;
  findingId: string;
};

export function DismissFindingScreen({ scope, findingId }: Readonly<DismissFindingScreenProps>) {
  const router = useRouter();
  const colors = useThemeColors();
  const [reason, setReason] = useState<DismissReason | null>(null);
  const commentRef = useRef('');
  const dismissFinding = useDismissSecurityFinding(scope);

  const onSubmit = () => {
    if (!reason) {
      return;
    }
    const comment = commentRef.current.trim();
    dismissFinding.mutate(
      { findingId, reason, comment: comment || undefined },
      {
        // Pop only once the command is accepted — the scope command observer
        // reports the terminal (success/failure) toast once it resolves.
        onSuccess: () => {
          router.back();
        },
      }
    );
  };

  return (
    <ScrollView
      className="flex-1 bg-background px-6"
      contentContainerClassName="gap-6 pb-8 pt-4"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
      <Text className="text-center text-lg font-semibold text-foreground">Dismiss Finding</Text>
      <View className="gap-2">
        <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
          Reason
        </Text>
        <View className="overflow-hidden rounded-lg bg-secondary">
          {DISMISS_REASONS.map(([value, label], index) => {
            const selected = reason === value;
            return (
              <Pressable
                key={value}
                className={cn(
                  'min-h-11 flex-row items-center justify-between px-4 py-3 active:opacity-70',
                  index < DISMISS_REASONS.length - 1 && 'border-b-[0.5px] border-hair-soft'
                )}
                onPress={() => {
                  setReason(value);
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
              >
                <Text className="flex-1 text-sm">{label}</Text>
                {selected && <Check size={16} color={colors.primary} />}
              </Pressable>
            );
          })}
        </View>
      </View>

      <View className="gap-3">
        <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
          Comment (optional)
        </Text>
        <TextInput
          accessibilityLabel="Dismissal comment"
          className="h-24 rounded-lg bg-secondary p-3 text-sm leading-5 text-foreground"
          multiline
          textAlignVertical="top"
          placeholder="Add context for this dismissal…"
          placeholderTextColor={colors.mutedForeground}
          onChangeText={value => {
            commentRef.current = value;
          }}
        />
      </View>

      <Button disabled={!reason || dismissFinding.isPending} onPress={onSubmit}>
        {dismissFinding.isPending ? (
          <ActivityIndicator size="small" color={colors.primaryForeground} />
        ) : null}
        <Text className="text-primary-foreground">Dismiss finding</Text>
      </Button>
    </ScrollView>
  );
}
