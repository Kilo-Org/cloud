/* eslint-disable react-native/no-inline-styles -- the Android widget host requires native style objects */
'use no memo';

import { FlexWidget, type WidgetInfo } from 'react-native-android-widget';

import {
  ACTION_TARGET,
  type Copy,
  countRow,
  detail,
  entryRows,
  footer,
  header,
  hero,
  heroVariantFor,
  type Paint,
  readingOrder,
  text,
} from './active-agents-widget-parts';
import { type AndroidWidgetProps } from './widget-props';

/** Keep the existing native renderer's height buckets. */
export const SHORT_HEIGHT = 180;
/** Every card insets its content by this much on every side. */
export const MARGIN = 12;
/** Footer line height: the checked stamp owns only its own line, not the leftover. */
const FOOTER_HEIGHT = 16;
/** One line of secondary copy between the hero and the entries. */
const DETAIL_HEIGHT = 24;
/** Copy size is a fraction of the card width so a locked portrait cell reads deliberate. */
const COPY_RATIO = 0.078;
/** Capped so a locked cell reads as a state panel, not a headline stretched to the width. */
const COPY_MAX = 24;
/** The lock is sized from the copy, not the cell: its full height is ~1.35x the copy's
 * cap height (the host font's cap height is ~0.75 of its size) so glyph and words match. */
const LOCK_PER_COPY = 1.35 * 0.75;
/** The host font's line box and the glyph-to-copy gap, both per unit of copy size. */
const COPY_LINE = 1.32;
const LOCK_GAP = 0.5;

/** Everything one layout needs to draw a placed widget in one palette. */
export type Frame = {
  props: AndroidWidgetProps;
  copy: Copy;
  paint: Paint;
  info: WidgetInfo;
};

/** One of the three equal flexible gaps that spread the free height down the card. */
function gap(key: string) {
  return <FlexWidget key={key} style={{ width: 'match_parent', flex: 1 }} />;
}

/** The primary line for a band, told how much width it actually has. */
export function rowDetail(
  copy: Copy,
  paint: Paint,
  slot: { height: number; size: number; available: number }
) {
  return detail(copy, paint, { ...slot, fallback: false });
}

/** Row typography scales with the height a cell can afford a row. */
const ENTRY_SIZES = [
  { min: 60, title: 16, reason: 13 },
  { min: 50, title: 15, reason: 12 },
];

function entrySizes(rowHeight: number) {
  return (
    ENTRY_SIZES.find(entry => rowHeight >= entry.min) ?? {
      title: 14,
      reason: 12,
    }
  );
}

/**
 * The list owns exactly the height its rows need: rows stay capped so a tall cell
 * shows roomy rows rather than two blocks pushed to the edges, and the block keeps
 * its rows centred. The leftover belongs to the three gaps around it.
 */
function entries(copy: Copy, paint: Paint, slot: { slots: number; rowHeight: number }) {
  const { title: titleSize, reason: reasonSize } = entrySizes(slot.rowHeight);
  return (
    <FlexWidget
      style={{
        width: 'match_parent',
        height: slot.slots * slot.rowHeight,
        justifyContent: 'center',
      }}
    >
      {entryRows(copy)
        .slice(0, slot.slots)
        .map((row, index) => (
          <FlexWidget
            key={index}
            style={{
              width: 'match_parent',
              height: slot.rowHeight,
              justifyContent: 'center',
              // The host lays text out from its left edge; a row is mirrored by hand so
              // an RTL catalogue keeps every line on its reading-start side.
              alignItems: paint.rtl ? 'flex-end' : 'flex-start',
            }}
          >
            {text(row.title, paint, { size: titleSize })}
            {row.time === null ? null : text(row.time, paint, { size: reasonSize, muted: true })}
          </FlexWidget>
        ))}
    </FlexWidget>
  );
}

/** The natural hero height for a body, picked in bands so no count or label is clipped. */
function naturalHero(body: number): number {
  if (body >= 300) {
    return 84;
  }
  if (body >= 210) {
    return 68;
  }
  if (body >= 140) {
    return 44;
  }
  return 32;
}

/**
 * The full card: brand header, a hero block scaled to the cell (the primary line
 * and support counts travel with it), the entry rows, then the footer. Three equal
 * flexible gaps spread the leftover, so the free height never pools in one place.
 */
export function card({ props, copy, paint, info }: Frame) {
  const wide = info.width >= 266;
  const inner = info.height - MARGIN * 2;
  const rows = entryRows(copy);
  const hasDetail = copy.detail !== null && copy.detail !== '';
  // The primary line and the first entry are the same agent while it waits: show it once.
  const firstEntry = rows[0];
  const duplicatesEntry =
    copy.detail !== null &&
    copy.detail !== '' &&
    firstEntry !== undefined &&
    firstEntry.title !== '' &&
    copy.detail.includes(firstEntry.title);
  // Wide cards show the support counts beside the hero, so the hero must clear them.
  const besideCounts = wide ? Math.min(3, copy.secondaryCounts.length) * 26 : 0;
  const heroFloor = Math.max(32, besideCounts);
  // Keep as many stacked counts as the card can hold without squeezing the hero out.
  let supportRows = wide ? 0 : Math.min(3, copy.secondaryCounts.length);
  while (supportRows > 0 && inner - ACTION_TARGET - FOOTER_HEIGHT - supportRows * 26 < heroFloor) {
    supportRows -= 1;
  }
  const plan = (suppressDetail: boolean) => {
    const body =
      inner -
      ACTION_TARGET -
      (suppressDetail || !hasDetail ? 0 : DETAIL_HEIGHT) -
      supportRows * 26 -
      FOOTER_HEIGHT;
    const heroHeight = Math.max(besideCounts, Math.min(naturalHero(body), Math.max(32, body)));
    const slots = Math.max(0, Math.min(3, Math.floor((body - heroHeight) / 44)));
    const rowHeight =
      slots === 0 ? 0 : Math.max(44, Math.min(64, Math.floor((body - heroHeight) / slots)));
    return { heroHeight, slots, rowHeight };
  };
  // Suppressing the primary line is only worth it while its entry is actually listed.
  let suppressed = duplicatesEntry;
  let planned = plan(suppressed);
  if (suppressed && planned.slots === 0) {
    suppressed = false;
    planned = plan(suppressed);
  }
  const { rowHeight } = planned;
  // Never reserve height for rows the copy does not carry.
  const slots = Math.min(planned.slots, rows.length);
  // A short card cannot hold a hero, a detail line, the footer and the counts together: drop the detail first.
  const bodyRoom = inner - ACTION_TARGET - supportRows * 26 - FOOTER_HEIGHT;
  const showDetail = !(suppressed || !hasDetail) && bodyRoom - DETAIL_HEIGHT >= heroFloor;
  // The hero keeps its floor and clears the counts beside it.
  const free = bodyRoom - (showDetail ? DETAIL_HEIGHT : 0);
  const heroHeight = slots === 0 ? Math.max(heroFloor, Math.min(free, 140)) : planned.heroHeight;
  const variant = heroVariantFor(heroHeight);
  // A 172dp-wide card can only fit the longest agent title at 11dp.
  const detailSize = info.width >= 280 ? 12 : 11;
  const avail = info.width - MARGIN * 2;
  return (
    <FlexWidget style={{ width: 'match_parent', height: 'match_parent' }}>
      {header(props, paint, wide)}
      {gap('gap-top')}
      <FlexWidget key="hero-block" style={{ width: 'match_parent' }}>
        <FlexWidget
          style={{
            width: 'match_parent',
            height: heroHeight,
            flexDirection: 'row',
            alignItems: 'center',
            flexGap: 12,
          }}
        >
          {readingOrder(
            [
              <FlexWidget key="hero" style={{ width: 0, flex: 1 }}>
                {hero(copy, paint, variant)}
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
        {showDetail
          ? rowDetail(copy, paint, {
              height: DETAIL_HEIGHT,
              size: detailSize,
              available: avail,
            })
          : null}
        {wide ? null : (
          <FlexWidget style={{ width: 'match_parent', height: supportRows * 26 }}>
            {copy.secondaryCounts.slice(0, supportRows).map(line => countRow(line, paint))}
          </FlexWidget>
        )}
      </FlexWidget>
      {slots > 0 ? gap('gap-middle') : null}
      {slots > 0 ? entries(copy, paint, { slots, rowHeight }) : null}
      {gap('gap-bottom')}
      {footer(copy, paint, FOOTER_HEIGHT)}
    </FlexWidget>
  );
}

/** A padlock drawn from two rectangles: a rounded shackle sitting on a rounded body. */
function lockGlyph(paint: Paint, size: number) {
  const stroke = Math.max(2, Math.round(size * 0.13));
  const bodyHeight = Math.round(size * 0.6);
  const shackleWidth = Math.round(size * 0.54);
  return (
    <FlexWidget
      key="lock"
      style={{
        width: size,
        height: size,
        flexDirection: 'column',
        alignItems: 'center',
      }}
    >
      <FlexWidget
        style={{
          width: shackleWidth,
          height: size - bodyHeight,
          borderWidth: stroke,
          borderBottomWidth: 0,
          borderColor: paint.palette.foreground,
          borderTopLeftRadius: Math.round(shackleWidth / 2),
          borderTopRightRadius: Math.round(shackleWidth / 2),
        }}
      />
      <FlexWidget
        style={{
          width: size,
          height: bodyHeight,
          borderRadius: Math.max(2, Math.round(size * 0.16)),
          backgroundColor: paint.palette.foreground,
        }}
      />
    </FlexWidget>
  );
}

/**
 * The locked card (privacy/signed-out): the brand header, then one state block -
 * a lock and the existing privacy copy - centred in the free height. The copy is
 * sized from the cell so a portrait card reads as a deliberate composition.
 */
export function locked({ copy, paint, info }: Frame) {
  const band = info.height < SHORT_HEIGHT;
  const brandHeight = band ? 22 : ACTION_TARGET;
  let brandSize = 18;
  if (band) {
    brandSize = 14;
  }
  if (info.height < 96) {
    brandSize = 12;
  }
  // The thinnest bands drop the glyph: a copy on one line beats a squeezed lock.
  const showLock = info.height >= 92;
  const footerHeight = copy.checked === null ? 0 : FOOTER_HEIGHT;
  // Copy is capped by width; the free height then bounds it through the whole stack
  // (glyph, gap and one line), so the block stays whole and the spacing carries the rest.
  const byWidth = Math.min(COPY_MAX, Math.max(12, Math.round(info.width * COPY_RATIO)));
  const stack = showLock ? LOCK_PER_COPY + LOCK_GAP + COPY_LINE : COPY_LINE;
  const inner = info.height - (band ? 0 : MARGIN * 2) - brandHeight - footerHeight - 8;
  const size = Math.max(11, Math.min(byWidth, Math.floor(inner / stack)));
  const lockSize = Math.max(12, Math.round(size * LOCK_PER_COPY));
  return (
    <FlexWidget
      style={{
        width: 'match_parent',
        height: 'match_parent',
        marginHorizontal: band ? MARGIN : 0,
      }}
    >
      <FlexWidget
        style={{
          width: 'match_parent',
          height: brandHeight,
          flexDirection: 'row',
          alignItems: 'center',
          // Brand sits on the reading-start edge: left in LTR, right in RTL.
          justifyContent: paint.rtl ? 'flex-end' : 'flex-start',
        }}
      >
        {text('Kilo', paint, { size: brandSize, bold: true })}
      </FlexWidget>
      <FlexWidget
        key="state"
        style={{
          width: 'match_parent',
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          flexGap: Math.round(size * LOCK_GAP),
        }}
      >
        {showLock ? lockGlyph(paint, lockSize) : null}
        {text(copy.status ?? '', paint, { size, align: 'center' })}
      </FlexWidget>
      {copy.checked === null ? null : footer(copy, paint, FOOTER_HEIGHT)}
    </FlexWidget>
  );
}
