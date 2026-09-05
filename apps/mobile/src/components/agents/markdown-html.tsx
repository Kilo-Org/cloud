/* oxlint-disable max-lines -- cohesive HTML segmentation, sanitization, and image/link wiring share one renderer */
import { useMemo } from 'react';
import { marked, type Token } from 'marked';
import {
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  Text,
  useWindowDimensions,
} from 'react-native';
import { MarkedLexer } from 'react-native-marked';
import RenderHTML, {
  type CustomBlockRenderer,
  type CustomMixedRenderer,
  type CustomTagRendererRecord,
  type DomVisitorCallbacks,
  type RenderersProps,
  type TNode,
} from 'react-native-render-html';

import { isSupportedScheme } from './markdown-html-image';
import { REMOVED_HTML_TAGS } from './markdown-html-sanitization';
import { MarkdownImage } from './markdown-image';
import { confirmAndOpenMarkdownLink } from './markdown-link-confirm';
import { getLinkAccessibilityActions, resolveLinkAccessibilityLabel } from './markdown-link';
import {
  getMarkdownHeadingStyles,
  getMarkdownHtmlTagStyles,
  type MarkdownPalette,
} from './markdown-palette';
import {
  type MarkdownLinkLongPressHandler,
  type MarkdownLinkPressHandler,
} from './markdown-renderer';
import { resolveImagePreviewAspectRatio } from './tool-card-attachments';

const REMOVED_HTML_TAG_SET = new Set<string>(REMOVED_HTML_TAGS);

// Ignore only void tags here. The library preserves nested text when it ignores
// a container tag, so the visitor clears container contents before rendering.
const IGNORED_HTML_TAGS = ['link', 'frame', 'embed', 'source', 'track', 'input', 'base', 'meta'];
const HTML_DOM_VISITORS: DomVisitorCallbacks = {
  onElement(element) {
    if (REMOVED_HTML_TAG_SET.has(element.name)) {
      element.children.splice(0);
    }
  },
};

type MarkdownHtmlSegment = {
  type: 'html' | 'markdown';
  raw: string;
};

function pushSegment(segments: MarkdownHtmlSegment[], segment: MarkdownHtmlSegment) {
  if (segment.raw.length === 0) {
    return;
  }
  const previous = segments.at(-1);
  if (previous?.type === segment.type) {
    previous.raw += segment.raw;
  } else {
    segments.push(segment);
  }
}

function hasDirectHtml(token: Token): boolean {
  if (token.type !== 'paragraph' && token.type !== 'heading') {
    return false;
  }
  return (token.tokens ?? []).some(inlineToken => inlineToken.type === 'html');
}

// react-native-marked renders inline HTML tokens through `MarkdownRenderer.html`,
// which shows them as plain text: a link, heading, or emphasis tag nested inside
// a list item or blockquote loses the styling its Markdown equivalent keeps.
// Those tags are the ones the HTML engine styles; containers holding only
// unstyled tags (div, span, …) stay on the Markdown path by design.
const STYLED_HTML_TAGS = new Set([
  'a',
  'b',
  'strong',
  'em',
  'i',
  'u',
  's',
  'del',
  'ins',
  'mark',
  'small',
  'sub',
  'sup',
  'code',
  'kbd',
  'samp',
  'var',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'br',
  'hr',
]);

// Containers whose nested HTML the Markdown lexer cannot style. Code and table
// descendants are excluded from routing so fenced code keeps the CodeBlock and
// tables keep the MarkdownTable chip.
const NESTED_HTML_CONTAINERS = new Set(['list', 'blockquote']);

function tokenChildren(token: Token): Token[] {
  const container = token as { tokens?: Token[]; items?: Token[] };
  return [...(container.tokens ?? []), ...(container.items ?? [])];
}

function htmlRawHasStyledTag(raw: string): boolean {
  for (const match of raw.matchAll(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/g)) {
    const tagName = match[1];
    if (tagName !== undefined && STYLED_HTML_TAGS.has(tagName.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function containsStyledHtml(token: Token): boolean {
  if (token.type === 'html') {
    return htmlRawHasStyledTag(token.raw);
  }
  return tokenChildren(token).some(child => containsStyledHtml(child));
}

function containsRichBlock(token: Token): boolean {
  if (token.type === 'code' || token.type === 'table') {
    return true;
  }
  return tokenChildren(token).some(child => containsRichBlock(child));
}

function routesNestedHtml(token: Token): boolean {
  return (
    NESTED_HTML_CONTAINERS.has(token.type) && containsStyledHtml(token) && !containsRichBlock(token)
  );
}

export function splitMarkdownHtml(value: string): MarkdownHtmlSegment[] {
  // eslint-disable-next-line new-cap -- react-native-marked exports the lexer function with this name
  const tokens = MarkedLexer(value, { gfm: true });
  const segments: MarkdownHtmlSegment[] = [];
  for (const token of tokens) {
    if (token.type === 'html') {
      pushSegment(segments, { type: 'html', raw: token.raw });
    } else if (hasDirectHtml(token) || routesNestedHtml(token)) {
      pushSegment(segments, {
        type: 'html',
        raw: marked.parse(token.raw, { async: false, gfm: true }),
      });
    } else {
      pushSegment(segments, { type: 'markdown', raw: token.raw });
    }
  }
  return segments.some(segment => segment.type === 'html')
    ? segments
    : [{ type: 'markdown', raw: value }];
}

function parentAnchor(tnode: TNode): TNode | null {
  let current = tnode.parent;
  while (current !== null) {
    if (current.tagName === 'a') {
      return current;
    }
    current = current.parent;
  }
  return null;
}

type MarkdownHtmlProps = {
  html: string;
  palette: MarkdownPalette;
  selectable: boolean;
  onLongPressLink?: MarkdownLinkLongPressHandler;
  onPressLink?: MarkdownLinkPressHandler;
};

export function MarkdownHtml({
  html,
  palette,
  selectable,
  onLongPressLink,
  onPressLink,
}: Readonly<MarkdownHtmlProps>) {
  const { width } = useWindowDimensions();
  const source = useMemo(() => ({ html }), [html]);
  const baseStyle = useMemo(
    () => ({ color: palette.textColor, fontSize: 16, lineHeight: 24 }),
    [palette]
  );
  const tagsStyles = useMemo(
    () => ({ ...getMarkdownHeadingStyles(palette), ...getMarkdownHtmlTagStyles(palette) }),
    [palette]
  );
  const renderersProps = useMemo<Partial<RenderersProps>>(
    () => ({
      a: {
        onPress: (_event, href, attributes) => {
          if (!onPressLink?.(href)) {
            confirmAndOpenMarkdownLink(href, { label: attributes.title });
          }
        },
      },
    }),
    [onPressLink]
  );
  const renderers = useMemo<CustomTagRendererRecord>(() => {
    const showLinkActions = (href: string, label?: string, event?: GestureResponderEvent) => {
      if (onLongPressLink) {
        onLongPressLink(href, event);
      } else {
        confirmAndOpenMarkdownLink(href, { label });
      }
    };
    const HtmlAnchor: CustomMixedRenderer = ({ InternalRenderer, ...props }) => {
      const href = props.tnode.attributes.href ?? '';
      const label = props.tnode.attributes.title;
      return (
        <InternalRenderer
          {...props}
          textProps={{
            ...props.textProps,
            accessibilityActions: getLinkAccessibilityActions(onLongPressLink !== undefined),
            onAccessibilityAction: (event: AccessibilityActionEvent) => {
              if (event.nativeEvent.actionName === 'showLinkActions') {
                onLongPressLink?.(href);
              }
            },
            onLongPress: (event: GestureResponderEvent) => {
              showLinkActions(href, label, event);
            },
          }}
        />
      );
    };
    const HtmlImage: CustomBlockRenderer = ({ tnode }) => {
      const src = tnode.attributes.src ?? '';
      if (!isSupportedScheme(src)) {
        return (
          <Text selectable={selectable} style={baseStyle}>
            {tnode.attributes.alt ?? ''}
          </Text>
        );
      }
      const anchor = parentAnchor(tnode);
      const href = anchor?.attributes.href;
      const linkLabel = href
        ? resolveLinkAccessibilityLabel(tnode.attributes.alt ?? '', href, anchor.attributes.title)
        : undefined;
      return (
        <MarkdownImage
          uri={src}
          alt={tnode.attributes.alt ?? ''}
          aspectRatio={resolveImagePreviewAspectRatio(
            Number(tnode.attributes.width),
            Number(tnode.attributes.height)
          )}
          accessibilityLabel={linkLabel}
          onPress={
            href
              ? () => {
                  if (!onPressLink?.(href)) {
                    confirmAndOpenMarkdownLink(href, { label: linkLabel });
                  }
                }
              : undefined
          }
          onShowLinkActions={
            href
              ? () => {
                  showLinkActions(href, anchor.attributes.title);
                }
              : undefined
          }
        />
      );
    };
    return { a: HtmlAnchor, img: HtmlImage };
  }, [baseStyle, onLongPressLink, onPressLink, selectable]);

  return (
    <RenderHTML
      baseStyle={baseStyle}
      contentWidth={width}
      defaultTextProps={{ selectable }}
      domVisitors={HTML_DOM_VISITORS}
      enableCSSInlineProcessing={false}
      ignoredDomTags={IGNORED_HTML_TAGS}
      renderers={renderers}
      renderersProps={renderersProps}
      source={source}
      tagsStyles={tagsStyles}
    />
  );
}
