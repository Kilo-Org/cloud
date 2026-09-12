import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  Pressable,
  Text as RNText,
  View,
} from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { tokenColorFor } from '@/lib/pr-review/diff/syntax-colors';

import { useTranscriptTextSelectable } from './bubble-text-selection-context';
import { tokenizeCodeLines } from './code-block-model';
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
 * Shared highlighted code block for tool detail sheets and markdown fences.
 *
 * Each line is highlighted independently by `highlightLine` (the per-line
 * ceiling documented in `highlight.ts`); the tokens render as nested RNText
 * runs inside one selectable parent RNText, mirroring the shipped `DiffLine`
 * pattern. `SelectableText` cannot carry colored runs, so highlighted code
 * accepts the documented iOS select-callout trade-off (see
 * `selectable-text.tsx`) — plain text surfaces (list rows, todo rows) keep
 * true `SelectableText`.
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
  const isDark = colors.background === '#0E0E10';
  const { displayText, isTruncated } = prepareMonoScrollContent(code, maxLength);
  const tokenLines = useMemo(
    () => tokenizeCodeLines(displayText, language),
    [displayText, language]
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

  const copyAccessibilityActions = canCopyCode
    ? [{ name: 'copyCode', label: copyLabel }]
    : undefined;

  const content = tokenLines.map((tokens, lineIndex) => (
    <Fragment key={`line-${lineIndex}`}>
      {lineIndex > 0 ? '\n' : null}
      {tokens.map((token, tokenIndex) => {
        const color = token.className === null ? textBase : tokenColorFor(token.className, isDark);
        return (
          // eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- per-token syntax color
          <RNText key={`tok-${tokenIndex}`} style={{ color }}>
            {token.text}
          </RNText>
        );
      })}
    </Fragment>
  ));

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
    const codeText = (
      <RNText
        selectable={effectiveSelectable}
        className="font-mono text-xs leading-4"
        accessibilityActions={copyAccessibilityActions}
        onAccessibilityAction={canCopyCode ? handleCopyAccessibilityAction : undefined}
      >
        {content}
      </RNText>
    );
    return (
      <View>
        {copyTriggerProps ? (
          // Leave the selectable code text its own accessible element: it reads
          // the code and carries the copyCode action, instead of collapsing the
          // whole block into one synthesized button label. The right gutter is
          // reserved on the trigger, not the text, so the pill anchored to this
          // view's (unpadded) right edge lands in the padding, clear of glyphs.
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
      <RNText
        selectable={effectiveSelectable}
        onLayout={handleContentLayout}
        className="shrink-0 self-start font-mono text-xs leading-4"
        accessibilityActions={copyAccessibilityActions}
        onAccessibilityAction={canCopyCode ? handleCopyAccessibilityAction : undefined}
      >
        {content}
      </RNText>
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
