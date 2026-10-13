/* eslint-disable max-lines -- the 'widget' layout function is stringified whole, so its helpers cannot be extracted to module scope; the surface stays in one function */
import {
  Button,
  Circle,
  HStack,
  Image,
  Link,
  RoundedRectangle,
  Spacer,
  Text,
  VStack,
  ZStack,
} from '@expo/ui/swift-ui';
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
  layoutPriority,
  lineLimit,
  monospacedDigit,
  opacity,
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
 * One followed session (`.specs/mobile-session-live-activity.md`). The card
 * shows the mark, the session title, one status line with the time in that
 * state, one step line ("Editing auth.ts") with the plan progress, and one
 * quiet line when the agent has stopped reporting activity. A permission wait
 * adds the trimmed command and its Approve and Open controls; a finished card
 * adds the outcome line. The Dynamic Island shows the mark and the state time
 * when compact, the state dot when minimal, and the whole card on black when
 * expanded, with the diff and the cost there only.
 */
const layout: LiveActivityComponent<ContentState> = (props, activityEnvironment) => {
  'widget';

  // The literal, not an imported constant: see the note at the top of the file.
  // eslint-disable-next-line typescript-eslint/no-inferrable-types -- replaced source literal
  // The quiet window is a literal, because the stringified layout cannot
  // import it; `session-live-activity.test.ts` holds it to the shared
  // `SESSION_CARD_QUIET_AFTER_MS` export of `@kilocode/notifications`.
  // eslint-disable-next-line typescript-eslint/no-inferrable-types -- replaced source literal alongside the copy
  const QUIET_AFTER_MS: number = 5 * 60 * 1000;
  // eslint-disable-next-line typescript-eslint/no-inferrable-types -- replaced source literal
  const copySource: string = '__KILO_GLANCEABLE_COPY__';
  const COPY = JSON.parse(copySource.startsWith('{') ? copySource : '{}') as Record<string, string>;
  const locale = COPY.locale ?? 'en';
  const digits = COPY.digits ?? '';
  const kind = props.statusKind ?? 'running';
  const failureKind = props.failure?.kind ?? null;
  const FAILURE_COPY = {
    provider: COPY.failureProvider ?? 'Stopped: provider error',
    tool: COPY.failureTool ?? 'Stopped: tool error',
    cancelled: COPY.failureCancelled ?? 'Stopped: cancelled',
    other: COPY.failureOther ?? 'Stopped',
  };
  const failureText = (() => {
    if (failureKind === 'provider') {
      return FAILURE_COPY.provider;
    }
    if (failureKind === 'tool') {
      return FAILURE_COPY.tool;
    }
    if (failureKind === 'cancelled') {
      return FAILURE_COPY.cancelled;
    }
    return FAILURE_COPY.other;
  })();

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
        track: '#3A3A40',
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
        track: '#DEDBD2',
      };
  type Scheme = {
    fg: string;
    muted: string;
    warn: string;
    good: string;
    primary: string;
    primaryFg: string;
    secondary: string;
    track: string;
    dot: string;
    titleSize: number;
  };
  const dots = {
    needsInput: palette.warn,
    running: palette.good,
    scheduled: palette.info,
    idle: palette.idle,
    failed: palette.warn,
  };
  const flash = {
    needsInput: dots.needsInput,
    running: dots.running,
    scheduled: dots.scheduled,
    idle: dots.idle,
  };
  const CARD_DOT = {
    needsInput: flash.needsInput,
    failed: flash.needsInput,
    running: flash.running,
    scheduled: flash.scheduled,
    idle: flash.idle,
  } as const;
  const card: Scheme = { ...palette, dot: CARD_DOT[kind], titleSize: 16 };
  // The Dynamic Island is always black: the dark palette with white text.
  const islandDots = {
    needsInput: '#F2B05F',
    running: '#5FCB8E',
    scheduled: '#60A5FA',
    idle: '#56544F',
    failed: '#F2B05F',
  };
  const ISLAND_DOT = {
    needsInput: islandDots.needsInput,
    failed: islandDots.needsInput,
    running: islandDots.running,
    scheduled: islandDots.scheduled,
    idle: islandDots.idle,
  } as const;
  const island: Scheme = {
    fg: '#FFFFFF',
    muted: '#8A8680',
    warn: '#F2B05F',
    // The same green the dark palette uses for the added-lines line.
    good: '#5FCB8E',
    primary: '#E8F27A',
    primaryFg: '#1A1A10',
    secondary: '#26262B',
    track: '#3A3A40',
    dot: ISLAND_DOT[kind],
    titleSize: 15,
  };

  const labels = {
    needsInput: COPY.needsInput ?? 'Needs input',
    running: COPY.running ?? 'Working',
    scheduled: COPY.scheduled ?? 'Scheduled',
    idle: COPY.finished ?? 'Finished',
    failed: COPY.failed ?? 'Stopped',
  };
  const STATUS_LABEL = {
    needsInput: labels.needsInput,
    scheduled: labels.scheduled,
    idle: labels.idle,
    failed: labels.failed,
    running: labels.running,
  };
  const statusLabel = STATUS_LABEL[kind];
  const rawTitle = (props.title ?? '').trim();
  const title = rawTitle.length > 0 ? rawTitle : (COPY.agent ?? 'Agent');

  // The app language's digits, so a count reads in the same script as the
  // labels beside it. An empty table means the language writes Western digits.
  // eslint-disable-next-line unicorn/consistent-function-scoping -- the 'widget' layout is stringified whole; a helper outside it is an undefined global in the widget process
  const DIGIT_INDEX = '0123456789';
  // A string keeps its leading zeros (a cost's fraction digits).
  const count = (value: number | string) => {
    const plain = String(value);
    if (digits.length < 10) {
      return plain;
    }
    let out = '';
    for (const character of plain) {
      const index = DIGIT_INDEX.indexOf(character);
      out += index === -1 ? character : digits[index];
    }
    return out;
  };
  // eslint-disable-next-line unicorn/consistent-function-scoping -- see above
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
  const lastActivityAt = usableDate(props.lastActivityAt);
  const startedAt = usableDate(props.startedAt);
  // iOS marks the card out of date at the stale date the producer set. For a
  // working card that date is the end of the quiet window after the last
  // activity, so stale and quiet are the same moment here; the quiet line
  // carries that news, and the last-known header would only repeat it. A card
  // that is out of date in any other state prints the honest time instead.
  const quietAt =
    (lastActivityAt === null ? Date.now() : lastActivityAt.getTime()) + QUIET_AFTER_MS;
  const quiet = kind === 'running' && Date.now() >= quietAt;
  const lastKnown = activityEnvironment.isStale === true && !quiet ? updatedAt : null;
  const dimmed = (activityEnvironment.isStale === true && !quiet) || kind === 'failed';

  // The step the agent is on: what it is doing, and to what. `other` names no
  // step of its own, so such a card shows the target alone, or nothing.
  const STEP_COPY = {
    editing: COPY.editing ?? 'Editing',
    reading: COPY.reading ?? 'Reading',
    running: COPY.stepRunning ?? 'Run',
    searching: COPY.searching ?? 'Web search',
    thinking: COPY.thinking ?? 'Thinking it through',
  };
  const stepVerbValue = props.currentStep?.verb ?? null;
  const stepWords =
    stepVerbValue === null || stepVerbValue === 'other' ? null : STEP_COPY[stepVerbValue];
  const stepTargetRaw = (props.currentStep?.target ?? '').trim();
  const stepTarget = stepTargetRaw.length > 0 ? stepTargetRaw : null;
  const stepLine = (() => {
    if (stepWords === null) {
      return stepTarget;
    }
    if (stepTarget === null) {
      return stepWords;
    }
    return `${stepWords} ${stepTarget}`;
  })();
  const finished = kind === 'idle' || kind === 'failed';
  const hasCost = (props.costMicrodollars ?? 0) >= 50;
  const plan = props.plan ?? null;
  const planDone = plan === null ? 0 : plan.done;
  const planTotal = plan === null ? 0 : plan.total;
  const planPercent = planTotal > 0 ? Math.min(1, planDone / planTotal) : 0;

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
  // A number never truncates: it keeps its content size while the labels
  // around it compress, so the counts stay readable in every language.
  // eslint-disable-next-line max-params -- see above
  const number = (
    value: string,
    size: number,
    color: string,
    weight: 'regular' | 'semibold' = 'regular'
  ) => (
    <Text
      modifiers={[
        font({ size, weight }),
        lineLimit(1),
        fixedSize({ horizontal: true, vertical: false }),
        monospacedDigit(),
        foregroundStyle(color),
      ]}
    >
      {value}
    </Text>
  );
  // A label that must never truncate, whatever the language and the controls
  // beside it: the status label. Numbers use `number` for the same reason.
  // eslint-disable-next-line max-params -- see above
  const fixedLabel = (
    value: string,
    size: number,
    color: string,
    weight: 'regular' | 'semibold' = 'regular'
  ) => (
    <Text
      modifiers={[
        font({ size, weight }),
        lineLimit(1),
        fixedSize({ horizontal: true, vertical: false }),
        foregroundStyle(color),
      ]}
    >
      {value}
    </Text>
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
    fixedSize({ horizontal: true, vertical: false }),
    monospacedDigit(),
    foregroundStyle(color),
  ];
  // A self-updating date text must not take a horizontal `fixedSize`: it
  // reports an infinite ideal width, and on the Lock Screen the whole banner
  // then lays out at an infinite frame and draws nothing. It keeps a minimum
  // width that holds its short forms ("59 min", "23 hr") instead, so it does
  // not shift the line as it counts. A static time string keeps `fixedSize`.
  const TIMER_MIN_WIDTH = 54;
  const timerModifiers = (size: number, color: string) => [
    font({ size }),
    lineLimit(1),
    monospacedDigit(),
    foregroundStyle(color),
    frame({ minWidth: TIMER_MIN_WIDTH, alignment: 'leading' }),
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
      return number(formatted, size, color);
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
      return <Text date={since} dateStyle="elapsed" modifiers={timerModifiers(size, color)} />;
    }
    return clock(since, size, color);
  };
  // The quiet line counts up on its own from the last activity the server saw,
  // so the card reaches the warning without a push for the clock alone.
  const quietLine = (size: number, color: string) =>
    lastActivityAt === null ? null : (
      <HStack spacing={4}>
        {text(COPY.noActivity ?? 'No activity for', size, color, 'semibold')}
        <Text date={lastActivityAt} dateStyle="elapsed" modifiers={timerModifiers(size, color)} />
      </HStack>
    );
  // The plan bar from plain shapes: a track and a filled segment of the same
  // height, which draw in every Live Activity presentation.
  const BAR_WIDTH = 64;
  const BAR_HEIGHT = 4;
  const progressBar = (scheme: Scheme) => {
    const filled = Math.round(BAR_WIDTH * planPercent);
    return (
      <ZStack alignment="leading" modifiers={[frame({ width: BAR_WIDTH, height: BAR_HEIGHT })]}>
        <RoundedRectangle
          cornerRadius={BAR_HEIGHT / 2}
          modifiers={[
            frame({ width: BAR_WIDTH, height: BAR_HEIGHT }),
            foregroundStyle(scheme.track),
          ]}
        />
        {filled <= 0 ? null : (
          <RoundedRectangle
            cornerRadius={BAR_HEIGHT / 2}
            modifiers={[
              frame({ width: Math.max(BAR_HEIGHT, filled), height: BAR_HEIGHT }),
              foregroundStyle(scheme.primary),
            ]}
          />
        )}
      </ZStack>
    );
  };
  // The plan line: "3 of 7" and the bar, then the step in progress on its own
  // line. The step is never repeated, so the line never shows it twice.
  const planLine = (scheme: Scheme, size: number) =>
    plan === null || planTotal === 0 ? null : (
      <VStack alignment="leading" spacing={4}>
        <HStack alignment="center" spacing={6}>
          <HStack spacing={3}>
            {number(count(planDone), size, scheme.fg, 'semibold')}
            {text(COPY.of ?? 'of', size, scheme.muted)}
            {number(count(planTotal), size, scheme.fg, 'semibold')}
          </HStack>
          {progressBar(scheme)}
          <Spacer minLength={0} />
        </HStack>
        {plan.current == null ? null : text(plan.current, size, scheme.muted)}
      </VStack>
    );
  const changesLine = (scheme: Scheme, size: number) => {
    const changes = props.changes ?? null;
    if (changes === null || changes.files === 0) {
      return null;
    }
    return (
      <HStack spacing={6}>
        {number(`+${count(changes.added)}`, size, scheme.good, 'semibold')}
        {number(`−${count(changes.removed)}`, size, scheme.warn, 'semibold')}
        {text(`${COPY.filesChanged ?? 'files'}:`, size, scheme.muted)}
        {number(count(changes.files), size, scheme.muted, 'semibold')}
      </HStack>
    );
  };
  // The cost in the app language: the app's own cost rules (two decimals
  // from half a cent, four below it, nothing below the four-decimal zero),
  // the language's digits and decimal separator, and the baked currency
  // template, so the symbol matches the app's other cost labels.
  const costText = (() => {
    const micros = props.costMicrodollars ?? 0;
    // Below 50 microdollars the four-decimal amount reads as a false zero.
    if (!(micros >= 50)) {
      return null;
    }
    const usd = micros / 1_000_000;
    const [whole, fraction] = usd.toFixed(micros >= 5000 ? 2 : 4).split('.');
    // An empty baked slot means the template could not be read.
    const decimal =
      COPY.costDecimal === undefined || COPY.costDecimal === '' ? '.' : COPY.costDecimal;
    const template =
      COPY.costTemplate === undefined || COPY.costTemplate === '' ? '$#' : COPY.costTemplate;
    const amount = `${count(whole ?? '0')}${decimal}${count(fraction ?? '')}`;
    return template.split('#').join(amount);
  })();
  const costLine = (scheme: Scheme, size: number) =>
    costText === null ? null : number(costText, size, scheme.muted);
  // The outcome of a finished session: the pull request it opened, its diff,
  // or nothing. The duration prints beside it when the session start is known.
  const finishedDuration = (() => {
    if (startedAt === null || since === null) {
      return null;
    }
    const minutes = Math.max(0, Math.round((since.getTime() - startedAt.getTime()) / 60_000));
    if (minutes < 60) {
      return `${count(minutes)} ${COPY.minute ?? 'min'}`;
    }
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${count(hours)} ${COPY.hour ?? 'h'} ${count(rest)} ${COPY.minute ?? 'min'}`;
  })();
  const outcomeLine = (scheme: Scheme, size: number) => {
    const outcome = props.outcome?.kind ?? null;
    if (outcome === 'pr_opened') {
      return text(COPY.prOpened ?? 'Pull request opened', size, scheme.good, 'semibold');
    }
    // A diff outcome is the diff line itself, which every card draws once.
    return null;
  };

  // The words the card shows under the status, as one spoken run.
  const summaryText = (() => {
    if (kind === 'failed') {
      return failureText;
    }
    if (kind === 'idle') {
      const parts: string[] = [];
      if (finishedDuration !== null) {
        parts.push(`${COPY.finishedIn ?? 'Finished in'} ${finishedDuration}`);
      }
      if (props.outcome?.kind === 'pr_opened') {
        parts.push(COPY.prOpened ?? 'Pull request opened');
      } else if (props.outcome?.kind === 'changes') {
        parts.push(`${count(props.changes?.files ?? 0)} ${COPY.filesChanged ?? 'files changed'}`);
      }
      return parts.join(', ');
    }
    if (kind === 'needsInput') {
      const command = (props.permissionCommand ?? '').trim();
      return command.length > 0
        ? `${COPY.permissionWants ?? 'Wants to run'} ${command}`
        : (COPY.answerNeeded ?? 'Answer needed');
    }
    if (quiet) {
      return COPY.noActivity ?? 'No activity for';
    }
    return stepLine ?? '';
  })();
  const spoken = [title, statusLabel, summaryText].filter(part => part !== '').join(', ');

  // The header carries the mark and the last-known time alone: the title and
  // the state own the lines below, so nothing here repeats them.
  const header = (scheme: Scheme) => (
    <HStack alignment="center" spacing={6} modifiers={[frame({ height: 18 })]}>
      {mark(18)}
      <Spacer minLength={8} />
      {lastKnown === null ? null : (
        <HStack spacing={3}>
          {text(`${COPY.lastKnown ?? 'Last known'} ·`, 11, scheme.muted)}
          {clock(lastKnown, 11, scheme.muted)}
        </HStack>
      )}
    </HStack>
  );

  const statusLine = (scheme: Scheme, withTime: boolean) => {
    const time = withTime ? stateTime(13, scheme.muted) : null;
    return (
      <HStack alignment="center" spacing={6}>
        {dot(8, scheme.dot)}
        {fixedLabel(statusLabel, 13, scheme.fg, 'semibold')}
        {time === null ? null : text('·', 13, scheme.muted)}
        {time}
        <Spacer minLength={6} />
      </HStack>
    );
  };

  // The line under the status: the step and its timer while the agent works,
  // the steps done while it is scheduled or waits on an answer, the stopped
  // reason when it failed, and the outcome when it finished. The status line
  // carries the state time for every kind but a working card, whose timer
  // sits here beside the step, so each card prints its time once.
  const detailLine = (scheme: Scheme, size: number) => {
    if (kind === 'failed') {
      return (
        <HStack spacing={6}>
          {text(failureText, size, scheme.warn, 'semibold')}
          <Spacer minLength={6} />
          {plan === null
            ? null
            : text(`${count(planDone)}/${count(planTotal)}`, size, scheme.muted)}
        </HStack>
      );
    }
    if (kind === 'idle') {
      return (
        <HStack spacing={6}>
          {finishedDuration === null
            ? null
            : text(`${COPY.finishedIn ?? 'Finished in'} ${finishedDuration}`, size, scheme.muted)}
          {plan === null
            ? null
            : text(`${count(planDone)}/${count(planTotal)}`, size, scheme.muted)}
          <Spacer minLength={6} />
          {outcomeLine(scheme, size)}
        </HStack>
      );
    }
    if (kind === 'scheduled') {
      return (
        <HStack spacing={6}>
          {plan === null
            ? null
            : text(`${count(planDone)}/${count(planTotal)}`, size, scheme.muted)}
          <Spacer minLength={6} />
        </HStack>
      );
    }
    if (kind === 'needsInput') {
      const command = (props.permissionCommand ?? '').trim();
      return (
        <HStack spacing={6}>
          {text(
            command.length > 0
              ? (COPY.permissionWants ?? 'Wants to run')
              : (COPY.answerNeeded ?? 'Answer needed'),
            size,
            scheme.fg,
            'semibold'
          )}
          {command.length > 0 ? text(command, size, scheme.muted) : null}
          {command.length > 0 || plan === null
            ? null
            : text(`${count(planDone)}/${count(planTotal)}`, size, scheme.muted)}
          <Spacer minLength={6} />
        </HStack>
      );
    }
    if (quiet) {
      // The quiet line under the summary replaces the step (spec "Content"
      // rule 7), so a quiet card shows that one line and no step.
      return null;
    }
    return (
      <HStack spacing={6}>
        {stepLine === null ? null : text(stepLine, size, scheme.fg, 'semibold')}
        <Spacer minLength={6} />
        {stateTime(size, scheme.muted)}
      </HStack>
    );
  };

  // The title, the status line, and the detail line. The spoken label sits on
  // this block alone, so the controls after it stay their own focusable
  // elements.
  const summary = (scheme: Scheme) => (
    <VStack
      alignment="leading"
      spacing={4}
      modifiers={[layoutPriority(1), accessibilityElement('combine'), accessibilityLabel(spoken)]}
    >
      {text(title, scheme.titleSize, scheme.fg, 'semibold')}
      {statusLine(scheme, kind !== 'running' || quiet)}
      {detailLine(scheme, 13)}
    </VStack>
  );

  // A compact pill: its label keeps its own width, so the controls take only
  // the room their copy needs and the summary keeps the rest of the card.
  const pill = (label: string, tone: { fill: string; color: string }) => (
    <Text
      modifiers={[
        font({ size: 13, weight: 'semibold' }),
        lineLimit(1),
        foregroundStyle(tone.color),
        fixedSize({ horizontal: true, vertical: false }),
        padding({ horizontal: 12 }),
        frame({ height: 32 }),
        background(tone.fill, shapes.capsule()),
      ]}
    >
      {label}
    </Text>
  );
  // Open as a round icon: the spoken label names it, and the card keeps the
  // width a word would take.
  const OPEN_SIZE = 32;
  const openIcon = (tone: { fill: string; color: string }) => (
    <ZStack
      modifiers={[
        frame({ width: OPEN_SIZE, height: OPEN_SIZE }),
        background(tone.fill, shapes.capsule()),
      ]}
    >
      <Image systemName="arrow.up.forward" size={13} color={tone.color} />
    </ZStack>
  );
  // Approve (or the muted Approving… pill while the press runs) and Open. The
  // target literal must stay equal to `GLANCEABLE_APPROVE_TARGET` in
  // `interaction.ts`, which `session-live-activity.test.ts` holds it to.
  const actions = (scheme: Scheme) => {
    const open =
      openUrl === null ? null : (
        <Link destination={openUrl} modifiers={[accessibilityLabel(COPY.open ?? 'Open')]}>
          {openIcon({ fill: scheme.secondary, color: scheme.fg })}
        </Link>
      );
    // A waiting question has nothing to approve: its card offers Open alone,
    // which is the way to answer it.
    if (!approving && !canApprove) {
      if (kind !== 'needsInput') {
        return null;
      }
      return (
        <HStack alignment="center" spacing={4}>
          {open}
        </HStack>
      );
    }
    return (
      <HStack alignment="center" spacing={4}>
        {approving ? (
          pill(COPY.approving ?? 'Approving…', {
            fill: scheme.secondary,
            color: scheme.muted,
          })
        ) : (
          <Button
            target="approve"
            modifiers={[buttonStyle('plain'), accessibilityLabel(COPY.approve ?? 'Approve')]}
          >
            {pill(COPY.approve ?? 'Approve', { fill: scheme.primary, color: scheme.primaryFg })}
          </Button>
        )}
        {open}
      </HStack>
    );
  };

  // The expanded island's full card. The actions sit beside the summary,
  // centered vertically with it, so the labels keep their own width and only
  // the trailing controls shrink when the language is long. The island has
  // room for the plan bar, the plan step name, the diff and the cost.
  const expandedCard = (scheme: Scheme) => (
    <VStack alignment="leading" spacing={0}>
      {header(scheme)}
      <HStack alignment="center" spacing={10} modifiers={[padding({ top: 12 })]}>
        {summary(scheme)}
        <Spacer minLength={6} />
        {actions(scheme)}
      </HStack>
      {quiet ? (
        <VStack alignment="leading" spacing={0} modifiers={[padding({ top: 6 })]}>
          {quietLine(13, scheme.warn)}
        </VStack>
      ) : null}
      {/* The diff size (spec "Content" rule 8) and the cost (rule 11). */}
      {changesLine(scheme, 12) === null && !hasCost ? null : (
        <VStack alignment="leading" spacing={6} modifiers={[padding({ top: 8 })]}>
          {changesLine(scheme, 12)}
          {hasCost ? costLine(scheme, 12) : null}
        </VStack>
      )}
      {/* One plan line per card: the full bar for a working card; every other
          state prints its compact step count in the detail line instead. */}
      {planLine(scheme, 12) === null || kind !== 'running' ? null : (
        <VStack alignment="leading" spacing={4} modifiers={[padding({ top: 8 })]}>
          {planLine(scheme, 12)}
        </VStack>
      )}
      {notice === null ? null : (
        <VStack alignment="leading" spacing={0} modifiers={[padding({ top: 8 })]}>
          {text(notice, 13, scheme.warn, 'semibold')}
        </VStack>
      )}
    </VStack>
  );

  // The Lock Screen card is at most 160 pt tall, and ActivityKit draws
  // nothing at all, not even the logo, when the banner is taller. So the
  // banner keeps a hard budget of three single-line rows: the header (the
  // mark, the title, the last-known time), the status line with the
  // controls, and one detail line that merges the step or the state's own
  // fact with the compact plan count and the diff. The expanded island keeps
  // the full card, with the bar and every line.
  const sep = (scheme: Scheme, size: number) => text('·', size, scheme.muted);
  const compactFacts = (scheme: Scheme, size: number, withCost: boolean) => {
    const changes = props.changes ?? null;
    const facts = [
      plan === null || planTotal === 0 ? null : (
        <HStack key="plan" spacing={3}>
          {number(count(planDone), size, scheme.fg, 'semibold')}
          {text(COPY.of ?? 'of', size, scheme.muted)}
          {number(count(planTotal), size, scheme.fg, 'semibold')}
        </HStack>
      ),
      changes === null || changes.files === 0 ? null : (
        <HStack key="diff" spacing={4}>
          {number(`+${count(changes.added)}`, size, scheme.good, 'semibold')}
          {number(`−${count(changes.removed)}`, size, scheme.warn, 'semibold')}
        </HStack>
      ),
      changes === null || changes.files === 0 ? null : (
        <HStack key="files" spacing={3}>
          {number(count(changes.files), size, scheme.muted, 'semibold')}
          {text(COPY.filesChanged ?? 'files changed', size, scheme.muted)}
        </HStack>
      ),
      withCost && costText !== null ? (
        <HStack key="cost" spacing={0}>
          {number(costText, size, scheme.muted)}
        </HStack>
      ) : null,
    ].filter(fact => fact !== null);
    // A separator between two facts, never before the first one.
    return facts.flatMap((fact, index) =>
      index === 0
        ? [fact]
        : [
            <HStack key={`sep-${index}`} spacing={0}>
              {sep(scheme, size)}
            </HStack>,
            fact,
          ]
    );
  };
  // The fact a state leads its detail line with, or null for none.
  const leadFact = (scheme: Scheme, size: number) => {
    if (kind === 'failed') {
      return text(failureText, size, scheme.warn, 'semibold');
    }
    if (kind === 'idle') {
      const pr = props.outcome?.kind === 'pr_opened';
      if (finishedDuration === null && !pr) {
        return null;
      }
      return (
        <HStack spacing={6}>
          {finishedDuration === null
            ? null
            : text(`${COPY.finishedIn ?? 'Finished in'} ${finishedDuration}`, size, scheme.muted)}
          {finishedDuration !== null && pr ? sep(scheme, size) : null}
          {pr ? text(COPY.prOpened ?? 'Pull request opened', size, scheme.good, 'semibold') : null}
        </HStack>
      );
    }
    if (kind === 'needsInput') {
      const command = (props.permissionCommand ?? '').trim();
      return command.length > 0 ? (
        <HStack spacing={6}>
          {text(COPY.permissionWants ?? 'Wants to run', size, scheme.fg, 'semibold')}
          {text(command, size, scheme.muted)}
        </HStack>
      ) : (
        text(COPY.answerNeeded ?? 'Answer needed', size, scheme.fg, 'semibold')
      );
    }
    if (kind === 'running' && quiet) {
      return quietLine(size, scheme.warn);
    }
    if (kind === 'running' && stepLine !== null) {
      return text(stepLine, size, scheme.fg, 'semibold');
    }
    return null;
  };
  const lockScreenDetail = (scheme: Scheme, size: number) => {
    if (notice !== null) {
      return text(notice, size, scheme.warn, 'semibold');
    }
    // A permission wait spends the line on the command Approve answers.
    const permission = kind === 'needsInput' && (props.permissionCommand ?? '').trim().length > 0;
    const lead = leadFact(scheme, size);
    const facts = permission ? [] : compactFacts(scheme, size, finished);
    if (lead === null && facts.length === 0) {
      return null;
    }
    return (
      <HStack alignment="center" spacing={6}>
        {lead}
        {lead === null || facts.length === 0 ? null : sep(scheme, size)}
        {facts}
        <Spacer minLength={0} />
      </HStack>
    );
  };
  const lockScreenCard = (scheme: Scheme) => {
    const detail = lockScreenDetail(scheme, 13);
    return (
      <VStack alignment="leading" spacing={0}>
        <HStack
          alignment="center"
          spacing={8}
          modifiers={[
            frame({ height: 20 }),
            accessibilityElement('combine'),
            accessibilityLabel(spoken),
          ]}
        >
          {mark(18)}
          {text(title, scheme.titleSize, scheme.fg, 'semibold')}
          <Spacer minLength={8} />
          {lastKnown === null ? null : (
            <HStack spacing={3}>
              {text(`${COPY.lastKnown ?? 'Last known'} ·`, 11, scheme.muted)}
              {clock(lastKnown, 11, scheme.muted)}
            </HStack>
          )}
        </HStack>
        <HStack alignment="center" spacing={8} modifiers={[padding({ top: 8 })]}>
          {statusLine(scheme, true)}
          {actions(scheme)}
        </HStack>
        {detail === null ? null : (
          <HStack alignment="center" spacing={0} modifiers={[padding({ top: 6 })]}>
            {detail}
          </HStack>
        )}
      </VStack>
    );
  };

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
          opacity(dimmed ? 0.72 : 1),
        ]}
      >
        {lockScreenCard(card)}
      </VStack>
    ),
    // The Apple Watch and CarPlay small family: the status line and Approve.
    bannerSmall: (
      <VStack alignment="leading" spacing={6}>
        <HStack alignment="center" spacing={10}>
          {statusLine(island, true)}
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
    // keeps an equal inset on both sides. The diff and the cost live here only.
    expandedBottom: (
      <VStack
        alignment="leading"
        spacing={0}
        modifiers={[
          padding({ leading: 14, trailing: 14, bottom: 10 }),
          environment({ key: 'locale', value: locale }),
        ]}
      >
        {expandedCard(island)}
      </VStack>
    ),
  };
};

/**
 * The session card's registered name: the native activity type and the key the
 * layout is stored under. One factory serves every followed session; each
 * card's content state carries its session id.
 */
const SESSION_LIVE_ACTIVITY_NAME = 'SessionLiveActivity';

const registerLayout = () =>
  createLiveActivity<ContentState>(
    SESSION_LIVE_ACTIVITY_NAME,
    withGlanceableCopy(withWidgetLogo(layout))
  );

export type SessionLiveActivityProps = ContentState;

/**
 * The layout function itself, for the state-selection tests. The app registers
 * the transformed copy above; a test runs no widget transform, so it renders
 * this function directly, as `active-agents-live-activity.test.ts` does.
 */
export const sessionLiveActivityLayout = layout;

export const SessionLiveActivity = registerLayout();

/**
 * Re-bake the stored layout in the active language. The name identifies the
 * native type, so the fresh factory is discarded and `SessionLiveActivity`
 * stays the handle (see `refreshActiveAgentsLiveActivityCopy`).
 */
export function refreshSessionLiveActivityCopy(): void {
  registerLayout();
}
