import { type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch, TextInput, View } from 'react-native';

import {
  PrFormSheetFooter,
  useFormSheetKeyboardVisible,
} from '@/components/pr-review/pr-form-sheet-chrome';
import { Button } from '@/components/ui/button';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { type AllowedMergeMethod } from '@/lib/pr-review/merge/merge-blocked-reasons';
import { type MergeMethodOption } from '@/components/pr-review/merge/pr-merge-icons';
import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { MethodPicker } from '@/components/pr-review/merge/pr-merge-method-picker';

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
  /**
   * False on the Bitbucket merge arm (s6f): the provider merge takes only
   * the message, so no commit-title input exists whose value would be
   * silently dropped on submit.
   */
  showTitle: boolean;
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
    showTitle,
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
        {showTitle ? (
          <CommitTitleField
            titleRef={titleRef}
            inputRef={titleInputRef}
            placeholder={titlePlaceholder}
            isDisabled={isMutating}
          />
        ) : null}
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
