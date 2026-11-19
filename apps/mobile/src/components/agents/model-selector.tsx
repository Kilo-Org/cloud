/* eslint-disable max-lines -- The selector and picker row share model disclosure behavior. */
import { selectionHaptic } from '@/lib/haptics';
import { type Href } from 'expo-router';
import {
  BookOpenCheck,
  Brain,
  Check,
  ChevronDown,
  ImageIcon,
  Star,
  Wrench,
} from '@/components/ui/icons';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { Keyboard, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { i18n } from '@/i18n';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { SectionHeader } from '@/components/ui/section-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  CHIP_HIT_SLOP,
  COMPACT_CONTROL_BOX_CLASS,
  COMPACT_CONTROL_HIT_SLOP_DP,
  FIELD_TRIGGER_BODY_CLASS,
  FIELD_TRIGGER_FRAME_CLASS,
} from '@/lib/a11y/tap-target';
import { autoModelLabel } from '@/lib/auto-model-name';
import { formatList } from '@/lib/format';
import {
  BYOK_MODEL_LABEL,
  freeModelDataLabel,
  freeModelFreeLabel,
  modelNameStatesFree,
} from '@/lib/free-model-data-disclosure';
import { type ModelOption, thinkingEffortLabel } from '@/lib/hooks/use-available-models';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { type SinglePushRoute, useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { modelPickerCostLabel } from '@/lib/model-cost';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type ModelPickerSelection, type ModelPickerSelectionScope } from '@/lib/picker-bridge';
import { modelPickerSlot } from '@/lib/route-registry';
import { selectionCheckColor } from '@/lib/selection-check-color';
import { cn } from '@/lib/utils';

import { modelSelectorBadges } from './model-selector-badges';
import { resolveModelSelectorLabel } from './model-selector-label';

type ModelSelectorProps = {
  value: string;
  variant: string;
  options: (ModelOption | SessionModelOption)[];
  /** Whether this chip's `onSelect` stores the picked thinking effort. */
  acceptsVariant: boolean;
  onSelect: (modelId: string, variant: string, pickerSelection?: ModelPickerSelection) => void;
  /** Called as the chip opens the picker, so a caller can mark the field as visited. */
  onOpen?: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  /** Agent name that pins the model; when set with `disabled`, the chip is locked. */
  lockLabel?: string;
  /**
   * `chip` is the composer's inline pill, beside the mode chip. `field` is the
   * form's picker: a label above the 48pt select box, on the field-label
   * column the text fields use, for a form that lists its picks as fields.
   */
  presentation?: 'chip' | 'field';
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

/**
 * The selection check's own square, and therefore the width every row reserves
 * for it. The column and the glyph read the same number, so a row that gains a
 * check never moves the model name or the favourite control beside it.
 */
const CHECK_COLUMN_DP = 18;

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

export function openModelPicker(
  push: SinglePushRoute,
  params: {
    options: (ModelOption | SessionModelOption)[];
    value: string;
    variant: string;
    /** Whether the caller stores the picked thinking effort; see `ModelPickerBridge`. */
    acceptsVariant: boolean;
    onSelect: (modelId: string, variant: string, pickerSelection?: ModelPickerSelection) => void;
    selectionScope?: ModelPickerSelectionScopeContextValue;
  }
) {
  const {
    options,
    value,
    variant,
    acceptsVariant,
    onSelect,
    selectionScope = UNFENCED_SELECTION_CONTEXT,
  } = params;
  const routeKey = selectionScope.selectionScope.sessionId;
  modelPickerSlot.set(routeKey, {
    options: options.map(option => toSessionModelOption(option)),
    currentValue: value,
    currentVariant: variant,
    acceptsVariant,
    selectionScope: selectionScope.selectionScope,
    isSelectionCurrent: selectionScope.isSelectionCurrent,
    onSelect: selection => {
      onSelect(selection.option.id, selection.variant, selection);
    },
  });
  // The sheet anchors over the keyboard only at its first layout and never
  // re-anchors when the keyboard hides afterwards: opened while the composer
  // holds the IME up, it keeps the keyboard-height bottom inset and exposes a
  // strip of the screen behind it below the sheet. Dismiss the keyboard first
  // so the sheet anchors at the window bottom (e1 spot check).
  Keyboard.dismiss();
  push(`/(app)/agent-chat/model-picker?routeKey=${encodeURIComponent(routeKey)}` as Href);
}

export function ModelSelector({
  value,
  variant,
  options,
  acceptsVariant,
  onSelect,
  onOpen,
  disabled = false,
  isLoading = false,
  lockLabel,
  presentation = 'chip',
}: Readonly<ModelSelectorProps>) {
  const pushOnce = useSinglePushRoute();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const selectionContext = useContext(ModelPickerSelectionScopeContext);

  if (isLoading) {
    const loadingBar = (
      <View
        accessible
        accessibilityRole="button"
        accessibilityState={{ busy: true, disabled: true }}
        accessibilityLabel={t('common.model')}
        className={
          presentation === 'field'
            ? undefined
            : 'min-w-0 shrink flex-row items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5'
        }
      >
        {/* The bar stands in for the label line and takes that line's own box:
            `text-sm` sets one 17.5 dp line, which is the scale's `h-5`, so the
            pill is the height it will have once the model arrives. Its width is
            the nearest spacing step rather than the arriving label's measured
            width: that width belongs to the label, and a pinned bar would be a
            pixel value the contract does not allow. `bg-muted-soft` for the
            reason recorded on the repository loading row: the default
            `bg-skeleton-fill` equals this pill's `bg-secondary` in the light
            palette and would paint nothing. The wrapper keeps the busy label for
            assistive tech without a text node that reads as a resolved value. */}
        <Skeleton className="h-5 w-20 bg-muted-soft" />
        <View className="opacity-50">
          <ChevronDown size={presentation === 'field' ? 16 : 14} color={colors.mutedForeground} />
        </View>
      </View>
    );
    if (presentation === 'field') {
      return (
        <View className="gap-2">
          <FormFieldLabel label={t('common.model')} />
          <View className={FIELD_TRIGGER_FRAME_CLASS}>
            <View className={cn(FIELD_TRIGGER_BODY_CLASS, 'justify-between')}>{loadingBar}</View>
          </View>
        </View>
      );
    }
    return loadingBar;
  }

  const pickerOptions = options.map(option => toSessionModelOption(option));
  const selectedModel = pickerOptions.find(option => option.id === value);
  const providerAware = pickerOptions.some(
    option => option.modelRef !== undefined || !option.showGatewayMetadata
  );
  // A matched option can be one of Kilo's own Auto models, whose backend name no
  // catalog translates, so resolve its label first and let the helper fall back
  // to the short name (or the generic label) for a stored reference the catalog
  // does not carry.
  const label = resolveModelSelectorLabel({
    selectedName: selectedModel
      ? autoModelLabel(selectedModel.displayId, selectedModel.name)
      : undefined,
    value,
    providerAware,
    fallbackLabel: t('common.model'),
  });
  const { byok, collectsData } = modelSelectorBadges(selectedModel);
  const hasVariants = selectedModel ? selectedModel.variants.length > 1 : false;
  const variantLabel = variant ? thinkingEffortLabel(variant) : '';
  const chipParts = [
    label,
    collectsData ? freeModelDataLabel() : undefined,
    byok ? BYOK_MODEL_LABEL : undefined,
  ].filter((part): part is string => part !== undefined);
  const modelLabel = formatList(chipParts, i18n.language);
  const spokenModel =
    hasVariants && variantLabel
      ? t('agentChat.modelSelector.thinkingEffortWithModel', {
          model: modelLabel,
          variant: variantLabel,
        })
      : modelLabel;
  // The chip names one model, so it states that model's state. Every option
  // being unavailable is therefore not what decides the announcement.
  const selectedUnavailable = selectedModel?.unavailable === true;
  // An empty catalog has nothing to choose, so the chip stays disabled instead
  // of opening a sheet with no rows; an unavailable catalog keeps its press so
  // the picker can explain each model.
  const chipDisabled = disabled || pickerOptions.length === 0;
  const accessibilityLabel = [
    spokenModel,
    selectedUnavailable ? t('agentChat.modelSelector.unavailable') : undefined,
    lockLabel && disabled
      ? t('agentChat.modelSelector.lockedByAgent', { agent: lockLabel })
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(t('common.sentenceJoiner'));
  // A pinned variant is meaningful even when the locked option carries a single
  // variant, so surface the badge whenever a lock label is present.
  const showVariantBadge = variantLabel !== '' && (hasVariants || Boolean(lockLabel));

  function handlePress() {
    if (chipDisabled) {
      return;
    }
    onOpen?.();
    openModelPicker(pushOnce, {
      options: pickerOptions,
      value,
      variant,
      acceptsVariant,
      onSelect,
      selectionScope: selectionContext,
    });
  }

  const selectorBody = (
    <View className="min-w-0 shrink flex-row items-center gap-1.5">
      <Text className="shrink text-sm font-medium text-foreground" numberOfLines={1}>
        {label}
      </Text>
      {byok ? (
        <View className="rounded-full bg-neutral-200 px-1.5 py-0.5 dark:bg-neutral-700">
          <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
            {BYOK_MODEL_LABEL}
          </Text>
        </View>
      ) : null}
      {collectsData ? <BookOpenCheck size={12} color={colors.warn} /> : null}
      {showVariantBadge ? (
        <View className="flex-row items-center gap-1 rounded-full bg-neutral-200 px-1.5 py-0.5 dark:bg-neutral-800">
          <Brain size={12} color={colors.mutedForeground} />
          {/* The label is text, not the chip's chevron/icon, so it keeps
           * full theme contrast against the badge surface. The muted token
           * falls below 4.5:1 on `neutral-200`/`neutral-800`, which the
           * dim-only-chevron/icon rule does not cover (D2). */}
          <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
            {variantLabel}
          </Text>
        </View>
      ) : null}
    </View>
  );
  const pressableProps = {
    onPress: handlePress,
    disabled: chipDisabled,
    accessibilityRole: 'button' as const,
    accessibilityLabel,
    accessibilityState: { disabled: chipDisabled },
  };

  if (presentation === 'field') {
    // The form's picker: the label above the shared 48pt select box, the way
    // the text fields above it name their inputs. The pill belongs to the
    // composer, where it sits beside the mode chip; inside a field column it
    // read as a third control type (design review, 2026-11-18).
    return (
      <View className="gap-2">
        <FormFieldLabel label={t('common.model')} />
        <Pressable
          {...pressableProps}
          className={cn(FIELD_TRIGGER_FRAME_CLASS, !chipDisabled && 'active:opacity-70')}
        >
          <View className={cn(FIELD_TRIGGER_BODY_CLASS, 'justify-between')}>
            {selectorBody}
            <View className={cn(chipDisabled && 'opacity-50')}>
              <ChevronDown size={16} color={colors.mutedForeground} />
            </View>
          </View>
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable
      {...pressableProps}
      // The chip's own 27.81pt frame is the visual; the vertical slop carries
      // its touch region past the 44pt design target without growing the row.
      hitSlop={CHIP_HIT_SLOP}
      className="min-w-0 shrink flex-row items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 active:opacity-70"
    >
      {selectorBody}
      {/* The label stays at full theme contrast; a disabled chip dims only its
       * chevron so the pill text keeps the WCAG AA 4.5:1 ratio (D2). */}
      <View className={cn(chipDisabled && 'opacity-50')}>
        <ChevronDown size={14} color={colors.mutedForeground} />
      </View>
    </Pressable>
  );
}

export function ModelPickerOptionRow({
  option,
  selected,
  selectedVariant,
  acceptsVariant,
  isFavorite,
  showProvider,
  onSelectModel,
  onSelectVariant,
  onToggleFavorite,
}: Readonly<{
  option: SessionModelOption;
  selected: boolean;
  selectedVariant: string;
  /**
   * Whether the picker's caller keeps a picked effort. When it does not, the
   * row renders no effort chips: a chip here would close the sheet and drop the
   * choice, because the caller stores only the model id.
   */
  acceptsVariant: boolean;
  isFavorite: boolean;
  /**
   * Whether the row shows its provider line. The list turns it off inside a
   * provider section, whose header already names the provider; the row's
   * accessibility label keeps the name either way.
   */
  showProvider: boolean;
  onSelectModel: (option: SessionModelOption) => void;
  onSelectVariant: (variant: string) => void;
  onToggleFavorite: (option: SessionModelOption) => void;
}>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { free, byok, collectsData, tools, images } = modelSelectorBadges(option);
  const costLabel = modelPickerCostLabel(option);
  const name = autoModelLabel(option.displayId, option.name);
  // The name may already state the fact ("… (free)", "Auto Free" in every
  // locale), so the badge and its accessibility phrase only render when it
  // does not. The free Auto model is decided by id too: nine catalogs name it
  // with a free word the badge label does not contain.
  const showFreeBadge = free && !byok && !modelNameStatesFree(name, option.displayId);
  const accessibilityLabel = formatList(
    [
      option.provider?.name,
      name,
      option.displayId,
      byok ? BYOK_MODEL_LABEL : undefined,
      showFreeBadge ? freeModelFreeLabel() : undefined,
      collectsData ? freeModelDataLabel() : undefined,
      tools ? t('modelChat.backends.modelTools') : undefined,
      images ? t('modelChat.backends.modelImages') : undefined,
      costLabel ?? undefined,
      option.unavailable ? t('agentChat.modelSelector.unavailableState') : undefined,
      selected ? t('agentChat.modelSelector.selectedState') : undefined,
    ].filter(value => value !== undefined),
    i18n.language
  );

  // The row is a NON-accessible container with two sibling controls: the
  // main select (row content) and the favorite star. A pressable nested
  // inside a pressable would shadow the favorite for assistive technology,
  // so the two must never nest. The selected check is a static sibling to
  // the LEFT of the star, in a fixed-width column reserved in every row so
  // selecting a row never moves the row content or the star, and the star is
  // the row's last child with the constant pr-4 padding, so every row's star
  // shares one right-alignment column and the check can never sit right of
  // it.
  return (
    <View className="border-b-[0.5px] border-hair-soft">
      <View className="flex-row items-center gap-3 pr-4">
        <Pressable
          className="min-h-9 min-w-0 flex-1 flex-row items-center ps-4 py-3 active:bg-secondary"
          onPress={() => {
            onSelectModel(option);
          }}
          disabled={option.unavailable}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={{ disabled: option.unavailable, selected }}
        >
          <View className="min-w-0 flex-1">
            {/* The disabled cue is the name's muted token, not a row opacity:
             * the metadata below and the `unavailable` line stay readable,
             * which a row-level 50% opacity took below 4.5:1. */}
            <Text
              className={cn(
                'text-base',
                option.unavailable ? 'text-muted-foreground' : 'text-foreground'
              )}
            >
              {name}
            </Text>
            {option.modelRef && showProvider ? (
              <Text selectable className="font-mono text-xs text-muted-foreground">
                {t('agentChat.modelSelector.provider', { id: option.modelRef.providerID })}
              </Text>
            ) : null}
            {option.displayId ? (
              // The subtitle names a source, and a repository path can be long, so
              // it stays one line: a wrapped path would make one row taller than
              // its neighbours for a value the person reads at a glance.
              <Text
                selectable
                numberOfLines={1}
                ellipsizeMode="tail"
                className="font-mono text-xs text-muted-foreground"
              >
                {option.displayId}
              </Text>
            ) : null}
            {costLabel ? <Text className="text-xs text-muted-foreground">{costLabel}</Text> : null}
            {option.unavailable ? (
              <Text className="mt-1 text-xs text-muted-foreground">
                {t('agentChat.modelSelector.unavailable')}
              </Text>
            ) : null}
            {showFreeBadge || byok || collectsData || tools || images ? (
              // The badges state facts about the model, not an affordance, so
              // an unavailable row leaves their copy at full contrast: the
              // row's cue is its muted name and the `unavailable` line.
              <View className="mt-1 flex-row items-center gap-1 self-start">
                {showFreeBadge ? (
                  <View className="rounded-full bg-good px-2 py-0.5">
                    <Text className="text-xs font-medium text-good-foreground">
                      {freeModelFreeLabel()}
                    </Text>
                  </View>
                ) : null}
                {byok ? (
                  <View className="rounded-full bg-neutral-200 px-2 py-0.5 dark:bg-neutral-700">
                    <Text className="text-xs font-medium text-foreground">{BYOK_MODEL_LABEL}</Text>
                  </View>
                ) : null}
                {collectsData ? (
                  <BookOpenCheck
                    accessibilityLabel={freeModelDataLabel()}
                    size={13}
                    color={colors.warn}
                  />
                ) : null}
                {tools ? <Wrench size={13} color={colors.mutedForeground} /> : null}
                {images ? <ImageIcon size={13} color={colors.mutedForeground} /> : null}
              </View>
            ) : null}
          </View>
        </Pressable>
        <View className="items-center justify-center" style={{ width: CHECK_COLUMN_DP }}>
          {selected ? (
            <Check size={CHECK_COLUMN_DP} color={selectionCheckColor(colors, option.unavailable)} />
          ) : null}
        </View>
        <Pressable
          onPress={() => {
            selectionHaptic();
            onToggleFavorite(option);
          }}
          hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
          className={cn(COMPACT_CONTROL_BOX_CLASS, 'items-center justify-center')}
          accessibilityRole="button"
          accessibilityLabel={
            isFavorite
              ? t('agentChat.modelSelector.removeFromFavorites', { name })
              : t('agentChat.modelSelector.addToFavorites', { name })
          }
          accessibilityState={{ selected: isFavorite }}
        >
          <Star
            size={20}
            color={isFavorite ? colors.primary : colors.mutedForeground}
            fill={isFavorite ? colors.primary : 'transparent'}
          />
        </Pressable>
      </View>
      {acceptsVariant && selected && option.variants.length > 1 ? (
        <View className="px-4 pb-3">
          <SectionHeader label={t('agentChat.modelSelector.thinkingEffort')} />
          <View className="flex-row flex-wrap gap-2">
            {option.variants.map(thinkingVariant => {
              const active = thinkingVariant === selectedVariant;
              return (
                <Pressable
                  key={thinkingVariant}
                  hitSlop={CHIP_HIT_SLOP}
                  className={cn(
                    'items-center justify-center rounded-full px-4 py-1.5 active:opacity-70',
                    active ? 'bg-foreground' : 'bg-secondary'
                  )}
                  onPress={() => {
                    onSelectVariant(thinkingVariant);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: active }}
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
          </View>
        </View>
      ) : null}
    </View>
  );
}
