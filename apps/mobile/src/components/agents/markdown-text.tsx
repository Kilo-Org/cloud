import { type ReactNode, useMemo } from 'react';
import { Linking, Text, type TextStyle, useColorScheme, View, type ViewStyle } from 'react-native';
import { Renderer, useMarkdown } from 'react-native-marked';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import {
  getMarkdownStyles,
  getPalette,
  type MarkdownPalette,
  type MarkdownVariant,
} from './markdown-palette';
import { MarkdownTable } from './markdown-table';

type MarkdownTextProps = {
  value: string;
  variant?: MarkdownVariant;
  selectable?: boolean;
};

// The library's default `Renderer` renders code blocks with the `em` text
// style (italic) and renders tables with fixed column widths that frequently
// overflow the screen with no way to scroll within a chat bubble. We subclass
// it to render code blocks in a monospace font and to render tables as a
// "View table" chip that opens a full-screen modal (see `MarkdownTable`).
//
// Notes on horizontal scrolling: the default library renders code (and we
// previously rendered tables) inside a horizontal ScrollView, but on RN 0.83
// Fabric a horizontal ScrollView inside a width-constrained bubble produces
// spurious vertical height (measured up to ~10x the actual content height,
// growing as sibling messages re-rendered the list), and its scroll gesture
// loses to the chat bubble's swipe-to-reply pan. We render code as a plain
// wrapping Text and tables behind a chip instead — no horizontal ScrollView
// ever renders inside a bubble.
class MarkdownRenderer extends Renderer {
  private readonly palette: MarkdownPalette;
  private readonly selectable: boolean;

  constructor(palette: MarkdownPalette, selectable = true) {
    super();
    this.palette = palette;
    this.selectable = selectable;
  }

  private textNode(children: string | ReactNode[], styles?: TextStyle): ReactNode {
    return (
      <Text selectable={this.selectable} key={this.getKey()} style={styles}>
        {children}
      </Text>
    );
  }

  override heading(text: string | ReactNode[], styles?: TextStyle): ReactNode {
    return this.textNode(text, styles);
  }

  // eslint-disable-next-line eslint/max-params -- signature fixed by react-native-marked's RendererInterface
  override code(
    text: string,
    _language: string | undefined,
    containerStyle: ViewStyle | undefined,
    _textStyle: TextStyle | undefined
  ): ReactNode {
    return (
      <View key={this.getKey()} style={containerStyle}>
        <Text
          selectable={this.selectable}
          className="font-mono text-sm leading-5"
          // eslint-disable-next-line react-native/no-inline-styles -- dynamic per-variant text color
          style={{ color: this.palette.textColor }}
        >
          {text}
        </Text>
      </View>
    );
  }

  override escape(text: string, styles?: TextStyle): ReactNode {
    return this.textNode(text, styles);
  }

  // eslint-disable-next-line eslint/max-params -- signature fixed by react-native-marked's RendererInterface
  override link(
    children: string | ReactNode[],
    href: string,
    styles?: TextStyle,
    title?: string
  ): ReactNode {
    return (
      <Text
        selectable={this.selectable}
        accessibilityRole="link"
        accessibilityHint="Opens in a new window"
        accessibilityLabel={title ?? 'Link'}
        key={this.getKey()}
        onPress={() => {
          void Linking.openURL(href);
        }}
        style={styles}
      >
        {children}
      </Text>
    );
  }

  override strong(children: string | ReactNode[], styles?: TextStyle): ReactNode {
    return this.textNode(children, styles);
  }

  override em(children: string | ReactNode[], styles?: TextStyle): ReactNode {
    return this.textNode(children, styles);
  }

  override codespan(text: string, styles?: TextStyle): ReactNode {
    return this.textNode(text, styles);
  }

  override br(): ReactNode {
    return this.textNode('\n', {});
  }

  override del(children: string | ReactNode[], styles?: TextStyle): ReactNode {
    return this.textNode(children, styles);
  }

  override text(text: string | ReactNode[], styles?: TextStyle): ReactNode {
    return this.textNode(text, styles);
  }

  override html(text: string | ReactNode[], styles?: TextStyle): ReactNode {
    return this.textNode(text, styles);
  }

  // eslint-disable-next-line eslint/max-params -- signature fixed by react-native-marked's RendererInterface
  override table(
    header: ReactNode[][],
    rows: ReactNode[][][],
    _tableStyle: ViewStyle | undefined,
    _rowStyle: ViewStyle | undefined,
    _cellStyle: ViewStyle | undefined
  ): ReactNode {
    return <MarkdownTable key={this.getKey()} palette={this.palette} header={header} rows={rows} />;
  }
}

export function MarkdownText({
  value,
  variant = 'assistant',
  selectable = true,
}: Readonly<MarkdownTextProps>) {
  const colorScheme = useColorScheme();
  const colors = useThemeColors();

  const { styles, renderer, theme } = useMemo(() => {
    const palette = getPalette(variant, colors);
    return {
      styles: getMarkdownStyles(palette),
      renderer: new MarkdownRenderer(palette, selectable),
      theme: {
        colors: {
          text: palette.textColor,
          code: palette.textColor,
          link: palette.textColor,
          border: palette.borderColor,
        },
      },
    };
  }, [variant, colors, selectable]);

  const elements = useMarkdown(value, {
    colorScheme,
    theme,
    styles,
    renderer,
  });

  return <View>{elements}</View>;
}
