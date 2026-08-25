/* eslint-disable max-lines -- The selector and picker row share model disclosure behavior. */
import * as Haptics from 'expo-haptics';
import { type Href, type ImperativeRouter, useRouter } from 'expo-router';
import { BookOpenCheck, Brain, Check, ChevronDown, Star } from '@/components/ui/icons';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { i18n } from '@/i18n';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  BYOK_MODEL_LABEL,
  freeModelDataLabel,
  freeModelFreeLabel,
  getFreeModelDataAccessibilityLabel,
} from '@/lib/free-model-data-disclosure';
import { type ModelOption, thinkingEffortLabel } from '@/lib/hooks/use-available-models';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { modelPickerCostLabel } from '@/lib/model-cost';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type ModelPickerSelection, type ModelPickerSelectionScope } from '@/lib/picker-bridge';
import { modelPickerSlot } from '@/lib/route-registry';
import { cn } from '@/lib/utils';

import { modelSelectorBadges } from './model-selector-badges';

type ModelSelectorProps = {
  value: string;
  variant: string;
  options: (ModelOption | SessionModelOption)[];
  onSelect: (modelId: string, variant: string, pickerSelection?: ModelPickerSelection) => void;
  disabled?: boolean;
  isLoading?: boolean;
  /** Agent name that pins the model; when set with `disabled`, the chip is locked. */
  lockLabel?: string;
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
  if ('displayId' in option && 'showGatewayMetadata' in option) {
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
    return i18n.t('agentChat.modelSelector.thinkingEffortXhigh');
  }
  if (variant === 'medium') {
    return i18n.t('agentChat.modelSelector.thinkingEffortMedium');
  }
  return thinkingEffortLabel(variant);
}

export function openModelPicker(
  router: ImperativeRouter,
  params: {
    options: (ModelOption | SessionModelOption)[];
    value: string;
    variant: string;
    onSelect: (modelId: string, variant: string, pickerSelection?: ModelPickerSelection) => void;
    selectionScope?: ModelPickerSelectionScopeContextValue;
  }
) {
  const { options, value, variant, onSelect, selectionScope = UNFENCED_SELECTION_CONTEXT } = params;
  const routeKey = selectionScope.selectionScope.sessionId;
  modelPickerSlot.set(routeKey, {
    options: options.map(option => toSessionModelOption(option)),
    currentValue: value,
    currentVariant: variant,
    selectionScope: selectionScope.selectionScope,
    isSelectionCurrent: selectionScope.isSelectionCurrent,
    onSelect: selection => {
      onSelect(selection.option.id, selection.variant, selection);
    },
  });
  router.push(`/(app)/agent-chat/model-picker?routeKey=${encodeURIComponent(routeKey)}` as Href);
}

export function ModelSelector({
  value,
  variant,
  options,
  onSelect,
  disabled = false,
  isLoading = false,
  lockLabel,
}: Readonly<ModelSelectorProps>) {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const selectionContext = useContext(ModelPickerSelectionScopeContext);

  if (isLoading) {
    return <Skeleton className="h-8 w-28 rounded-full" />;
  }

  const pickerOptions = options.map(option => toSessionModelOption(option));
  const effectivelyDisabled = disabled || pickerOptions.every(option => option.unavailable);
  const selectedModel = pickerOptions.find(option => option.id === value);
  const providerAware = pickerOptions.some(
    option => option.modelRef !== undefined || !option.showGatewayMetadata
  );
  const label =
    selectedModel?.name ?? (!providerAware && value ? value : t('agentChat.modelSelector.model'));
  const { byok, collectsData } = modelSelectorBadges(selectedModel);
  const hasVariants = selectedModel ? selectedModel.variants.length > 1 : false;
  const variantLabel = variant ? thinkingEffortLabel(variant) : '';
  const compactVariantLabel = variant ? compactThinkingEffortLabel(variant) : '';
  const dataLabel = collectsData ? getFreeModelDataAccessibilityLabel(label) : label;
  const modelLabel = byok ? `${dataLabel}, ${BYOK_MODEL_LABEL}` : dataLabel;
  const accessibilityLabel =
    (hasVariants && variantLabel
      ? t('agentChat.modelSelector.thinkingEffortWithModel', {
          model: modelLabel,
          variant: variantLabel,
        })
      : modelLabel) +
    (lockLabel && disabled ? t('agentChat.modelSelector.lockedByAgent', { agent: lockLabel }) : '');
  // A pinned variant is meaningful even when the locked option carries a single
  // variant, so surface the badge whenever a lock label is present.
  const showVariantBadge = compactVariantLabel !== '' && (hasVariants || Boolean(lockLabel));

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
      accessibilityState={{ disabled: effectivelyDisabled }}
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
        {showVariantBadge ? (
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
  const { t } = useTranslation();
  const { free, byok, collectsData } = modelSelectorBadges(option);
  const costLabel = modelPickerCostLabel(option);
  const accessibilityLabel = [
    option.provider?.name,
    option.name,
    option.displayId,
    byok ? BYOK_MODEL_LABEL : undefined,
    free && !byok ? freeModelFreeLabel() : undefined,
    collectsData ? freeModelDataLabel() : undefined,
    costLabel ?? undefined,
    option.unavailable ? t('agentChat.modelSelector.unavailableState') : undefined,
    selected ? t('agentChat.modelSelector.selectedState') : undefined,
  ]
    .filter(Boolean)
    .join(', ');

  // The row is a NON-accessible container with two sibling controls: the
  // main select (row content) and the favorite star. A pressable nested
  // inside a pressable would shadow the favorite for assistive technology,
  // so the two must never nest. The selected check stays a static sibling
  // to preserve the exact visual order (content, star, check).
  return (
    <View className="border-b border-border">
      <View className={cn('flex-row items-center gap-3 pr-4', option.unavailable && 'opacity-50')}>
        <Pressable
          className="min-h-9 flex-1 flex-row items-center py-3 pl-4 active:bg-secondary"
          onPress={() => {
            onSelectModel(option);
          }}
          disabled={option.unavailable}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={{ disabled: option.unavailable, selected }}
        >
          <View className="flex-1">
            <Text className="text-base text-foreground">{option.name}</Text>
            {option.modelRef ? (
              <Text selectable className="font-mono text-xs text-muted-foreground">
                {t('agentChat.modelSelector.provider', { id: option.modelRef.providerID })}
              </Text>
            ) : null}
            {option.displayId ? (
              <Text selectable className="font-mono text-xs text-muted-foreground">
                {option.modelRef
                  ? t('agentChat.modelSelector.modelId', { id: option.displayId })
                  : option.displayId}
              </Text>
            ) : null}
            {costLabel ? <Text className="text-xs text-muted-foreground">{costLabel}</Text> : null}
            {option.unavailable ? (
              <Text className="mt-1 text-xs text-muted-foreground">
                {t('agentChat.modelSelector.unavailable')}
              </Text>
            ) : null}
            {free || byok || collectsData ? (
              <View className="mt-1 flex-row items-center gap-1 self-start">
                {free && !byok ? (
                  <View className="rounded-full bg-good px-2 py-0.5">
                    <Text className="text-[11px] font-medium text-good-foreground">
                      {freeModelFreeLabel()}
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
                    accessibilityLabel={freeModelDataLabel()}
                    size={13}
                    color={colors.warn}
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        </Pressable>
        <Pressable
          onPress={() => {
            void Haptics.selectionAsync();
            onToggleFavorite(option);
          }}
          hitSlop={12}
          className="min-h-[44px] min-w-[44px] items-center justify-center"
          accessibilityRole="button"
          accessibilityLabel={
            isFavorite
              ? t('agentChat.modelSelector.removeFromFavorites', { name: option.name })
              : t('agentChat.modelSelector.addToFavorites', { name: option.name })
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
      </View>
      {selected && option.variants.length > 1 ? (
        <View className="px-4 pb-3">
          <Text className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t('agentChat.modelSelector.thinkingEffort')}
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
                  accessibilityLabel={
                    active
                      ? t('agentChat.modelSelector.thinkingEffortSelected', {
                          label: thinkingEffortLabel(thinkingVariant),
                        })
                      : t('agentChat.modelSelector.thinkingEffortAccessibility', {
                          label: thinkingEffortLabel(thinkingVariant),
                        })
                  }
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
