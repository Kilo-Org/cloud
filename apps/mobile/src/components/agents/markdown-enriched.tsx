import { useMemo, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import {
  type AccessibilityLabels,
  EnrichedMarkdownText,
  type MarkdownStyle,
} from 'react-native-enriched-markdown';
import { useTranslation } from 'react-i18next';

import { ImageViewer } from '@/components/ui/image-viewer';
import { withoutLeadingDirectionMarks } from '@/lib/rtl-text';
import { TOKEN_DARK_LIGHT } from '@/lib/pr-review/diff/syntax-colors';

import {
  type MarkdownCopyCodeHandler,
  type MarkdownLinkLongPressHandler,
  type MarkdownLinkPressHandler,
} from './markdown-handlers';
import {
  requestMarkdownImageTrust,
  subscribeMarkdownImageLoadAllowed,
} from './markdown-image-confirm';
import {
  findMarkdownImages,
  gateMarkdownImages,
  isMarkdownImageDisplayable,
  parseImageLoadUrl,
} from './markdown-image-gate';
import { markdownImageFilename, resolveMarkdownImageSrc } from './markdown-image-src';
import { confirmAndOpenMarkdownLink } from './markdown-link-confirm';
import { getMarkdownHeadingStyles, type MarkdownPalette } from './markdown-palette';

type MarkdownEnrichedProps = {
  value: string;
  palette: MarkdownPalette;
  /**
   * The direction the whole message names (`markdownMessageDirection`), or
   * `undefined` when it holds no letter. The container carries it, so a block
   * holding no letter of its own sits on the message's edge instead of the
   * interface's.
   */
  messageDirection: 'ltr' | 'rtl' | undefined;
  selectable: boolean;
  onLongPressLink?: MarkdownLinkLongPressHandler;
  onPressLink?: MarkdownLinkPressHandler;
  onCopyCode?: MarkdownCopyCodeHandler;
};

const CODE_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const BODY_LINE_HEIGHT = 24;

function enrichedStyle(palette: MarkdownPalette): MarkdownStyle {
  const { textColor, mutedTextColor, codeBackground, borderColor } = palette;
  const half = palette.codeTokenScheme === 'onLight' ? 'light' : 'dark';
  const headings = getMarkdownHeadingStyles(palette);
  // The native renderer resolves each paragraph's direction from its first
  // strong character. That is the rule for markdown, which is always copy the
  // app did not write: an English reply keeps its left edge and the punctuation
  // that ends it inside a right-to-left interface, and an Arabic one still sits
  // on the right. A paragraph with no strong character of its own follows the
  // container's direction instead (`messageDirection` in `MarkdownEnriched`).
  // Naming the interface's start edge instead right-aligned the English and
  // left the punctuation of a wrapped line at the wrong end.
  const heading = (level: keyof typeof headings) => {
    const style = headings[level];
    return {
      color: style.color,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      marginTop: style.marginTop,
      marginBottom: style.marginBottom,
    };
  };
  return {
    // No top margin: the library puts a leading margin on the first block as a
    // spacer line, and its measure reads any second line as wrapped text and
    // takes the full width, so a short user bubble filled its maximum width.
    // The bottom margin alone keeps the gap between paragraphs.
    paragraph: {
      color: textColor,
      fontSize: 16,
      lineHeight: BODY_LINE_HEIGHT,
      marginTop: 0,
      marginBottom: 4,
    },
    h1: heading('h1'),
    h2: heading('h2'),
    h3: heading('h3'),
    h4: heading('h4'),
    h5: heading('h5'),
    h6: heading('h6'),
    strong: { color: textColor, fontWeight: 'bold' },
    em: { color: textColor, fontStyle: 'italic' },
    strikethrough: { color: mutedTextColor },
    link: { color: textColor, underline: true },
    code: {
      fontFamily: CODE_FONT,
      fontSize: 14,
      color: textColor,
      backgroundColor: codeBackground,
      borderColor: codeBackground,
    },
    codeBlock: {
      fontFamily: CODE_FONT,
      fontSize: 14,
      color: textColor,
      backgroundColor: codeBackground,
      borderColor: codeBackground,
      borderRadius: 8,
      padding: 12,
      marginTop: 4,
      marginBottom: 4,
      syntaxColors: {
        keyword: TOKEN_DARK_LIGHT.keyword[half],
        operator: TOKEN_DARK_LIGHT.operator[half],
        string: TOKEN_DARK_LIGHT.string[half],
        number: TOKEN_DARK_LIGHT.number[half],
        constant: TOKEN_DARK_LIGHT.literal[half],
        comment: TOKEN_DARK_LIGHT.comment[half],
        function: TOKEN_DARK_LIGHT.function[half],
        type: TOKEN_DARK_LIGHT.type[half],
        property: TOKEN_DARK_LIGHT.property[half],
        tag: TOKEN_DARK_LIGHT.tag[half],
        attribute: TOKEN_DARK_LIGHT.attribute[half],
      },
    },
    // The library's quote, bullet and table-row defaults are light-theme
    // colors; every surface color here comes from the palette so dark mode
    // and the colored user bubbles stay readable.
    blockquote: {
      borderColor,
      borderWidth: 3,
      gapWidth: 12,
      color: textColor,
      backgroundColor: 'transparent',
    },
    list: {
      color: textColor,
      fontSize: 16,
      lineHeight: BODY_LINE_HEIGHT,
      markerColor: textColor,
      bulletColor: textColor,
    },
    thematicBreak: { color: borderColor, height: 1, marginTop: 8, marginBottom: 8 },
    table: {
      color: textColor,
      fontSize: 15,
      borderColor,
      borderWidth: 1,
      borderRadius: 6,
      headerTextColor: textColor,
      headerBackgroundColor: codeBackground,
      rowEvenBackgroundColor: 'transparent',
      rowOddBackgroundColor: 'transparent',
    },
  };
}

/**
 * One markdown run rendered as native text by `react-native-enriched-markdown`.
 * Images the reader has not allowed are rewritten before the native view sees
 * them (`markdown-image-gate`), so it never fetches an untrusted image.
 */
export function MarkdownEnriched({
  value,
  palette,
  messageDirection,
  selectable,
  onLongPressLink,
  onPressLink,
  onCopyCode,
}: Readonly<MarkdownEnrichedProps>) {
  const { t } = useTranslation();
  const [viewer, setViewer] = useState<{ uri: string; filename: string } | null>(null);
  // Markdown is always copy the app did not write, so every block keeps the
  // renderer's own per-paragraph direction (`enrichedStyle`); `messageDirection`
  // answers only for a block with no strong character of its own.
  const markdownStyle = useMemo(() => enrichedStyle(palette), [palette]);
  // The renderer's own screen-reader strings (table rows, list items,
  // blockquotes, math, and the iOS rotor) so a translation is spoken in the
  // app language instead of the library's English default. `t` changes
  // identity on a language switch, so this memo tracks the app language.
  const accessibilityLabels = useMemo<AccessibilityLabels>(
    () => ({
      list: {
        bulletPoint: t('common.markdownA11y.list.bulletPoint'),
        nestedBulletPoint: t('common.markdownA11y.list.nestedBulletPoint'),
        orderedItem: t('common.markdownA11y.list.orderedItem'),
        nestedOrderedItem: t('common.markdownA11y.list.nestedOrderedItem'),
      },
      blockquote: {
        quote: t('common.markdownA11y.blockquote.quote'),
        nestedQuote: t('common.markdownA11y.blockquote.nestedQuote'),
      },
      table: { row: t('common.markdownA11y.table.row') },
      math: { equation: t('common.markdownA11y.math.equation') },
      rotor: {
        headings: t('common.markdownA11y.rotor.headings'),
        links: t('common.markdownA11y.rotor.links'),
        images: t('common.markdownA11y.rotor.images'),
      },
    }),
    [t]
  );
  const images = useMemo(() => findMarkdownImages(value), [value]);
  // One flag per image, so trusting a host or confirming a URI re-renders
  // with the real image and a revoke gates it again.
  const displayable = useSyncExternalStore(subscribeMarkdownImageLoadAllowed, () =>
    images.map(image => (isMarkdownImageDisplayable(image.href) ? '1' : '0')).join('')
  );
  const markdown = useMemo(
    () =>
      withoutLeadingDirectionMarks(
        gateMarkdownImages(
          value,
          images.filter((_, index) => displayable[index] !== '1'),
          t
        )
      ),
    [value, images, displayable, t]
  );
  // A block with no letter of its own lays out in the container's direction,
  // while a paragraph with a letter of its own still resolves from that letter:
  // the native paragraph renderer sets no direction of its own, so the platform
  // reads the view's. Naming the message's direction here is what puts `42 · 7`
  // on the same edge as the lettered blocks beside it.
  const containerStyle = useMemo(
    () => (messageDirection === undefined ? undefined : { direction: messageDirection }),
    [messageDirection]
  );
  return (
    <>
      <EnrichedMarkdownText
        flavor="github"
        // One rule per message: a block takes the direction of its own first
        // letter, a mark the content put in front of a block's first character
        // is stripped so it cannot override that letter, and a block with no
        // letter at all takes the message's direction from the container. The
        // renderer draws a list's marker on its item's own leading edge, so the
        // marker follows the item.
        markdown={markdown}
        markdownStyle={markdownStyle}
        containerStyle={containerStyle}
        accessibilityLabels={accessibilityLabels}
        selectable={selectable}
        // A long press on a message opens the host's message details; the
        // library's own block menu would open on top of it. Copy stays on the
        // fence header button.
        enableBlockContextMenu={false}
        onLinkPress={({ url }) => {
          const imageUri = parseImageLoadUrl(url);
          if (imageUri !== null) {
            requestMarkdownImageTrust(imageUri);
          } else if (onPressLink?.(url) !== true) {
            confirmAndOpenMarkdownLink(url);
          }
        }}
        onLinkLongPress={
          onLongPressLink
            ? ({ url }) => {
                onLongPressLink(parseImageLoadUrl(url) ?? url);
              }
            : undefined
        }
        onImagePress={({ url, altText }) => {
          if (isMarkdownImageDisplayable(url)) {
            setViewer({
              uri: resolveMarkdownImageSrc(url),
              filename: markdownImageFilename(url, altText),
            });
          }
        }}
        onCopyPress={
          onCopyCode
            ? ({ code }) => {
                onCopyCode(code);
              }
            : undefined
        }
      />
      {viewer ? (
        <ImageViewer
          visible
          uri={viewer.uri}
          filename={viewer.filename}
          onClose={() => {
            setViewer(null);
          }}
        />
      ) : null}
    </>
  );
}
