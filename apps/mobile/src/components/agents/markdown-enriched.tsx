import { useMemo, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { EnrichedMarkdownText, type MarkdownStyle } from 'react-native-enriched-markdown';
import { useTranslation } from 'react-i18next';

import { ImageViewer } from '@/components/ui/image-viewer';
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
  selectable: boolean;
  onLongPressLink?: MarkdownLinkLongPressHandler;
  onPressLink?: MarkdownLinkPressHandler;
  onCopyCode?: MarkdownCopyCodeHandler;
};

const CODE_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

function enrichedStyle(palette: MarkdownPalette): MarkdownStyle {
  const { textColor, mutedTextColor, codeBackground, borderColor } = palette;
  const half = palette.codeTokenScheme === 'onLight' ? 'light' : 'dark';
  const headings = getMarkdownHeadingStyles(palette);
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
    paragraph: { color: textColor, fontSize: 16, lineHeight: 24, marginTop: 2, marginBottom: 2 },
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
    blockquote: { borderColor, borderWidth: 3, gapWidth: 12, color: textColor },
    list: { color: textColor, fontSize: 16, lineHeight: 24, markerColor: textColor },
    thematicBreak: { color: borderColor, height: 1, marginTop: 8, marginBottom: 8 },
    table: {
      color: textColor,
      fontSize: 15,
      borderColor,
      borderWidth: 1,
      borderRadius: 6,
      headerTextColor: textColor,
      headerBackgroundColor: codeBackground,
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
  selectable,
  onLongPressLink,
  onPressLink,
  onCopyCode,
}: Readonly<MarkdownEnrichedProps>) {
  const { t } = useTranslation();
  const [viewer, setViewer] = useState<{ uri: string; filename: string } | null>(null);
  const markdownStyle = useMemo(() => enrichedStyle(palette), [palette]);
  const images = useMemo(() => findMarkdownImages(value), [value]);
  // One flag per image, so trusting a host or confirming a URI re-renders
  // with the real image and a revoke gates it again.
  const displayable = useSyncExternalStore(subscribeMarkdownImageLoadAllowed, () =>
    images.map(image => (isMarkdownImageDisplayable(image.href) ? '1' : '0')).join('')
  );
  const markdown = useMemo(
    () =>
      gateMarkdownImages(
        value,
        images.filter((_, index) => displayable[index] !== '1'),
        t
      ),
    [value, images, displayable, t]
  );
  return (
    <>
      <EnrichedMarkdownText
        flavor="github"
        markdown={markdown}
        markdownStyle={markdownStyle}
        selectable={selectable}
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
        onCopyPress={onCopyCode ? ({ code }) => onCopyCode(code) : undefined}
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
