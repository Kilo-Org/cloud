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

import { withRtlWritingDirection } from '@/lib/rtl-text';

import { isSupportedScheme, resolveHtmlImageAspectRatio } from './markdown-html-image';
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

const REMOVED_HTML_TAG_SET = new Set<string>(REMOVED_HTML_TAGS);

// Ignore only void tags here: the engine drops an ignored tag's whole subtree.
// The visitor below handles containers — clearing the contents of removed ones
// and hoisting the children of `picture` so its fallback `<img>` still renders.
const IGNORED_HTML_TAGS = ['link', 'frame', 'embed', 'source', 'track', 'input', 'base', 'meta'];
const HTML_DOM_VISITORS: DomVisitorCallbacks = {
  onElement(element) {
    if (REMOVED_HTML_TAG_SET.has(element.name)) {
      element.children.splice(0);
    } else if (element.name === 'picture' && element.parent !== null) {
      // Dropping the `<picture>` wrapper must not drop its fallback `<img>`:
      // replace the wrapper with its children (`<source>` candidates never
      // reach the tree; removed children are already cleared above).
      const index = element.parent.children.indexOf(element);
      if (index !== -1) {
        element.parent.children.splice(index, 1, ...element.children);
      }
    }
  },
};

type MarkdownHtmlSegment = {
  type: 'html' | 'markdown';
  raw: string;
};

/**
 * The reusable head of a previous `splitMarkdownHtmlIncremental` call: `value`
 * is the exact string it segmented, `headSegments` the segments of the stable
 * tokens before the tail boundary, and `tailStart` the source offset where the
 * tail begins. A longer value that extends `value` re-lexes only from
 * `tailStart`, which keeps the last block run and any list or blockquote that
 * can still absorb it out of the frozen head. `hasDefinition` records that the
 * value contains a top-level link reference definition, whose duplicate-raw
 * handling stops marked's tokens from tiling the source; such a value disables
 * head reuse entirely.
 */
export type MarkdownHtmlSnapshot = {
  value: string;
  tailStart: number;
  headSegments: readonly MarkdownHtmlSegment[];
  headHasHtml: boolean;
  hasDefinition: boolean;
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

// The incremental path shares the snapshot's `headSegments` array with the
// caller, so it must never mutate the last element in place: replace it.
function pushSegmentCopyOnWrite(segments: MarkdownHtmlSegment[], segment: MarkdownHtmlSegment) {
  if (segment.raw.length === 0) {
    return;
  }
  const previous = segments.at(-1);
  if (previous?.type === segment.type) {
    segments[segments.length - 1] = { ...previous, raw: previous.raw + segment.raw };
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

function tokenSegment(token: Token): MarkdownHtmlSegment {
  if (token.type === 'html') {
    return { type: 'html', raw: token.raw };
  }
  if (hasDirectHtml(token) || routesNestedHtml(token)) {
    return {
      type: 'html',
      raw: marked.parse(token.raw, { async: false, gfm: true }),
    };
  }
  return { type: 'markdown', raw: token.raw };
}

export function splitMarkdownHtml(value: string): MarkdownHtmlSegment[] {
  // eslint-disable-next-line new-cap -- react-native-marked exports the lexer function with this name
  const tokens = MarkedLexer(value, { gfm: true });
  const segments: MarkdownHtmlSegment[] = [];
  for (const token of tokens) {
    pushSegment(segments, tokenSegment(token));
  }
  return segments.some(segment => segment.type === 'html')
    ? segments
    : [{ type: 'markdown', raw: value }];
}

// A top-level link reference definition makes marked drop a duplicate
// definition's raw text, so its block tokens no longer tile the source and a
// raw-length offset is no longer a source offset. A definition in the re-lexed
// region therefore disables head reuse; the value still renders through the
// whole-value path.
function hasDefinitionToken(tokens: readonly Token[]): boolean {
  return tokens.some(token => token.type === 'def');
}

/** A head plus the tail that the next incremental parse re-lexes. */
type MarkdownHtmlAppend = {
  segments: MarkdownHtmlSegment[];
  tailStart: number;
};

/** A segmentation of a value together with the snapshot the next call reuses. */
type MarkdownHtmlSplit = {
  segments: MarkdownHtmlSegment[];
  snapshot: MarkdownHtmlSnapshot;
};

// Block types that absorb a following block across a blank line: a list takes
// the next item and a blockquote keeps a quoted paragraph, so one of these must
// stay in the tail while only a blank line separates it from text the next
// publish can still change.
const ABSORBING_BLOCK_TYPES = new Set(['list', 'blockquote']);

// A `space` token permanently ends the block before it only when it holds
// nothing but spaces and newlines. Marked's paragraph tokenizer treats a line
// of spaces as blank but lets a line containing a tab continue the paragraph, so
// a `space` token with a tab is provisional: `x\n\t\n` lexes as a paragraph plus
// a space token, while `x\n\t\n- a` pulls the tab line back into the paragraph.
// A boundary drawn after a provisional separator would freeze a paragraph the
// next append can still extend.
const STABLE_SEPARATOR = /^ *\n+$/;
function isStableSeparator(token: Token | undefined): boolean {
  return token?.type === 'space' && STABLE_SEPARATOR.test(token.raw);
}

/**
 * The index of the first token a later append can still change; every earlier
 * token is a stable head. Three rules keep the boundary safe:
 *
 * - The last block run — the tokens after the final stable separator — is never
 *   frozen. Marked's block tokenizer decides inside a run whether a line
 *   interrupts a paragraph or continues it, and that decision flips when a
 *   later line arrives: `1. a\n\n2` lexes as a list plus a paragraph, but
 *   appending `.` turns the paragraph into the list's second item, so the list
 *   token's raw grows retroactively.
 * - A list or blockquote that only a stable separator separates from that run
 *   is not frozen either, for the same reason: it absorbs the run once the run's
 *   text becomes a list item or a quoted paragraph.
 * - An absorbing block pulled into the tail brings its whole run with it: a
 *   block earlier in that run (a paragraph a list item merges into) can absorb
 *   the block too, so the boundary walks back to the run's first token and then
 *   repeats the previous rule.
 * - A provisional separator carries its run back with it: the scan walks past it
 *   to the last separator the next append cannot eat.
 *
 * The last non-space token always stays in the tail so the next publish has a
 * non-empty suffix to re-lex; a head that ends at `value.length` would disable
 * reuse. The returned boundary is always 0 or directly preceded by a stable
 * separator.
 */
function tailBoundaryIndex(tokens: readonly Token[]): number {
  let lastNonSpace = -1;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index]?.type !== 'space') {
      lastNonSpace = index;
      break;
    }
  }
  if (lastNonSpace === -1) {
    return 0;
  }
  let start = 0;
  for (let index = lastNonSpace - 1; index >= 0; index -= 1) {
    if (isStableSeparator(tokens[index])) {
      start = index + 1;
      break;
    }
  }
  // The boundary must never land inside a block run. Pulling an absorbing list
  // or blockquote into the tail is not enough on its own: the run that holds it
  // can start earlier, and a block earlier in that run (a paragraph a list item
  // merges into, as in `<b>x</b>\n2. b \n-`) can absorb the absorbing block and
  // everything after it. Walk back to the run's first token every time the
  // boundary moves, then repeat the absorbing-block check, because that run can
  // itself begin with an absorbing block behind a stable separator. The result
  // is always 0 or a boundary directly preceded by a stable separator.
  let backedUp = true;
  while (backedUp) {
    while (start > 0 && !isStableSeparator(tokens[start - 1])) {
      start -= 1;
    }
    backedUp =
      start >= 2 &&
      isStableSeparator(tokens[start - 1]) &&
      ABSORBING_BLOCK_TYPES.has(tokens[start - 2]?.type ?? '');
    if (backedUp) {
      start -= 2;
    }
  }
  return Math.min(start, lastNonSpace);
}

/**
 * Append a token list to a head, splitting at `tailBoundaryIndex`: every earlier
 * token becomes part of the head (shared with the caller's snapshot, so every
 * push is copy-on-write), the boundary token and everything after it stay in the
 * returned tail for the next publish to re-lex. `segments` starts as a copy of
 * the head and shares its element objects, which is safe only because nothing is
 * mutated in place.
 */
function appendTokens(
  tokens: readonly Token[],
  headSegments: MarkdownHtmlSegment[],
  tailStart: number
): MarkdownHtmlAppend {
  const segments = [...headSegments];
  const tailSegments: MarkdownHtmlSegment[] = [];
  let nextTailStart = tailStart;
  const boundary = tailBoundaryIndex(tokens);
  for (const [index, token] of tokens.entries()) {
    const segment = tokenSegment(token);
    if (index < boundary) {
      pushSegmentCopyOnWrite(headSegments, segment);
      pushSegmentCopyOnWrite(segments, segment);
      nextTailStart += token.raw.length;
    } else {
      pushSegmentCopyOnWrite(tailSegments, segment);
    }
  }
  for (const segment of tailSegments) {
    pushSegmentCopyOnWrite(segments, segment);
  }
  return { segments, tailStart: nextTailStart };
}

/**
 * Streaming-aware `splitMarkdownHtml`: when `value` extends the previous
 * snapshot it re-lexes only the text from that snapshot's tail boundary — the
 * last block run and any list or blockquote that can still absorb it (see
 * `tailBoundaryIndex`) — and reuses the head segments unchanged, so a message
 * that grows one publish at a time stays proportional to the last block instead
 * of the whole value. The result is identical to `splitMarkdownHtml(value)` for
 * every value that extends the snapshot.
 */
export function splitMarkdownHtmlIncremental(
  value: string,
  previous?: MarkdownHtmlSnapshot
): MarkdownHtmlSplit {
  // Fast path: `hasDirectHtml` and `routesNestedHtml` both need a `<` in the
  // raw token text, so a `<`-free value can never produce an html segment and
  // needs no lex at all. Keeping the whole value as the head means the next
  // publish lexes only the appended suffix.
  if (!value.includes('<')) {
    const segment: MarkdownHtmlSegment = { type: 'markdown', raw: value };
    return {
      segments: [segment],
      snapshot: {
        value,
        tailStart: value.length,
        headSegments: [segment],
        headHasHtml: false,
        hasDefinition: false,
      },
    };
  }

  // Reuse the head only when the previous value ended at a real token boundary.
  // The `<`-free fast path keeps the whole value as an unstripped head
  // (`tailStart === value.length`), so if the appended text turns out to
  // continue that last block with inline HTML (an inline tag after text, a list
  // item, an unterminated fence) the head would not match what a whole-value
  // lex produces; lex the whole value once to re-establish the boundary, then
  // every later publish reuses the snapshot again. A value with a carriage
  // return never reuses a head either: marked normalizes `\r\n` out of token
  // raws, so a raw-length offset is not a source offset (see the snapshot
  // below).
  if (
    previous !== undefined &&
    value.length > previous.value.length &&
    value.startsWith(previous.value) &&
    previous.tailStart !== previous.value.length &&
    !previous.hasDefinition &&
    !value.includes('\r')
  ) {
    const headSegments = [...previous.headSegments];
    const suffix = value.slice(previous.tailStart);
    // eslint-disable-next-line new-cap -- react-native-marked exports the lexer function with this name
    const tokens = MarkedLexer(suffix, { gfm: true });
    // A definition in the appended suffix can duplicate one already in the
    // head: the suffix lex emits it, the whole-value lex drops it, so the two
    // no longer agree. Fall through and re-lex the whole value in that case.
    if (!hasDefinitionToken(tokens)) {
      const appended = appendTokens(tokens, headSegments, previous.tailStart);
      if (tokens.length === 0 && suffix.length > 0) {
        // The lexer dropped a whitespace-only suffix; keep it on the markdown
        // path and re-lex it together with the next append.
        pushSegmentCopyOnWrite(appended.segments, { type: 'markdown', raw: suffix });
      }
      const headHasHtml = headSegments.some(segment => segment.type === 'html');
      const hasHtml = headHasHtml || appended.segments.some(segment => segment.type === 'html');
      return {
        segments: hasHtml ? appended.segments : [{ type: 'markdown', raw: value }],
        snapshot: {
          value,
          tailStart: appended.tailStart,
          headSegments,
          headHasHtml,
          hasDefinition: false,
        },
      };
    }
  }

  // No reusable prefix: lex the whole value once and keep every token before
  // the boundary as the head, so the next publish starts from a token boundary.
  // eslint-disable-next-line new-cap -- react-native-marked exports the lexer function with this name
  const tokens = MarkedLexer(value, { gfm: true });
  const headSegments: MarkdownHtmlSegment[] = [];
  const { segments, tailStart } = appendTokens(tokens, headSegments, 0);
  return {
    segments: segments.some(segment => segment.type === 'html')
      ? segments
      : [{ type: 'markdown', raw: value }],
    snapshot: {
      value,
      // Marked normalizes `\r\n` to `\n` inside token raws, so a raw-length
      // offset is not a source offset once the value holds a carriage return.
      // A head that ends at `value.length` is never reused, so the next publish
      // re-lexes the whole value instead of slicing at the wrong offset.
      tailStart: value.includes('\r') ? value.length : tailStart,
      headSegments,
      headHasHtml: headSegments.some(segment => segment.type === 'html'),
      hasDefinition: hasDefinitionToken(tokens),
    },
  };
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
          <Text selectable={selectable} style={withRtlWritingDirection(baseStyle)}>
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
          aspectRatio={resolveHtmlImageAspectRatio(tnode.attributes.width, tnode.attributes.height)}
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
