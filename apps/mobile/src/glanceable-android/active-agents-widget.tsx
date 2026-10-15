/* eslint-disable react-native/no-inline-styles -- the Android widget host requires native style objects */
'use no memo';

import {
  OverlapWidget,
  type WidgetInfo,
  type WidgetRepresentation,
} from 'react-native-android-widget';

import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';

import { small } from './active-agents-widget-card';
import { large } from './active-agents-widget-large';
import { medium } from './active-agents-widget-medium';
import { type Copy, type Frame, type Paint, type Palette } from './active-agents-widget-parts';
import { row } from './active-agents-widget-row';
import { landscape, narrow } from './active-agents-widget-short';
import { type AndroidWidgetProps } from './widget-props';

export const WIDGET_NAME = 'ActiveAgentsWidget';

/** The approved widget palettes; three surfaces have no app theme token. */
const LIGHT: Palette = {
  background: lightColors.background,
  foreground: lightColors.foreground,
  muted: lightColors.mutedForeground,
  warn: lightColors.warn,
  good: lightColors.good,
  info: lightColors.info,
  idle: lightColors.mutedSoft,
  primary: lightColors.primary,
  primaryForeground: lightColors.primaryForeground,
  secondary: lightColors.secondary,
  divider: '#E6E3DA',
};
const DARK: Palette = {
  background: darkColors.card,
  foreground: darkColors.foreground,
  muted: darkColors.mutedForeground,
  warn: darkColors.warn,
  good: darkColors.good,
  info: darkColors.info,
  idle: darkColors.mutedSoft,
  primary: darkColors.primary,
  primaryForeground: darkColors.primaryForeground,
  secondary: '#26262B',
  divider: '#2A2A30',
};

export type SizeClass = 'small' | 'medium' | 'large' | 'row' | 'narrow' | 'landscape';

/** Every launcher cell maps to one size class; its layout then fills the cell. */
export function sizeClassFor(width: number, height: number): SizeClass {
  if (height < 84) {
    return 'landscape';
  }
  if (height < 152) {
    return width < 220 ? 'narrow' : 'row';
  }
  if (width < 240) {
    return 'small';
  }
  return height < 300 ? 'medium' : 'large';
}

const LAYOUTS = { small, medium, large, row, narrow, landscape } as const;

// Old persisted props have no Home presentation. They get the same hierarchy;
// fresh producers always provide shared Home policy and translated Home copy.
function copyFor(props: AndroidWidgetProps): Copy {
  if (props.homeCopy !== undefined) {
    return props.homeCopy;
  }
  const primary = props.countLines.find(line => line.label === props.primaryLabel);
  return {
    statusKind: primary === undefined ? 'signed_out' : 'content',
    primaryKind: primary?.kind ?? null,
    primaryCount: primary?.count ?? '',
    primaryLabel: primary?.label ?? null,
    status: props.statusLine,
    emptyShort: props.statusLine ?? '',
    title: null,
    wake: null,
    wakeOverdue: false,
    footer: null,
    actionLine: null,
    approveFailed: '',
    headings: { recent: '', waitingForYou: '', nextScheduled: '' },
    secondaryCounts: props.countLines.filter(line => line !== primary && line.count !== '0'),
    waitingAgents: [],
    scheduledAgents: [],
    accessibilityLabel: props.accessibilityLabel,
  };
}

function draw(props: AndroidWidgetProps, info: WidgetInfo, paint: Paint) {
  const { palette } = paint;
  const frame: Frame = {
    props,
    copy: copyFor(props),
    paint,
    width: info.width,
    height: info.height,
  };
  const sizeClass = sizeClassFor(info.width, info.height);
  return (
    <OverlapWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: 'kiloapp:///cloud/sessions' }}
      accessibilityLabel={frame.copy.accessibilityLabel}
      style={{
        width: 'match_parent',
        height: 'match_parent',
        borderRadius: sizeClass === 'landscape' ? 18 : 22,
        backgroundColor: palette.background,
        overflow: 'hidden',
      }}
    >
      {LAYOUTS[sizeClass](frame)}
    </OverlapWidget>
  );
}

export function renderActiveAgentsWidget(
  props: AndroidWidgetProps,
  info: WidgetInfo,
  rtl = false
): WidgetRepresentation {
  return {
    light: draw(props, info, { palette: LIGHT, rtl }),
    dark: draw(props, info, { palette: DARK, rtl }),
  };
}
