import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
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
import {
  type SettingsBackGuardResult,
  useSettingsBackGuard,
} from '@/lib/hooks/use-settings-back-guard';

// The multiline editor's keyboard has no Done key on iOS (return inserts a
// newline), so a covered Save left no keyboard-adjacent way out. The accessory
// bar rides above the IME and dismisses it.
const INSTRUCTIONS_DONE_ACCESSORY_ID = 'instructions-editor-done';

function InstructionsEditor({
  initial,
  onDirty,
  save,
  onSaved,
  skipNextGuardRef,
  draftRef,
}: Readonly<{
  // Uncontrolled per apps/mobile/AGENTS.md "Text inputs": iOS text is never
  // controlled with `value` + state; the draft lives in the caller's ref and
  // only the derived dirty flag reaches state.
  initial: string;
  onDirty: (text: string) => void;
  save: SaveReviewConfigMutation;
  onSaved: () => void;
  skipNextGuardRef: SettingsBackGuardResult['skipNextGuardRef'];
  draftRef: { current: string };
}>) {
  const { t } = useTranslation();

  return (
    <Animated.View entering={FadeIn.duration(200)} className="gap-4">
      <Text className="text-sm text-muted-foreground">
        {t('codeReviewer.instructions.deprecation')}
      </Text>
      {/* A multiline field takes the platform's generic text-view name on iOS,
          so the accessible name is the localized heading this screen renders. */}
      <TextInput
        className="min-h-32 rounded-lg bg-secondary p-3 text-sm leading-5 text-foreground"
        accessibilityLabel={t('codeReviewer.instructions.title')}
        multiline
        textAlignVertical="top"
        inputAccessoryViewID={INSTRUCTIONS_DONE_ACCESSORY_ID}
        placeholder={t('codeReviewer.instructions.placeholder')}
        defaultValue={initial}
        onChangeText={text => {
          draftRef.current = text;
          onDirty(text);
        }}
      />
      {/* eslint-disable-next-line typescript-eslint/no-deprecated -- the iOS Done bar needs the keyboard accessory view this SDK still exports */}
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
            { customInstructions: draftRef.current.trim() },
            {
              onSuccess: () => {
                // The router.back() this triggers must not be intercepted by
                // the dirty guard: `dirty` is still computed from the previous
                // render's state at that point.
                skipNextGuardRef.current = true;
                onSaved();
              },
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

  // Draft in a ref over an uncontrolled defaultValue (apps/mobile/AGENTS.md
  // "Text inputs"). `initial` reaches the field directly from the loaded
  // value; this effect only seeds the comparison baseline (initialRef) and
  // the draft (draftRef) that save and the dirty flag read.
  const [dirty, setDirty] = useState(false);
  const hydratedRef = useRef(false);
  const initialRef = useRef('');
  const draftRef = useRef('');
  useEffect(() => {
    if (hydratedRef.current || data == null) {
      return;
    }
    hydratedRef.current = true;
    initialRef.current = data.customInstructions ?? '';
    draftRef.current = initialRef.current;
  }, [data]);

  const handleSave = async () => {
    await save.mutateAsync({ customInstructions: draftRef.current.trim() });
    initialRef.current = draftRef.current.trim();
    setDirty(false);
  };

  const { onBack, skipNextGuardRef, dialog } = useSettingsBackGuard({
    dirty,
    valid: true,
    onSave: handleSave,
  });

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('codeReviewer.instructions.title')} onBack={onBack} />
      {dialog}
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
              onDirty={text => {
                setDirty(text.trim() !== initialRef.current.trim());
              }}
              save={save}
              onSaved={() => {
                router.back();
              }}
              skipNextGuardRef={skipNextGuardRef}
              draftRef={draftRef}
            />
          )}
        </Animated.View>
      </TabScreenScrollView>
    </View>
  );
}
