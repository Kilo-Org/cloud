import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  Pressable,
  Text as RNText,
  useColorScheme,
  View,
} from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { useTranscriptTextSelectable } from './bubble-text-selection-context';
import { renderChunkChildren } from './code-block-chunk-content';
import {
  chunkTokenLines,
  CODE_FIRST_PAINT_CHUNKS,
  nextChunkMountCount,
  tokenizeCodeLines,
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
   * When provided, a single tap on the block reveals an inline "Copy" action
   * that hands the full source (before the display cap) back to the caller.
   * The caller owns the clipboard write and its success/failure feedback, so
   * this presentational block stays free of platform side effects. Omitted by
   * non-transcript callers (tool cards), which keep the static block.
   */
  onCopyCode?: (code: string) => void;
  /**
   * Long-press handler for the copy trigger. A transcript host forwards its
   * message-details long-press here so press-and-hold on a fence still opens
   * details instead of being swallowed by the trigger. Ignored when
   * `onCopyCode` is omitted, because no trigger renders without it.
   */
  onLongPressCode?: () => void;
};

/**
 * Space between the code's right edge and the revealed action's left edge.
 *
 * The revealed action is right-aligned to the block edge (the tap can be many
 * screens into a long fence, so the action must land in view), so the code area
 * gives up its right edge instead of the action covering source glyphs. The
 * gutter lives on the trigger, whose parent is unpadded, so the absolutely
 * positioned pill anchors to the parent edge and lands inside this padding.
 *
 * The gutter is the measured width of the pill itself, not a fixed value: the
 * label is `t('common.copy')`, and a length tied to the English "Copy" is too
 * narrow in a longer catalog, where the pill would draw over the code again.
 */
const COPY_ACTION_GAP = 8;

/**
 * Mono sizing on every rendered code text: one per chunk of a fence.
 */
const CODE_LINE_CLASSNAME = 'font-mono text-xs leading-4';

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
 * screen-reader navigation from one element per fence to one per chunk, and the
 * shared `copyCode` action needs one focusable host rather than one per chunk.
 * Each chunk is explicit `accessible={false}` so the host stays the only target.
 *
 * Sheet contract: inside the tool detail sheet the block reads the mono
 * sheet context, registers presence through `track()`, and honors the sheet's
 * wrap/scroll mode. Scroll mode reuses `MONO_SCROLL_VIEW_PROPS` and the
 * height-pin model from `mono-scroll-block-model.ts`. Outside the sheet
 * (chat bubbles) the mode is always `wrap` — the no-nested-horizontal-
 * ScrollView rule that protects RN 0.83 Fabric from spurious heights.
 *
 * Copy: when the markdown host supplies `onCopyCode`, a single tap anywhere
 * on the code reveals an absolutely-positioned "Copy" action (no layout
 * shift) and a `copyCode` accessibility action on the code text. The action is
 * anchored to the tap's content-space Y, so a fence taller than the viewport
 * still reveals it in view instead of off the top. The copy trigger reserves a
 * right gutter measured from that action, so the pill never covers source
 * glyphs in any locale. The pill hands the full source to the caller and
 * dismisses itself. The copy trigger is the only pressable wrapper the block
 * mounts: without `onCopyCode` the code text renders bare, so the transcript
 * bubble's own long-press still reaches a fence in tool cards and static
 * callers. When the host supplies `onLongPressCode`, the trigger forwards
 * press-and-hold to it (message details) instead of revealing the action, and
 * hides any action a prior tap already revealed so the pill cannot outlive the
 * details sheet.
 */
function CodeBlockImpl({
  code,
  language,
  maxLength,
  selectable,
  baseColor,
  onCopyCode,
  onLongPressCode,
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
  const { displayText, isTruncated } = prepareMonoScrollContent(code, maxLength);
  const tokenLines = useMemo(
    () => tokenizeCodeLines(displayText, language),
    [displayText, language]
  );
  // Memoized so the chunk array keeps its identity and the code content below
  // is not rebuilt (and its spans re-applied) on an unrelated re-render.
  const tokenChunks = useMemo(() => chunkTokenLines(tokenLines), [tokenLines]);
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
  // Add one batch per commit until the fence is fully mounted. Each batch is
  // CODE_CHUNK_MOUNT_BATCH chunks, so the spans applied in one frame stay
  // bounded however long the file is.
  useEffect(() => {
    if (mountedChunkCount >= tokenChunks.length) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setMountProgress({
        text: displayText,
        chunks: nextChunkMountCount(mountedChunkCount, tokenChunks.length),
      });
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [displayText, mountedChunkCount, tokenChunks.length]);
  const mountedChunks = useMemo(
    () => tokenChunks.slice(0, Math.min(mountedChunkCount, tokenChunks.length)),
    [tokenChunks, mountedChunkCount]
  );
  const [heightPin, setHeightPin] = useState<MonoScrollHeightPin | undefined>(undefined);
  // Content-space Y of the revealed copy action; null means hidden. The action
  // is anchored to the tap, not the block top: a long fence is many screens
  // tall, so a top-anchored action on a fence scrolled near its end renders
  // above the viewport and is unreachable.
  const [copyActionTop, setCopyActionTop] = useState<number | null>(null);
  // The revealed action's width for the current label, measured off the hidden
  // pill. Keyed by label so a catalog change re-measures instead of reusing the
  // previous language's width.
  const [copyActionMetrics, setCopyActionMetrics] = useState<{
    label: string;
    width: number;
  } | null>(null);
  const contentHeight = resolveMonoScrollPinnedHeight(heightPin, displayText);
  const textBase = baseColor ?? colors.foreground;
  // An empty fence has nothing to hand over, so it never offers the action.
  const canCopyCode = onCopyCode !== undefined && code.length > 0;
  // The label is translated, so the gutter has to come from what the pill
  // actually renders, not a width tied to English.
  const copyLabel = t('common.copy');
  const copyActionWidth = copyActionMetrics?.label === copyLabel ? copyActionMetrics.width : null;

  // Registers this block's presence exactly once per mount; the cleanup is the
  // unregister. The effect only re-runs when `track` identity changes, which
  // the sheet keeps stable, so mode flips never re-register.
  useEffect(() => track?.(), [track]);

  // A session or display-text change must not leave a stale action revealed.
  useEffect(() => {
    setCopyActionTop(null);
  }, [code]);

  const handleContentLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const measured = event.nativeEvent.layout.height;
      setHeightPin(prev => nextMonoScrollHeightPin(prev, displayText, measured));
    },
    [displayText]
  );

  // Records the hidden pill's width so the trigger can reserve exactly that
  // much of the code's right edge.
  const handleCopyActionLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const width = event.nativeEvent.layout.width;
      setCopyActionMetrics(previous =>
        previous?.label === copyLabel && previous.width === width
          ? previous
          : { label: copyLabel, width }
      );
    },
    [copyLabel]
  );

  // Reserve exactly the revealed pill's width plus a gap, so the action never
  // covers a glyph whatever the catalog renders for `common.copy`.
  const copyTriggerStyle = useMemo(
    () =>
      copyActionWidth === null ? undefined : { paddingRight: copyActionWidth + COPY_ACTION_GAP },
    [copyActionWidth]
  );

  // The reveal's top follows the tap's content-space Y; a memoized object keeps
  // the style off the inline-style lint rule.
  const copyActionTopStyle = useMemo(
    () => (copyActionTop === null ? undefined : { top: copyActionTop }),
    [copyActionTop]
  );

  const handleCopyCode = useCallback(() => {
    setCopyActionTop(null);
    // The full source, not the display-capped slice: the user asked for the
    // code, and the Truncated marker already says the view is a prefix.
    onCopyCode?.(code);
  }, [code, onCopyCode]);

  const handleToggleCopyAction = useCallback((event?: GestureResponderEvent) => {
    setCopyActionTop(previous => {
      if (previous !== null) {
        return null;
      }
      const tappedY = event?.nativeEvent.locationY;
      // A synthetic press (no touch event) has no coordinates; fall back to the
      // block top, which a short fence still shows.
      return tappedY === undefined || !Number.isFinite(tappedY) ? 0 : Math.max(0, tappedY);
    });
  }, []);

  // Opening message details must not strand a revealed copy action: without
  // this, a tap-then-hold leaves the pill mounted under the sheet and it is
  // still visible over the transcript once the sheet closes.
  const handleLongPressCode = useCallback(() => {
    setCopyActionTop(null);
    onLongPressCode?.();
  }, [onLongPressCode]);

  const handleCopyAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'copyCode') {
        handleCopyCode();
      }
    },
    [handleCopyCode]
  );

  const copyAccessibilityActions = useMemo(
    () => (canCopyCode ? [{ name: 'copyCode', label: copyLabel }] : undefined),
    [canCopyCode, copyLabel]
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
  // accessible host that carries the `copyCode` action, and each chunk `RNText`
  // is explicit `accessible={false}`. The host reads the whole fence in one
  // swipe and offers the action once.
  //
  // A blank line keeps its line box only when the fence has another line: an
  // empty fence — an empty ```` ``` ```` in a message — is one blank line and
  // nothing else, so its empty `displayText` skips the placeholder and the
  // fence renders the zero-height empty code `Text` it did before this block
  // chunked it, instead of gaining a blank code line (see `BLANK_CODE_LINE`
  // in `code-block-chunk-content.ts`).
  const keepBlankLineBox = displayText.length > 0;
  const codeContent = useMemo(
    () => (
      <View
        // Always accessible: the fence is one element whether or not it
        // offers copy. The host, not the chunks, is the a11y target.
        accessible
        accessibilityActions={copyAccessibilityActions}
        onAccessibilityAction={canCopyCode ? handleCopyAccessibilityAction : undefined}
      >
        {mountedChunks.map((chunk, chunkIndex) => (
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
            {renderChunkChildren(chunk, isDark, keepBlankLineBox)}
          </RNText>
        ))}
      </View>
    ),
    [
      keepBlankLineBox,
      mountedChunks,
      effectiveSelectable,
      textBase,
      copyAccessibilityActions,
      canCopyCode,
      handleCopyAccessibilityAction,
      isDark,
    ]
  );

  const truncatedMarker = isTruncated ? (
    <Text
      accessibilityLabel={t('common.contentTruncated')}
      className="mt-1 text-xs text-muted-foreground"
    >
      {t('common.truncated')}
    </Text>
  ) : null;

  // Inline (not in-flow) so revealing it never shifts the transcript layout.
  // The reveal is anchored to the tap's content-space Y so it lands in view on
  // fences taller than the viewport. Right-aligned into the code text's reserved
  // gutter (measured from this pill) so it sits clear of the source glyphs.
  const copyActionRevealed = canCopyCode && copyActionTop !== null;
  // Until the label is measured the same pill renders hidden, purely to report
  // its width; it unmounts as soon as the gutter is reserved, so a hidden "Copy"
  // never lingers in the accessibility tree.
  const copyActionMeasuring = canCopyCode && copyActionWidth === null;
  const copyAction =
    copyActionRevealed || copyActionMeasuring ? (
      <Pressable
        onPress={copyActionRevealed ? handleCopyCode : undefined}
        onLayout={handleCopyActionLayout}
        accessibilityRole="button"
        accessibilityLabel={copyLabel}
        testID={copyActionRevealed ? 'code-block-copy-action' : 'code-block-copy-measure'}
        hitSlop={8}
        pointerEvents={copyActionRevealed ? 'auto' : 'none'}
        accessibilityElementsHidden={!copyActionRevealed}
        importantForAccessibility={copyActionRevealed ? 'auto' : 'no-hide-descendants'}
        style={copyActionRevealed ? copyActionTopStyle : undefined}
        className={`absolute right-0 rounded-md border border-border bg-card px-2 py-1 ${
          copyActionRevealed ? 'active:opacity-70' : 'opacity-0'
        }`}
      >
        <Text className="text-xs font-medium text-foreground">{copyLabel}</Text>
      </Pressable>
    ) : null;

  // The copy trigger is the only responder wrapper the block ever mounts. It
  // must not wrap the code when there is nothing to copy: an unconditional
  // Pressable claims the touch responder and swallows the transcript bubble's
  // own long-press (message details) even in tool cards that render a plain
  // static block. When a copy handler exists, a long press is forwarded back to
  // the host so press-and-hold still opens details.
  const copyTriggerProps = canCopyCode
    ? {
        onPress: handleToggleCopyAction,
        onLongPress: onLongPressCode ? handleLongPressCode : undefined,
        accessible: false,
      }
    : null;

  if (textMode === 'wrap') {
    const codeText = <View>{codeContent}</View>;
    return (
      <View>
        {copyTriggerProps ? (
          // Leave the code text its own accessible element: the accessible
          // host wrapping the fence's chunks reads the code and carries the
          // copyCode action, instead of collapsing the whole block into one
          // synthesized button label. The right gutter is reserved on the
          // trigger, not the text, so the pill anchored to this view's
          // (unpadded) right edge lands in the padding, clear of glyphs.
          <Pressable
            {...copyTriggerProps}
            testID="code-block-copy-trigger"
            style={copyTriggerStyle}
          >
            {codeText}
          </Pressable>
        ) : (
          codeText
        )}
        {truncatedMarker}
        {copyAction}
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
      {copyTriggerProps ? (
        <Pressable {...copyTriggerProps} testID="code-block-copy-trigger" style={copyTriggerStyle}>
          {scrollView}
        </Pressable>
      ) : (
        scrollView
      )}
      {truncatedMarker}
      {copyAction}
    </View>
  );
}

export const CodeBlock = memo(CodeBlockImpl);
