import { type Href, useRouter } from 'expo-router';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  InputAccessoryView,
  Keyboard,
  Pressable,
  TextInput,
  type TextInputInstance,
  View,
} from 'react-native';
import Animated, { FadeOut, LinearTransition } from 'react-native-reanimated';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { QueryError } from '@/components/query-error';
import { performCopy } from '@/components/agents/use-message-copy';
import { ReviewerHeader } from '@/components/code-reviewer/reviewer-header';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { AlertTriangle, Copy } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { instructionsFieldOverflows } from '@/lib/code-reviewer-instructions-field';
import { useReviewConfig, useSaveReviewConfig } from '@/lib/hooks/use-code-reviewer';
import { reviewConfigFailure, useReviewConfigBody } from '@/lib/hooks/use-review-config-body';
import {
  type SettingsBackGuardSaveOutcome,
  useSettingsBackGuard,
} from '@/lib/hooks/use-settings-back-guard';
import { useReviewerRouteParams } from '@/lib/hooks/use-reviewer-route-params';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

// The multiline editor's keyboard has no Done key on iOS (return inserts a
// newline), so a covered Save left no keyboard-adjacent way out. The accessory
// bar rides above the IME and dismisses it.
//
// The field and the bar pair through one id per mounted editor, not one id for
// every copy of the screen: iOS binds an accessory to the first text input in
// the window whose `inputAccessoryViewID` matches, once, when the bar enters
// the window (RCTInputAccessoryComponentView.didMoveToWindow). A constant id
// therefore lets one mounted editor take the bar of another, which then has no
// bar above its own keyboard at all.
const INSTRUCTIONS_DONE_ACCESSORY_ID = 'instructions-editor-done';

function InstructionsEditor({
  initial,
  onDirty,
  pending,
  onSave,
  draftRef,
}: Readonly<{
  // Uncontrolled per apps/mobile/AGENTS.md "Text inputs": iOS text is never
  // controlled with `value` + state; the draft lives in the caller's ref and
  // only the derived dirty flag reaches state.
  initial: string;
  onDirty: (text: string) => void;
  pending: boolean;
  // The screen owns the save: it may have to ask before an emptied field
  // replaces stored instructions, and the back guard saves through it too.
  onSave: () => void;
  draftRef: { current: string };
}>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  // The value the notice hands over: the stored instructions, trimmed the way
  // Save persists them, so the copied text is the value the backend holds.
  const storedValue = initial.trim();
  // Stable for this mount and distinct from every other mounted editor, so the
  // bar below can only bind to this editor's field.
  const accessoryId = `${INSTRUCTIONS_DONE_ACCESSORY_ID}${useId()}`;
  // A stored value taller than the capped field opens at the platform caret,
  // which sits at its end: the value's first line is then out of sight, the
  // symptom #7892 removed for a field that grew with its value. Once the field
  // and its content have both been measured, put the caret on the first line
  // for a value that overflows. A value that fits keeps the platform caret.
  //
  // This is the stored value's opening state only: once the reader has edited
  // the draft, a content measurement must never move their caret. Both
  // platforms report a content size for the empty field at mount, so the
  // alignment is normally spent before any edit; the edit guard keeps a mount
  // that reports none (a recycled view) from yanking the caret mid-paste.
  const fieldRef = useRef<TextInputInstance | null>(null);
  const fieldHeightRef = useRef(0);
  const contentHeightRef = useRef<number | null>(null);
  const alignedRef = useRef(false);
  const editedRef = useRef(false);
  const alignFirstLineIfOverflowing = () => {
    const contentHeight = contentHeightRef.current;
    if (
      alignedRef.current ||
      editedRef.current ||
      contentHeight == null ||
      fieldHeightRef.current === 0
    ) {
      return;
    }
    alignedRef.current = true;
    if (instructionsFieldOverflows(contentHeight, fieldHeightRef.current)) {
      fieldRef.current?.setSelection(0, 0);
    }
  };

  return (
    // No entrance animation on the loaded body: a Reanimated `entering` fade
    // carries `initialValues: { opacity: 0 }`, so a cancelled or overwritten
    // entrance (the app leaving the foreground mid-fade, a connection hiccup
    // that remounts the editor, a layout animation taking the same property)
    // leaves the note, the field and Save mounted at opacity 0 under a painted
    // header, with no skeleton, no error and no retry. The body paints in the
    // frame the read lands; only the skeleton's exit fade remains.
    <View className="gap-4">
      {/* The deprecation note asks the reader to move the guidelines elsewhere;
          as body-coloured text it read as a field description. A tinted notice
          with its own mark separates it from the field below. The action beside
          it hands over the whole stored value: the field shows at most ten
          lines and scrolls the rest, so selecting the text by hand meant
          dragging through a window that never shows it all. */}
      <View className="flex-row items-center gap-3 rounded-xl border border-warn-tile-border bg-warn-tile-bg p-3">
        <View className="min-w-0 flex-1 flex-row items-start gap-2">
          <AlertTriangle size={16} color={colors.warn} />
          <Text className="min-w-0 flex-1 text-sm text-warn">
            {t('codeReviewer.instructions.deprecation')}
          </Text>
        </View>
        {storedValue === '' ? null : (
          // What is copied is the value the notice retires — what the backend
          // holds and a save writes — not the draft under it. With nothing
          // stored there is no action rather than one that copies nothing.
          <Button
            variant="outline"
            size="sm"
            onPress={() => {
              void performCopy(storedValue);
            }}
          >
            <Copy size={14} color={colors.foreground} />
            <Text>{t('common.copy')}</Text>
          </Button>
        )}
      </View>
      {/* A multiline field takes the platform's generic text-view name on iOS,
          so the accessible name is the localized heading this screen renders.
          `max-h-[196px]` is the `p-3` padding (2 × 10.5) plus ten
          `leading-[1.25rem]` line boxes (10 × 17.5, native rem is 14): a cap
          that is not a whole number of lines paints the top visible line cut
          when the field scrolls to the caret. Past the cap the field scrolls
          its own text, so a multi-thousand-character draft no longer turns the
          page into one oversized text view that pushes the note and Save out
          of the viewport; the min height still grows the field with a short
          stored value. */}
      <TextInput
        ref={fieldRef}
        onLayout={event => {
          fieldHeightRef.current = event.nativeEvent.layout.height;
          alignFirstLineIfOverflowing();
        }}
        onContentSizeChange={event => {
          contentHeightRef.current = event.nativeEvent.contentSize.height;
          alignFirstLineIfOverflowing();
        }}
        className="min-h-32 max-h-[196px] rounded-lg bg-secondary p-3 text-sm leading-[1.25rem] text-foreground"
        accessibilityLabel={t('codeReviewer.instructions.title')}
        multiline
        textAlignVertical="top"
        inputAccessoryViewID={accessoryId}
        placeholder={t('codeReviewer.instructions.placeholder')}
        defaultValue={initial}
        onChangeText={text => {
          editedRef.current = true;
          draftRef.current = text;
          onDirty(text);
        }}
      />
      {/* eslint-disable-next-line typescript-eslint/no-deprecated -- the iOS Done bar needs the keyboard accessory view this SDK still exports */}
      <InputAccessoryView nativeID={accessoryId}>
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
      <Button disabled={pending} onPress={onSave}>
        <Text>{t('common.save')}</Text>
      </Button>
    </View>
  );
}

export default function InstructionsRoute() {
  const params = useReviewerRouteParams();
  if (!params) {
    return <InvalidRouteState backTo={'/(app)/code-reviewer' as Href} />;
  }
  return <InstructionsScreen scope={params.scope} platform={params.platform} />;
}

function InstructionsScreen({
  scope,
  platform,
}: Readonly<{ scope: string; platform: ReviewerPlatform }>) {
  const router = useRouter();
  const config = useReviewConfig(scope, platform);
  const configBody = useReviewConfigBody(config);
  const { data } = config;
  const failure = reviewConfigFailure(configBody, config.isFetching);
  const save = useSaveReviewConfig(scope, platform);
  const { confirm, dialog: removalDialog } = useConfirmDialog();
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

  // An emptied field is a removal: the stored text is the only copy, and the
  // save that replaces it with nothing is the one action the screen cannot
  // undo. The back guard's Save arrives here too, so the question lives with
  // the save instead of with either control.
  const handleSave = async (): Promise<SettingsBackGuardSaveOutcome> => {
    if (draftRef.current.trim() === '' && initialRef.current.trim() !== '') {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      confirm({
        title: t('codeReviewer.instructions.clearTitle'),
        message: t('codeReviewer.instructions.clearMessage'),
        confirmLabel: t('common.remove'),
        cancelLabel: t('common.keepEditing'),
        onConfirm: () => {
          resolve(true);
        },
        onCancel: () => {
          resolve(false);
        },
      });
      // Declining keeps the editor open with the draft; the back guard reads
      // the outcome as "do not leave" and stays with it too.
      if (!(await promise)) {
        return 'declined';
      }
    }
    const draft = draftRef.current.trim();
    await save.mutateAsync({ customInstructions: draft });
    initialRef.current = draft;
    setDirty(false);
    return 'saved';
  };

  const { onBack, skipNextGuardRef, dialog } = useSettingsBackGuard({
    dirty,
    valid: true,
    onSave: handleSave,
  });

  const handlePressSave = () => {
    void (async () => {
      try {
        if ((await handleSave()) === 'declined') {
          return;
        }
        // The router.back() this triggers must not be intercepted by the dirty
        // guard: `dirty` is still computed from the previous render's state at
        // that point.
        skipNextGuardRef.current = true;
        router.back();
      } catch {
        // The save mutation's centralized onError already toasted; the editor
        // stays mounted with the draft.
      }
    })();
  };

  return (
    <View className="flex-1 bg-background">
      <ReviewerHeader title={t('codeReviewer.instructions.title')} onBack={onBack} />
      {dialog}
      {removalDialog}
      {failure ? (
        // A config read that failed, or one that stayed pending with nothing
        // in flight even after its automatic restart, gets the action that can
        // resolve it instead of a skeleton that never ends.
        <QueryError
          variant={failure.variant}
          onRetry={() => {
            failure.onRetry();
          }}
          isRetrying={failure.isRetrying}
        />
      ) : (
        <TabScreenScrollView
          // iOS IME inset and focused-field auto-reveal (AGENTS.md: input screens).
          automaticallyAdjustKeyboardInsets
          className="flex-1"
          contentContainerClassName="px-6 pt-4"
          keyboardShouldPersistTaps="handled"
        >
          <Animated.View layout={LinearTransition} className="gap-4">
            {configBody.body.status === 'loading' && (
              <Animated.View exiting={FadeOut.duration(150)} className="gap-4">
                <Skeleton className="h-32 w-full rounded-lg" />
                <Skeleton className="h-10 w-full rounded-md" />
              </Animated.View>
            )}

            {configBody.body.status === 'ready' && data != null && (
              <InstructionsEditor
                initial={data.customInstructions ?? ''}
                onDirty={text => {
                  setDirty(text.trim() !== initialRef.current.trim());
                }}
                pending={save.isPending}
                onSave={handlePressSave}
                draftRef={draftRef}
              />
            )}
          </Animated.View>
        </TabScreenScrollView>
      )}
    </View>
  );
}
