/* eslint-disable max-lines */
import * as Sentry from '@sentry/react-native';
import { useMutation } from '@tanstack/react-query';
import * as Location from 'expo-location';
import { ChevronDown, ChevronRight, ChevronUp, MapPin } from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, TextInput, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useTRPC } from '@/lib/trpc';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

import { type BotIdentity, DEFAULT_BOT_IDENTITY } from './state';

type NaturePreset = {
  id: string;
  emoji: string;
  label: string;
  vibe: string;
};

const DEFAULT_NATURE = {
  id: 'ai-assistant',
  emoji: '🤖',
  label: 'AI assistant',
  vibe: 'Helpful, capable, professional',
} satisfies NaturePreset;

const NATURE_PRESETS: readonly NaturePreset[] = [
  DEFAULT_NATURE,
  {
    id: 'digital-creature',
    emoji: '🐙',
    label: 'Digital creature',
    vibe: 'Quirky, alive, a bit unpredictable',
  },
  {
    id: 'virtual-companion',
    emoji: '🌙',
    label: 'Virtual companion',
    vibe: 'Warm, present, genuinely cares',
  },
  {
    id: 'something-weirder',
    emoji: '🌀',
    label: 'Something weirder…',
    vibe: 'Define it yourself',
  },
];

const EMOJI_OPTIONS = ['🤖', '👾', '🧠', '⚡', '🔮', '🔥', '🐉', '✨', '🌙'];

type IdentityStepProps = {
  onContinue: (identity: BotIdentity, weatherLocation: string | null) => void;
  initialIdentity?: BotIdentity | null;
  initialWeatherLocation?: string | null;
};

const GPS_TIMEOUT_MS = 10_000;
const GPS_COORDINATE_PRECISION = 2;

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

  const validateLocation = useMutation(trpc.kiloclaw.validateWeatherLocation.mutationOptions({}));

  const nature = NATURE_PRESETS.find(n => n.id === selectedNatureId) ?? DEFAULT_NATURE;

  const handleGpsPress = useCallback(async () => {
    setIsGpsLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== Location.PermissionStatus.GRANTED) {
        Alert.alert(
          'Location access denied',
          'Enable location access in Settings to use your current location.'
        );
        return;
      }
      const pos = await getCurrentPositionWithTimeout();
      const latitude = pos.coords.latitude.toFixed(GPS_COORDINATE_PRECISION);
      const longitude = pos.coords.longitude.toFixed(GPS_COORDINATE_PRECISION);
      const coords = `${latitude},${longitude}`;
      locationTextRef.current = coords;
      setLocationDefaultValue(coords);
      setLocationInputKey(k => k + 1);
    } catch (error) {
      Sentry.captureException(error);
      toast.error('Could not get your location. Enter it manually.');
    } finally {
      setIsGpsLoading(false);
    }
  }, []);

  const validateLocationMutate = validateLocation.mutate;
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

    validateLocationMutate(
      { location: trimmedLocation },
      {
        onSuccess: result => {
          if (result.status === 'service_unavailable') {
            toast("wttr.in is down right now. We'll store your location as entered.");
          }
          onContinue(identity, result.location);
        },
        onError: () => {
          // Don't block the user if validation fails; pass the entered text.
          onContinue(identity, trimmedLocation);
        },
      }
    );
  }, [nature, onContinue, selectedEmoji, validateLocationMutate]);

  const isValidating = validateLocation.isPending;

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="p-4 gap-5"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
      <Animated.View layout={LinearTransition} className="gap-3">
        <View className="flex-row items-center gap-3">
          <Pressable
            accessibilityLabel="Choose avatar"
            accessibilityRole="button"
            onPress={() => {
              setAvatarExpanded(v => !v);
            }}
            className={cn(
              'h-14 w-14 items-center justify-center rounded-xl border',
              avatarExpanded
                ? 'border-primary bg-neutral-200 dark:bg-neutral-800'
                : 'border-border bg-card active:opacity-70'
            )}
          >
            <Text className="text-3xl">{selectedEmoji}</Text>
          </Pressable>
          <TextInput
            className="h-14 flex-1 rounded-xl border border-input bg-background px-3 text-sm leading-5 text-foreground"
            placeholder="Name your bot"
            placeholderTextColor={colors.mutedForeground}
            defaultValue={initialName}
            onChangeText={value => {
              nameRef.current = value;
            }}
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={80}
            returnKeyType="done"
          />
        </View>

        {avatarExpanded && (
          <View className="flex-row flex-wrap gap-3">
            {EMOJI_OPTIONS.map(emoji => (
              <Pressable
                key={emoji}
                accessibilityLabel={`Select ${emoji} as avatar`}
                accessibilityRole="button"
                onPress={() => {
                  setSelectedEmoji(emoji);
                  setAvatarExpanded(false);
                }}
                className={cn(
                  'h-14 w-14 items-center justify-center rounded-xl border',
                  selectedEmoji === emoji
                    ? 'border-primary bg-neutral-200 dark:bg-neutral-800'
                    : 'border-border active:opacity-70'
                )}
              >
                <Text className="text-2xl">{emoji}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </Animated.View>

      <Animated.View layout={LinearTransition} className="gap-2">
        <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Personality
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
                  'flex-row items-center gap-3 rounded-md border px-3 py-3',
                  selectedNatureId === preset.id
                    ? 'border-primary bg-neutral-200 dark:bg-neutral-800'
                    : 'border-border active:opacity-70'
                )}
              >
                <Text className="text-xl">{preset.emoji}</Text>
                <View className="flex-1 gap-0.5">
                  <Text className="text-sm font-medium">{preset.label}</Text>
                  <Text className="text-xs text-muted-foreground">{preset.vibe}</Text>
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
            accessibilityLabel="Change personality"
            onPress={() => {
              setPersonalityExpanded(true);
            }}
            className="flex-row items-center gap-3 rounded-md border border-border px-3 py-3 active:opacity-70"
          >
            <Text className="text-xl">{nature.emoji}</Text>
            <View className="flex-1 gap-0.5">
              <Text className="text-sm font-medium">{nature.label}</Text>
              <Text className="text-xs text-muted-foreground">{nature.vibe}</Text>
            </View>
            <ChevronDown size={16} color={colors.mutedForeground} />
          </Pressable>
        )}
      </Animated.View>

      <Animated.View layout={LinearTransition} className="gap-2">
        <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Location
        </Text>
        <View className="flex-row items-center gap-2">
          <TextInput
            key={locationInputKey}
            className="h-11 flex-1 rounded-xl border border-input bg-background px-3 text-sm leading-5 text-foreground"
            placeholder="City or region (optional)"
            placeholderTextColor={colors.mutedForeground}
            defaultValue={locationDefaultValue}
            onChangeText={value => {
              locationTextRef.current = value;
            }}
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={200}
            returnKeyType="done"
          />
          <Pressable
            accessibilityLabel="Use current location"
            accessibilityRole="button"
            onPress={() => {
              void handleGpsPress();
            }}
            disabled={isGpsLoading || isValidating}
            className="h-11 w-11 items-center justify-center rounded-xl border border-input bg-background active:opacity-70 disabled:opacity-50"
          >
            {isGpsLoading ? (
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            ) : (
              <MapPin size={18} color={colors.mutedForeground} />
            )}
          </Pressable>
        </View>
      </Animated.View>

      <Button size="lg" onPress={handleContinue} disabled={isValidating} className="mt-2">
        {isValidating ? (
          <ActivityIndicator size="small" color={colors.primaryForeground} />
        ) : (
          <>
            <Text>Continue</Text>
            <ChevronRight size={16} color={colors.primaryForeground} />
          </>
        )}
      </Button>
    </ScrollView>
  );
}
