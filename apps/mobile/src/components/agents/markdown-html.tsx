/* oxlint-disable max-lines -- cohesive HTML segmentation, sanitization, and image/link wiring share one renderer */
import { useMemo } from 'react';
import { marked, type Token } from 'marked';
import {
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  Platform,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import RenderHTML, {
  type CustomBlockRenderer,
  type CustomMixedRenderer,
  type CustomTagRendererRecord,
  type CustomTextualRenderer,
  defaultHTMLElementModels,
  type DomVisitorCallbacks,
  HTMLContentModel,
  type RenderersProps,
  type TNode,
} from '@native-html/render';

import { withRtlWritingDirection } from '@/lib/rtl-text';

import {
  type MarkdownLinkLongPressHandler,
  type MarkdownLinkPressHandler,
} from './markdown-handlers';
import { HtmlDetails } from './markdown-html-details';
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
import { lexMarkdown } from './markdown-parse-cache';

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

export type MarkdownHtmlSegment = {
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

// The Markdown renderer does not style inline HTML tokens: a link, heading, or
// emphasis tag nested inside a list item or blockquote loses the styling its
// Markdown equivalent keeps.
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

// Containers whose nested HTML the Markdown renderer cannot style. Code and
// table descendants are excluded from routing so fenced code and tables stay on
// the Markdown renderer's native blocks.
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

function tokenSegment(token: Token, inDetails: boolean): MarkdownHtmlSegment {
  if (token.type === 'html') {
    return { type: 'html', raw: token.raw };
  }
  if (inDetails || hasDirectHtml(token) || routesNestedHtml(token)) {
    return {
      type: 'html',
      raw: marked.parse(token.raw, { async: false, gfm: true }),
    };
  }
  return { type: 'markdown', raw: token.raw };
}

const DETAILS_TAG = /<(\/?)details\b[^>]*>/gi;

function detailsDepthChange(token: Token): number {
  const html =
    token.type === 'paragraph' ? (token.tokens ?? []).filter(inline => inline.type === 'html') : [];
  let change = 0;
  for (const part of token.type === 'html' ? [token] : html) {
    for (const match of part.raw.matchAll(DETAILS_TAG)) {
      change += match[1] === '/' ? -1 : 1;
    }
  }
  return change;
}

/**
 * For each token, the index of the token that opened the `<details>` element
 * it belongs to, or -1 outside one. GitHub-style details put a blank line
 * around a markdown body, so the element spans several block tokens; they all
 * render as one HTML segment so the body collapses with its summary.
 */
function detailsGroupStarts(tokens: readonly Token[]): number[] {
  const starts: number[] = [];
  let depth = 0;
  let opener = -1;
  for (const [index, token] of tokens.entries()) {
    const change = detailsDepthChange(token);
    if (depth === 0 && change > 0) {
      opener = index;
    }
    starts.push(depth > 0 || change > 0 ? opener : -1);
    depth = Math.max(0, depth + change);
  }
  return starts;
}

export function splitMarkdownHtml(value: string): MarkdownHtmlSegment[] {
  const tokens = lexMarkdown(value);
  const groupStarts = detailsGroupStarts(tokens);
  const segments: MarkdownHtmlSegment[] = [];
  for (const [index, token] of tokens.entries()) {
    pushSegment(segments, tokenSegment(token, (groupStarts[index] ?? -1) !== -1));
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
export type MarkdownHtmlSplit = {
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
 * reuse. A `<details>` element never straddles the boundary: the tail starts at
 * its opener, because a token's grouping depends on the tags before it. The
 * returned boundary is always 0 or directly preceded by a stable separator.
 */
function tailBoundaryIndex(tokens: readonly Token[], groupStarts: readonly number[]): number {
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
  // boundary moves, then repeat the absorbing-block and details checks, because
  // that run can itself begin with an absorbing block behind a stable separator
  // or sit inside a details element. The result is always 0 or a boundary
  // directly preceded by a stable separator.
  let backedUp = true;
  while (backedUp) {
    while (start > 0 && !isStableSeparator(tokens[start - 1])) {
      start -= 1;
    }
    const groupStart = groupStarts[start] ?? -1;
    const absorbed =
      start >= 2 &&
      isStableSeparator(tokens[start - 1]) &&
      ABSORBING_BLOCK_TYPES.has(tokens[start - 2]?.type ?? '');
    backedUp = absorbed || (groupStart !== -1 && groupStart < start);
    if (absorbed) {
      start -= 2;
    } else if (backedUp) {
      start = groupStart;
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
  const groupStarts = detailsGroupStarts(tokens);
  const boundary = tailBoundaryIndex(tokens, groupStarts);
  for (const [index, token] of tokens.entries()) {
    const segment = tokenSegment(token, (groupStarts[index] ?? -1) !== -1);
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
 * Streaming-aware `splitMarkdownHtml`: when `value` keeps the previous
 * snapshot's head it re-lexes only the text from that snapshot's tail boundary
 * — the last block run and any list or blockquote that can still absorb it (see
 * `tailBoundaryIndex`) — and reuses the head segments unchanged, so a message
 * that grows one publish at a time stays proportional to the last block instead
 * of the whole value. The result is identical to `splitMarkdownHtml(value)` for
 * every value that keeps the head.
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
  //
  // Only the head has to match, not the whole previous value: the head's tokens
  // do not depend on the text after the tail boundary, so a tail rewritten in
  // place (HTML converted to markdown re-closes an open `<b>` at the new end,
  // turning `**wor**` into `**word**`) still reuses the head.
  if (
    previous !== undefined &&
    value.length > previous.tailStart &&
    previous.tailStart !== previous.value.length &&
    value.slice(0, previous.tailStart) === previous.value.slice(0, previous.tailStart) &&
    !previous.hasDefinition &&
    !value.includes('\r')
  ) {
    const headSegments = [...previous.headSegments];
    const suffix = value.slice(previous.tailStart);
    const tokens = lexMarkdown(suffix);
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
          hasDefinition: false,
        },
      };
    }
  }

  // No reusable prefix: lex the whole value once and keep every token before
  // the boundary as the head, so the next publish starts from a token boundary.
  const tokens = lexMarkdown(value);
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

// The engine models `details` and `summary` as interactive tags with no
// content, so it renders neither; give them block content for `HtmlDetails`.
const HTML_ELEMENT_MODELS = {
  details: defaultHTMLElementModels.details.extend({ contentModel: HTMLContentModel.block }),
  summary: defaultHTMLElementModels.summary.extend({ contentModel: HTMLContentModel.block }),
};

const CODE_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

// Subscript and superscript sit in an inline view, the one way React Native
// can shift text off the line's baseline.
const HtmlSub: CustomTextualRenderer = ({ TDefaultRenderer, ...props }) => (
  <View className="translate-y-1">
    <TDefaultRenderer {...props} />
  </View>
);
const HtmlSup: CustomTextualRenderer = ({ TDefaultRenderer, ...props }) => (
  <View className="-translate-y-1.5">
    <TDefaultRenderer {...props} />
  </View>
);

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
    () => ({
      ...getMarkdownHeadingStyles(palette),
      ...getMarkdownHtmlTagStyles(palette),
      kbd: { fontFamily: CODE_FONT, fontSize: 13, lineHeight: 20 },
      sub: { fontSize: 11, lineHeight: 16 },
      sup: { fontSize: 11, lineHeight: 16 },
    }),
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
    const HtmlKbd: CustomTextualRenderer = ({ TDefaultRenderer, ...props }) => (
      <View
        className="rounded border px-1"
        style={{ backgroundColor: palette.codeBackground, borderColor: palette.borderColor }}
      >
        <TDefaultRenderer {...props} />
      </View>
    );
    return {
      a: HtmlAnchor,
      img: HtmlImage,
      details: HtmlDetails,
      kbd: HtmlKbd,
      sub: HtmlSub,
      sup: HtmlSup,
    };
  }, [baseStyle, onLongPressLink, onPressLink, palette, selectable]);

  return (
    <RenderHTML
      baseStyle={baseStyle}
      contentWidth={width}
      customHTMLElementModels={HTML_ELEMENT_MODELS}
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
