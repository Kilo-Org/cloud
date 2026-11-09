import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Clipboard } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/icon-button';
import { Text } from '@/components/ui/text';

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
      className="my-1 overflow-hidden rounded-lg px-3 pt-2 pb-3"
      // eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- the card color is the markdown variant's runtime palette
      style={{ backgroundColor: palette.codeBackground }}
    >
      <View className="mb-1 flex-row items-center justify-between">
        <Text
          className="text-[11px] font-medium"
          // eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- the label tracks the markdown variant's palette
          style={{ color: palette.mutedTextColor }}
          numberOfLines={1}
        >
          {language ?? ''}
        </Text>
        <IconButton
          accessibilityLabel={t('common.copy')}
          onPress={() => {
            copy(code);
          }}
        >
          <Clipboard size={14} color={palette.mutedTextColor} />
        </IconButton>
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
