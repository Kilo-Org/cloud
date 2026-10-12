/* eslint-disable max-lines -- the 'widget' layout function is stringified whole, so its helpers cannot be extracted to module scope; the surface stays in one function */
import { Button, Circle, HStack, Image, Link, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityLabel,
  activityBackgroundTint,
  background,
  buttonStyle,
  cornerRadius,
  environment,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  monospacedDigit,
  padding,
  resizable,
  shapes,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, type LiveActivityComponent } from 'expo-widgets';

import { type SessionLiveActivityContentState } from '@kilocode/notifications';

import { withGlanceableCopy } from './layout-copy';
import { withWidgetLogo } from './widget-logo';

// The layout function below is marked with the `'widget'` directive, so Babel
// stringifies it and the widget extension re-evaluates the source. Everything
// it references must be a widget global (`Text`, `VStack`, `Button`, the
// modifiers) or a built-in. Do not call `@/` helpers or i18n from here. The
// copy and the logo path are baked in after stringification, as for the
// aggregate card (`active-agents-live-activity.tsx`).

// The pushed content state plus the facts only the app adds while an Approve
// press runs: the in-flight flag and the failure line. They stay local fields,
// because every imported binding would be an undefined global in the widget
// process. Every field is optional so a malformed push draws a safe card.
type ContentState = Partial<SessionLiveActivityContentState> & {
  approving?: boolean;
  notice?: string;
};

/**
 * One followed session (`.specs/mobile-session-live-activity.md`). The Lock
 * Screen card has the mark (and the last-known time on a stale card), the
 * session title, and one status line: the dot, the status label, and the time
 * in that state. A permission wait adds Approve and Open at the trailing edge.
 * The Dynamic Island shows the mark and the status time when compact, the dot
 * when minimal, and the card on black when expanded.
 */
const layout: LiveActivityComponent<ContentState> = (props, activityEnvironment) => {
  'widget';

  // The literal, not an imported constant: see the note at the top of the file.
  // eslint-disable-next-line typescript-eslint/no-inferrable-types -- replaced source literal
  const copySource: string = '__KILO_GLANCEABLE_COPY__';
  const COPY = JSON.parse(copySource.startsWith('{') ? copySource : '{}') as Record<string, string>;
  const locale = COPY.locale ?? 'en';

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
  type Scheme = {
    fg: string;
    muted: string;
    warn: string;
    primary: string;
    primaryFg: string;
    secondary: string;
    dot: string;
    titleSize: number;
  };
  const kind = props.statusKind ?? 'running';
  const dots = {
    needsInput: palette.warn,
    running: palette.good,
    scheduled: palette.info,
    idle: palette.idle,
  };
  const card: Scheme = { ...palette, dot: dots[kind], titleSize: 16 };
  // The Dynamic Island is always black: the dark palette with white text.
  const islandDots = {
    needsInput: '#F2B05F',
    running: '#5FCB8E',
    scheduled: '#60A5FA',
    idle: '#56544F',
  };
  const island: Scheme = {
    fg: '#FFFFFF',
    muted: '#8A8680',
    warn: '#F2B05F',
    primary: '#E8F27A',
    primaryFg: '#1A1A10',
    secondary: '#26262B',
    dot: islandDots[kind],
    titleSize: 15,
  };

  const labels = {
    needsInput: COPY.needsInput ?? 'Needs input',
    running: COPY.running ?? 'Working',
    scheduled: COPY.scheduled ?? 'Scheduled',
    idle: COPY.finished ?? 'Finished',
  };
  const statusLabel = labels[kind];
  const rawTitle = (props.title ?? '').trim();
  const title = rawTitle.length > 0 ? rawTitle : (COPY.agent ?? 'Agent');

  const usableDate = (value: string | null | undefined) => {
    if (value == null) {
      return null;
    }
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  };
  const since = usableDate(props.statusSince);
  const scheduledAt = kind === 'scheduled' ? usableDate(props.scheduledAt) : null;
  const updatedAt = usableDate(props.updatedAt);
  const lastKnown = activityEnvironment.isStale === true && updatedAt !== null;

  // Approve answers only the exact request the card carries.
  const approving = props.approving === true && kind === 'needsInput';
  const canApprove =
    kind === 'needsInput' &&
    props.awaitingPermission === true &&
    (props.approvalKey ?? '').length > 0;
  // A retry in flight hides the failure line it answers.
  const notice = approving || kind !== 'needsInput' ? null : (props.notice ?? null);
  const sessionId = props.sessionId ?? '';
  const openUrl =
    sessionId.length > 0 ? `kiloapp:///cloud/sessions/${encodeURIComponent(sessionId)}` : null;

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
  // eslint-disable-next-line typescript-eslint/no-inferrable-types -- replaced source literal
  const markUri: string = '__KILO_WIDGET_LOGO_URI__';
  // The slot keeps its size while the image is missing, so nothing beside it moves.
  const mark = (size: number) => (
    <ZStack modifiers={[frame({ width: size, height: size })]}>
      <Image
        uiImage={markUri}
        modifiers={[resizable(), frame({ width: size, height: size }), cornerRadius(size * 0.22)]}
      />
    </ZStack>
  );
  const timeModifiers = (size: number, color: string) => [
    font({ size }),
    lineLimit(1),
    monospacedDigit(),
    foregroundStyle(color),
  ];
  // The clock time alone today; another day adds the locale date.
  const clock = (date: Date, size: number, color: string) => {
    if (date.toDateString() === new Date().toDateString()) {
      return <Text date={date} dateStyle="time" modifiers={timeModifiers(size, color)} />;
    }
    try {
      // eslint-disable-next-line no-restricted-globals -- the widget process cannot import @/lib/intl-cache; failure falls back to SwiftUI's date text
      const formatted = new Intl.DateTimeFormat(locale.split('_').join('-'), {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(date);
      return text(formatted, size, color);
    } catch {
      return <Text date={date} dateStyle="date" modifiers={timeModifiers(size, color)} />;
    }
  };
  // The time in the current state. Working counts up on the device from the
  // last status change; the other states name the moment the state began, or
  // the wake time for a scheduled session.
  const stateTime = (size: number, color: string) => {
    if (kind === 'scheduled') {
      if (scheduledAt === null) {
        return null;
      }
      return Date.now() >= scheduledAt.getTime()
        ? text(COPY.awaitingUpdate ?? 'Awaiting update', size, color)
        : clock(scheduledAt, size, color);
    }
    if (since === null) {
      return null;
    }
    if (kind === 'running') {
      return <Text date={since} dateStyle="elapsed" modifiers={timeModifiers(size, color)} />;
    }
    return clock(since, size, color);
  };

  const spoken = [title, statusLabel].join(', ');

  const header = (scheme: Scheme) => (
    <HStack alignment="center" spacing={6} modifiers={[frame({ height: 18 })]}>
      {mark(18)}
      <Spacer minLength={8} />
      {lastKnown && updatedAt !== null ? (
        <HStack spacing={3}>
          {text(`${COPY.lastKnown ?? 'Last known'} ·`, 11, scheme.muted)}
          {clock(updatedAt, 11, scheme.muted)}
        </HStack>
      ) : null}
    </HStack>
  );

  const statusLine = (scheme: Scheme) => {
    const time = stateTime(13, scheme.muted);
    return (
      <HStack alignment="center" spacing={6}>
        {dot(8, scheme.dot)}
        {text(statusLabel, 13, scheme.fg, 'semibold')}
        {time === null ? null : text('·', 13, scheme.muted)}
        {time}
      </HStack>
    );
  };

  // The title and the status line. The spoken label sits on this block alone,
  // so the controls after it stay their own focusable elements.
  const summary = (scheme: Scheme) => (
    <VStack
      alignment="leading"
      spacing={4}
      modifiers={[accessibilityElement('combine'), accessibilityLabel(spoken)]}
    >
      {text(title, scheme.titleSize, scheme.fg, 'semibold')}
      {statusLine(scheme)}
    </VStack>
  );

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
  // Approve (or the muted Approving… pill while the press runs) and Open. The
  // target literal must stay equal to `GLANCEABLE_APPROVE_TARGET` in
  // `interaction.ts`, which `session-live-activity.test.ts` holds it to.
  const actions = (scheme: Scheme) => {
    if (!approving && !canApprove) {
      return null;
    }
    const open =
      openUrl === null ? null : (
        <Link destination={openUrl} modifiers={[accessibilityLabel(COPY.open ?? 'Open')]}>
          {pill(COPY.open ?? 'Open', 64, { fill: scheme.secondary, color: scheme.fg })}
        </Link>
      );
    return (
      <HStack alignment="center" spacing={4}>
        {approving ? (
          pill(COPY.approving ?? 'Approving…', 104, {
            fill: scheme.secondary,
            color: scheme.muted,
          })
        ) : (
          <Button
            target="approve"
            modifiers={[buttonStyle('plain'), accessibilityLabel(COPY.approve ?? 'Approve')]}
          >
            {pill(COPY.approve ?? 'Approve', 96, { fill: scheme.primary, color: scheme.primaryFg })}
          </Button>
        )}
        {open}
      </HStack>
    );
  };

  const body = (scheme: Scheme) => (
    <VStack alignment="leading" spacing={0}>
      {header(scheme)}
      <HStack alignment="center" spacing={0} modifiers={[padding({ top: 12 })]}>
        {summary(scheme)}
        <Spacer minLength={10} />
        {actions(scheme)}
      </HStack>
      {notice === null ? null : (
        <VStack alignment="leading" spacing={0} modifiers={[padding({ top: 8 })]}>
          {text(notice, 13, scheme.warn, 'semibold')}
        </VStack>
      )}
    </VStack>
  );

  return {
    banner: (
      <VStack
        alignment="leading"
        spacing={0}
        modifiers={[
          padding({ all: 16 }),
          activityBackgroundTint(palette.bg),
          // The widget process takes its locale from the device language; the
          // baked tag keeps the times in the app language.
          environment({ key: 'locale', value: locale }),
        ]}
      >
        {body(card)}
      </VStack>
    ),
    // The Apple Watch and CarPlay small family: the status line and Approve.
    bannerSmall: (
      <VStack alignment="leading" spacing={6}>
        <HStack alignment="center" spacing={10}>
          {statusLine(island)}
          {canApprove && !approving ? <Button label={COPY.approve} target="approve" /> : null}
          <Spacer />
        </HStack>
        <VStack modifiers={[frame({ height: 18 })]}>
          {notice === null ? null : text(notice, 13, island.warn, 'semibold')}
        </VStack>
      </VStack>
    ),
    compactLeading: mark(18),
    compactTrailing: (
      <HStack
        alignment="center"
        spacing={6}
        modifiers={[accessibilityElement('combine'), accessibilityLabel(spoken)]}
      >
        {dot(8, island.dot)}
        {stateTime(13, island.fg)}
      </HStack>
    ),
    minimal: (
      <HStack modifiers={[accessibilityElement('combine'), accessibilityLabel(spoken)]}>
        {dot(8, island.dot)}
      </HStack>
    ),
    // The island's rounded corner cuts into the leading edge, so the content
    // keeps an equal inset on both sides.
    expandedBottom: (
      <VStack
        alignment="leading"
        spacing={0}
        modifiers={[
          padding({ leading: 14, trailing: 14, bottom: 10 }),
          environment({ key: 'locale', value: locale }),
        ]}
      >
        {body(island)}
      </VStack>
    ),
  };
};

/**
 * The session card's registered name: the native activity type and the key the
 * layout is stored under. One factory serves every followed session; each
 * card's content state carries its session id.
 */
export const SESSION_LIVE_ACTIVITY_NAME = 'SessionLiveActivity';

export const sessionLiveActivityLayout = layout;
const registerLayout = () =>
  createLiveActivity<ContentState>(
    SESSION_LIVE_ACTIVITY_NAME,
    withGlanceableCopy(withWidgetLogo(layout))
  );

export type SessionLiveActivityProps = ContentState;

export const SessionLiveActivity = registerLayout();

/**
 * Re-bake the stored layout in the active language. The name identifies the
 * native type, so the fresh factory is discarded and `SessionLiveActivity`
 * stays the handle (see `refreshActiveAgentsLiveActivityCopy`).
 */
export function refreshSessionLiveActivityCopy(): void {
  registerLayout();
}
