/* eslint-disable max-lines -- Merge-sheet form sub-components share the sheet's keyboard-visibility and footer contracts. */
// Form sub-components for the S8 merge sheet. Extracted out of
// `pr-merge-sheet.tsx` to keep that file under the repo's 300-line limit.

import { type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
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
  prMergeDescription,
} from '@/lib/pr-review/merge/merge-blocked-reasons';
import { type MergeMethodOption } from '@/components/pr-review/merge/pr-merge-icons';
import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';

const METHOD_LABEL_KEYS = {
  merge: 'prReview.merge.methods.merge',
  squash: 'prReview.merge.methods.squash',
  rebase: 'prReview.merge.methods.rebase',
} as const satisfies Record<AllowedMergeMethod, string>;

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
  const { t } = useTranslation();
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        {t('prReview.merge.methodLabel')}
      </Text>
      <RadioGroup label={t('prReview.merge.methodLabel')} className="flex-row flex-wrap gap-2">
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
              accessibilityHint={prMergeDescription(option.value)}
              className={cn(
                'min-h-11 items-center justify-center rounded-full border px-4 py-2 active:opacity-70',
                active && 'border-primary bg-primary',
                !active && isDisabled && 'border-hair-soft bg-secondary',
                !active && !isDisabled && 'border-border bg-secondary'
              )}
            >
              <Text
                className={cn(
                  'text-sm font-medium',
                  active && 'text-primary-foreground',
                  !active && isDisabled && 'text-muted-foreground',
                  !active && !isDisabled && 'text-foreground'
                )}
              >
                {t(METHOD_LABEL_KEYS[option.value])}
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
  const { t } = useTranslation();
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-foreground">{t('prReview.merge.commitTitle')}</Text>
      <TextInput
        ref={inputRef}
        defaultValue={titleRef.current}
        editable={!isDisabled}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        accessibilityLabel={t('prReview.merge.commitTitle')}
        onChangeText={value => {
          titleRef.current = value;
        }}
        className={cn(
          'min-h-11 rounded-md border border-input bg-background px-3 py-2 text-sm leading-5 text-foreground',
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
  const { t } = useTranslation();
  const keyboardVisible = useFormSheetKeyboardVisible();
  const tight = compact || keyboardVisible;
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-foreground">
        {t('prReview.merge.commitMessage')}
      </Text>
      <TextInput
        ref={inputRef}
        defaultValue={messageRef.current}
        editable={!isDisabled}
        placeholder={t('prReview.merge.commitMessagePlaceholder')}
        placeholderTextColor={colors.mutedForeground}
        accessibilityLabel={t('prReview.merge.commitMessage')}
        onChangeText={value => {
          messageRef.current = value;
        }}
        className={cn(
          'rounded-md border border-input bg-background px-3 py-2 text-sm leading-5 text-foreground',
          'focus:border-ring',
          tight ? 'max-h-16 min-h-11' : 'min-h-24 max-h-40'
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
  const { t } = useTranslation();
  if (hidden || keyboardVisible) {
    return null;
  }
  return (
    <View className="flex-row items-center justify-between rounded-lg bg-secondary px-4 py-3">
      <Text className="flex-1 pr-3 text-sm font-medium">{t('prReview.merge.deleteBranch')}</Text>
      <Switch
        accessibilityLabel={t('prReview.merge.deleteBranchAfterMerge')}
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

  const { t } = useTranslation();

  return (
    <>
      <View className="gap-4 px-6 pt-4">
        {noMethodsAllowed ? (
          <View className="rounded-md border border-border bg-secondary p-3">
            <AccessibleStatus
              message={t('prReview.merge.noEnabledMethods')}
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

      <PrFormSheetFooter>
        <Button
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
          variant="ghost"
          onPress={onDismiss}
          disabled={isMutating}
          className="mt-2"
          accessibilityLabel={t('common.cancel')}
        >
          <Text>{t('common.cancel')}</Text>
        </Button>
      </PrFormSheetFooter>
    </>
  );
}
