import {
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  type AccessibilityActionEvent,
  type AccessibilityRole,
  type GestureResponderEvent,
  type ImageStyle,
  Pressable,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import { Renderer } from 'react-native-marked';

import { openExternalUrl } from '@/lib/external-link';

import { CodeBlock } from './code-block';
import { normalizeFenceLanguage } from './code-block-model';
import { isSupportedScheme, parseHtmlImages } from './markdown-html-image';
import { MarkdownImage } from './markdown-image';
import {
  getLinkAccessibilityActions,
  getLinkAccessibilityHint,
  getLinkLongPressHandler,
  resolveLinkAccessibilityLabel,
} from './markdown-link';
import { type MarkdownPalette } from './markdown-palette';
import { MarkdownTable } from './markdown-table';

export type MarkdownLinkLongPressHandler = (href: string, event?: GestureResponderEvent) => void;

export type MarkdownLinkPressHandler = (href: string) => boolean;

// Fenced code blocks are highlighted by the shared CodeBlock; a huge pasted
// fence must not threaten the transcript's scroll performance, so the code
// payload is capped and the hit shows the shared Truncated marker.
export const MARKDOWN_CODE_CHARACTER_CAP = 50_000;

/** Recursively checks whether any node in the tree is a MarkdownImage. */
function containsMarkdownImage(nodes: ReactNode[]): boolean {
  for (const node of nodes) {
    if (Array.isArray(node)) {
      if (containsMarkdownImage(node as ReactNode[])) {
        return true;
      }
    } else if (isValidElement(node)) {
      if (node.type === MarkdownImage) {
        return true;
      }
      const children = (node.props as { children?: ReactNode }).children;
      if (children !== undefined) {
        const list = Array.isArray(children)
          ? (children as ReactNode[])
          : ([children] as ReactNode[]);
        if (containsMarkdownImage(list)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Recursively checks whether any node in the tree carries non-image text
 * content. Whitespace-only strings do not count, so a heading that is an
 * image plus trailing whitespace still counts as image-only.
 */
function containsMeaningfulNonImageText(nodes: ReactNode[]): boolean {
  for (const node of nodes) {
    if (Array.isArray(node)) {
      if (containsMeaningfulNonImageText(node as ReactNode[])) {
        return true;
      }
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ReactNode primitive-arm check; no non-typeof discriminant separates string/number in this union
    } else if (typeof node === 'string') {
      if (node.trim().length > 0) {
        return true;
      }
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ReactNode primitive-arm check; no non-typeof discriminant separates string/number in this union
    } else if (typeof node === 'number') {
      return true;
    } else if (isValidElement(node)) {
      const children = (node.props as { children?: ReactNode }).children;
      if (node.type !== MarkdownImage && children !== undefined) {
        const list = Array.isArray(children)
          ? (children as ReactNode[])
          : ([children] as ReactNode[]);
        if (containsMeaningfulNonImageText(list)) {
          return true;
        }
      }
    }
  }
  return false;
}

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
  private imageIndex = 0;

  constructor(palette: MarkdownPalette, selectable: boolean, handlers: MarkdownRendererHandlers) {
    super();
    this.palette = palette;
    this.selectable = selectable;
    this.onLongPressLink = handlers.onLongPressLink;
    this.onPressLink = handlers.onPressLink;
  }

  private textNode(
    children: string | ReactNode[],
    styles?: TextStyle,
    extraProps: { accessibilityRole?: AccessibilityRole } = {}
  ): ReactNode {
    return createElement(
      Text,
      { selectable: this.selectable, key: this.getKey(), style: styles, ...extraProps },
      children
    );
  }

  private textOrChildren(children: string | ReactNode[], styles?: TextStyle): ReactNode {
    if (Array.isArray(children) && children.length > 0 && containsMarkdownImage(children)) {
      return children;
    }
    return this.textNode(children, styles);
  }

  override heading(text: string | ReactNode[], styles?: TextStyle): ReactNode {
    // Headings announce as headers; image-only headings stay pass-through so
    // the image keeps its own tap target and label. A heading that mixes an
    // image with real text keeps header semantics, so wrap it in a
    // header-role View that leaves the image reachable.
    if (Array.isArray(text) && text.length > 0 && containsMarkdownImage(text)) {
      if (containsMeaningfulNonImageText(text)) {
        return createElement(View, { accessibilityRole: 'header', key: this.getKey() }, text);
      }
      return text;
    }
    return this.textNode(text, styles, { accessibilityRole: 'header' });
  }

  // eslint-disable-next-line eslint/max-params -- signature fixed by react-native-marked's RendererInterface
  override code(
    text: string,
    language: string | undefined,
    containerStyle: ViewStyle | undefined,
    _textStyle: TextStyle | undefined
  ): ReactNode {
    return createElement(
      View,
      { key: this.getKey(), style: containerStyle },
      createElement(CodeBlock, {
        code: text,
        language: normalizeFenceLanguage(language),
        selectable: this.selectable,
        baseColor: this.palette.textColor,
        maxLength: MARKDOWN_CODE_CHARACTER_CAP,
      })
    );
  }

  // Loose Markdown lists — any blank line between items — wrap every item's
  // text in a paragraph View (marked rewrites item `text` tokens to
  // `paragraph` tokens). That paragraph's top margin pushes the first line
  // below the marker, which sits at the row top (see the `list` style note
  // in markdown-palette.ts). Rewrite the leading paragraph View's vertical
  // margin so loose and tight items start their first line at the row top
  // alike. A leading blockquote or hr View has border properties but no
  // `paddingVertical`, so it keeps its own spacing.
  override listItem(children: ReactNode[], styles?: ViewStyle): ReactNode {
    const first = children[0];
    if (isValidElement(first) && first.type === View) {
      const styleProp = (first.props as { style?: ViewStyle }).style;
      // The paragraph View is the only leading View whose style carries the
      // paragraph's `paddingVertical` (palette paragraph is
      // { marginVertical: 2, paddingVertical: 0 }).
      if (styleProp !== undefined && 'paddingVertical' in styleProp) {
        const { marginVertical, marginBottom, ...rest } = styleProp;
        const adjusted: ViewStyle = {
          ...rest,
          marginTop: 0,
          marginBottom: marginBottom ?? marginVertical,
        };
        return super.listItem(
          [
            // eslint-disable-next-line react/no-clone-element -- listItem must rewrite the leading paragraph View's style in place; cloning preserves the element's key and the renderer's key sequence
            cloneElement(first as ReactElement<{ style?: ViewStyle }>, {
              style: adjusted,
            }),
            ...children.slice(1),
          ],
          styles
        );
      }
    }
    return super.listItem(children, styles);
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
    const interactionProps = this.linkInteractionProps(children, href, title);
    if (Array.isArray(children) && children.length > 0 && containsMarkdownImage(children)) {
      return createElement(Pressable, { ...interactionProps, key: this.getKey() }, children);
    }
    return createElement(
      Text,
      {
        ...interactionProps,
        selectable: this.selectable,
        key: this.getKey(),
        style: styles,
      },
      children
    );
  }

  /** Interaction wiring shared by the Pressable (image) and Text link branches. */
  private linkInteractionProps(children: string | ReactNode[], href: string, title?: string) {
    const accessibilityLabel = resolveLinkAccessibilityLabel(children, href, title);
    return {
      accessibilityRole: 'link' as const,
      accessibilityHint: getLinkAccessibilityHint(),
      accessibilityLabel,
      accessibilityActions: getLinkAccessibilityActions(this.onLongPressLink !== undefined),
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
    };
  }

  override strong(children: string | ReactNode[], styles?: TextStyle): ReactNode {
    return this.textOrChildren(children, styles);
  }

  override em(children: string | ReactNode[], styles?: TextStyle): ReactNode {
    return this.textOrChildren(children, styles);
  }

  override codespan(text: string, styles?: TextStyle): ReactNode {
    return this.textNode(text, styles);
  }

  override br(): ReactNode {
    return this.textNode('\n', {});
  }

  override del(children: string | ReactNode[], styles?: TextStyle): ReactNode {
    return this.textOrChildren(children, styles);
  }

  override text(text: string | ReactNode[], styles?: TextStyle): ReactNode {
    return this.textOrChildren(text, styles);
  }

  // eslint-disable-next-line eslint/max-params -- signature fixed by react-native-marked's RendererInterface
  override image(uri: string, alt?: string, _style?: ImageStyle, title?: string): ReactNode {
    if (!isSupportedScheme(uri)) {
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must fall back to title; ?? would skip ''
      return this.textNode(alt || title || '', {});
    }
    const key = `md-image-${this.imageIndex}`;
    this.imageIndex += 1;
    return createElement(MarkdownImage, {
      key,
      uri,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string must fall back to title; ?? would skip ''
      alt: alt || title || '',
    });
  }

  override html(text: string | ReactNode[], styles?: TextStyle): ReactNode {
    if (Array.isArray(text)) {
      return this.textOrChildren(text, styles);
    }
    const images = parseHtmlImages(text);
    if (images.length === 0) {
      return this.textNode(text, styles);
    }
    const baseKey = `md-html-image-${this.imageIndex}`;
    this.imageIndex += 1;
    const elements = images.map((image, index) =>
      createElement(MarkdownImage, {
        key: `${baseKey}-${index}`,
        uri: image.src,
        alt: image.alt,
        aspectRatio: image.aspectRatio,
      })
    );
    return elements.length === 1 ? elements[0] : elements;
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
