/* eslint-disable react-native/no-inline-styles -- the Android widget host requires native style objects */
'use no memo';

import {
  FlexWidget,
  type WidgetInfo,
  type WidgetRepresentation,
} from 'react-native-android-widget';

import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';

import {
  action,
  ACTION_TARGET,
  type Copy,
  countRow,
  detail,
  entries,
  ENTRY_ROW_HEIGHT,
  footer,
  header,
  hero,
  type Paint,
  readingOrder,
  text,
} from './active-agents-widget-parts';
import { type AndroidWidgetProps } from './widget-props';

export const WIDGET_NAME = 'ActiveAgentsWidget';

// Keep the existing native renderer's height buckets.
const SHORT_HEIGHT = 180;

/** Everything one layout needs to draw a placed widget in one palette. */
type Frame = { props: AndroidWidgetProps; copy: Copy; paint: Paint; info: WidgetInfo };

/** A landscape launcher row: brand/checked, hero/detail, then two 48dp actions. */
function strip({ props, copy, paint, info }: Frame) {
  const wide = info.width >= 467;
  return (
    <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', flexGap: 6 }}>
      {readingOrder(
        [
          <FlexWidget key="brand" style={{ width: 96 }}>
            {text('Kilo', paint, { size: 14, bold: true })}
            {footer(copy, paint)}
          </FlexWidget>,
          <FlexWidget
            key="body"
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', flexGap: 8 }}
          >
            {readingOrder(
              [
                <FlexWidget key="hero" style={{ flex: 1 }}>
                  {hero(copy, paint, 'strip')}
                  {detail(copy, paint, { height: 18, fallback: !wide })}
                </FlexWidget>,
                wide ? (
                  <FlexWidget
                    key="support"
                    style={{ width: Math.floor((info.width - 226) * 0.4), height: 52 }}
                  >
                    {copy.secondaryCounts.slice(0, 2).map(line => countRow(line, paint))}
                  </FlexWidget>
                ) : null,
              ],
              paint.rtl
            )}
          </FlexWidget>,
          action(props, 'approve', paint),
          action(props, 'create', paint),
        ],
        paint.rtl
      )}
    </FlexWidget>
  );
}

/** 2x1 keeps the hero, wake/detail and checked slots; actions use the full height. */
function compact({ props, copy, paint, info }: Frame) {
  const innerHeight = info.height - 8;
  const wide = info.width >= 266;
  const supportSlots = Math.min(3, Math.floor((innerHeight - 34) / 26));
  return (
    <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', flexGap: 4 }}>
      {readingOrder(
        [
          <FlexWidget key="body" style={{ flex: 1, height: innerHeight }}>
            <FlexWidget style={{ height: 16 }}>
              {text('Kilo', paint, { size: 12, bold: true })}
            </FlexWidget>
            <FlexWidget
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                flexGap: wide ? 12 : 0,
              }}
            >
              {readingOrder(
                [
                  <FlexWidget key="hero" style={{ flex: 1, height: innerHeight - 34 }}>
                    <FlexWidget style={{ flex: 1, justifyContent: 'center' }}>
                      {hero(copy, paint, info.height < 130 ? 'compact' : 'regular')}
                    </FlexWidget>
                    {detail(copy, paint, { height: 20, fallback: !wide })}
                  </FlexWidget>,
                  wide ? (
                    <FlexWidget
                      key="support"
                      style={{
                        width: Math.floor((info.width - 72) * 0.46),
                        height: supportSlots * 26,
                      }}
                    >
                      {copy.secondaryCounts
                        .slice(0, supportSlots)
                        .map(line => countRow(line, paint))}
                    </FlexWidget>
                  ) : null,
                ],
                paint.rtl
              )}
            </FlexWidget>
            {footer(copy, paint, 18)}
          </FlexWidget>,
          <FlexWidget
            key="actions"
            style={{ width: ACTION_TARGET, height: innerHeight, justifyContent: 'space-between' }}
          >
            {action(props, 'create', paint)}
            {action(props, 'approve', paint)}
          </FlexWidget>,
        ],
        paint.rtl
      )}
    </FlexWidget>
  );
}

function card({ props, copy, paint, info }: Frame) {
  const large = info.height >= 300;
  const wide = info.width >= 266;
  const heroHeight = large ? 100 : 80;
  // Wide cards show the support counts beside the hero instead of below it.
  const stackedSupportSlots = large ? 3 : 1;
  const supportSlots = wide ? 0 : stackedSupportSlots;
  const innerHeight = info.height - 24;
  const entryRoom = innerHeight - ACTION_TARGET - heroHeight - 24 - supportSlots * 26 - 20;
  const entrySlots = Math.max(0, Math.min(3, Math.floor(entryRoom / ENTRY_ROW_HEIGHT)));
  return (
    <FlexWidget style={{ height: 'match_parent' }}>
      {header(props, paint, wide)}
      <FlexWidget
        style={{ height: heroHeight, flexDirection: 'row', alignItems: 'center', flexGap: 12 }}
      >
        {readingOrder(
          [
            <FlexWidget key="hero" style={{ flex: 1 }}>
              {hero(copy, paint, large ? 'large' : 'regular')}
            </FlexWidget>,
            wide ? (
              <FlexWidget
                key="support"
                style={{
                  width: Math.floor((info.width - 36) * 0.46),
                  height: heroHeight,
                  justifyContent: 'center',
                }}
              >
                {copy.secondaryCounts.map(line => countRow(line, paint))}
              </FlexWidget>
            ) : null,
          ],
          paint.rtl
        )}
      </FlexWidget>
      {detail(copy, paint, { height: 24, fallback: false })}
      {wide ? null : (
        <FlexWidget style={{ height: supportSlots * 26 }}>
          {copy.secondaryCounts.slice(0, supportSlots).map(line => countRow(line, paint))}
        </FlexWidget>
      )}
      {entries(copy, paint, entrySlots)}
      <FlexWidget style={{ flex: 1 }} />
      {footer(copy, paint)}
    </FlexWidget>
  );
}

// Old persisted props have no Home presentation. They get the same hierarchy;
// fresh producers always provide shared Home policy and translated Home copy.
function copyFor(props: AndroidWidgetProps): Copy {
  if (props.homeCopy !== undefined) {
    return props.homeCopy;
  }
  const primary = props.countLines.find(line => line.label === props.primaryLabel);
  return {
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

function layoutFor(frame: Frame) {
  if (frame.info.height < 80) {
    return strip(frame);
  }
  if (frame.info.height < SHORT_HEIGHT) {
    return compact(frame);
  }
  return card(frame);
}

function draw(props: AndroidWidgetProps, info: WidgetInfo, paint: Paint) {
  const copy = copyFor(props);
  const isStrip = info.height < 80;
  const isCompact = info.height < SHORT_HEIGHT;
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: 'kiloapp:///cloud/sessions' }}
      accessibilityLabel={copy.accessibilityLabel}
      style={{
        width: 'match_parent',
        height: 'match_parent',
        borderRadius: 20,
        backgroundColor: paint.palette.background,
        padding: isStrip || isCompact ? 4 : 12,
      }}
    >
      {layoutFor({ props, copy, paint, info })}
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
