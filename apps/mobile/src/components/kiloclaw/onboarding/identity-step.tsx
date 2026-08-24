/* eslint-disable max-lines */
import * as Sentry from '@sentry/react-native';
import { useMutation } from '@tanstack/react-query';
import * as Location from 'expo-location';
import { ChevronDown, ChevronUp, MapPin } from '@/components/ui/icons';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Pressable, ScrollView, TextInput, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { BotAvatar } from '@/components/kiloclaw/bot-avatar';
import { botAvatarName } from '@/components/kiloclaw/bot-avatar-options';
import { agentColor } from '@/lib/agent-color';
import { useTRPC } from '@/lib/trpc';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

import { type BotIdentity, DEFAULT_BOT_IDENTITY } from './state';

type NaturePreset = {
  id: string;
  emoji: string;
  /** Persisted English value stored as botNature; never rendered directly. */
  label: string;
  /** i18n key rendered in the UI. */
  labelKey: string;
  /** Persisted English value stored as botVibe; never rendered directly. */
  vibe: string;
  /** i18n key rendered in the UI. */
  vibeKey: string;
};

const DEFAULT_NATURE = {
  id: 'ai-assistant',
  emoji: '🤖',
  label: 'AI assistant',
  labelKey: 'kiloclaw.onboarding.identity.nature.aiAssistantLabel',
  vibe: 'Helpful, capable, professional',
  vibeKey: 'kiloclaw.onboarding.identity.nature.aiAssistantVibe',
} as const satisfies NaturePreset;

const NATURE_PRESETS = [
  DEFAULT_NATURE,
  {
    id: 'digital-creature',
    emoji: '🐙',
    label: 'Digital creature',
    labelKey: 'kiloclaw.onboarding.identity.nature.digitalCreatureLabel',
    vibe: 'Quirky, alive, a bit unpredictable',
    vibeKey: 'kiloclaw.onboarding.identity.nature.digitalCreatureVibe',
  },
  {
    id: 'virtual-companion',
    emoji: '🌙',
    label: 'Virtual companion',
    labelKey: 'kiloclaw.onboarding.identity.nature.virtualCompanionLabel',
    vibe: 'Warm, present, genuinely cares',
    vibeKey: 'kiloclaw.onboarding.identity.nature.virtualCompanionVibe',
  },
  {
    id: 'something-weirder',
    emoji: '🌀',
    label: 'Something weirder…',
    labelKey: 'kiloclaw.onboarding.identity.nature.somethingWeirderLabel',
    vibe: 'Define it yourself',
    vibeKey: 'kiloclaw.onboarding.identity.nature.somethingWeirderVibe',
  },
] as const satisfies readonly NaturePreset[];

const EMOJI_OPTIONS = ['🤖', '👾', '🧠', '⚡', '🔮', '🔥', '🐉', '✨', '🌙'];

type IdentityStepProps = {
  onContinue: (identity: BotIdentity, weatherLocation: string | null) => void;
  initialIdentity?: BotIdentity | null;
  initialWeatherLocation?: string | null;
};

const GPS_TIMEOUT_MS = 10_000;
const GPS_COORDINATE_PRECISION = 2;

function locationFeedbackClassName(status: 'validated' | 'service_unavailable' | 'error'): string {
  if (status === 'error') {
    return 'text-destructive';
  }
  if (status === 'service_unavailable') {
    return 'text-warn';
  }
  return 'text-muted-foreground';
}

async function getCurrentPositionWithTimeout(): Promise<Location.LocationObject> {
  let triggerTimeout: (() => void) | null = null;
  const timeoutPromise = new Promise<Location.LocationObject>((_resolve, reject) => {
    triggerTimeout = () => {
      reject(new Error('timeout'));
    };
  });
  const timeoutId = setTimeout(() => {
    triggerTimeout?.();
  }, GPS_TIMEOUT_MS);
  try {
    return await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Lowest }),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function IdentityStep({
  onContinue,
  initialIdentity,
  initialWeatherLocation,
}: Readonly<IdentityStepProps>) {
  const colors = useThemeColors();
  const trpc = useTRPC();
  const { t } = useTranslation();
  const initialName = initialIdentity?.botName ?? '';
  const initialEmoji = initialIdentity?.botEmoji ?? DEFAULT_BOT_IDENTITY.botEmoji;
  const initialNatureId = initialIdentity
    ? (NATURE_PRESETS.find(n => n.label === initialIdentity.botNature)?.id ?? DEFAULT_NATURE.id)
    : DEFAULT_NATURE.id;
  const initialLocation = initialWeatherLocation ?? '';

  const nameRef = useRef<string>(initialName);
  const [selectedEmoji, setSelectedEmoji] = useState<string>(initialEmoji);
  const [selectedNatureId, setSelectedNatureId] = useState<string>(initialNatureId);
  const [avatarExpanded, setAvatarExpanded] = useState(false);
  const [personalityExpanded, setPersonalityExpanded] = useState(false);

  // Location — ref-based value per iOS TextInput rule; key+defaultValue trick for GPS pre-fill.
  const locationTextRef = useRef<string>(initialLocation);
  const [locationInputKey, setLocationInputKey] = useState(0);
  const [locationDefaultValue, setLocationDefaultValue] = useState(initialLocation);
  const [isGpsLoading, setIsGpsLoading] = useState(false);
  const [locationFeedback, setLocationFeedback] = useState<{
    message: string;
    status: 'validated' | 'service_unavailable' | 'error';
  } | null>(null);
  const [validatedLocation, setValidatedLocation] = useState<string | null>(null);

  const validateLocation = useMutation(trpc.kiloclaw.validateWeatherLocation.mutationOptions({}));
  const validateLocationAsync = validateLocation.mutateAsync;
  const validateLocationMutate = validateLocation.mutate;

  const nature = NATURE_PRESETS.find(n => n.id === selectedNatureId) ?? DEFAULT_NATURE;
  const selectedTint = agentColor(selectedEmoji);

  const applyLocationText = useCallback((value: string) => {
    locationTextRef.current = value;
    setLocationDefaultValue(value);
    setLocationInputKey(k => k + 1);
  }, []);

  const handleLocationBlur = useCallback(async () => {
    const trimmed = locationTextRef.current.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed === validatedLocation) {
      return;
    }
    if (isGpsLoading || validateLocation.isPending) {
      return;
    }

    try {
      const result = await validateLocationAsync({ location: trimmed });
      // Guard against stale responses: user may have kept typing after blur.
      if (locationTextRef.current.trim() !== trimmed) {
        return;
      }
      applyLocationText(result.location);
      setLocationFeedback({ message: result.currentWeatherText, status: result.status });
      setValidatedLocation(result.location);
    } catch (error) {
      if (locationTextRef.current.trim() !== trimmed) {
        return;
      }
      setValidatedLocation(null);
      const message =
        error instanceof Error
          ? error.message
          : t('kiloclaw.onboarding.identity.locationValidationFailed');
      setLocationFeedback({ message, status: 'error' });
    }
  }, [
    applyLocationText,
    isGpsLoading,
    validateLocation.isPending,
    validateLocationAsync,
    validatedLocation,
    t,
  ]);

  const handleGpsPress = useCallback(async () => {
    setIsGpsLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== Location.PermissionStatus.GRANTED) {
        Alert.alert(
          t('kiloclaw.onboarding.identity.locationDeniedTitle'),
          t('kiloclaw.onboarding.identity.locationDeniedMessage')
        );
        return;
      }
      const pos = await getCurrentPositionWithTimeout();
      const latitude = pos.coords.latitude.toFixed(GPS_COORDINATE_PRECISION);
      const longitude = pos.coords.longitude.toFixed(GPS_COORDINATE_PRECISION);
      const coords = `${latitude},${longitude}`;

      try {
        const result = await validateLocationAsync({ location: coords });
        applyLocationText(result.location);
        setLocationFeedback({ message: result.currentWeatherText, status: result.status });
        setValidatedLocation(result.location);
      } catch (validateError) {
        Sentry.captureException(validateError, {
          tags: {
            'error.subsystem': 'kiloclaw-onboarding',
            'error.operation': 'validate-gps-location',
          },
          extra: { coordinatePrecision: GPS_COORDINATE_PRECISION },
        });
        applyLocationText(coords);
        setValidatedLocation(null);
        setLocationFeedback({
          message: t('kiloclaw.onboarding.identity.locationResolveFailed'),
          status: 'error',
        });
      }
    } catch {
      // Expected user-environment outcomes (GPS timeout, location services off,
      // permission failure). The user is told via locationFeedback below, and
      // there is nothing a developer could act on, so nothing is reported.
      setLocationFeedback({
        message: t('kiloclaw.onboarding.identity.locationGetFailed'),
        status: 'error',
      });
    } finally {
      setIsGpsLoading(false);
    }
  }, [applyLocationText, validateLocationAsync, t]);

  const handleContinue = useCallback(() => {
    const trimmedName = nameRef.current.trim();
    const identity: BotIdentity = {
      botName: trimmedName.length > 0 ? trimmedName : DEFAULT_BOT_IDENTITY.botName,
      botEmoji: selectedEmoji,
      botNature: nature.label,
      botVibe: nature.vibe,
    };

    const trimmedLocation = locationTextRef.current.trim();
    if (!trimmedLocation) {
      onContinue(identity, null);
      return;
    }

    if (trimmedLocation === validatedLocation) {
      onContinue(identity, trimmedLocation);
      return;
    }

    validateLocationMutate(
      { location: trimmedLocation },
      {
        // Advancing to the next step unmounts this screen either way, so
        // there's no inline slot left to show feedback in — same as the
        // onError path below, just continue silently.
        onSuccess: result => {
          onContinue(identity, result.location);
        },
        onError: () => {
          // Don't block the user if validation fails; pass the entered text.
          onContinue(identity, trimmedLocation);
        },
      }
    );
  }, [nature, onContinue, selectedEmoji, validateLocationMutate, validatedLocation]);

  const isValidating = validateLocation.isPending;

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="p-4 gap-6"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
      <Animated.View layout={LinearTransition} className="gap-3">
        <View className="flex-row items-center gap-3">
          <Pressable
            accessibilityLabel={t('kiloclaw.onboarding.identity.chooseAvatar')}
            accessibilityRole="button"
            onPress={() => {
              setAvatarExpanded(v => !v);
            }}
            className={cn(
              'h-14 w-14 items-center justify-center rounded-[14px] border active:opacity-70',
              selectedTint.tileBgClass,
              avatarExpanded ? 'border-primary' : selectedTint.tileBorderClass
            )}
          >
            <BotAvatar emoji={selectedEmoji} size={24} color={colors.foreground} />
          </Pressable>
          <TextInput
            className="h-14 flex-1 rounded-xl border border-input bg-background px-3 text-base leading-[normal] text-foreground"
            placeholder={t('kiloclaw.onboarding.identity.namePlaceholder')}
            placeholderTextColor={colors.mutedForeground}
            defaultValue={initialName}
            onChangeText={value => {
              nameRef.current = value;
            }}
            autoCapitalize="words"
            autoCorrect={false}
            spellCheck={false}
            maxLength={80}
            returnKeyType="done"
          />
        </View>

        {avatarExpanded && (
          <View className="flex-row flex-wrap gap-3">
            {EMOJI_OPTIONS.map(emoji => {
              const tint = agentColor(emoji);
              const isSelected = selectedEmoji === emoji;
              return (
                <Pressable
                  key={emoji}
                  accessibilityLabel={t('kiloclaw.onboarding.identity.selectAvatar', {
                    name: botAvatarName(emoji),
                  })}
                  accessibilityRole="button"
                  onPress={() => {
                    setSelectedEmoji(emoji);
                    setAvatarExpanded(false);
                  }}
                  className={cn(
                    'h-14 w-14 items-center justify-center rounded-[14px] border active:opacity-70',
                    tint.tileBgClass,
                    isSelected ? 'border-primary' : tint.tileBorderClass
                  )}
                >
                  <BotAvatar emoji={emoji} size={24} color={colors.foreground} />
                </Pressable>
              );
            })}
          </View>
        )}
      </Animated.View>

      <Animated.View layout={LinearTransition} className="gap-2">
        <Text variant="eyebrow" className="text-xs">
          {t('kiloclaw.onboarding.identity.personality')}
        </Text>
        {personalityExpanded ? (
          <View className="gap-2">
            {NATURE_PRESETS.map(preset => (
              <Pressable
                key={preset.id}
                accessibilityRole="button"
                accessibilityState={{ selected: selectedNatureId === preset.id }}
                onPress={() => {
                  setSelectedNatureId(preset.id);
                  setPersonalityExpanded(false);
                }}
                className={cn(
                  'flex-row items-center gap-3 rounded-xl border px-3 py-3',
                  selectedNatureId === preset.id
                    ? 'border-primary bg-neutral-200 dark:bg-neutral-800'
                    : 'border-transparent bg-secondary active:opacity-70'
                )}
              >
                <BotAvatar emoji={preset.emoji} size={24} color={colors.foreground} />
                <View className="flex-1 gap-0.5">
                  <Text className="text-base font-medium">{t(preset.labelKey)}</Text>
                  <Text className="text-sm text-muted-foreground">{t(preset.vibeKey)}</Text>
                </View>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setPersonalityExpanded(false);
              }}
              className="items-center py-1 active:opacity-70"
            >
              <ChevronUp size={18} color={colors.mutedForeground} />
            </Pressable>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('kiloclaw.onboarding.identity.changePersonality')}
            onPress={() => {
              setPersonalityExpanded(true);
            }}
            className="flex-row items-center gap-3 rounded-xl bg-secondary px-3 py-3 active:opacity-70"
          >
            <BotAvatar emoji={nature.emoji} size={24} color={colors.foreground} />
            <View className="flex-1 gap-0.5">
              <Text className="text-base font-medium">{t(nature.labelKey)}</Text>
              <Text className="text-sm text-muted-foreground">{t(nature.vibeKey)}</Text>
            </View>
            <ChevronDown size={16} color={colors.mutedForeground} />
          </Pressable>
        )}
      </Animated.View>

      <Animated.View layout={LinearTransition} className="gap-2">
        <Text variant="eyebrow" className="text-xs">
          {t('kiloclaw.onboarding.identity.location')}
        </Text>
        <View className="flex-row items-center gap-2">
          <TextInput
            key={locationInputKey}
            className="h-11 flex-1 rounded-xl border border-input bg-background px-3 text-base leading-[normal] text-foreground"
            placeholder={t('kiloclaw.onboarding.identity.locationPlaceholder')}
            placeholderTextColor={colors.mutedForeground}
            defaultValue={locationDefaultValue}
            onChangeText={value => {
              locationTextRef.current = value;
              if (locationFeedback !== null) {
                setLocationFeedback(null);
              }
              if (validatedLocation !== null) {
                setValidatedLocation(null);
              }
            }}
            onBlur={() => {
              void handleLocationBlur();
            }}
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={200}
            returnKeyType="done"
          />
          <Pressable
            accessibilityLabel={t('kiloclaw.onboarding.identity.useCurrentLocation')}
            accessibilityRole="button"
            onPress={() => {
              void handleGpsPress();
            }}
            disabled={isGpsLoading || isValidating}
            accessibilityState={{ disabled: isValidating, busy: isGpsLoading }}
            className={cn(
              'h-11 w-11 items-center justify-center rounded-xl bg-secondary active:opacity-70',
              isValidating && !isGpsLoading && 'opacity-50'
            )}
          >
            {isGpsLoading ? (
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            ) : (
              <MapPin size={18} color={colors.mutedForeground} />
            )}
          </Pressable>
        </View>
        {locationFeedback && (
          <Text className={cn('px-1 text-sm', locationFeedbackClassName(locationFeedback.status))}>
            {locationFeedback.message}
          </Text>
        )}
      </Animated.View>

      <Button size="lg" onPress={handleContinue} disabled={isValidating} className="mt-2">
        {isValidating ? (
          <ActivityIndicator size="small" color={colors.primaryForeground} />
        ) : (
          <>
            <Text className="text-base">{t('kiloclaw.onboarding.identity.continue')}</Text>
            <DirectionalChevronRight size={16} color={colors.primaryForeground} />
          </>
        )}
      </Button>
    </ScrollView>
  );
}
