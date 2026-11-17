import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Clipboard } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import {
  SECTION_ACTION_BOX_CLASS,
  SECTION_ACTION_HIT_SLOP,
  SECTION_HEADER_ROW_PADDING_CLASS,
} from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

import { CodeBlock } from './code-block';
import { performCopy } from './use-message-copy';
import { type MarkdownCopyCodeHandler } from './markdown-handlers';
import { type MarkdownPalette } from './markdown-palette';

type MarkdownCodeFenceProps = {
  code: string;
  language: string | null;
  palette: MarkdownPalette;
  selectable: boolean;
  onCopyCode?: MarkdownCopyCodeHandler;
};

/**
 * A fenced code block from a markdown run, drawn on the code card the native
 * renderer drew (same background, radius, padding and margins) with the same
 * header: the fence's language and a copy button.
 *
 * The code itself goes through `CodeBlock`, which wraps outside the tool detail
 * sheet instead of scrolling, so every line is readable. The native renderer's
 * fence scrolls horizontally and its pane never receives the pan inside the
 * conversation list (see `mono-scroll-block.tsx`), which clipped long lines.
 *
 * Without a host handler the copy button still copies the fence's source,
 * matching the renderer's own button.
 *
 * The language chip is a stop of its own, named by the language it shows, so
 * Android does not fold it into the message group's name ahead of the role;
 * an unnamed fence keeps a bare chip rather than an empty focus stop.
 */
export function MarkdownCodeFence({
  code,
  language,
  palette,
  selectable,
  onCopyCode,
}: Readonly<MarkdownCodeFenceProps>) {
  const { t } = useTranslation();
  const copy = onCopyCode ?? ((source: string) => void performCopy(source));
  return (
    <View
      className="my-1 overflow-hidden rounded-lg px-3 pb-3"
      // eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- the card color is the markdown variant's runtime palette
      style={{ backgroundColor: palette.codeBackground }}
    >
      <View
        className={cn(
          'mb-1 flex-row items-center justify-between',
          SECTION_HEADER_ROW_PADDING_CLASS
        )}
      >
        <Text
          variant="caption"
          // eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- the label tracks the markdown variant's palette
          style={{ color: palette.mutedTextColor }}
          numberOfLines={1}
          {...(language ? { accessible: true, accessibilityLabel: language } : {})}
        >
          {language ?? ''}
        </Text>
        {/* The copy control keeps the section header's compact box, and the row
            reserves its hit slop as padding, so the whole touch target lies
            inside the row that delivers it: the row is 28 + 9 + 9 dp tall
            instead of the 48 dp icon box's, and the box itself is never larger
            than one text line (apps/mobile/AGENTS.md:211). */}
        <Pressable
          className={cn(SECTION_ACTION_BOX_CLASS, 'items-center justify-center active:opacity-70')}
          hitSlop={SECTION_ACTION_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={t('common.copy')}
          onPress={() => {
            copy(code);
          }}
        >
          <Clipboard size={14} color={palette.mutedTextColor} />
        </Pressable>
      </View>
      <CodeBlock
        code={code}
        language={language}
        selectable={selectable}
        baseColor={palette.textColor}
        tokenScheme={palette.codeTokenScheme}
      />
    </View>
  );
}
