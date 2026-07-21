// Form sub-components for the S8 merge sheet. Extracted out of
// `pr-merge-sheet.tsx` to keep that file under the repo's 300-line limit.

import { type RefObject } from 'react';
import { Switch, TextInput, View } from 'react-native';

import { PillGroup } from '@/components/security-agent/settings-pill-group';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import {
  type AllowedMergeMethod,
  PR_MERGE_DESCRIPTIONS,
} from '@/lib/pr-review/merge/merge-blocked-reasons';
import { type MergeMethodOption } from '@/components/pr-review/merge/pr-merge-icons';

export function MethodPicker({
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
    <View className="gap-2">
      <Text variant="eyebrow" className="uppercase tracking-wide text-muted-foreground">
        Method
      </Text>
      <PillGroup
        label="Merge method"
        options={methodOptions.map(o => ({ value: o.value, label: o.label }))}
        value={method}
        disabled={isDisabled}
        onChange={value => {
          onChange(value);
        }}
      />
      <Text variant="muted" className="text-sm">
        {PR_MERGE_DESCRIPTIONS[method]}
      </Text>
    </View>
  );
}

export function CommitTitleField({
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
    <View className="gap-2">
      <Text className="text-sm font-medium text-foreground">Commit title</Text>
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
          'rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-5 text-foreground',
          'focus:border-ring'
        )}
        multiline
      />
    </View>
  );
}

export function CommitMessageField({
  messageRef,
  inputRef,
  isDisabled,
}: Readonly<{
  messageRef: RefObject<string>;
  inputRef: RefObject<TextInput | null>;
  isDisabled: boolean;
}>) {
  const colors = useThemeColors();
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-foreground">Commit message</Text>
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
          'min-h-24 rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-5 text-foreground',
          'focus:border-ring'
        )}
        multiline
        textAlignVertical="top"
      />
    </View>
  );
}

export function DeleteBranchToggle({
  value,
  onChange,
  isDisabled,
}: Readonly<{
  value: boolean;
  onChange: (next: boolean) => void;
  isDisabled: boolean;
}>) {
  return (
    <View className="flex-row items-center justify-between rounded-lg bg-secondary p-4">
      <View className="flex-1 pr-3">
        <Text className="text-sm font-medium">Delete branch</Text>
        <Text variant="muted" className="text-xs">
          Delete the head branch after the merge succeeds.
        </Text>
      </View>
      <Switch
        accessibilityLabel="Delete branch after merge"
        value={value}
        disabled={isDisabled}
        onValueChange={onChange}
      />
    </View>
  );
}
