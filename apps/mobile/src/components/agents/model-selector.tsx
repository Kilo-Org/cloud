/* eslint-disable max-lines -- The selector and picker row share model disclosure behavior. */
import * as Haptics from 'expo-haptics';
import { type Href, type Router, useRouter } from 'expo-router';
import { BookOpenCheck, Brain, Check, ChevronDown, Star } from 'lucide-react-native';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Text } from '@/components/ui/text';
import {
  BYOK_MODEL_LABEL,
  FREE_MODEL_DATA_LABEL,
  FREE_MODEL_FREE_LABEL,
  getFreeModelDataAccessibilityLabel,
  hasUserByokAvailable,
  isFreeModelOption,
  mayTrainOnYourPrompts,
} from '@/lib/free-model-data-disclosure';
import { type ModelOption, thinkingEffortLabel } from '@/lib/hooks/use-available-models';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  type ModelPickerSelection,
  type ModelPickerSelectionScope,
  setModelPickerBridge,
} from '@/lib/picker-bridge';
import { cn } from '@/lib/utils';

type ModelSelectorProps = {
  value: string;
  variant: string;
  options: (ModelOption | SessionModelOption)[];
  onSelect: (modelId: string, variant: string, pickerSelection?: ModelPickerSelection) => void;
  disabled?: boolean;
};

type ModelPickerSelectionScopeContextValue = {
  selectionScope: ModelPickerSelectionScope;
  isSelectionCurrent: (scope: ModelPickerSelectionScope) => boolean;
};

const UNFENCED_SELECTION_CONTEXT: ModelPickerSelectionScopeContextValue = {
  selectionScope: {
    sessionId: 'unscoped',
    ownerConnectionId: null,
    protocol: 'unknown',
    catalogGenerationIdentity: null,
  },
  isSelectionCurrent: () => true,
};

const ModelPickerSelectionScopeContext = createContext(UNFENCED_SELECTION_CONTEXT);

export function ModelPickerSelectionScopeProvider({
  children,
  selectionScope,
  isSelectionCurrent,
}: Readonly<ModelPickerSelectionScopeContextValue & { children: ReactNode }>) {
  const contextValue = useMemo(
    () => ({ selectionScope, isSelectionCurrent }),
    [isSelectionCurrent, selectionScope]
  );

  return (
    <ModelPickerSelectionScopeContext.Provider value={contextValue}>
      {children}
    </ModelPickerSelectionScopeContext.Provider>
  );
}

function toSessionModelOption(option: ModelOption | SessionModelOption): SessionModelOption {
  if (
    'displayId' in option &&
    typeof option.displayId === 'string' &&
    'showGatewayMetadata' in option &&
    typeof option.showGatewayMetadata === 'boolean'
  ) {
    return {
      ...option,
      displayId: option.displayId,
      showGatewayMetadata: option.showGatewayMetadata,
    };
  }

  return { ...option, displayId: option.id, showGatewayMetadata: true };
}

function compactThinkingEffortLabel(variant: string) {
  if (variant === 'xhigh') {
    return 'XH';
  }
  if (variant === 'medium') {
    return 'Med';
  }
  return thinkingEffortLabel(variant);
}

export function openModelPicker(
  router: Router,
  params: {
    options: (ModelOption | SessionModelOption)[];
    value: string;
    variant: string;
    onSelect: (modelId: string, variant: string, pickerSelection?: ModelPickerSelection) => void;
    selectionScope?: ModelPickerSelectionScopeContextValue;
  }
) {
  const { options, value, variant, onSelect, selectionScope = UNFENCED_SELECTION_CONTEXT } = params;
  setModelPickerBridge({
    options: options.map(option => toSessionModelOption(option)),
    currentValue: value,
    currentVariant: variant,
    selectionScope: selectionScope.selectionScope,
    isSelectionCurrent: selectionScope.isSelectionCurrent,
    onSelect: selection => {
      onSelect(selection.option.id, selection.variant, selection);
    },
  });
  router.push('/(app)/agent-chat/model-picker' as Href);
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
  const selectionContext = useContext(ModelPickerSelectionScopeContext);
  const pickerOptions = options.map(option => toSessionModelOption(option));
  const effectivelyDisabled = disabled || pickerOptions.every(option => option.unavailable);
  const selectedModel = pickerOptions.find(option => option.id === value);
  const providerAware = pickerOptions.some(
    option => option.modelRef !== undefined || !option.showGatewayMetadata
  );
  const showGatewayMetadata = selectedModel?.showGatewayMetadata ?? false;
  const label = selectedModel?.name ?? (!providerAware && value ? value : 'Model');
  const byok = showGatewayMetadata && hasUserByokAvailable(selectedModel);
  const collectsData = showGatewayMetadata && mayTrainOnYourPrompts(selectedModel);
  const hasVariants = selectedModel ? selectedModel.variants.length > 1 : false;
  const variantLabel = variant ? thinkingEffortLabel(variant) : '';
  const compactVariantLabel = variant ? compactThinkingEffortLabel(variant) : '';
  const dataLabel = collectsData ? getFreeModelDataAccessibilityLabel(label) : label;
  const modelLabel = byok ? `${dataLabel}, ${BYOK_MODEL_LABEL}` : dataLabel;
  const accessibilityLabel =
    hasVariants && variantLabel ? `${modelLabel}, ${variantLabel} thinking effort` : modelLabel;

  function handlePress() {
    if (effectivelyDisabled) {
      return;
    }
    openModelPicker(router, {
      options: pickerOptions,
      value,
      variant,
      onSelect,
      selectionScope: selectionContext,
    });
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={effectivelyDisabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
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
        {byok ? (
          <View className="rounded-full bg-neutral-200 px-1.5 py-0.5 dark:bg-neutral-700">
            <Text className="text-[10px] font-medium text-foreground" numberOfLines={1}>
              {BYOK_MODEL_LABEL}
            </Text>
          </View>
        ) : null}
        {collectsData ? <BookOpenCheck size={12} color={colors.warn} /> : null}
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

export function ModelPickerOptionRow({
  option,
  selected,
  selectedVariant,
  isFavorite,
  onSelectModel,
  onSelectVariant,
  onToggleFavorite,
}: Readonly<{
  option: SessionModelOption;
  selected: boolean;
  selectedVariant: string;
  isFavorite: boolean;
  onSelectModel: (option: SessionModelOption) => void;
  onSelectVariant: (variant: string) => void;
  onToggleFavorite: (option: SessionModelOption) => void;
}>) {
  const colors = useThemeColors();
  const free = option.showGatewayMetadata && isFreeModelOption(option);
  const byok = option.showGatewayMetadata && hasUserByokAvailable(option);
  const collectsData = option.showGatewayMetadata && mayTrainOnYourPrompts(option);
  const accessibilityLabel = [
    option.provider?.name,
    option.name,
    option.displayId,
    byok ? BYOK_MODEL_LABEL : undefined,
    free && !byok ? FREE_MODEL_FREE_LABEL : undefined,
    collectsData ? FREE_MODEL_DATA_LABEL : undefined,
    option.unavailable ? 'unavailable' : undefined,
    selected ? 'selected' : undefined,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <View className="border-b border-border">
      <Pressable
        className={cn(
          'flex-row items-center gap-3 px-4 py-3 active:bg-secondary',
          option.unavailable && 'opacity-50'
        )}
        onPress={() => {
          onSelectModel(option);
        }}
        disabled={option.unavailable}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
      >
        <View className="flex-1">
          <Text className="text-base text-foreground">{option.name}</Text>
          {option.modelRef ? (
            <Text selectable className="font-mono text-xs text-muted-foreground">
              Provider {option.modelRef.providerID}
            </Text>
          ) : null}
          {option.displayId ? (
            <Text selectable className="font-mono text-xs text-muted-foreground">
              {option.modelRef ? `Model ${option.displayId}` : option.displayId}
            </Text>
          ) : null}
          {option.unavailable ? (
            <Text className="mt-1 text-xs text-muted-foreground">Unavailable</Text>
          ) : null}
          {free || byok || collectsData ? (
            <View className="mt-1 flex-row items-center gap-1 self-start">
              {free && !byok ? (
                <View className="rounded-full bg-good px-2 py-0.5">
                  <Text className="text-[11px] font-medium text-good-foreground">
                    {FREE_MODEL_FREE_LABEL}
                  </Text>
                </View>
              ) : null}
              {byok ? (
                <View className="rounded-full bg-neutral-200 px-2 py-0.5 dark:bg-neutral-700">
                  <Text className="text-[11px] font-medium text-foreground">
                    {BYOK_MODEL_LABEL}
                  </Text>
                </View>
              ) : null}
              {collectsData ? (
                <BookOpenCheck
                  accessibilityLabel={FREE_MODEL_DATA_LABEL}
                  size={13}
                  color={colors.warn}
                />
              ) : null}
            </View>
          ) : null}
        </View>
        <Pressable
          onPress={() => {
            void Haptics.selectionAsync();
            onToggleFavorite(option);
          }}
          hitSlop={12}
          className="min-h-[44px] min-w-[44px] items-center justify-center"
          accessibilityRole="button"
          accessibilityLabel={
            isFavorite ? `Remove ${option.name} from favorites` : `Add ${option.name} to favorites`
          }
          accessibilityState={{ selected: isFavorite }}
        >
          <Star
            size={20}
            color={isFavorite ? colors.primary : colors.mutedForeground}
            fill={isFavorite ? colors.primary : 'transparent'}
          />
        </Pressable>
        {selected ? <Check size={18} color={colors.primary} /> : null}
      </Pressable>
      {selected && option.variants.length > 1 ? (
        <View className="px-4 pb-3">
          <Text className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Thinking effort
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2"
            keyboardShouldPersistTaps="handled"
          >
            {option.variants.map(thinkingVariant => {
              const active = thinkingVariant === selectedVariant;
              return (
                <Pressable
                  key={thinkingVariant}
                  className={cn(
                    'rounded-full px-3 py-1.5 active:opacity-70',
                    active ? 'bg-foreground' : 'bg-secondary'
                  )}
                  onPress={() => {
                    onSelectVariant(thinkingVariant);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`${thinkingEffortLabel(thinkingVariant)} thinking effort${active ? ', selected' : ''}`}
                >
                  <Text
                    className={cn(
                      'text-sm font-medium',
                      active ? 'text-background' : 'text-foreground'
                    )}
                  >
                    {thinkingEffortLabel(thinkingVariant)}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
