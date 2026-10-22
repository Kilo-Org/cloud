import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type LayoutChangeEvent,
  Platform,
  Text as RNText,
  useColorScheme,
  View,
} from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { styled } from 'react-native-css';
import { UITextView } from '@bsky.app/react-native-uitextview';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type TokenScheme } from '@/lib/pr-review/diff/syntax-colors';

import { useTranscriptTextSelectable } from './bubble-text-selection-context';
import { renderChunkChildren, renderSelectableChunkChildren } from './code-block-chunk-content';
import {
  chunkCodeLines,
  CODE_CHUNK_MOUNT_BATCH,
  CODE_FIRST_PAINT_CHUNKS,
  nextChunkMountCount,
} from './code-block-model';
import { useMonoScrollSheet } from './mono-scroll-block';
import {
  MONO_SCROLL_VIEW_PROPS,
  type MonoScrollHeightPin,
  nextMonoScrollHeightPin,
  prepareMonoScrollContent,
  resolveMonoScrollPinnedHeight,
} from './mono-scroll-block-model';

type CodeBlockProps = {
  code: string;
  language: string | null;
  /** Char cap; on overflow slice and show the Truncated marker. */
  maxLength?: number;
  /** Default: useTranscriptTextSelectable(). */
  selectable?: boolean;
  /** Base (plain-text) color. Default: useThemeColors().foreground.
      The markdown renderer passes palette.textColor so code inside user
      variant bubbles keeps its designed ink color (lime/primary surfaces). */
  baseColor?: string;
  /**
   * Token scheme for the syntax-highlighted runs, derived by the caller from
   * the card the block is painted on (`tokenSchemeForSurface`). The markdown
   * renderer passes its palette's scheme; tool cards omit it and fall back to
   * the app color scheme, since they render on the app `card` surface.
   */
  tokenScheme?: TokenScheme;
};

/**
 * Mono sizing on every rendered code text: one per chunk of a fence.
 */
const CODE_LINE_CLASSNAME = 'font-mono text-xs leading-4';

/** `UITextView` with `className` mapped to `style`, like the built-in `Text`. */
const SelectableCodeText = styled(UITextView, { className: 'style' });

/**
 * Shared highlighted code block for tool detail sheets and markdown fences.
 *
 * Each line is highlighted independently by `highlightLine` (the per-line
 * ceiling documented in `highlight.ts`). A fence renders one `RNText` per chunk
 * of source lines, mirroring the shipped `DiffLine` pattern, and a single line
 * denser than the chunk's run budget is split across chunks so no `Text` holds
 * an unbounded run set (see `chunkTokenLines`).
 * Android builds one `SpannableStringBuilder` per `ReactTextView` and runs
 * `SetSpanOperation.execute` once per span on the UI thread, so a fence
 * rendered as one `RNText` made the span count scale with the whole fence — a
 * long file blocked input dispatch. A chunk bounds the spans one `Text` holds
 * and still needs a small fraction of the views a `Text` per line would cost
 * (see `chunkTokenLines`); the chunk's lines lay out together in one
 * `StaticLayout` instead of the whole fence doing so.
 *
 * A SELECTABLE fence renders those same chunks. Android can only select across
 * characters inside a single `ReactTextView`, so a selection spans the chunk a
 * gesture starts in rather than the whole fence; 32 lines is far more than a
 * press-hold-drag selects, so the one-gesture cross-line drag is unchanged.
 * Bounding the selectable path matters because the tool detail sheet routes a
 * read-tool-card body of up to 50,000 characters through it: one whole-fence
 * `SpannableStringBuilder` for a file of ~1,500 lines is what left the sheet on
 * its bare backdrop while the fence built. Whole-fence selection stays
 * available on the message-details "Select text" view. `SelectableText` cannot
 * carry colored runs, so highlighted code accepts the documented iOS
 * select-callout trade-off (see `selectable-text.tsx`) — plain text surfaces
 * (list rows, todo rows) keep true `SelectableText`.
 *
 * First paint: a fence mounts `CODE_FIRST_PAINT_CHUNKS` chunks in the render
 * that mounts it and adds the rest in bounded batches, one per commit (see
 * `code-block-model.ts`). The chunk cap bounds the spans one `Text` holds, but
 * RN applies every mounted `Text`'s spans in the frame that mounts it, so
 * mounting a whole 50,000-character file at once held the UI thread for seconds
 * with nothing on screen. The first paint is about a screen of code, and the
 * batches land below it, so the fence's own height is the only thing that grows
 * while the rest arrives. A streamed fence keeps the mounts it already has and
 * batches only its new lines; only a replaced fence restarts from the first
 * paint, so a growing transcript fence never drops and re-applies its spans.
 *
 * Accessibility: the fence is ONE element whether or not it is selectable. The
 * chunk `RNText`s sit in one accessible `View`: `Text` defaults to an
 * accessibility element on iOS, so chunk Texts would otherwise regress
 * screen-reader navigation from one element per fence to one per chunk.
 * Each chunk is explicit `accessible={false}` so the host stays the only target.
 *
 * Sheet contract: inside the tool detail sheet the block reads the mono
 * sheet context, registers presence through `track()`, and honors the sheet's
 * wrap/scroll mode. Scroll mode reuses `MONO_SCROLL_VIEW_PROPS` and the
 * height-pin model from `mono-scroll-block-model.ts`. Outside the sheet
 * (chat bubbles) the mode is always `wrap` — the no-nested-horizontal-
 * ScrollView rule that protects RN 0.83 Fabric from spurious heights.
 *
 * The code has no responder wrapper, so its host's long-press behavior passes
 * through unchanged.
 */
function CodeBlockImpl({
  code,
  language,
  maxLength,
  selectable,
  baseColor,
  tokenScheme,
}: Readonly<CodeBlockProps>) {
  const sheet = useMonoScrollSheet();
  const textMode = sheet?.mode ?? 'wrap';
  const track = sheet?.track;
  const textSelectable = useTranscriptTextSelectable();
  const effectiveSelectable = selectable ?? textSelectable;
  const colors = useThemeColors();
  const { t } = useTranslation();
  // Same signal `useThemeColors` reads. Never infer dark mode from a
  // background-token equality: the generated palette can change, and the
  // tokens would silently flip against their surface.
  const isDark = useColorScheme() === 'dark';
  // Tool cards render on the app `card` surface, whose brightness tracks the
  // app scheme; the markdown renderer passes the scheme of its own code card.
  const effectiveTokenScheme = tokenScheme ?? (isDark ? 'onDark' : 'onLight');
  const { displayText, isTruncated } = prepareMonoScrollContent(code, maxLength);
  // How much of the fence is mounted right now, remembered with the text it was
  // mounted for. The first paint mounts CODE_FIRST_PAINT_CHUNKS chunks — 128
  // lines, about a screen at this leading — so the sheet shows its header and
  // the front of the code in the frame that opens it; the rest follows in
  // bounded batches so no single commit carries the whole fence's spans (see
  // `code-block-model.ts`).
  const [mountProgress, setMountProgress] = useState({
    text: displayText,
    chunks: CODE_FIRST_PAINT_CHUNKS,
  });
  // A streamed fence only appends to the text it already had, so its mounts
  // carry over and the batches continue; a replaced fence (a different part, an
  // edited message) restarts from the bounded first paint. The reset is applied
  // during render, not left to the batch effect: a replaced fence shorter than
  // the first paint never runs that effect, so its text would stay in the state
  // and a later fence that extends the replaced-away text would match it and
  // resume its count, mounting more than one batch in a single commit. Setting
  // the state during render re-renders this component alone before its children
  // render, so the reset frame itself stays bounded.
  const sameFence = displayText.startsWith(mountProgress.text);
  if (!sameFence) {
    setMountProgress({ text: displayText, chunks: CODE_FIRST_PAINT_CHUNKS });
  }
  const mountedChunkCount = sameFence ? mountProgress.chunks : CODE_FIRST_PAINT_CHUNKS;
  // Highlight only the lines the mounted front needs. The lazy chunker walks
  // the source in order and stops once `mountedChunkCount` chunks are complete,
  // so a 200 KB fence never pays `highlightLine` for the thousands of lines
  // below the first paint at mount — or again on a remount. `hasMoreChunks`
  // reports a chunk past the mounted front, which schedules the next batch.
  // Memoized so the chunk array keeps its identity and the code content below
  // is not rebuilt (and its spans re-applied) on an unrelated re-render.
  const { chunks: mountedChunks, hasMore: hasMoreChunks } = useMemo(
    () => chunkCodeLines(displayText, language, mountedChunkCount),
    [displayText, language, mountedChunkCount]
  );
  // Add one batch per commit until the fence is fully mounted. Each batch is
  // CODE_CHUNK_MOUNT_BATCH chunks, so the spans applied in one frame stay
  // bounded however long the file is. `hasMoreChunks` proves at least one chunk
  // follows the mounted front, so one batch is the cap.
  useEffect(() => {
    if (!hasMoreChunks) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setMountProgress({
        text: displayText,
        chunks: nextChunkMountCount(mountedChunkCount, mountedChunkCount + CODE_CHUNK_MOUNT_BATCH),
      });
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [displayText, mountedChunkCount, hasMoreChunks]);
  const [heightPin, setHeightPin] = useState<MonoScrollHeightPin | undefined>(undefined);
  const contentHeight = resolveMonoScrollPinnedHeight(heightPin, displayText);
  const textBase = baseColor ?? colors.foreground;

  // Registers this block's presence exactly once per mount; the cleanup is the
  // unregister. The effect only re-runs when `track` identity changes, which
  // the sheet keeps stable, so mode flips never re-register.
  useEffect(() => track?.(), [track]);

  const handleContentLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const measured = event.nativeEvent.layout.height;
      setHeightPin(prev => nextMonoScrollHeightPin(prev, displayText, measured));
    },
    [displayText]
  );

  // Every fence is one `RNText` per chunk of source lines, selectable or not,
  // so each Text's Android span count is bounded to its chunk — the previous
  // selectable path gave Android one `SpannableStringBuilder` for the whole
  // fence (see the component doc), turning a long file into thousands of
  // `SetSpanOperation.execute` calls in a single frame. `mountedChunks` is the
  // bounded first paint plus whatever batches have landed since.
  //
  // The chunk split must not turn one fence into N accessibility elements:
  // `Text` is one element per chunk on iOS (`accessible` defaults on) and the
  // fence was one element before the split. The chunks therefore sit in ONE
  // accessible host, and each chunk `RNText` is explicit `accessible={false}`.
  // The host reads the whole fence in one swipe.
  //
  // A blank line keeps its line box only when the fence has another line: an
  // empty fence — an empty ```` ``` ```` in a message — is one blank line and
  // nothing else, so its empty `displayText` skips the placeholder and the
  // fence renders the zero-height empty code `Text` it did before this block
  // chunked it, instead of gaining a blank code line (see `BLANK_CODE_LINE`
  // in `code-block-chunk-content.tsx`).
  const keepBlankLineBox = displayText.length > 0;
  const codeContent = useMemo(
    () => (
      <View accessible>
        {mountedChunks.map((chunk, chunkIndex) =>
          // iOS `Text selectable` copies the whole Text and shows an empty
          // first menu (see `selectable-text.tsx`); a `UITextView` chunk gives
          // the platform's own range selection and callout. Android keeps
          // `RNText`, whose native selection already works per chunk.
          Platform.OS === 'ios' && effectiveSelectable ? (
            <SelectableCodeText
              // eslint-disable-next-line react/no-array-index-key -- code chunks are positional, not reorderable
              key={`chunk-${chunkIndex}`}
              accessible={false}
              selectable
              uiTextView
              className={CODE_LINE_CLASSNAME}
              // eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- base ink for untagged runs
              style={{ color: textBase }}
            >
              {renderSelectableChunkChildren(chunk, effectiveTokenScheme, keepBlankLineBox)}
            </SelectableCodeText>
          ) : (
            <RNText
              // Chunks are positional: the index is their identity.
              // eslint-disable-next-line react/no-array-index-key -- code chunks are positional, not reorderable
              key={`chunk-${chunkIndex}`}
              accessible={false}
              // Native selection is offered per chunk; the sheet's wrap/scroll
              // mode and this flag are independent.
              selectable={effectiveSelectable}
              className={CODE_LINE_CLASSNAME}
              // eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- base ink for untagged runs
              style={{ color: textBase }}
            >
              {renderChunkChildren(chunk, effectiveTokenScheme, keepBlankLineBox)}
            </RNText>
          )
        )}
      </View>
    ),
    [keepBlankLineBox, mountedChunks, effectiveSelectable, textBase, effectiveTokenScheme]
  );

  const truncatedMarker = isTruncated ? (
    <Text
      accessibilityLabel={t('common.contentTruncated')}
      className="mt-1 text-xs text-muted-foreground"
    >
      {t('common.truncated')}
    </Text>
  ) : null;

  if (textMode === 'wrap') {
    const codeText = <View>{codeContent}</View>;
    return (
      <View>
        {codeText}
        {truncatedMarker}
      </View>
    );
  }

  const scrollView = (
    <ScrollView
      {...MONO_SCROLL_VIEW_PROPS}
      // Explicit height from measured content — see MonoScrollBlock's doc.
      // eslint-disable-next-line react-native/no-inline-styles -- measured height cannot be a Tailwind class
      style={contentHeight === undefined ? undefined : { height: contentHeight }}
    >
      <View onLayout={handleContentLayout} className="shrink-0 self-start">
        {codeContent}
      </View>
    </ScrollView>
  );

  return (
    <View>
      {scrollView}
      {truncatedMarker}
    </View>
  );
}

export const CodeBlock = memo(CodeBlockImpl);
