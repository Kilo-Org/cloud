import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { InputAccessoryView, Keyboard, Pressable, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { type ReviewerPlatform } from '@/lib/code-reviewer-config';
import {
  type SaveReviewConfigMutation,
  useReviewConfig,
  useSaveReviewConfig,
} from '@/lib/hooks/use-code-reviewer';

// The multiline editor's keyboard has no Done key on iOS (return inserts a
// newline), so a covered Save left no keyboard-adjacent way out. The accessory
// bar rides above the IME and dismisses it.
const INSTRUCTIONS_DONE_ACCESSORY_ID = 'instructions-editor-done';

// Mounted only once `data != null`, so useRef(initial) captures the real
// loaded value instead of the pre-fetch default.
function InstructionsEditor({
  initial,
  save,
  onSaved,
}: Readonly<{
  initial: string;
  save: SaveReviewConfigMutation;
  onSaved: () => void;
}>) {
  const valueRef = useRef(initial);
  const { t } = useTranslation();

  return (
    <Animated.View entering={FadeIn.duration(200)} className="gap-4">
      <Text className="text-sm text-muted-foreground">
        {t('codeReviewer.instructions.deprecation')}
      </Text>
      <TextInput
        className="h-32 rounded-lg bg-secondary p-3 text-sm leading-5 text-foreground"
        multiline
        textAlignVertical="top"
        inputAccessoryViewID={INSTRUCTIONS_DONE_ACCESSORY_ID}
        placeholder={t('codeReviewer.instructions.placeholder')}
        defaultValue={initial}
        onChangeText={text => {
          valueRef.current = text;
        }}
      />
      <InputAccessoryView nativeID={INSTRUCTIONS_DONE_ACCESSORY_ID}>
        <View className="flex-row justify-end bg-background px-4 py-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.done')}
            onPress={() => {
              Keyboard.dismiss();
            }}
            className="px-3 py-2 active:opacity-70"
          >
            <Text className="text-sm font-medium text-primary">{t('common.done')}</Text>
          </Pressable>
        </View>
      </InputAccessoryView>
      <Button
        disabled={save.isPending}
        onPress={() => {
          save.mutate(
            { customInstructions: valueRef.current.trim() },
            {
              onSuccess: onSaved,
            }
          );
        }}
      >
        <Text>{t('common.save')}</Text>
      </Button>
    </Animated.View>
  );
}

export default function InstructionsRoute() {
  const { scope, platform } = useLocalSearchParams<{ scope: string; platform: ReviewerPlatform }>();
  const router = useRouter();
  const { data } = useReviewConfig(scope, platform);
  const save = useSaveReviewConfig(scope, platform);
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('codeReviewer.instructions.title')} />
      <TabScreenScrollView
        // iOS IME inset and focused-field auto-reveal (AGENTS.md: input screens).
        automaticallyAdjustKeyboardInsets
        className="flex-1"
        contentContainerClassName="px-6 pt-4"
        keyboardShouldPersistTaps="handled"
      >
        <Animated.View layout={LinearTransition} className="gap-4">
          {data == null && (
            <Animated.View exiting={FadeOut.duration(150)} className="gap-4">
              <Skeleton className="h-32 w-full rounded-lg" />
              <Skeleton className="h-10 w-full rounded-md" />
            </Animated.View>
          )}

          {data != null && (
            <InstructionsEditor
              initial={data.customInstructions ?? ''}
              save={save}
              onSaved={() => {
                router.back();
              }}
            />
          )}
        </Animated.View>
      </TabScreenScrollView>
    </View>
  );
}
