import { createElement, type ReactNode } from 'react';
import {
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import { Renderer } from 'react-native-marked';

import { openExternalUrl } from '@/lib/external-link';

import {
  getLinkAccessibilityActions,
  getLinkLongPressHandler,
  LINK_ACCESSIBILITY_HINT,
  resolveLinkAccessibilityLabel,
} from './markdown-link';
import { type MarkdownPalette } from './markdown-palette';
import { MarkdownTable } from './markdown-table';

export type MarkdownLinkLongPressHandler = (href: string, event?: GestureResponderEvent) => void;

export type MarkdownLinkPressHandler = (href: string) => boolean;

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
type MarkdownRendererHandlers = {
  onLongPressLink?: MarkdownLinkLongPressHandler;
  onPressLink?: MarkdownLinkPressHandler;
};

export class MarkdownRenderer extends Renderer {
  private readonly palette: MarkdownPalette;
  private readonly selectable: boolean;
  private readonly onLongPressLink?: MarkdownLinkLongPressHandler;
  private readonly onPressLink?: MarkdownLinkPressHandler;
  // Ordinal host key: Parser parses every header/body cell (each consuming
  // getKey()) before table() returns, so a slugger-based host key would shift
  // as rows/cells grow. A fresh renderer per parse restarts this counter, so
  // the k-th table keeps `md-table-(k-1)` across re-parses regardless of size.
  private tableIndex = 0;

  constructor(palette: MarkdownPalette, selectable: boolean, handlers: MarkdownRendererHandlers) {
    super();
    this.palette = palette;
    this.selectable = selectable;
    this.onLongPressLink = handlers.onLongPressLink;
    this.onPressLink = handlers.onPressLink;
  }

  private textNode(children: string | ReactNode[], styles?: TextStyle): ReactNode {
    return createElement(
      Text,
      { selectable: this.selectable, key: this.getKey(), style: styles },
      children
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
    return createElement(
      View,
      { key: this.getKey(), style: containerStyle },
      createElement(
        Text,
        {
          selectable: this.selectable,
          className: 'font-mono text-sm leading-5',
          // eslint-disable-next-line react-native/no-inline-styles -- dynamic per-variant text color
          style: { color: this.palette.textColor },
        },
        text
      )
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
    const accessibilityLabel = resolveLinkAccessibilityLabel(children, href, title);
    const linkActionsEnabled = this.onLongPressLink !== undefined;

    return createElement(
      Text,
      {
        selectable: this.selectable,
        accessibilityRole: 'link',
        accessibilityHint: LINK_ACCESSIBILITY_HINT,
        accessibilityLabel,
        accessibilityActions: getLinkAccessibilityActions(linkActionsEnabled),
        key: this.getKey(),
        onAccessibilityAction: (event: AccessibilityActionEvent) => {
          if (event.nativeEvent.actionName === 'showLinkActions') {
            this.onLongPressLink?.(href);
          }
        },
        onLongPress: getLinkLongPressHandler(this.onLongPressLink, href),
        onPress: () => {
          const handled = this.onPressLink?.(href);
          if (handled) {
            return;
          }
          void openExternalUrl(href, { label: accessibilityLabel });
        },
        style: styles,
      },
      children
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
    const key = `md-table-${this.tableIndex}`;
    this.tableIndex += 1;
    return createElement(MarkdownTable, {
      key,
      palette: this.palette,
      header,
      rows,
    });
  }
}
