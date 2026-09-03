/* eslint-disable react-native/no-inline-styles -- react-native-android-widget primitives take style objects; NativeWind className is unavailable in the widget host */

'use no memo';

import {
  FlexWidget,
  type HexColor,
  TextWidget,
  type WidgetInfo,
  type WidgetRepresentation,
} from 'react-native-android-widget';

import { type AndroidWidgetProps } from './widget-props';

export const WIDGET_NAME = 'ActiveAgentsWidget';

/** Below this width (dp) the widget shows only the primary count. */
const COMPACT_MAX_WIDTH_DP = 150;

type Palette = { background: HexColor; primary: HexColor; muted: HexColor };

const LIGHT: Palette = {
  background: '#FFFFFF',
  primary: '#111827',
  muted: '#6B7280',
};

const DARK: Palette = {
  background: '#0B0F19',
  primary: '#F9FAFB',
  muted: '#9CA3AF',
};

// This function is evaluated only through `renderActiveAgentsWidget` and the
// library's `buildWidgetTree`. Everything it references is explicit so the
// React Compiler is disabled ("use no memo") and the widget host can re-evaluate
// the source. Translated copy arrives through `props`; the English fallbacks
// below only render while the gallery placeholder has no snapshot props.

function isCompact(info: WidgetInfo): boolean {
  return info.width < COMPACT_MAX_WIDTH_DP;
}

function compactText(props: AndroidWidgetProps): string {
  if (props.primaryLabel === null) {
    return props.statusLine ?? '';
  }
  return `${props.primaryCount} ${props.primaryLabel}`;
}

function countRows(props: AndroidWidgetProps, color: HexColor) {
  return props.countLines.map(line => (
    <TextWidget
      key={line.label}
      // oxlint-disable-next-line no-literal-copy/no-literal-copy -- line.label arrives translated; count is a number
      text={`${line.count} ${line.label}`}
      style={{ color, fontSize: 14 }}
    />
  ));
}

/** Compact widths show the primary count; wider cells show every non-zero count. */
function renderPrimaryArea(props: AndroidWidgetProps, palette: Palette, compact: boolean) {
  if (compact) {
    return (
      <TextWidget
        text={compactText(props)}
        maxLines={1}
        style={{ color: palette.primary, fontSize: 16, fontWeight: 'bold' }}
      />
    );
  }
  if (props.countLines.length === 0) {
    return null;
  }
  return countRows(props, palette.primary);
}

function renderSurface(props: AndroidWidgetProps, palette: Palette, compact: boolean) {
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
        padding: 12,
      }}
    >
      <FlexWidget style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
        {renderPrimaryArea(props, palette, compact)}
        {!compact && props.statusLine !== null ? (
          <TextWidget
            text={props.statusLine}
            maxLines={1}
            style={{ color: palette.muted, fontSize: 12 }}
          />
        ) : null}
      </FlexWidget>
      {!compact && props.showOpenAgents ? (
        <TextWidget
          text={props.openAgentsLabel}
          maxLines={1}
          style={{ color: palette.primary, fontSize: 13, fontWeight: 'bold' }}
        />
      ) : null}
    </FlexWidget>
  );
}

/**
 * Distinct light and dark layouts through the library's theme callback. Narrow
 * widths show only the primary count; wider cells show every non-zero count.
 */
export function renderActiveAgentsWidget(
  props: AndroidWidgetProps,
  info: WidgetInfo
): WidgetRepresentation {
  const compact = isCompact(info);
  return {
    light: renderSurface(props, LIGHT, compact),
    dark: renderSurface(props, DARK, compact),
  };
}
