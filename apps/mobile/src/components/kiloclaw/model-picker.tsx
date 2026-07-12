import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { CheckCircle2, type LucideIcon, Scale, Zap } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { instanceOrgId, useInstanceContext } from '@/lib/hooks/use-instance-context';
import { useKiloClawConfig, useKiloClawMutations } from '@/lib/hooks/use-kiloclaw-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { addModelPrefix, stripModelPrefix } from '@/lib/model-id';

type AutoModelCard = {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  iconBg: string;
  iconColorKey: 'agentSky' | 'agentYuki';
  cost: number;
  performance: number;
  performanceDotColor: string;
};

const AUTO_MODEL_CARDS: AutoModelCard[] = [
  {
    id: 'kilo-auto/frontier',
    label: 'Frontier',
    description: 'Highest performance. Routes to frontier models with reasoning.',
    icon: Zap,
    iconBg: 'bg-agent-yuki-tile-bg',
    iconColorKey: 'agentYuki',
    cost: 3,
    performance: 3,
    performanceDotColor: 'bg-agent-yuki',
  },
  {
    id: 'kilo-auto/balanced',
    label: 'Balanced',
    description: 'Smart balance of speed and capability at lower cost.',
    icon: Scale,
    iconBg: 'bg-agent-sky-tile-bg',
    iconColorKey: 'agentSky',
    cost: 2,
    performance: 2,
    performanceDotColor: 'bg-agent-sky',
  },
];

const AUTO_MODEL_IDS = new Set(AUTO_MODEL_CARDS.map(c => c.id));

function CostIndicator({ level }: { level: number }) {
  return (
    <View className="flex-row items-center justify-between">
      <Text className="text-xs text-muted-foreground">Cost</Text>
      <View className="flex-row gap-0.5">
        {[0, 1, 2].map(i => (
          <Text
            key={i}
            className={`text-sm font-medium ${i < level ? 'text-foreground' : 'text-neutral-300 dark:text-neutral-700'}`}
          >
            $
          </Text>
        ))}
      </View>
    </View>
  );
}

function PerformanceIndicator({ level, dotColor }: { level: number; dotColor: string }) {
  return (
    <View className="flex-row items-center justify-between">
      <Text className="text-xs text-muted-foreground">Performance</Text>
      <View className="flex-row gap-1">
        {[0, 1, 2].map(i => (
          <View
            key={i}
            className={`h-2.5 w-5 rounded-full ${i < level ? dotColor : 'bg-neutral-200 dark:bg-neutral-700'}`}
          />
        ))}
      </View>
    </View>
  );
}

export function ModelPicker() {
  const router = useRouter();
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const instanceContext = useInstanceContext(instanceId);
  const organizationId = instanceOrgId(instanceContext);
  const { data: config, isLoading } = useKiloClawConfig(organizationId);
  const mutations = useKiloClawMutations(organizationId);
  const colors = useThemeColors();

  const currentModel = stripModelPrefix(config?.kilocodeDefaultModel);
  const isAutoModel = AUTO_MODEL_IDS.has(currentModel);

  const handleSelectAutoModel = (modelId: string) => {
    if (currentModel === modelId) {
      return;
    }
    mutations.updateModel.mutate({ kilocodeDefaultModel: addModelPrefix(modelId) });
  };

  // Disabled queries (organizationId unresolved) have isLoading === false, so
  // also skeleton while instance context is loading — otherwise the cards render
  // interactive but taps silently no-op.
  if (isLoading || instanceContext.status !== 'ready') {
    return (
      <View className="gap-3">
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </View>
    );
  }

  return (
    <View className="gap-4">
      <View className="gap-3">
        <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Kilo Auto
        </Text>
        {AUTO_MODEL_CARDS.map(card => {
          const selected = currentModel === card.id;
          const Icon = card.icon;
          return (
            <Pressable
              key={card.id}
              className={`relative gap-3 rounded-lg border p-4 active:opacity-80 ${
                selected
                  ? 'border-primary bg-neutral-100 dark:bg-neutral-800'
                  : 'border-border bg-secondary'
              }`}
              disabled={mutations.updateModel.isPending}
              onPress={() => {
                handleSelectAutoModel(card.id);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: mutations.updateModel.isPending }}
              accessibilityLabel={`${card.label} auto model`}
            >
              {selected && (
                <View className="absolute right-3 top-3">
                  <CheckCircle2 size={20} color={colors.primary} />
                </View>
              )}
              <View className={`h-9 w-9 items-center justify-center rounded-lg ${card.iconBg}`}>
                <Icon size={20} color={colors[card.iconColorKey]} />
              </View>
              <View className="gap-1">
                <Text className="font-semibold">{card.label}</Text>
                <Text className="text-xs leading-relaxed text-muted-foreground">
                  {card.description}
                </Text>
              </View>
              <View className="gap-1.5">
                <CostIndicator level={card.cost} />
                <PerformanceIndicator
                  level={card.performance}
                  dotColor={card.performanceDotColor}
                />
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* Current non-auto model display */}
      {!isAutoModel && currentModel && (
        <View className="rounded-lg bg-secondary p-3">
          <Text className="text-xs text-muted-foreground">Current model</Text>
          <Text className="text-sm font-medium">{currentModel}</Text>
        </View>
      )}

      {/* Navigate to full model list */}
      <Pressable
        className="min-h-11 items-center justify-center py-2 active:opacity-70"
        onPress={() => {
          router.push(`/(app)/kiloclaw/${instanceId}/settings/model-list` as Href);
        }}
        accessibilityRole="link"
        accessibilityLabel="Browse all 500+ models"
      >
        <Text className="text-sm text-muted-foreground">or select from 500+ models</Text>
      </Pressable>
    </View>
  );
}
