import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { SheetHeader } from '@/components/sheet-header';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { SelectableText } from '@/components/ui/selectable-text';
import { Text } from '@/components/ui/text';
import { isolateLtrBidiText } from '@/lib/bidi';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { codeFieldTextStyle } from '@/lib/rtl-text';

type InstructionViewSheetProps = Readonly<{
  /** The instruction to read, or `null` while the sheet is closed. */
  instruction: { name: string; content: string } | null;
  onClose: () => void;
}>;

/**
 * The read-only instruction sheet: the whole rule file name, the path it is
 * stored at and its markdown. A row clamps the name to one line, and a file
 * name up to the server's 100-character bound is far longer than a phone row
 * paints, so the row's press opens this surface where the name is readable in
 * full.
 *
 * Nothing here is edited: the sheet shows data, so `SessionPageSheet` takes
 * `dismissible` and the drag is one more way out beside the header's close.
 * Both values render through `SelectableText`, so a reader can copy the name or
 * the rules. The name keeps the mono family of the row it came from, and it
 * wraps instead of clamping: its whole length is the point of this surface.
 */
export function InstructionViewSheet({
  instruction,
  onClose,
}: Readonly<InstructionViewSheetProps>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  // A closed sheet renders nothing, exactly as the form sheet beside it: the
  // header's close unmounts the surface, and the row's press mounts it again
  // with the row it opens.
  if (instruction === null) {
    return null;
  }
  const nameLabel = t('profiles.instructionNameLabel');
  const contentLabel = t('profiles.instructionContentLabel');
  // A storage path reads position by position, so it keeps its left-to-right
  // direction inside a right-to-left interface; the leading dot is neutral.
  const rulesPath = `.kilocode/rules/${instruction.name}.md`;

  return (
    <SessionPageSheet visible dismissible onClose={onClose}>
      <SheetHeader
        variant="close"
        title={t('profiles.instructionViewTitle')}
        onDone={onClose}
        topInset="ios-page-sheet"
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-1.5">
          <FormFieldLabel label={nameLabel} />
          {/* No `numberOfLines`: the name wraps to its whole length, which is
              what the clamped row could not show. */}
          <SelectableText
            accessibilityLabel={nameLabel}
            className="font-mono text-sm leading-[1.25rem] text-foreground"
            style={codeFieldTextStyle()}
          >
            {instruction.name}
          </SelectableText>
          <Text variant="caption">{isolateLtrBidiText(rulesPath)}</Text>
        </View>
        <View className="gap-1.5">
          <FormFieldLabel label={contentLabel} />
          <SelectableText
            accessibilityLabel={contentLabel}
            className="font-mono text-sm leading-[1.25rem] text-foreground"
            style={codeFieldTextStyle()}
          >
            {instruction.content}
          </SelectableText>
        </View>
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
    </SessionPageSheet>
  );
}
