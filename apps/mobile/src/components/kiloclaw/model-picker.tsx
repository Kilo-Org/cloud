import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { CheckCircle2, type LucideIcon, Scale, Zap } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useKiloClawConfig, useKiloClawMutations } from '@/lib/hooks/use-kiloclaw';
import { addModelPrefix, stripModelPrefix } from '@/lib/model-id';

type AutoModelCard = {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  iconBg: string;
  iconColor: string;
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
    iconBg: 'bg-purple-500/20',
    iconColor: '#a855f7',
    cost: 3,
    performance: 3,
    performanceDotColor: 'bg-purple-400',
  },
  {
    id: 'kilo-auto/balanced',
    label: 'Balanced',
    description: 'Smart balance of speed and capability at lower cost.',
    icon: Scale,
    iconBg: 'bg-blue-500/20',
    iconColor: '#3b82f6',
    cost: 2,
    performance: 2,
    performanceDotColor: 'bg-blue-400',
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
  const { data: config, isLoading } = useKiloClawConfig();
  const mutations = useKiloClawMutations();

  const currentModel = stripModelPrefix(config?.kilocodeDefaultModel);
  const isAutoModel = AUTO_MODEL_IDS.has(currentModel);

  const handleSelectAutoModel = (modelId: string) => {
    if (currentModel === modelId) {
      return;
    }
    mutations.updateModel.mutate({ kilocodeDefaultModel: addModelPrefix(modelId) });
  };

  if (isLoading) {
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
              className={`relative gap-3 rounded-lg border p-4 ${selected ? 'border-blue-500 bg-blue-500/5' : 'border-border bg-secondary'}`}
              disabled={mutations.updateModel.isPending}
              onPress={() => {
                handleSelectAutoModel(card.id);
              }}
            >
              {selected && (
                <View className="absolute right-3 top-3">
                  <CheckCircle2 size={20} color="#3b82f6" />
                </View>
              )}
              <View className={`h-9 w-9 items-center justify-center rounded-lg ${card.iconBg}`}>
                <Icon size={20} color={card.iconColor} />
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
        className="items-center py-2 active:opacity-70"
        onPress={() => {
          router.push(`/(app)/(tabs)/(1_kiloclaw)/${instanceId}/settings/model-list` as Href);
        }}
      >
        <Text className="text-sm text-muted-foreground">or select from 500+ models</Text>
      </Pressable>
    </View>
  );
}
