/* eslint-disable react-native/no-inline-styles -- the Android widget host requires native style objects */
'use no memo';

import { FlexWidget, type HexColor, TextWidget } from 'react-native-android-widget';

import { LAUNCHER_NEW_AGENT_URL } from '@/lib/launcher-surfaces';

import { type AndroidWidgetProps } from './widget-props';

// Short rows reserve two 48dp targets.
export const ACTION_TARGET = 48;
export const ENTRY_ROW_HEIGHT = 48;

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

export function readingOrder(children: React.ReactNode[], rtl: boolean) {
  return rtl ? [...children].toReversed() : children;
}

export function text(
  value: string,
  paint: Paint,
  options: {
    size: number;
    bold?: boolean;
    muted?: boolean;
    lines?: number;
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
        textAlign: paint.rtl ? 'right' : 'left',
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
    <FlexWidget style={{ height: ACTION_TARGET, flexDirection: 'row', alignItems: 'center' }}>
      {readingOrder(
        [
          <FlexWidget key="brand" style={{ flex: 1 }}>
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
              <FlexWidget key="label" style={{ flex: 1 }}>
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
      style={{ height: 26, flexDirection: 'row', alignItems: 'center', flexGap: 6 }}
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
          <FlexWidget key="label" style={{ flex: 1 }}>
            {text(line.label, paint, { size: 13, muted: true })}
          </FlexWidget>,
        ],
        paint.rtl
      )}
    </FlexWidget>
  );
}

/** `fallback` fills an empty detail slot with the first support count. */
export function detail(copy: Copy, paint: Paint, slot: { height: number; fallback: boolean }) {
  const first = copy.secondaryCounts[0];
  const value =
    copy.detail ?? (slot.fallback && first !== undefined ? `${first.count} ${first.label}` : '');
  return (
    <FlexWidget style={{ height: slot.height, justifyContent: 'center' }}>
      {text(value, paint, { size: slot.height < 20 ? 11 : 12, muted: true })}
    </FlexWidget>
  );
}

export function footer(copy: Copy, paint: Paint, height = 20) {
  return (
    <FlexWidget style={{ height, justifyContent: 'center' }}>
      {text(copy.checked ?? '', paint, { size: 11, muted: true })}
    </FlexWidget>
  );
}

export function entries(copy: Copy, paint: Paint, slots: number) {
  const rows =
    copy.waitingAgents.length > 0
      ? copy.waitingAgents.map(agent => ({ title: agent.title, time: agent.reason }))
      : copy.scheduledAgents;
  return (
    <FlexWidget style={{ height: slots * ENTRY_ROW_HEIGHT }}>
      {rows.slice(0, slots).map((row, index) => (
        <FlexWidget
          key={index}
          style={{
            height: ENTRY_ROW_HEIGHT,
            justifyContent: 'center',
          }}
        >
          {text(row.title, paint, { size: 14 })}
          {row.time === null ? null : text(row.time, paint, { size: 12, muted: true })}
        </FlexWidget>
      ))}
    </FlexWidget>
  );
}
