import { Pressable, View } from 'react-native';
import { type Href, useRouter } from 'expo-router';
import { Brain, ChevronDown } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { type ModelOption, thinkingEffortLabel } from '@/lib/hooks/use-available-models';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { setModelPickerBridge } from '@/lib/picker-bridge';
import { cn } from '@/lib/utils';

type ModelSelectorProps = {
  value: string;
  variant: string;
  options: ModelOption[];
  onSelect: (modelId: string, variant: string) => void;
  disabled?: boolean;
};

function compactThinkingEffortLabel(variant: string) {
  if (variant === 'xhigh') {
    return 'XH';
  }
  if (variant === 'medium') {
    return 'Med';
  }
  return thinkingEffortLabel(variant);
}

export function ModelSelector({
  value,
  variant,
  options,
  onSelect,
  disabled = false,
}: Readonly<ModelSelectorProps>) {
  const router = useRouter();
  const colors = useThemeColors();
  const effectivelyDisabled = disabled || options.length === 0;

  const selectedModel = options.find(m => m.id === value);
  const label = selectedModel?.name ?? (value || 'Model');
  const hasVariants = selectedModel ? selectedModel.variants.length > 1 : false;
  const variantLabel = variant ? thinkingEffortLabel(variant) : '';
  const compactVariantLabel = variant ? compactThinkingEffortLabel(variant) : '';

  function handlePress() {
    if (effectivelyDisabled) {
      return;
    }
    setModelPickerBridge({
      options,
      currentValue: value,
      currentVariant: variant,
      onSelect,
    });
    router.push('/(app)/agent-chat/model-picker' as Href);
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={effectivelyDisabled}
      accessibilityRole="button"
      accessibilityLabel={
        hasVariants && variantLabel ? `${label}, ${variantLabel} thinking effort` : label
      }
      className={cn(
        'max-w-[240px] shrink flex-row items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 active:opacity-70',
        effectivelyDisabled && 'opacity-50'
      )}
    >
      <View className="min-w-0 shrink flex-row items-center gap-1.5">
        <Text
          className="max-w-[170px] shrink text-sm font-medium text-foreground"
          numberOfLines={1}
        >
          {label}
        </Text>
        {hasVariants && compactVariantLabel ? (
          <View className="flex-row items-center gap-1 rounded-full bg-neutral-200 px-1.5 py-0.5 dark:bg-neutral-800">
            <Brain size={12} color={colors.mutedForeground} />
            <Text className="text-xs font-medium text-muted-foreground" numberOfLines={1}>
              {compactVariantLabel}
            </Text>
          </View>
        ) : null}
      </View>
      <ChevronDown size={14} color={colors.mutedForeground} />
    </Pressable>
  );
}
