/* eslint-disable react-native/no-inline-styles -- the Android widget host requires native style objects */
'use no memo';

import { FlexWidget } from 'react-native-android-widget';

import { type Frame, MARGIN, rowDetail } from './active-agents-widget-card';
import {
  action,
  ACTION_TARGET,
  detailValue,
  footer,
  hero,
  type Paint,
  readingOrder,
  text,
} from './active-agents-widget-parts';
import { type AndroidWidgetProps } from './widget-props';

/** Above this width a short cell puts the actions beside the text instead of under it. */
const SIDE_ACTIONS_WIDTH = 300;

/** The two 48dp controls, side by side, always in a fixed 100dp group. */
function actions(props: AndroidWidgetProps, paint: Paint) {
  return (
    <FlexWidget key="actions" style={{ flexDirection: 'row', alignItems: 'center', flexGap: 4 }}>
      {readingOrder([action(props, 'approve', paint), action(props, 'create', paint)], paint.rtl)}
    </FlexWidget>
  );
}

/**
 * A wide short cell (landscape rows, 4x1 portrait): Kilo and the count share the
 * first band, then the detail and the checked time; the actions sit in a 100dp
 * column beside them so both lines get the full width. Each band is one line.
 */
function shortWide({ props, copy, paint, info }: Frame) {
  const hasDetail = detailValue(copy, false) !== '';
  const textWidth = info.width - (ACTION_TARGET * 2 + 4) - MARGIN * 2 - 4;
  const smallSize = info.width >= 400 ? 12 : 10;
  const hasChecked = (copy.checked ?? '') !== '';
  const lines = 1 + (hasDetail ? 1 : 0) + (hasChecked ? 1 : 0);
  // A 30dp head (22dp count) plus 15dp per extra line is the tightest every script fits.
  const extra = lines - 1;
  const outer = Math.max(0, Math.min(MARGIN, Math.floor((info.height - (30 + extra * 15)) / 2)));
  const content = info.height - 2 * outer;
  let small = Math.max(15, Math.min(24, Math.floor((content - 30) / Math.max(1, extra))));
  let head = content - small * extra;
  if (head < 30) {
    small = Math.floor((content - 30) / Math.max(1, extra));
    head = content - small * extra;
  }
  return (
    <FlexWidget
      style={{
        width: 'match_parent',
        flexDirection: 'row',
        alignItems: 'center',
        flexGap: 4,
        marginHorizontal: MARGIN,
        marginVertical: outer,
      }}
    >
      {readingOrder(
        [
          <FlexWidget key="text" style={{ width: 0, flex: 1 }}>
            <FlexWidget
              key="head"
              style={{
                width: 'match_parent',
                height: head,
                flexDirection: 'row',
                alignItems: 'center',
                flexGap: 6,
              }}
            >
              {readingOrder(
                [
                  <FlexWidget key="brand">
                    {text('Kilo', paint, { size: 14, bold: true })}
                  </FlexWidget>,
                  <FlexWidget key="hero" style={{ width: 0, flex: 1 }}>
                    {hero(copy, paint, 'strip')}
                  </FlexWidget>,
                ],
                paint.rtl
              )}
            </FlexWidget>
            {hasDetail
              ? rowDetail(copy, paint, { height: small, size: smallSize, available: textWidth })
              : null}
            {hasChecked ? footer(copy, paint, small) : null}
          </FlexWidget>,
          actions(props, paint),
        ],
        paint.rtl
      )}
    </FlexWidget>
  );
}

/**
 * The narrowest short cell (2x1 portrait, 172dp): the count owns the header band
 * beside the two 48dp controls, then the brand with its label, the detail and the
 * checked time each get the full 148dp width. Every line is one line, so nothing
 * ellipsises. The label cannot join the count band: a 22dp count, a 48dp control
 * band and two tall-script-safe 15dp lines already need 108dp of the 104dp cell.
 */
function shortNarrow({ props, copy, paint, info }: Frame) {
  const count = copy.primaryLabel !== null;
  const label = count ? copy.primaryCount : 'Kilo';
  const hasDetail = detailValue(copy, false) !== '';
  const hasChecked = (copy.checked ?? '') !== '';
  const band = 20;
  const line = 15;
  const avail = info.width - MARGIN * 2;
  const total = ACTION_TARGET + band + (hasDetail ? line : 0) + (hasChecked ? line : 0);
  const outer = Math.max(0, Math.min(MARGIN, Math.floor((info.height - total) / 2)));
  return (
    <FlexWidget style={{ width: 'match_parent', marginHorizontal: MARGIN, marginVertical: outer }}>
      <FlexWidget
        key="head"
        style={{
          width: 'match_parent',
          height: ACTION_TARGET,
          flexDirection: 'row',
          alignItems: 'center',
          flexGap: 6,
        }}
      >
        {readingOrder(
          [
            <FlexWidget
              key="count"
              style={{ width: 0, flex: 1, alignItems: paint.rtl ? 'flex-end' : 'flex-start' }}
            >
              {count
                ? text(label, paint, { size: 22, bold: true })
                : text(label, paint, { size: 15, bold: true })}
            </FlexWidget>,
            actions(props, paint),
          ],
          paint.rtl
        )}
      </FlexWidget>
      <FlexWidget
        key="label"
        style={{
          width: 'match_parent',
          height: band,
          flexDirection: 'row',
          alignItems: 'center',
          flexGap: 6,
        }}
      >
        {readingOrder(
          [
            count ? (
              <FlexWidget key="brand">{text('Kilo', paint, { size: 12, bold: true })}</FlexWidget>
            ) : null,
            <FlexWidget
              key="value"
              style={{ width: 0, flex: 1, alignItems: paint.rtl ? 'flex-end' : 'flex-start' }}
            >
              {count
                ? text(copy.primaryLabel ?? '', paint, { size: 12, muted: true })
                : text(copy.status ?? '', paint, { size: 12, bold: true })}
            </FlexWidget>,
          ],
          paint.rtl
        )}
      </FlexWidget>
      {hasDetail ? rowDetail(copy, paint, { height: line, size: 11, available: avail }) : null}
      {hasChecked ? footer(copy, paint, line) : null}
    </FlexWidget>
  );
}

export function short(frame: Frame) {
  return frame.info.width >= SIDE_ACTIONS_WIDTH ? shortWide(frame) : shortNarrow(frame);
}
