/* eslint-disable react-native/no-inline-styles -- react-native-android-widget primitives take style objects; NativeWind className is unavailable in the widget host */

'use no memo';

// Metro turns a static image import into the asset id the widget host resolves,
// the same value `require` would give. Imported rather than required so vitest
// can stand in for the binary.
import LOGO from '../../assets/images/logo-widget.png';
import {
  FlexWidget,
  type HexColor,
  ImageWidget,
  TextWidget,
  type WidgetInfo,
  type WidgetRepresentation,
} from 'react-native-android-widget';

import { type GlanceableCountKind } from '@/lib/glanceable/presentation';
import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';

import { type AndroidWidgetProps } from './widget-props';

export const WIDGET_NAME = 'ActiveAgentsWidget';

/** Below this width (dp) only the primary count fits beside the mark. */
const COMPACT_MAX_WIDTH_DP = 170;
/** Below this height (dp) the three rows cannot stack, so they run in a row. */
const ROW_MAX_HEIGHT_DP = 90;


type Palette = {
  background: HexColor;
  foreground: HexColor;
  muted: HexColor;
  /** Three states, three colors — the same vocabulary the iOS surfaces draw. */
  needsInput: HexColor;
  running: HexColor;
};

// The app's own palette, not a widget-local one: a Home Screen card that does
// not match the app it opens reads as a different product.
const LIGHT: Palette = {
  background: lightColors.background,
  foreground: lightColors.foreground,
  muted: lightColors.mutedForeground,
  needsInput: lightColors.warn,
  running: lightColors.good,
};

const DARK: Palette = {
  background: darkColors.background,
  foreground: darkColors.foreground,
  muted: darkColors.mutedForeground,
  needsInput: darkColors.warn,
  running: darkColors.good,
};

// This function is evaluated only through `renderActiveAgentsWidget` and the
// library's `buildWidgetTree`. Everything it references is explicit so the
// React Compiler is disabled ("use no memo") and the widget host can re-evaluate
// the source. Translated copy arrives through `props`; the English fallbacks
// below only render while the gallery placeholder has no snapshot props.

type Size = 'compact' | 'row' | 'stack';

function sizeOf(info: WidgetInfo): Size {
  if (info.width < COMPACT_MAX_WIDTH_DP) {
    return 'compact';
  }
  return info.height < ROW_MAX_HEIGHT_DP ? 'row' : 'stack';
}

function dotColor(kind: GlanceableCountKind, palette: Palette): HexColor {
  if (kind === 'needsInput') {
    return palette.needsInput;
  }
  return kind === 'running' ? palette.running : palette.foreground;
}

/**
 * The state marker. Needs-input and working are filled, idle is an outline —
 * the shapes differ as well as the colors, so the three states stay apart for a
 * user who cannot tell orange from green.
 */
function stateDot(kind: GlanceableCountKind, palette: Palette, size: number) {
  const color = dotColor(kind, palette);
  return (
    <FlexWidget
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        ...(kind === 'idle'
          ? { borderWidth: 2, borderColor: color }
          : { backgroundColor: color }),
      }}
    />
  );
}

function logo(size: number) {
  return <ImageWidget image={LOGO} imageWidth={size} imageHeight={size} radius={size * 0.24} />;
}

/**
 * One count line: marker, count, label. Only the label color ranks the rows,
 * because a second font size in a three-row list reads as a mistake.
 */
// eslint-disable-next-line max-params -- one line, its rank, and the two style inputs
function countRow(
  line: AndroidWidgetProps['countLines'][number],
  isPrimary: boolean,
  palette: Palette,
  fontSize: number
) {
  return (
    <FlexWidget
      key={line.label}
      style={{ flexDirection: 'row', alignItems: 'center', flexGap: 6 }}
    >
      {stateDot(line.kind, palette, fontSize < 14 ? 9 : 10)}
      <TextWidget
        // oxlint-disable-next-line no-literal-copy/no-literal-copy -- an already-formatted number
        text={line.count}
        maxLines={1}
        style={{ color: palette.foreground, fontSize, fontWeight: 'bold' }}
      />
      <TextWidget
        text={line.label}
        maxLines={1}
        truncate="END"
        style={{ color: isPrimary ? palette.foreground : palette.muted, fontSize }}
      />
    </FlexWidget>
  );
}

/** Narrow cells: the mark, the ranked marker, and the one count worth a glance. */
function renderCompact(props: AndroidWidgetProps, palette: Palette) {
  if (props.primaryKind === null) {
    return (
      <TextWidget
        text={props.statusLine ?? ''}
        maxLines={2}
        truncate="END"
        style={{ color: palette.muted, fontSize: 13 }}
      />
    );
  }
  return countRow(
    {
      label: props.primaryLabel ?? '',
      kind: props.primaryKind,
      count: props.primaryCount,
    },
    true,
    palette,
    15
  );
}

function statusText(props: AndroidWidgetProps, palette: Palette) {
  return (
    <TextWidget
      text={props.statusLine ?? ''}
      maxLines={2}
      truncate="END"
      style={{ color: palette.muted, fontSize: 13 }}
    />
  );
}

function renderCounts(props: AndroidWidgetProps, palette: Palette, size: Size) {
  if (props.countLines.length === 0) {
    return statusText(props, palette);
  }
  const primaryLabel = props.primaryLabel;
  const rows = props.countLines.map(line =>
    countRow(line, line.label === primaryLabel, palette, size === 'row' ? 13 : 15)
  );
  const stacked = (
    <FlexWidget
      style={{
        flexDirection: size === 'row' ? 'row' : 'column',
        alignItems: size === 'row' ? 'center' : 'flex-start',
        flexGap: size === 'row' ? 14 : 6,
      }}
    >
      {rows}
    </FlexWidget>
  );
  // Stale carries counts and a warning at once. Only the tall cell has a line
  // to spare for it; the short row would have to drop a count to fit it.
  if (size !== 'stack' || props.statusLine === null) {
    return stacked;
  }
  return (
    <FlexWidget style={{ flexDirection: 'column', alignItems: 'flex-start', flexGap: 4 }}>
      {stacked}
      {statusText(props, palette)}
    </FlexWidget>
  );
}

function renderSurface(props: AndroidWidgetProps, palette: Palette, size: Size) {
  const body =
    size === 'compact' ? renderCompact(props, palette) : renderCounts(props, palette, size);
  // Short cells put the mark beside the counts; a tall cell stacks the mark on
  // top and lets the counts sit at the bottom, the same composition as the iOS
  // small family.
  if (size === 'stack') {
    return (
      <FlexWidget
        clickAction="OPEN_URI"
        clickActionData={{ uri: 'kiloapp:///cloud/sessions' }}
        accessibilityLabel={props.accessibilityLabel}
        style={{
          backgroundColor: palette.background,
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          height: 'match_parent',
          width: 'match_parent',
          padding: 14,
        }}
      >
        {logo(26)}
        {body}
        {props.showOpenAgents ? (
          <TextWidget
            text={props.openAgentsLabel}
            maxLines={1}
            truncate="END"
            style={{ color: palette.muted, fontSize: 12 }}
          />
        ) : (
          <FlexWidget style={{ width: 0, height: 0 }} />
        )}
      </FlexWidget>
    );
  }
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: 'kiloapp:///cloud/sessions' }}
      accessibilityLabel={props.accessibilityLabel}
      style={{
        backgroundColor: palette.background,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        flexGap: size === 'compact' ? 10 : 14,
        height: 'match_parent',
        width: 'match_parent',
        padding: 12,
      }}
    >
      {logo(size === 'compact' ? 22 : 28)}
      {body}
    </FlexWidget>
  );
}

/**
 * Distinct light and dark layouts through the library's theme callback. Narrow
 * cells show only the ranked count; short cells run the three states in a row;
 * a tall cell stacks them under the mark.
 */
export function renderActiveAgentsWidget(
  props: AndroidWidgetProps,
  info: WidgetInfo
): WidgetRepresentation {
  const size = sizeOf(info);
  return {
    light: renderSurface(props, LIGHT, size),
    dark: renderSurface(props, DARK, size),
  };
}
