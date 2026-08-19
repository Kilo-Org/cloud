// Form sub-components for the S8 merge sheet. Extracted out of
// `pr-merge-sheet.tsx` to keep that file under the repo's 300-line limit.

import { type ReactNode, type RefObject } from 'react';
import { Pressable, Switch, TextInput, View } from 'react-native';
import * as Haptics from 'expo-haptics';

import {
  PrFormSheetFooter,
  useFormSheetKeyboardVisible,
} from '@/components/pr-review/pr-form-sheet-chrome';
import { Button } from '@/components/ui/button';
import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import {
  type AllowedMergeMethod,
  PR_MERGE_DESCRIPTIONS,
} from '@/lib/pr-review/merge/merge-blocked-reasons';
import { type MergeMethodOption } from '@/components/pr-review/merge/pr-merge-icons';
import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';

const NO_ENABLED_METHODS_MESSAGE =
  'This repository has no enabled merge methods. Ask a repository admin to enable merge, squash, or rebase merging.';

const SHORT_METHOD_LABELS = {
  merge: 'Merge',
  squash: 'Squash',
  rebase: 'Rebase',
} satisfies Record<AllowedMergeMethod, string>;

function MethodPicker({
  methodOptions,
  method,
  isDisabled,
  onChange,
}: Readonly<{
  methodOptions: MergeMethodOption[];
  method: AllowedMergeMethod;
  isDisabled: boolean;
  onChange: (next: AllowedMergeMethod) => void;
}>) {
  return (
    <View className="gap-0.5">
      <Text className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Method
      </Text>
      <RadioGroup label="Method" className="flex-row flex-wrap gap-1">
        {methodOptions.map(option => {
          const active = method === option.value;
          // Long labels stay readable via accessibilityLabel; chip shows short text.
          return (
            <Pressable
              key={option.value}
              disabled={isDisabled}
              onPress={() => {
                void Haptics.selectionAsync();
                onChange(option.value);
              }}
              {...radioItemA11y({ label: option.label, checked: active, disabled: isDisabled })}
              accessibilityHint={PR_MERGE_DESCRIPTIONS[option.value]}
              className={cn(
                'min-h-8 items-center justify-center rounded-full border px-2.5 py-1 active:opacity-70',
                active && 'border-primary bg-primary',
                !active && isDisabled && 'border-hair-soft bg-secondary',
                !active && !isDisabled && 'border-border bg-secondary'
              )}
            >
              <Text
                className={cn(
                  'text-xs font-medium',
                  active && 'text-primary-foreground',
                  !active && isDisabled && 'text-muted-foreground',
                  !active && !isDisabled && 'text-foreground'
                )}
              >
                {SHORT_METHOD_LABELS[option.value]}
              </Text>
            </Pressable>
          );
        })}
      </RadioGroup>
    </View>
  );
}

function CommitTitleField({
  titleRef,
  inputRef,
  placeholder,
  isDisabled,
}: Readonly<{
  titleRef: RefObject<string>;
  inputRef: RefObject<TextInput | null>;
  placeholder: string;
  isDisabled: boolean;
}>) {
  const colors = useThemeColors();
  return (
    <View className="gap-0.5">
      <Text className="text-xs font-medium text-foreground">Commit title</Text>
      <TextInput
        ref={inputRef}
        defaultValue={titleRef.current}
        editable={!isDisabled}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        accessibilityLabel="Commit title"
        onChangeText={value => {
          titleRef.current = value;
        }}
        className={cn(
          'min-h-9 max-h-12 rounded-md border border-input bg-background px-3 py-1 text-sm leading-5 text-foreground',
          'focus:border-ring'
        )}
        multiline
      />
    </View>
  );
}

function CommitMessageField({
  messageRef,
  inputRef,
  isDisabled,
  /** Half-detent / keyboard-open: keep a single-line-ish field so footer CTAs fit. */
  compact = false,
}: Readonly<{
  messageRef: RefObject<string>;
  inputRef: RefObject<TextInput | null>;
  isDisabled: boolean;
  compact?: boolean;
}>) {
  const colors = useThemeColors();
  const keyboardVisible = useFormSheetKeyboardVisible();
  const tight = compact || keyboardVisible;
  return (
    <View className="gap-0.5">
      <Text className="text-xs font-medium text-foreground">Commit message</Text>
      <TextInput
        ref={inputRef}
        defaultValue={messageRef.current}
        editable={!isDisabled}
        placeholder="Optional description for the merge commit"
        placeholderTextColor={colors.mutedForeground}
        accessibilityLabel="Commit message"
        onChangeText={value => {
          messageRef.current = value;
        }}
        className={cn(
          'rounded-md border border-input bg-background px-3 py-1 text-sm leading-5 text-foreground',
          'focus:border-ring',
          tight ? 'max-h-12 min-h-9' : 'min-h-11 max-h-16'
        )}
        multiline
        textAlignVertical="top"
      />
    </View>
  );
}

function DeleteBranchToggle({
  value,
  onChange,
  isDisabled,
  /** Hidden on half-detent and while the keyboard is open (footer room). */
  hidden = false,
}: Readonly<{
  value: boolean;
  onChange: (next: boolean) => void;
  isDisabled: boolean;
  hidden?: boolean;
}>) {
  const keyboardVisible = useFormSheetKeyboardVisible();
  if (hidden || keyboardVisible) {
    return null;
  }
  return (
    <View className="flex-row items-center justify-between rounded-lg bg-secondary px-3 py-1.5">
      <Text className="flex-1 pr-3 text-sm font-medium">Delete branch</Text>
      <Switch
        accessibilityLabel="Delete branch after merge"
        value={value}
        disabled={isDisabled}
        onValueChange={onChange}
      />
    </View>
  );
}

/** Compact form body + footer for half-detent CTA fit. */
export function MergeSheetFormBody(props: {
  noMethodsAllowed: boolean;
  methodOptions: MergeMethodOption[];
  method: AllowedMergeMethod;
  isMutating: boolean;
  onMethodChange: (next: AllowedMergeMethod) => void;
  titleRef: RefObject<string>;
  titleInputRef: RefObject<TextInput | null>;
  titlePlaceholder: string;
  messageRef: RefObject<string>;
  messageInputRef: RefObject<TextInput | null>;
  isHalfDetent: boolean;
  showDeleteBranchToggle: boolean;
  deleteBranch: boolean;
  onDeleteBranchChange: (next: boolean) => void;
  inlineError: string | null;
  inlineErrorKind: 'retryable' | 'non-retryable' | 'reconnect' | null;
  submitLabel: string;
  onConfirm: () => void;
  onDismiss: () => void;
}): ReactNode {
  const {
    noMethodsAllowed,
    methodOptions,
    method,
    isMutating,
    onMethodChange,
    titleRef,
    titleInputRef,
    titlePlaceholder,
    messageRef,
    messageInputRef,
    isHalfDetent,
    showDeleteBranchToggle,
    deleteBranch,
    onDeleteBranchChange,
    inlineError,
    inlineErrorKind,
    submitLabel,
    onConfirm,
    onDismiss,
  } = props;

  return (
    <>
      <View className="gap-1.5 px-6 pt-1.5">
        {noMethodsAllowed ? (
          <View className="rounded-md border border-border bg-secondary p-3">
            <AccessibleStatus
              message={NO_ENABLED_METHODS_MESSAGE}
              tone="status"
              className="text-sm"
            />
          </View>
        ) : (
          <MethodPicker
            methodOptions={methodOptions}
            method={method}
            isDisabled={isMutating}
            onChange={onMethodChange}
          />
        )}
        <CommitTitleField
          titleRef={titleRef}
          inputRef={titleInputRef}
          placeholder={titlePlaceholder}
          isDisabled={isMutating}
        />
        <CommitMessageField
          messageRef={messageRef}
          inputRef={messageInputRef}
          isDisabled={isMutating}
          compact={isHalfDetent}
        />
        {showDeleteBranchToggle ? (
          <DeleteBranchToggle
            value={deleteBranch}
            onChange={onDeleteBranchChange}
            isDisabled={isMutating}
            hidden={isHalfDetent}
          />
        ) : null}
        {inlineError && inlineErrorKind !== 'reconnect' ? (
          <View className="rounded-md border border-destructive bg-red-50 dark:bg-red-950 px-2.5 py-1.5">
            <Text className="text-xs text-destructive">{inlineError}</Text>
          </View>
        ) : null}
        {inlineErrorKind === 'reconnect' ? (
          <>
            <AccessibleStatus message={inlineError} tone="status" className="text-xs" />
            <PrReviewReconnectNotice />
          </>
        ) : null}
      </View>

      <PrFormSheetFooter className="pb-1 pt-1">
        <Button
          size="sm"
          onPress={onConfirm}
          loading={isMutating}
          disabled={
            noMethodsAllowed ||
            inlineErrorKind === 'non-retryable' ||
            inlineErrorKind === 'reconnect'
          }
          accessibilityLabel={submitLabel}
        >
          <Text>{submitLabel}</Text>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onPress={onDismiss}
          disabled={isMutating}
          className="mt-0.5"
          accessibilityLabel="Cancel"
        >
          <Text>Cancel</Text>
        </Button>
      </PrFormSheetFooter>
    </>
  );
}
