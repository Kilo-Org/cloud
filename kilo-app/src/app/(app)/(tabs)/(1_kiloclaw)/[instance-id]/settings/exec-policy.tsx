import { type LucideIcon, ShieldCheck, Zap } from 'lucide-react-native';
import { Pressable, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useKiloClawMutations, useKiloClawStatus } from '@/lib/hooks/use-kiloclaw';
import { cn } from '@/lib/utils';

type ExecPreset = 'always-ask' | 'never-ask';

type PolicyOption = {
  id: ExecPreset;
  icon: LucideIcon;
  iconColor: string;
  label: string;
  description: string;
  security: string;
  ask: string;
};

const POLICY_OPTIONS: PolicyOption[] = [
  {
    id: 'always-ask',
    icon: ShieldCheck,
    iconColor: '#10b981',
    label: 'Always Ask',
    description: 'Confirm every command before execution. Most secure.',
    security: 'ask',
    ask: 'true',
  },
  {
    id: 'never-ask',
    icon: Zap,
    iconColor: '#f59e0b',
    label: 'Never Ask',
    description: 'Execute commands without confirmation. Faster but less safe.',
    security: 'open',
    ask: 'false',
  },
];

function resolvePreset(
  execSecurity: string | null | undefined,
  execAsk: string | null | undefined
): ExecPreset | undefined {
  if (execSecurity === 'ask' && execAsk === 'true') {
    return 'always-ask';
  }
  if (execSecurity === 'open' && execAsk === 'false') {
    return 'never-ask';
  }
  return undefined;
}

export default function ExecPolicyScreen() {
  const statusQuery = useKiloClawStatus();
  const mutations = useKiloClawMutations();

  const currentPreset = resolvePreset(statusQuery.data?.execSecurity, statusQuery.data?.execAsk);

  if (statusQuery.isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Execution Policy" />
        <Animated.View layout={LinearTransition} className="flex-1 px-4 pt-4 gap-3">
          <Animated.View exiting={FadeOut.duration(150)}>
            <Skeleton className="h-20 w-full rounded-lg" />
          </Animated.View>
          <Animated.View exiting={FadeOut.duration(150)}>
            <Skeleton className="h-20 w-full rounded-lg" />
          </Animated.View>
        </Animated.View>
      </View>
    );
  }

  if (statusQuery.isError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Execution Policy" />
        <View className="flex-1 items-center justify-center">
          <QueryError
            message="Could not load execution policy"
            onRetry={() => {
              void statusQuery.refetch();
            }}
          />
        </View>
      </View>
    );
  }

  function handleSelect(option: PolicyOption) {
    mutations.patchExecPreset.mutate({ security: option.security, ask: option.ask });
  }

  return (
    <Animated.View layout={LinearTransition} className="flex-1 bg-background">
      <ScreenHeader title="Execution Policy" />
      <ScrollView contentContainerClassName="px-4 py-4 gap-4" showsVerticalScrollIndicator={false}>
        <Animated.View entering={FadeIn.duration(200)} className="gap-3">
          {POLICY_OPTIONS.map(option => {
            const Icon = option.icon;
            const isSelected = mutations.patchExecPreset.isPending
              ? mutations.patchExecPreset.variables.security === option.security
              : currentPreset === option.id;
            return (
              <Pressable
                key={option.id}
                className={cn(
                  'rounded-lg bg-secondary p-4 gap-3 border-2 active:opacity-70',
                  isSelected
                    ? 'border-primary bg-neutral-100 dark:bg-neutral-800'
                    : 'border-transparent'
                )}
                onPress={() => {
                  handleSelect(option);
                }}
              >
                <View className="flex-row items-center gap-3">
                  <Icon size={20} color={option.iconColor} />
                  <Text className="flex-1 text-base font-semibold">{option.label}</Text>
                  <View
                    className={cn(
                      'h-5 w-5 rounded-full border-2',
                      isSelected
                        ? 'border-primary bg-primary'
                        : 'border-muted-foreground bg-transparent'
                    )}
                  />
                </View>
                <Text variant="muted" className="text-sm">
                  {option.description}
                </Text>
              </Pressable>
            );
          })}

          {mutations.patchExecPreset.isPending && (
            <Animated.View entering={FadeIn.duration(200)}>
              <Text variant="muted" className="text-sm text-center">
                Saving...
              </Text>
            </Animated.View>
          )}
        </Animated.View>
      </ScrollView>
    </Animated.View>
  );
}
