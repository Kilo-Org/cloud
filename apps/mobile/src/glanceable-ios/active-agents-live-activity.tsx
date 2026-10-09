/* eslint-disable max-lines -- the 'widget' layout function is stringified whole, so its helpers cannot be extracted to module scope; the surface stays in one function */
import { Button, Circle, HStack, RoundedRectangle, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityLabel,
  activityBackgroundTint,
  background,
  buttonStyle,
  environment,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  monospacedDigit,
  padding,
  shapes,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, type LiveActivityComponent } from 'expo-widgets';

import { type GlanceableLiveActivityContentState } from '@kilocode/notifications';

import { withGlanceableCopy } from './layout-copy';

// The layout function below is marked with the `'widget'` directive, so Babel
// stringifies it and the widget extension re-evaluates the source. Everything
// it references must be a widget global (`Text`, `VStack`, `Button`, the
// modifiers) or a built-in. Do not call `@/` helpers or i18n from here.
//
// `withGlanceableCopy` swaps `__KILO_GLANCEABLE_COPY__` for the translated copy
// after stringification. The copy is baked in rather than passed through the
// content state because the notifications Worker pushes the same raw shape and
// knows no locale.

// The pushed content state plus the facts only the app can add: whether the
// recorded ask is one Approve can answer, the failure line a retryable Approve
// left on the card, and whether an Approve press is in flight. They stay local
// fields rather than imports from `./view-props`, because Babel stringifies
// this function's source and every imported binding would be an undefined
// global in the widget process. `updatedAt` is optional: a card started by an
// older server build carries no checked time and draws none.
type ContentState = Partial<GlanceableLiveActivityContentState> & {
  canApprove?: boolean;
  notice?: string;
  approving?: boolean;
};

/**
 * The approved Live Activity design (round 7). The Lock Screen card is 364pt
 * wide: the header at 16pt (tile, Kilo, and the checked time trailing), the
 * status row centred at 74pt (count 36, dot, label 16, Approve pill 96x32), and
 * an optional muted line at 118pt — the card is 140pt tall with it and 108pt
 * without. The expanded Dynamic Island repeats it on black at count 32 and
 * label 15; the compact and minimal presentations carry the dot and the count.
 */
// Babel replaces the annotated arrow with its source string, so `layout` is a
// string at runtime while TypeScript still checks it as a component — the same
// shape `expo-widgets` casts internally.
const layout: LiveActivityComponent<ContentState> = (props, activityEnvironment) => {
  'widget';

  // The literal, not an imported constant: the widget transform stringifies
  // this function's source, so an imported binding would be an undefined
  // global in the widget process. `withGlanceableCopy` replaces the token,
  // quotes included, with the translated copy as a JSON source literal.
  // eslint-disable-next-line typescript-eslint/no-inferrable-types -- see above
  const copySource: string = '__KILO_GLANCEABLE_COPY__';
  const COPY = JSON.parse(copySource.startsWith('{') ? copySource : '{}') as Record<string, string>;
  const locale = COPY.locale ?? 'en';

  // The counts are stringified here, not formatted: a pushed content state
  // carries raw numbers and this process has no formatter. `COPY.digits` is the
  // language's own ten (empty when `String` already writes them) and
  // `COPY.group` its thousands separator.
  const digits = COPY.digits ?? '';
  const groupSeparator = COPY.group ?? ',';
  const count = (value: number) => {
    const plain = String(value);
    let grouped = '';
    for (let index = 0; index < plain.length; index += 1) {
      if (index > 0 && (plain.length - index) % 3 === 0) {
        grouped += groupSeparator;
      }
      grouped += plain[index] ?? '';
    }
    return digits.length === 10
      ? // eslint-disable-next-line unicorn/prefer-spread -- `replaceAll` and a spread both failed in the widget process; this form is the one verified on device
        grouped
          .split('')
          .map(character => (/[0-9]/.test(character) ? digits[Number(character)] : character))
          .join('')
      : grouped;
  };

  const status = props.status ?? 'empty';
  const statusLine = status === 'happy' ? null : (COPY[status] ?? null);
  const dark = activityEnvironment.colorScheme === 'dark';
  const palette = dark
    ? {
        bg: '#17171A',
        fg: '#F2F0EB',
        muted: '#8A8680',
        warn: '#F2B05F',
        good: '#5FCB8E',
        info: '#60A5FA',
        idle: '#56544F',
        primary: '#E8F27A',
        primaryFg: '#1A1A10',
        secondary: '#26262B',
      }
    : {
        bg: '#FBFAF5',
        fg: '#14130F',
        muted: '#6F6A61',
        warn: '#956011',
        good: '#24784A',
        info: '#2260EB',
        idle: '#A9A39A',
        primary: '#4F5A10',
        primaryFg: '#FFFFFF',
        secondary: '#F0EEE6',
      };

  // Rank order: what the user must act on, then what is making progress, then
  // what will wake, then what is only connected. One number leads every
  // presentation, so this ranking decides what a glance says.
  const countLines = [
    { kind: 'needsInput', label: COPY.needsInput ?? 'Needs input', count: props.needsInput ?? 0 },
    { kind: 'running', label: COPY.running ?? 'Working', count: props.running ?? 0 },
    { kind: 'scheduled', label: COPY.scheduled ?? 'Scheduled', count: props.scheduled ?? 0 },
    { kind: 'idle', label: COPY.idle ?? 'Idle', count: props.idle ?? 0 },
  ] as const;
  const primary = countLines.find(line => line.count > 0) ?? null;
  const others = countLines
    .filter(line => line.count > 0 && line !== primary)
    .map(line => `${count(line.count)} ${line.label}`)
    .join(' · ');
  type Scheme = {
    fg: string;
    muted: string;
    warn: string;
    tile: string;
    inner: string;
    primary: string;
    primaryFg: string;
    secondary: string;
    dots: Record<(typeof countLines)[number]['kind'], string>;
    countSize: number;
    labelSize: number;
  };
  const card: Scheme = {
    ...palette,
    tile: palette.fg,
    inner: palette.bg,
    dots: {
      needsInput: palette.warn,
      running: palette.good,
      scheduled: palette.info,
      idle: palette.idle,
    },
    countSize: 36,
    labelSize: 16,
  };
  // The Dynamic Island is always black: the dark palette with white text.
  const island: Scheme = {
    fg: '#FFFFFF',
    muted: '#8A8680',
    warn: '#F2B05F',
    tile: '#F2F0EB',
    inner: '#17171A',
    primary: '#E8F27A',
    primaryFg: '#1A1A10',
    secondary: '#26262B',
    dots: { needsInput: '#F2B05F', running: '#5FCB8E', scheduled: '#60A5FA', idle: '#56544F' },
    countSize: 32,
    labelSize: 15,
  };
  // Approval is offered only while an ask actually waits and the app recorded
  // one Approve can answer. `needsInput` counts questions and retried asks too,
  // so the wait count alone must not offer a control that cannot act; the
  // pushed `needsApproval` — the `permission` rows — narrows it. That narrower
  // count is also what stands in when the app wrote no flag, which is every
  // state that arrived over APNs: a question-only server state then offers no
  // tap, while a `permission` server state still offers the tap the app-closed
  // press answers. `withStatus` zeroes the wait count on expiry but leaves
  // `needsApproval` standing, so the wait term keeps the expired frame gateless.
  const canApprove =
    (props.needsInput ?? 0) > 0 && (props.needsApproval ?? 0) > 0 && props.canApprove !== false;
  // The press in flight replaces Approve with a muted Approving… pill; a
  // failure brings Approve back with its line under the counts.
  const approving = props.approving === true && (props.needsInput ?? 0) > 0;
  // A retry in flight hides the failure line it answers.
  const notice = approving ? null : (props.notice ?? null);
  const scheduledAt =
    primary?.kind === 'scheduled' && others.length === 0 && props.scheduledAt != null
      ? new Date(props.scheduledAt)
      : null;
  const updatedAt = props.updatedAt == null ? null : new Date(props.updatedAt);
  const checkedAt = updatedAt !== null && Number.isFinite(updatedAt.getTime()) ? updatedAt : null;
  const lastKnown =
    status === 'stale' || status === 'expired' || activityEnvironment.isStale === true;

  // Spoken label: status word, numeric counts, then Open agents. The whole
  // surface deep-links to the agents list, so "Open agents" stays in the
  // spoken label even though no line draws it.
  const accessibility = [
    ...(statusLine === null ? [] : [statusLine]),
    ...countLines.map(line => `${line.count} ${line.label}`),
    COPY.openAgents ?? 'Open agents',
  ].join(', ');

  // eslint-disable-next-line max-params -- a text run is its copy, size, colour and weight, named as the design names them
  const text = (
    value: string,
    size: number,
    color: string,
    weight: 'regular' | 'semibold' = 'regular'
  ) => (
    <Text modifiers={[font({ size, weight }), lineLimit(1), foregroundStyle(color)]}>{value}</Text>
  );
  const dot = (diameter: number, color: string) => (
    <Circle modifiers={[frame({ width: diameter, height: diameter }), foregroundStyle(color)]} />
  );
  // The Kilo tile: a filled square with a smaller square of the background in it.
  const tile = (size: number, fill: string, inner: string) => (
    <RoundedRectangle
      cornerRadius={1}
      modifiers={[
        foregroundStyle(inner),
        frame({ width: size * 0.44, height: size * 0.44 }),
        frame({ width: size, height: size }),
        background(fill, shapes.roundedRectangle({ cornerRadius: size * 0.22 })),
      ]}
    />
  );
  // The clock time alone today; another day adds its weekday.
  const clock = (date: Date, color: string) => {
    if (date.toDateString() === new Date().toDateString()) {
      return (
        <Text
          date={date}
          dateStyle="time"
          modifiers={[font({ size: 11 }), lineLimit(1), monospacedDigit(), foregroundStyle(color)]}
        />
      );
    }
    try {
      // eslint-disable-next-line no-restricted-globals -- the widget process cannot import @/lib/intl-cache; failure falls back to SwiftUI's date text
      const formatted = new Intl.DateTimeFormat(locale.split('_').join('-'), {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      }).format(date);
      return text(formatted, 11, color);
    } catch {
      return (
        <Text
          date={date}
          dateStyle="time"
          modifiers={[font({ size: 11 }), lineLimit(1), monospacedDigit(), foregroundStyle(color)]}
        />
      );
    }
  };

  // Header: the tile, Kilo, and the checked time at the trailing edge.
  const header = (scheme: Scheme) => (
    <HStack alignment="center" spacing={6} modifiers={[frame({ height: 18 })]}>
      {tile(18, scheme.tile, scheme.inner)}
      {text('Kilo', 13, scheme.fg, 'semibold')}
      <Spacer minLength={8} />
      {checkedAt === null ? null : (
        <HStack spacing={3}>
          {text(
            lastKnown ? `${COPY.lastKnown ?? 'Last known'} ·` : (COPY.checked ?? 'Checked'),
            11,
            scheme.muted
          )}
          {clock(checkedAt, scheme.muted)}
        </HStack>
      )}
    </HStack>
  );

  // The Approve pill, or the muted Approving… pill while the press is in
  // flight. The target literal must stay equal to `GLANCEABLE_APPROVE_TARGET`
  // in `interaction.ts`, which `active-agents-live-activity.test.ts` holds it to.
  const pill = (label: string, width: number, tone: { fill: string; color: string }) => (
    <Text
      modifiers={[
        font({ size: 13, weight: 'semibold' }),
        lineLimit(1),
        foregroundStyle(tone.color),
        fixedSize({ horizontal: true, vertical: false }),
        padding({ horizontal: 14 }),
        frame({ minWidth: width, height: 32 }),
        background(tone.fill, shapes.capsule()),
      ]}
    >
      {label}
    </Text>
  );
  const approveControl = (scheme: Scheme) => {
    if (approving) {
      return pill(COPY.approving ?? 'Approving…', 104, {
        fill: scheme.secondary,
        color: scheme.muted,
      });
    }
    if (!canApprove) {
      return null;
    }
    return (
      <Button
        target="approve"
        modifiers={[buttonStyle('plain'), accessibilityLabel(COPY.approve ?? 'Approve')]}
      >
        {pill(COPY.approve ?? 'Approve', 96, { fill: scheme.primary, color: scheme.primaryFg })}
      </Button>
    );
  };

  // The status row: count, dot, label; or the status line when nothing counts.
  // The spoken label sits on this block alone, so the Approve control after it
  // stays its own focusable element.
  const statusBlock = (scheme: Scheme) => (
    <HStack
      alignment="center"
      spacing={6}
      modifiers={[accessibilityElement('combine'), accessibilityLabel(accessibility)]}
    >
      {primary === null ? (
        text(
          statusLine ?? COPY.openAgents ?? 'Open agents',
          scheme.labelSize,
          scheme.fg,
          'semibold'
        )
      ) : (
        <Text
          modifiers={[
            font({ size: scheme.countSize, weight: 'bold' }),
            monospacedDigit(),
            lineLimit(1),
            fixedSize({ horizontal: true, vertical: false }),
            foregroundStyle(scheme.fg),
          ]}
        >
          {count(primary.count)}
        </Text>
      )}
      {primary === null ? null : dot(scheme.countSize > 32 ? 9 : 8, scheme.dots[primary.kind])}
      {primary === null ? null : text(primary.label, scheme.labelSize, scheme.fg, 'semibold')}
    </HStack>
  );

  // The line under the counts: a failed Approve's retry line, else the other
  // counts, else the next run of a scheduled-only card. Nothing shortens the card.
  const bottomLine = (scheme: Scheme) => {
    if (notice !== null) {
      return text(notice, 13, scheme.warn, 'semibold');
    }
    if (others.length > 0) {
      return text(others, 13, scheme.muted);
    }
    if (scheduledAt !== null && Number.isFinite(scheduledAt.getTime())) {
      return (
        <HStack spacing={3}>
          {text(COPY.nextRun ?? 'Next run', 13, scheme.muted)}
          <Text
            date={scheduledAt}
            dateStyle="time"
            modifiers={[
              font({ size: 13 }),
              lineLimit(1),
              monospacedDigit(),
              foregroundStyle(scheme.muted),
            ]}
          />
        </HStack>
      );
    }
    return null;
  };
  const cardLine = bottomLine(card);
  const islandLine = bottomLine(island);

  return {
    // Lock Screen: header @16, status row centred @74, line @118 (13pt).
    banner: (
      <VStack
        alignment="leading"
        spacing={0}
        modifiers={[
          padding({ top: 16, leading: 16, trailing: 16, bottom: cardLine === null ? 12.4 : 18.9 }),
          activityBackgroundTint(palette.bg),
          // The widget process takes its locale from the device language, so
          // without this the times would be formatted in a different language
          // than the baked labels.
          environment({ key: 'locale', value: locale }),
        ]}
      >
        {header(card)}
        <HStack alignment="center" spacing={0} modifiers={[padding({ top: 18.7 })]}>
          {statusBlock(card)}
          <Spacer minLength={10} />
          {approveControl(card)}
        </HStack>
        {cardLine === null ? null : (
          <VStack alignment="leading" spacing={0} modifiers={[padding({ top: 9.9 })]}>
            {cardLine}
          </VStack>
        )}
      </VStack>
    ),
    // The Apple Watch and CarPlay small family draws this section, not the
    // phone `banner`: one compact status row plus the Approve control, and the
    // failure line in a reserved row below so a failed press cannot move the
    // count or its retry control.
    bannerSmall: (
      <VStack alignment="leading" spacing={6}>
        <HStack alignment="center" spacing={10}>
          {statusBlock({ ...island, countSize: 20 })}
          {canApprove && !approving ? <Button label={COPY.approve} target="approve" /> : null}
          <Spacer />
        </HStack>
        <VStack modifiers={[frame({ height: 18 })]}>
          {notice === null ? null : text(notice, 13, island.warn, 'semibold')}
        </VStack>
      </VStack>
    ),
    // Compact: the tile leading, the dot and count trailing.
    compactLeading: tile(18, island.tile, island.inner),
    compactTrailing:
      primary === null ? null : (
        <HStack
          alignment="center"
          spacing={6}
          modifiers={[accessibilityElement('combine'), accessibilityLabel(accessibility)]}
        >
          {dot(8, island.dots[primary.kind])}
          <Text
            modifiers={[
              font({ size: 15, weight: 'bold' }),
              monospacedDigit(),
              lineLimit(1),
              foregroundStyle(island.fg),
            ]}
          >
            {count(primary.count)}
          </Text>
        </HStack>
      ),
    // Minimal: the dot and the count, capped at 99+.
    minimal:
      primary === null ? null : (
        <HStack
          alignment="center"
          spacing={7}
          modifiers={[accessibilityElement('combine'), accessibilityLabel(accessibility)]}
        >
          {dot(7, island.dots[primary.kind])}
          <Text
            modifiers={[
              font({ size: 14, weight: 'bold' }),
              monospacedDigit(),
              lineLimit(1),
              foregroundStyle(island.fg),
            ]}
          >
            {primary.count > 99 ? `${count(99)}+` : count(primary.count)}
          </Text>
        </HStack>
      ),
    // Expanded: the Lock Screen card on black at count 32 and label 15. The
    // island's rounded corner cuts into the leading edge, so the content keeps
    // an inset on both sides.
    expandedBottom: (
      <VStack
        alignment="leading"
        spacing={0}
        modifiers={[
          padding({ leading: 14, trailing: 14, bottom: islandLine === null ? 4 : 10 }),
          environment({ key: 'locale', value: locale }),
        ]}
      >
        {header(island)}
        <HStack alignment="center" spacing={0} modifiers={[padding({ top: 15.5 })]}>
          {statusBlock(island)}
          <Spacer minLength={10} />
          {approveControl(island)}
        </HStack>
        {islandLine === null ? null : (
          <VStack alignment="leading" spacing={0} modifiers={[padding({ top: 13.9 })]}>
            {islandLine}
          </VStack>
        )}
      </VStack>
    ),
  };
};

/**
 * The Live Activity's registered name: the native activity type, the key the
 * layout is stored under, and the name a widget-style press would report as its
 * source. Exported because the app's interaction listener has to recognise a
 * press from this surface without repeating the literal.
 */
export const LIVE_ACTIVITY_NAME = 'ActiveAgentsLiveActivity';

/**
 * The whole surface deep-links here, and registration persists it. A
 * push-to-start creates the activity with no JavaScript running, so a URL
 * supplied only at `start` would leave a remotely started card untappable.
 */
export const OPEN_AGENTS_URL = 'kiloapp:///cloud/sessions';

export const activeAgentsLiveActivityLayout = layout;
const registerLayout = () =>
  createLiveActivity<ContentState>(LIVE_ACTIVITY_NAME, withGlanceableCopy(layout), OPEN_AGENTS_URL);

export const ActiveAgentsLiveActivity = registerLayout();

/**
 * Re-bake the stored layout in the active language.
 *
 * Constructing the factory only writes the layout into the shared app group,
 * and the name identifies the native Live Activity type, so the fresh factory
 * is discarded and `ActiveAgentsLiveActivity` stays the handle. The app boots
 * in English and applies the stored language afterwards, so this runs once the
 * language settles as well as on every later change.
 */
export function refreshActiveAgentsLiveActivityCopy(): void {
  registerLayout();
}
