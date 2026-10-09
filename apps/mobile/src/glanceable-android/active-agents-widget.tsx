/* eslint-disable react-native/no-inline-styles -- the Android widget host requires native style objects */
'use no memo';

import {
  FlexWidget,
  type WidgetInfo,
  type WidgetRepresentation,
} from 'react-native-android-widget';

import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';

import { card, type Frame, locked, MARGIN, SHORT_HEIGHT } from './active-agents-widget-card';
import { type Copy, type Paint } from './active-agents-widget-parts';
import { short } from './active-agents-widget-short';
import { type AndroidWidgetProps } from './widget-props';

export const WIDGET_NAME = 'ActiveAgentsWidget';

/** Privacy, org-lock and signed-out all share the centred locked composition. */
function compose(frame: Frame) {
  const { statusKind } = frame.copy;
  if (statusKind === 'privacy' || statusKind === 'unavailable' || statusKind === 'signed_out') {
    return locked(frame);
  }
  return frame.info.height < SHORT_HEIGHT ? short(frame) : card(frame);
}

// Old persisted props have no Home presentation. They get the same hierarchy;
// fresh producers always provide shared Home policy and translated Home copy.
function copyFor(props: AndroidWidgetProps): Copy {
  if (props.homeCopy !== undefined) {
    return props.homeCopy;
  }
  const primary = props.countLines.find(line => line.label === props.primaryLabel);
  return {
    statusKind: primary === undefined ? 'signed_out' : 'content',
    primaryCount: primary?.count ?? '',
    primaryLabel: primary?.label ?? null,
    status: props.statusLine,
    detail: props.scheduledTime,
    checked: null,
    secondaryCounts: props.countLines.filter(line => line !== primary && line.count !== '0'),
    waitingAgents: [],
    scheduledAgents: [],
    accessibilityLabel: props.accessibilityLabel,
  };
}

function draw(props: AndroidWidgetProps, info: WidgetInfo, paint: Paint) {
  const frame: Frame = { props, copy: copyFor(props), paint, info };
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: 'kiloapp:///cloud/sessions' }}
      accessibilityLabel={frame.copy.accessibilityLabel}
      style={{
        width: 'match_parent',
        height: 'match_parent',
        borderRadius: 20,
        backgroundColor: paint.palette.background,
        // Short bands inset their own content so the free height reaches the text.
        padding: info.height < SHORT_HEIGHT ? 0 : MARGIN,
      }}
    >
      {compose(frame)}
    </FlexWidget>
  );
}

export function renderActiveAgentsWidget(
  props: AndroidWidgetProps,
  info: WidgetInfo,
  rtl = false
): WidgetRepresentation {
  return {
    light: draw(props, info, { palette: lightColors, rtl }),
    dark: draw(props, info, { palette: darkColors, rtl }),
  };
}
