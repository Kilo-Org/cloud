/* eslint-disable react-native/no-inline-styles -- the Android widget host requires native style objects */
'use no memo';

import { FlexWidget, type HexColor, TextWidget } from 'react-native-android-widget';

import { LAUNCHER_NEW_AGENT_URL } from '@/lib/launcher-surfaces';

import { type AndroidWidgetProps } from './widget-props';

// Short rows reserve two 48dp targets, side by side on one band or stacked in a column.
export const ACTION_TARGET = 48;

type Palette = {
  background: HexColor;
  foreground: HexColor;
  mutedForeground: HexColor;
  primary: HexColor;
  primaryForeground: HexColor;
  warn: HexColor;
  good: HexColor;
};
export type Paint = { palette: Palette; rtl: boolean };
export type Copy = NonNullable<AndroidWidgetProps['homeCopy']>;
type CountLine = Copy['secondaryCounts'][number];
export type EntryRow = { title: string; time: string | null };

/** Strip and compact heroes put the label beside the number; cards stack it. */
export type HeroVariant = 'strip' | 'compact' | 'regular' | 'large';
const HERO_METRICS = {
  strip: { inline: true, statusSize: 12, statusLines: 1, numberSize: 22, labelSize: 13 },
  compact: { inline: true, statusSize: 12, statusLines: 2, numberSize: 25, labelSize: 13 },
  regular: { inline: false, statusSize: 18, statusLines: 2, numberSize: 34, labelSize: 14 },
  large: { inline: false, statusSize: 18, statusLines: 3, numberSize: 44, labelSize: 14 },
} as const;

const DOT_COLORS = {
  needsInput: 'warn',
  running: 'good',
  idle: 'mutedForeground',
  scheduled: 'mutedForeground',
} as const satisfies Record<CountLine['kind'], keyof Palette>;

const TALL_SCRIPT = /[\u0600-\u08FF\u0900-\u0DFF]/u;

/**
 * Largest font whose line box fits `height`. Scripts with tall fallback metrics
 * (Arabic-Indic, Devanagari) need the host's 1.62 line ratio, not the Latin 1.32.
 */
function fittedSize(value: string, height: number, preferred: number): number {
  const ratio = TALL_SCRIPT.test(value) ? 1.62 : 1.32;
  const sizes = [preferred, 12, 11, 10, 9].filter(size => size <= preferred);
  return sizes.find(size => Math.ceil(size * ratio) <= height) ?? 9;
}

export function readingOrder(children: React.ReactNode[], rtl: boolean) {
  return rtl ? [...children].toReversed() : children;
}

/**
 * Pick the hero variant a band can hold, using the tallest fallback line metrics
 * so neither the count nor its label is ever clipped.
 */
export function heroVariantFor(heroHeight: number): HeroVariant {
  if (heroHeight >= 82) {
    return 'large';
  }
  if (heroHeight >= 68) {
    return 'regular';
  }
  if (heroHeight >= 33) {
    return 'compact';
  }
  return 'strip';
}

export function text(
  value: string,
  paint: Paint,
  options: {
    size: number;
    bold?: boolean;
    muted?: boolean;
    lines?: number;
    /** Centred copy ignores the surface direction: it is a composition axis, not a reading edge. */
    align?: 'left' | 'center' | 'right';
  }
) {
  return (
    <TextWidget
      text={value}
      maxLines={options.lines ?? 1}
      truncate="END"
      allowFontScaling={false}
      style={{
        fontSize: options.size,
        fontWeight: options.bold ? 'bold' : 'normal',
        color: options.muted ? paint.palette.mutedForeground : paint.palette.foreground,
        textAlign: options.align ?? (paint.rtl ? 'right' : 'left'),
      }}
    />
  );
}

export function action(
  props: AndroidWidgetProps,
  kind: 'create' | 'approve' | 'approve-labeled',
  paint: Paint
) {
  const create = kind === 'create';
  const labeled = kind === 'approve-labeled';
  const width = labeled ? 104 : ACTION_TARGET;
  const approvalKey = props.home?.approvalKey ?? null;
  const enabled = create
    ? (props.home?.canCreate ?? props.actions.newAgent)
    : props.home?.canApprove === true &&
      approvalKey !== null &&
      props.actionFeedback !== 'approving';
  if (!enabled) {
    // Both controls own a fixed slot, even while approving or privacy-blanked.
    return <FlexWidget key={kind} style={{ width, height: ACTION_TARGET }} />;
  }
  const label = create ? props.actions.newAgentLabel : props.actions.approveLabel;
  // oxlint-disable-next-line no-literal-copy/no-literal-copy -- compact action glyphs, with translated spoken labels
  const glyph = { create: '+', approve: '✓', 'approve-labeled': label }[kind];
  return (
    <FlexWidget
      key={kind}
      {...(create
        ? { clickAction: 'OPEN_URI', clickActionData: { uri: LAUNCHER_NEW_AGENT_URL } }
        : { clickAction: 'approve', clickActionData: { approvalKey } })}
      accessibilityLabel={label}
      style={{ width, height: ACTION_TARGET, alignItems: 'center', justifyContent: 'center' }}
    >
      <FlexWidget
        style={{
          width: labeled ? 88 : 32,
          height: 32,
          borderRadius: 16,
          backgroundColor: create ? paint.palette.primary : paint.palette.warn,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <TextWidget
          text={glyph}
          maxLines={1}
          truncate="END"
          allowFontScaling={false}
          style={{
            fontSize: labeled ? 13 : 22,
            color: paint.palette.primaryForeground,
            fontWeight: 'bold',
          }}
        />
      </FlexWidget>
    </FlexWidget>
  );
}

export function header(props: AndroidWidgetProps, paint: Paint, wide: boolean) {
  return (
    <FlexWidget
      style={{
        width: 'match_parent',
        height: ACTION_TARGET,
        flexDirection: 'row',
        alignItems: 'center',
        flexGap: 8,
      }}
    >
      {readingOrder(
        [
          <FlexWidget
            key="brand"
            style={{ width: 0, flex: 1, alignItems: paint.rtl ? 'flex-end' : 'flex-start' }}
          >
            {text('Kilo', paint, { size: 18, bold: true })}
          </FlexWidget>,
          action(props, wide ? 'approve-labeled' : 'approve', paint),
          action(props, 'create', paint),
        ],
        paint.rtl
      )}
    </FlexWidget>
  );
}

export function hero(copy: Copy, paint: Paint, variant: HeroVariant) {
  const metrics = HERO_METRICS[variant];
  if (copy.primaryLabel === null) {
    return (
      <FlexWidget style={{ flex: 1, justifyContent: 'center' }}>
        {text(copy.status ?? '', paint, {
          size: metrics.statusSize,
          bold: true,
          lines: metrics.statusLines,
        })}
      </FlexWidget>
    );
  }
  const number = text(copy.primaryCount, paint, { size: metrics.numberSize, bold: true });
  const label = text(copy.primaryLabel, paint, { size: metrics.labelSize });
  const leadingEdge = paint.rtl ? 'flex-end' : 'flex-start';
  return (
    <FlexWidget
      style={{
        flex: 1,
        flexDirection: metrics.inline ? 'row' : 'column',
        alignItems: metrics.inline ? 'center' : leadingEdge,
        justifyContent: 'center',
        flexGap: metrics.inline ? 6 : 0,
      }}
    >
      {metrics.inline
        ? readingOrder(
            [
              <FlexWidget key="number">{number}</FlexWidget>,
              <FlexWidget
                key="label"
                style={{ width: 0, flex: 1, alignItems: paint.rtl ? 'flex-end' : 'flex-start' }}
              >
                {label}
              </FlexWidget>,
            ],
            paint.rtl
          )
        : [
            <FlexWidget key="number">{number}</FlexWidget>,
            <FlexWidget key="label">{label}</FlexWidget>,
          ]}
    </FlexWidget>
  );
}

export function countRow(line: CountLine, paint: Paint) {
  return (
    <FlexWidget
      key={line.kind}
      style={{
        width: 'match_parent',
        height: 26,
        flexDirection: 'row',
        alignItems: 'center',
        flexGap: 6,
      }}
    >
      {readingOrder(
        [
          <FlexWidget
            key="dot"
            style={{
              width: 5,
              height: 5,
              borderRadius: 3,
              backgroundColor: paint.palette[DOT_COLORS[line.kind]],
            }}
          />,
          <FlexWidget key="number">{text(line.count, paint, { size: 15, bold: true })}</FlexWidget>,
          <FlexWidget
            key="label"
            style={{ width: 0, flex: 1, alignItems: paint.rtl ? 'flex-end' : 'flex-start' }}
          >
            {text(line.label, paint, { size: 13, muted: true })}
          </FlexWidget>,
        ],
        paint.rtl
      )}
    </FlexWidget>
  );
}

/** `fallback` fills an empty detail slot with the first support count. */
export function detailValue(copy: Copy, fallback: boolean): string {
  if (copy.detail !== null && copy.detail !== '') {
    return copy.detail;
  }
  const first = copy.secondaryCounts[0];
  return fallback && first !== undefined ? `${first.count} ${first.label}` : '';
}

export function detail(
  copy: Copy,
  paint: Paint,
  slot: { height: number; fallback: boolean; size?: number; available?: number }
) {
  const composed = detailValue(copy, slot.fallback);
  const first = entryRows(copy)[0];
  // A 148-179dp line fits the agent title, not "Last known - <title>".
  const prefixed =
    first !== undefined &&
    first.title !== '' &&
    composed.includes(first.title) &&
    composed !== first.title;
  const value = prefixed && (slot.available ?? Infinity) < 200 ? first.title : composed;
  const preferred = slot.size ?? (slot.height < 20 ? 11 : 12);
  return (
    <FlexWidget
      style={{
        width: 'match_parent',
        height: slot.height,
        justifyContent: 'center',
        alignItems: paint.rtl ? 'flex-end' : 'flex-start',
      }}
    >
      {text(value, paint, {
        size: fittedSize(value, slot.height, preferred),
        muted: true,
      })}
    </FlexWidget>
  );
}

export function footer(copy: Copy, paint: Paint, height = 20) {
  const value = copy.checked ?? '';
  const preferred = height >= 20 ? 12 : 11;
  return (
    <FlexWidget
      style={{
        width: 'match_parent',
        height,
        justifyContent: 'center',
        alignItems: paint.rtl ? 'flex-end' : 'flex-start',
      }}
    >
      {text(value, paint, { size: fittedSize(value, height, preferred), muted: true })}
    </FlexWidget>
  );
}

/** Earliest waits first, then scheduled wakes: the card lists whichever the copy carries. */
export function entryRows(copy: Copy): EntryRow[] {
  return copy.waitingAgents.length > 0
    ? copy.waitingAgents.map(agent => ({ title: agent.title, time: agent.reason }))
    : copy.scheduledAgents.map(agent => ({ title: agent.title, time: agent.time }));
}
