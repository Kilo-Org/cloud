/* oxlint-disable max-lines -- cohesive HTML segmentation, sanitization, and image/link wiring share one renderer */
import { useMemo } from 'react';
import { type Token } from 'marked';
import {
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  useWindowDimensions,
} from 'react-native';
import { MarkedLexer } from 'react-native-marked';
import RenderHTML, {
  type CustomBlockRenderer,
  type CustomMixedRenderer,
  type CustomTagRendererRecord,
  type DomVisitorCallbacks,
  type MixedStyleDeclaration,
  type RenderersProps,
  type TNode,
} from 'react-native-render-html';

import { isSupportedScheme } from './markdown-html-image';
import { MarkdownImage } from './markdown-image';
import { confirmAndOpenMarkdownLink } from './markdown-link-confirm';
import { getLinkAccessibilityActions, resolveLinkAccessibilityLabel } from './markdown-link';
import { type MarkdownPalette } from './markdown-palette';
import {
  type MarkdownLinkLongPressHandler,
  type MarkdownLinkPressHandler,
} from './markdown-renderer';
import { resolveImagePreviewAspectRatio } from './tool-card-attachments';

const REMOVED_HTML_TAGS = new Set([
  'script',
  'style',
  'link',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'audio',
  'video',
  'source',
  'track',
  'picture',
  'form',
  'input',
  'button',
  'select',
  'option',
  'optgroup',
  'textarea',
  'label',
  'fieldset',
  'legend',
  'datalist',
  'output',
  'meter',
  'progress',
  'svg',
  'canvas',
  'base',
  'head',
  'meta',
  'title',
  'template',
  'noscript',
]);

// Ignore only void tags here. The library preserves nested text when it ignores
// a container tag, so the visitor clears container contents before rendering.
const IGNORED_HTML_TAGS = ['link', 'frame', 'embed', 'source', 'track', 'input', 'base', 'meta'];
const HTML_DOM_VISITORS: DomVisitorCallbacks = {
  onElement(element) {
    if (REMOVED_HTML_TAGS.has(element.name)) {
      element.children.splice(0);
    }
  },
};

type MarkdownHtmlSegment = {
  type: 'html' | 'markdown';
  raw: string;
};

type HtmlRange = {
  start: number;
  end: number;
};

const VOID_HTML_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

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

function inlineHtmlRanges(raw: string, blockToken: Token): HtmlRange[] {
  const htmlTokens: (HtmlRange & { raw: string })[] = [];
  const inlineTokens: Token[] =
    blockToken.type === 'paragraph' || blockToken.type === 'heading'
      ? (blockToken.tokens ?? [])
      : [];
  let cursor =
    blockToken.type === 'heading' ? (/^ {0,3}#{1,6}(?:[ \t]+|$)/.exec(raw)?.[0].length ?? 0) : 0;
  for (const inlineToken of inlineTokens) {
    const start = cursor;
    cursor += inlineToken.raw.length;
    if (inlineToken.type === 'html') {
      htmlTokens.push({ start, end: cursor, raw: inlineToken.raw });
    }
  }

  const ranges: HtmlRange[] = [];
  const openTags: (HtmlRange & { name: string })[] = [];
  for (const token of htmlTokens) {
    const tag = /^<\s*(\/?)\s*([A-Za-z][\w:-]*)/.exec(token.raw);
    if (!tag) {
      ranges.push(token);
    } else {
      const name = tag[2]?.toLowerCase() ?? '';
      if (tag[1] === '/') {
        const openIndex = openTags.findLastIndex(open => open.name === name);
        const open = openTags[openIndex];
        if (open) {
          ranges.push({ start: open.start, end: token.end });
          openTags.splice(openIndex);
        } else {
          ranges.push(token);
        }
      } else if (VOID_HTML_TAGS.has(name) || /\/\s*>$/.test(token.raw)) {
        ranges.push(token);
      } else {
        openTags.push({ start: token.start, end: token.end, name });
      }
    }
  }
  ranges.push(...openTags);

  const merged: HtmlRange[] = [];
  for (const range of ranges.toSorted(
    (left, right) => left.start - right.start || right.end - left.end
  )) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function splitMarkdownHtml(value: string): MarkdownHtmlSegment[] {
  // eslint-disable-next-line new-cap -- react-native-marked exports the lexer function with this name
  const tokens = MarkedLexer(value, { gfm: true });
  const segments: MarkdownHtmlSegment[] = [];
  for (const token of tokens) {
    if (token.type === 'html') {
      pushSegment(segments, { type: 'html', raw: token.raw });
    } else {
      const ranges = inlineHtmlRanges(token.raw, token);
      let offset = 0;
      for (const range of ranges) {
        pushSegment(segments, { type: 'markdown', raw: token.raw.slice(offset, range.start) });
        pushSegment(segments, { type: 'html', raw: token.raw.slice(range.start, range.end) });
        offset = range.end;
      }
      pushSegment(segments, { type: 'markdown', raw: token.raw.slice(offset) });
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
  const baseStyle = useMemo<MixedStyleDeclaration>(
    () => ({ color: palette.textColor, fontSize: 16, lineHeight: 24 }),
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
        return null;
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
  }, [onLongPressLink, onPressLink]);

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
    />
  );
}
