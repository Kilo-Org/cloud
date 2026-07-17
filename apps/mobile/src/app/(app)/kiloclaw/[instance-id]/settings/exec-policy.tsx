import { type LucideIcon, ShieldCheck, Zap } from 'lucide-react-native';
import { ActivityIndicator, Pressable, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useLocalSearchParams } from 'expo-router';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { InstanceContextBoundary } from '@/components/kiloclaw/instance-context-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { instanceOrgId, useInstanceContext } from '@/lib/hooks/use-instance-context';
import { useKiloClawMutations, useKiloClawStatus } from '@/lib/hooks/use-kiloclaw-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type ExecPreset, execPresetToConfig } from '@/lib/onboarding';
import { cn } from '@/lib/utils';

type PolicyOption = {
  id: ExecPreset;
  icon: LucideIcon;
  iconColor: string;
  label: string;
  description: string;
};

const POLICY_OPTIONS: PolicyOption[] = [
  {
    id: 'always-ask',
    icon: ShieldCheck,
    iconColor: '#10b981',
    label: 'Always ask',
    description: 'Confirm every command before execution. Most secure.',
  },
  {
    id: 'never-ask',
    icon: Zap,
    iconColor: '#f59e0b',
    label: 'Never ask',
    description: 'Execute commands without confirmation. Faster but less safe.',
  },
];

function resolvePreset(
  execSecurity: string | null | undefined,
  execAsk: string | null | undefined
): ExecPreset | undefined {
  if (execSecurity === 'allowlist' && execAsk === 'on-miss') {
    return 'always-ask';
  }
  if (execSecurity === 'full' && execAsk === 'off') {
    return 'never-ask';
  }
  return undefined;
}

export default function ExecPolicyScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const instanceContext = useInstanceContext(instanceId);
  const organizationId = instanceOrgId(instanceContext);
  const statusQuery = useKiloClawStatus(organizationId);
  const mutations = useKiloClawMutations(organizationId);
  const colors = useThemeColors();

  const currentPreset = resolvePreset(statusQuery.data?.execSecurity, statusQuery.data?.execAsk);

  if (instanceContext.status === 'error' || instanceContext.status === 'not_found') {
    return <InstanceContextBoundary title="Execution policy" context={instanceContext} />;
  }

  if (statusQuery.isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Execution policy" />
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
        <ScreenHeader title="Execution policy" />
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

  const isPending = mutations.patchExecPreset.isPending;

  function handleSelect(option: PolicyOption) {
    // Same-value guard (mirrors model-picker's handleSelectAutoModel) and
    // serializing while a change is already in flight — one policy change
    // at a time.
    if (isPending || option.id === currentPreset) {
      return;
    }
    mutations.patchExecPreset.mutate(execPresetToConfig(option.id));
  }

  const pendingPreset = isPending
    ? resolvePreset(
        mutations.patchExecPreset.variables.security,
        mutations.patchExecPreset.variables.ask
      )
    : undefined;

  return (
    <Animated.View layout={LinearTransition} className="flex-1 bg-background">
      <ScreenHeader title="Execution policy" />
      <DetailScreenScrollView
        contentContainerClassName="px-4 pt-4 gap-4"
        showsVerticalScrollIndicator={false}
      >
        <Animated.View entering={FadeIn.duration(200)} className="gap-3">
          {POLICY_OPTIONS.map(option => {
            const Icon = option.icon;
            const isSelected =
              pendingPreset !== undefined
                ? pendingPreset === option.id
                : currentPreset === option.id;
            const isRowPending = isPending && pendingPreset === option.id;
            return (
              <Pressable
                key={option.id}
                className={cn(
                  'rounded-lg bg-secondary p-4 gap-3 border-2 active:opacity-70',
                  isSelected
                    ? 'border-primary bg-neutral-100 dark:bg-neutral-800'
                    : 'border-transparent',
                  isPending && 'opacity-50'
                )}
                disabled={isPending}
                accessibilityState={{ disabled: isPending, busy: isRowPending }}
                onPress={() => {
                  handleSelect(option);
                }}
              >
                <View className="flex-row items-center gap-3">
                  <Icon size={20} color={option.iconColor} />
                  <Text className="flex-1 text-base font-semibold">{option.label}</Text>
                  {isRowPending ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <View
                      className={cn(
                        'h-5 w-5 rounded-full border-2',
                        isSelected
                          ? 'border-primary bg-primary'
                          : 'border-muted-foreground bg-transparent'
                      )}
                    />
                  )}
                </View>
                <Text variant="muted" className="text-sm">
                  {option.description}
                </Text>
              </Pressable>
            );
          })}
        </Animated.View>
      </DetailScreenScrollView>
    </Animated.View>
  );
}
