/* eslint-disable max-lines -- the 'widget' layout function is stringified whole, so its helpers cannot be extracted to module scope; every family stays in one function */
import {
  AccessoryWidgetBackground,
  Button,
  type ButtonProps,
  Circle,
  HStack,
  Image,
  type ImageProps,
  Rectangle,
  RoundedRectangle,
  Spacer,
  Text,
  VStack,
  ZStack,
} from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityLabel,
  aspectRatio,
  background,
  buttonStyle,
  containerBackground,
  environment,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  monospacedDigit,
  multilineTextAlignment,
  opacity,
  padding,
  resizable,
  shapes,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';

import { i18n } from '@/i18n';

import { withGlanceableCopy } from './layout-copy';
import {
  buildGalleryPreviewProps,
  type GlanceableWidgetAction,
  type GlanceableWidgetProps,
} from './view-props';

export type WidgetProps = GlanceableWidgetProps;
type WidgetPressPatch = {
  pendingAction: GlanceableWidgetAction;
  pendingApprovalKey?: string;
  /**
   * When the press happened (ms since epoch). The extension carries the marker
   * across timeline rebuilds only while it is younger than the TTL, so the
   * press records its own time: a marker that outlives a rebuild keeps the time
   * it was pressed with, and a fresh press always resets it.
   */
  pendingActionAt: number;
};
type WidgetButtonProps = Omit<ButtonProps, 'onPress'> & {
  onPress?: () => WidgetPressPatch;
  /** expo-widgets runs the press intent in the foreground app when set. */
  openAppWhenRun?: boolean;
};
type SystemSymbol = NonNullable<ImageProps['systemName']>;
type Weight = 'regular' | 'semibold' | 'bold';

/**
 * The approved Home widget design (direction A). Every number below is a point
 * position or size from the design generators, measured from the widget's top
 * left on the 170pt-tall small and medium and the 382pt-tall large card; gaps
 * between text lines are derived from the design baselines with SF Pro's line
 * metrics so the rendered baselines land where the design put them.
 */
// Everything this stringified function uses must be a widget global or a builtin.
const layout = (props: WidgetProps, widgetEnvironment: WidgetEnvironment): React.JSX.Element => {
  'widget';

  // The literal is replaced after Babel stringifies this function.
  // eslint-disable-next-line typescript-eslint/no-inferrable-types -- replaced source literal
  const copySource: string = '__KILO_GLANCEABLE_COPY__';
  const COPY = JSON.parse(copySource.startsWith('{') ? copySource : '{}') as Record<string, string>;
  const digits = COPY.digits ?? '';
  const groupSeparator = COPY.group ?? ',';
  const count = (value: number) => {
    // Grouped by hand: the widget process has no number formatter, and a
    // global-regex replace is one of the forms that failed there.
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
  const labels = {
    needsInput: COPY.needsInput ?? 'Needs input',
    running: COPY.running ?? 'Working',
    scheduled: COPY.scheduled ?? 'Scheduled',
    idle: COPY.idle ?? 'Idle',
  };
  // Lock Screen glyphs: the accessories are monochrome, so the symbol tells the states apart.
  const glyphs = {
    needsInput: 'exclamationmark.circle',
    running: 'circle.fill',
    scheduled: 'clock',
    idle: 'circle',
  } as const;
  type Kind = keyof typeof labels;
  // The widget process reads raw app-group JSON, so these parse each field at that boundary.
  const kindOf = (value: unknown): Kind | null =>
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- the widget process reads raw app-group JSON, not the typed props vitest renders
    typeof value === 'string' && Object.hasOwn(labels, value) ? (value as Kind) : null;
  // eslint-disable-next-line anti-slop/no-runtime-typeof, unicorn/consistent-function-scoping -- the widget process reads raw app-group JSON, and the stringified 'widget' layout cannot hoist helpers to module scope
  const safeText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const filledText = (value: unknown): string | null => {
    const text = safeText(value);
    return text === null || text.length === 0 ? null : text;
  };
  // eslint-disable-next-line unicorn/consistent-function-scoping -- the stringified 'widget' layout cannot hoist helpers to module scope
  const safeCount = (value: unknown): number =>
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- the widget process reads raw app-group JSON, not the typed props vitest renders
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  // eslint-disable-next-line unicorn/consistent-function-scoping -- the stringified 'widget' layout cannot hoist helpers to module scope
  const validDate = (value: unknown): Date | null => {
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- the widget process reads raw app-group JSON, not the typed props vitest renders
    if (typeof value !== 'string') {
      return null;
    }
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  };
  // eslint-disable-next-line unicorn/consistent-function-scoping -- the stringified 'widget' layout cannot hoist helpers to module scope
  const records = (value: unknown): Record<string, unknown>[] =>
    (Array.isArray(value) ? (value as unknown[]) : []).filter(
      // eslint-disable-next-line anti-slop/no-runtime-typeof -- the widget process reads raw app-group JSON, not the typed props vitest renders
      (row): row is Record<string, unknown> => row !== null && typeof row === 'object'
    );
  const localeModifier = environment({ key: 'locale', value: COPY.locale ?? 'en' });
  const bodyURL = widgetURL('kiloapp:///cloud/sessions');
  const genericA11y = [
    localeModifier,
    accessibilityElement('combine'),
    accessibilityLabel(safeText(props.accessibilityLabel) ?? ''),
  ];
  const family = widgetEnvironment.widgetFamily;
  // SwiftUI's default line box for SF Pro: ascent 0.952em over descent 0.241em.
  // eslint-disable-next-line unicorn/consistent-function-scoping, max-params -- the stringified 'widget' layout cannot hoist helpers to module scope; the gap is between two baselines of two sizes
  const gap = (baseline: number, size: number, nextBaseline: number, nextSize: number) =>
    nextBaseline - 0.952 * nextSize - (baseline + 0.241 * size);

  // A placed widget can carry props from an older app. This compatibility path
  // only displays its existing values; freshness policy belongs to the shared builder.
  const rawHome = props.home;
  const home =
    // eslint-disable-next-line anti-slop/no-runtime-typeof, typescript-eslint/no-unnecessary-condition -- the widget process reads raw app-group JSON, not the typed props vitest renders
    rawHome !== null && typeof rawHome === 'object' ? rawHome : undefined;
  const homeStatus = safeText(home?.status);
  // The circular accessory has no room for a count line when nothing is counting.
  // A lone dash is near-invisible over a light wallpaper and says nothing, so the
  // no-count state draws a state glyph instead — filled, so it keeps contrast.
  const statusGlyphs = {
    waiting: 'arrow.triangle.2.circlepath',
    empty: 'checkmark.circle.fill',
    privacy: 'lock.fill',
    unavailable: 'lock.fill',
    signed_out: 'person.fill',
  } as const;
  type HomeStatusGlyph = keyof typeof statusGlyphs;
  const statusGlyph =
    homeStatus !== null && Object.hasOwn(statusGlyphs, homeStatus)
      ? statusGlyphs[homeStatus as HomeStatusGlyph]
      : 'circle.fill';

  // ── Lock Screen accessories: monochrome (white and 62% white), no buttons ──
  // Accessories deliberately ignore Home titles, feedback and retained work.
  const genericKind = kindOf(props.primaryKind);
  const genericCount = safeCount(props.primaryCount);
  const genericStatus = safeText(props.statusLine) ?? COPY.signed_out ?? 'Sign in to see agents';
  const genericLabel =
    safeText(props.primaryLabel) ?? (genericKind === null ? '' : labels[genericKind]);
  const white = foregroundStyle('#FFFFFF');
  // eslint-disable-next-line unicorn/consistent-function-scoping -- the stringified 'widget' layout cannot hoist helpers to module scope
  const logoTile = (size: number, fill: string, inner: string) => (
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
  if (family === 'accessoryCircular') {
    const value = count(genericCount);
    let countSize = 30;
    if (value.length > 4) {
      countSize = 20;
    } else if (value.length > 3) {
      countSize = 22;
    } else if (value.length > 2) {
      countSize = 26;
    }
    return (
      <ZStack modifiers={[bodyURL, ...genericA11y]}>
        <AccessoryWidgetBackground />
        <VStack alignment="center" spacing={2}>
          {genericKind === null ? (
            <Image systemName={statusGlyph} size={24} color="#FFFFFF" />
          ) : (
            <Image systemName={glyphs[genericKind]} size={13} color="#FFFFFF" />
          )}
          {genericKind === null ? null : (
            <Text
              modifiers={[
                font({ size: countSize, weight: 'bold' }),
                monospacedDigit(),
                lineLimit(1),
                white,
              ]}
            >
              {value}
            </Text>
          )}
        </VStack>
      </ZStack>
    );
  }
  if (family === 'accessoryInline') {
    return (
      <HStack spacing={4} modifiers={[bodyURL, ...genericA11y]}>
        {genericKind === null ? null : <Image systemName={glyphs[genericKind]} size={12} />}
        <Text modifiers={[lineLimit(1)]}>
          {genericKind === null ? genericStatus : `${count(genericCount)} ${genericLabel}`}
        </Text>
      </HStack>
    );
  }
  if (family === 'accessoryRectangular') {
    const others = records(props.countLines)
      .filter(row => {
        const kind = kindOf(row.kind);
        return kind !== null && kind !== genericKind && safeCount(row.count) > 0;
      })
      .slice(0, 3)
      .map(
        row =>
          `${count(safeCount(row.count))} ${safeText(row.label) ?? labels[kindOf(row.kind) ?? 'idle']}`
      );
    // 160x72: the Kilo row (12pt, baseline 16.5), the primary count (15pt bold,
    // baseline 40) and the other counts (12pt at 62%, baseline 62), 6pt in.
    return (
      <VStack
        alignment="leading"
        spacing={0}
        modifiers={[
          bodyURL,
          ...genericA11y,
          padding({ top: 16.5 - 0.952 * 12 - 1.25, leading: 6, trailing: 6 }),
          frame({ maxWidth: 10_000, maxHeight: 10_000, alignment: 'topLeading' }),
        ]}
      >
        <HStack alignment="center" spacing={5}>
          {logoTile(11, '#FFFFFF', '#000000')}
          <Text modifiers={[font({ size: 12, weight: 'semibold' }), lineLimit(1), white]}>
            Kilo
          </Text>
        </HStack>
        <HStack
          alignment="center"
          spacing={4.5}
          modifiers={[padding({ top: gap(16.5, 12, 40, 15) })]}
        >
          <Image
            systemName={genericKind === null ? statusGlyph : glyphs[genericKind]}
            size={11}
            color="#FFFFFF"
          />
          <Text
            modifiers={[
              font({ size: 15, weight: 'bold' }),
              monospacedDigit(),
              lineLimit(genericKind === null ? 2 : 1),
              white,
            ]}
          >
            {genericKind === null ? genericStatus : `${count(genericCount)} ${genericLabel}`}
          </Text>
        </HStack>
        {others.length === 0 ? null : (
          <Text
            modifiers={[
              font({ size: 12 }),
              monospacedDigit(),
              lineLimit(1),
              white,
              opacity(0.62),
              padding({ top: gap(40, 15, 62, 12) }),
            ]}
          >
            {others.join(' · ')}
          </Text>
        )}
      </VStack>
    );
  }

  // ── Home Screen: systemSmall, systemMedium, systemLarge ──
  const palette =
    widgetEnvironment.colorScheme === 'dark'
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
          divider: '#2A2A30',
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
          divider: '#E6E3DA',
        };
  const dotColors = {
    needsInput: palette.warn,
    running: palette.good,
    scheduled: palette.info,
    idle: palette.idle,
  };

  const primaryKind = home === undefined ? genericKind : kindOf(home.primaryKind);
  const primaryCount = home === undefined ? genericCount : safeCount(home.primaryCount);
  const status = home?.status ?? (genericKind === null ? 'signed_out' : 'content');
  const content = status === 'content' && primaryKind !== null;
  const stale = home?.stale === true;
  const primaryLabel = primaryKind === null ? '' : labels[primaryKind];
  const scheduledAt = validDate(home?.scheduledAt ?? props.scheduledAt);
  const checkedAt = validDate(home?.checkedAt);
  const awaitingUpdate = home?.awaitingUpdate === true;
  const feedback = content ? safeText(props.actionFeedback) : null;
  const failed = feedback === 'couldNotApprove';
  // An untitled agent is still named, so its row never reads as blank.
  const rawTitle = home === undefined ? null : safeText(home.primaryTitle);
  const title = rawTitle === null ? null : (filledText(rawTitle) ?? COPY.agent ?? 'Agent');
  const agentTitle = (value: unknown) => filledText(value) ?? COPY.agent ?? 'Agent';
  const secondaryRows = (
    home === undefined ? records(props.countLines) : records(home.secondaryCounts)
  )
    .filter(row => {
      const kind = kindOf(row.kind);
      return content && kind !== null && kind !== primaryKind && safeCount(row.count) > 0;
    })
    .slice(0, 3)
    .map(row => ({ kind: kindOf(row.kind) ?? 'idle', count: safeCount(row.count) }));
  const waitingAgents = content ? records(home?.waitingAgents).slice(0, 3) : [];
  const scheduledAgents = content ? records(home?.scheduledAgents).slice(0, 3) : [];
  let detailRows: Record<string, unknown>[] = [];
  if (primaryKind === 'needsInput') {
    detailRows = waitingAgents;
  } else if (primaryKind === 'scheduled') {
    detailRows = scheduledAgents;
  }
  const canCreate =
    home === undefined
      ? props.actions?.newAgent === true
      : // eslint-disable-next-line typescript-eslint/no-unnecessary-boolean-literal-compare -- the widget process reads raw app-group JSON, not the typed props vitest renders
        (status === 'content' || status === 'empty') && home.canCreate === true;
  const approvalKey = home === undefined ? null : safeText(home.approvalKey);
  const canApprove = content && home?.canApprove === true && approvalKey !== null;
  const large = family === 'systemLarge';
  const wide = family === 'systemMedium';
  const WidgetButton = Button as (props: WidgetButtonProps) => React.JSX.Element;
  const today = widgetEnvironment.date instanceof Date ? widgetEnvironment.date : new Date();
  const intlLocale = (COPY.locale ?? 'en').split('_').join('-');

  // System content margins vary by device and OS, so the card pads the
  // difference to the design's 16pt sides, 12pt above the header controls and
  // 15pt below the footer line.
  const margins = widgetEnvironment.widgetContentMargins;
  // eslint-disable-next-line unicorn/consistent-function-scoping -- the stringified 'widget' layout cannot hoist helpers to module scope
  const inset = (design: number, system: unknown) =>
    // eslint-disable-next-line anti-slop/no-runtime-typeof -- the environment is read from the native host as raw JSON
    design - (typeof system === 'number' && Number.isFinite(system) ? system : 0);
  const rootModifiers = [
    bodyURL,
    containerBackground(palette.bg, 'widget'),
    localeModifier,
    frame({ maxWidth: 10_000, maxHeight: 10_000, alignment: 'topLeading' }),
    padding({
      top: inset(12, margins?.top),
      bottom: inset(15, margins?.bottom),
      leading: inset(16, margins?.leading),
      trailing: inset(16, margins?.trailing),
    }),
  ];

  // ── shared pieces ──
  // eslint-disable-next-line max-params -- a text run is its copy, size, colour and weight, named as the design names them
  const text = (value: string, size: number, color: string, weight: Weight = 'regular') => (
    <Text modifiers={[font({ size, weight }), lineLimit(1), foregroundStyle(color)]}>{value}</Text>
  );
  // A child moved down (or, for a negative offset, up into the line box above
  // it) so its baseline sits where the design puts it.
  // eslint-disable-next-line unicorn/consistent-function-scoping -- the stringified 'widget' layout cannot hoist helpers to module scope
  const shifted = (offset: number, child: React.JSX.Element | null, leading = 0) =>
    child === null ? null : (
      <VStack alignment="leading" spacing={0} modifiers={[padding({ top: offset, leading })]}>
        {child}
      </VStack>
    );
  const dot = (diameter: number, color: string) => (
    <Circle modifiers={[frame({ width: diameter, height: diameter }), foregroundStyle(color)]} />
  );
  const bar = (width: number, height: number, offset: number) =>
    shifted(
      offset,
      <RoundedRectangle
        cornerRadius={height / 2}
        modifiers={[frame({ width, height }), foregroundStyle(palette.secondary)]}
      />
    );
  const rule = (offset: number) =>
    shifted(
      offset,
      <Rectangle
        modifiers={[frame({ maxWidth: 10_000, height: 1 }), foregroundStyle(palette.divider)]}
      />
    );
  const formatDate = (date: Date, options: Intl.DateTimeFormatOptions): string | null => {
    try {
      // eslint-disable-next-line no-restricted-globals -- the widget process cannot import @/lib/intl-cache; failure falls back to SwiftUI's date text
      return new Intl.DateTimeFormat(intlLocale, options).format(date);
    } catch {
      return null;
    }
  };
  // Today is the clock time alone; another day adds a locale-formatted date.
  // There is no "Today"/"Tomorrow" word and no relative "ago" anywhere.
  // eslint-disable-next-line max-params -- the time, its text size and colour, and how much date to add on another day
  const when = (date: Date, size: number, color: string, style: 'short' | 'long') => {
    if (date.toDateString() === today.toDateString()) {
      return (
        <Text
          date={date}
          dateStyle="time"
          modifiers={[font({ size }), lineLimit(1), monospacedDigit(), foregroundStyle(color)]}
        />
      );
    }
    const time = { hour: 'numeric', minute: '2-digit' } as const;
    let options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', ...time };
    if (style === 'long') {
      options = { weekday: 'short', month: 'short', day: 'numeric', ...time };
    } else if (Math.abs(date.getTime() - today.getTime()) < 6 * 24 * 60 * 60 * 1000) {
      options = { weekday: 'short', ...time };
    }
    const formatted = formatDate(date, options);
    if (formatted !== null) {
      return text(formatted, size, color);
    }
    return (
      <HStack spacing={3}>
        <Text
          date={date}
          dateStyle="date"
          modifiers={[font({ size }), lineLimit(1), foregroundStyle(color)]}
        />
        <Text
          date={date}
          dateStyle="time"
          modifiers={[font({ size }), lineLimit(1), monospacedDigit(), foregroundStyle(color)]}
        />
      </HStack>
    );
  };
  // Header: the Kilo tile and name, then the Approve slot and the `+` slot at
  // the trailing edge. A hidden action leaves its slot empty, so `+` never moves.
  // eslint-disable-next-line max-params -- the symbol, its size, and the circle's fill and glyph colours
  const circleGlyph = (symbol: SystemSymbol, size: number, fill: string, color: string) => (
    <Image
      systemName={symbol}
      color={color}
      modifiers={[
        font({ size, weight: 'semibold' }),
        frame({ width: 24, height: 24 }),
        background(fill, shapes.circle()),
      ]}
    />
  );
  const pill = (label: string, fill: string, color: string) => (
    <Text
      modifiers={[
        font({ size: 12, weight: 'semibold' }),
        lineLimit(1),
        foregroundStyle(color),
        fixedSize({ horizontal: true, vertical: false }),
        padding({ horizontal: 14 }),
        frame({ minWidth: 86, height: 24 }),
        background(fill, shapes.capsule()),
      ]}
    >
      {label}
    </Text>
  );
  const approveButton = (child: React.JSX.Element) => (
    <WidgetButton
      modifiers={[buttonStyle('plain'), accessibilityLabel(COPY.approve ?? 'Approve')]}
      onPress={() => ({
        pendingAction: 'approve',
        pendingApprovalKey: approvalKey ?? undefined,
        pendingActionAt: Date.now(),
      })}
    >
      {child}
    </WidgetButton>
  );
  let approveControl: React.JSX.Element | null = null;
  if (feedback === 'approving') {
    approveControl =
      wide || large
        ? pill(COPY.approving ?? 'Approving…', palette.secondary, palette.muted)
        : circleGlyph('ellipsis', 13, palette.secondary, palette.muted);
  } else if (canApprove) {
    approveControl = approveButton(
      wide || large
        ? pill(COPY.approve ?? 'Approve', palette.primary, palette.primaryFg)
        : circleGlyph('checkmark', 12, palette.primary, palette.primaryFg)
    );
  }
  const createButton = (child: React.JSX.Element) => (
    <WidgetButton
      openAppWhenRun
      modifiers={[buttonStyle('plain'), accessibilityLabel(COPY.newAgent ?? 'New agent')]}
      onPress={() => ({ pendingAction: 'new-agent', pendingActionAt: Date.now() })}
    >
      {child}
    </WidgetButton>
  );
  // The empty Medium and Large cards offer New agent as a pill in the body, so
  // the header `+` hides there and the card has a single create control.
  const headerCreate = canCreate && (content || (status === 'empty' && !wide && !large));
  const header = (
    <HStack alignment="center" spacing={0} modifiers={[frame({ height: 24 })]}>
      {logoTile(18, palette.fg, palette.bg)}
      <Text
        modifiers={[
          font({ size: 13, weight: 'semibold' }),
          lineLimit(1),
          foregroundStyle(palette.fg),
          padding({ leading: 6 }),
        ]}
      >
        Kilo
      </Text>
      <Spacer minLength={8} />
      <HStack
        spacing={0}
        modifiers={[
          frame(wide || large ? { minWidth: 86, height: 24 } : { width: 24, height: 24 }),
          padding({ trailing: wide || large ? 8 : 4 }),
        ]}
      >
        {approveControl}
      </HStack>
      <HStack spacing={0} modifiers={[frame({ width: 24, height: 24 })]}>
        {headerCreate ? createButton(circleGlyph('plus', 14, palette.secondary, palette.fg)) : null}
      </HStack>
    </HStack>
  );

  // Footer: "Checked <time>" or "Last known · <time>"; a failed Approve on the
  // Medium and Large cards says so here instead.
  let footer: React.JSX.Element | null = null;
  if (failed && (wide || large)) {
    footer = text(
      COPY.approveFailed ?? "Couldn't approve. Tap Approve to try again.",
      11,
      palette.warn,
      'semibold'
    );
  } else if (status === 'waiting') {
    footer = text(COPY.waiting ?? 'Updating agents', 11, palette.muted);
  } else if (checkedAt !== null) {
    footer = (
      <HStack spacing={3}>
        {text(
          stale ? `${COPY.lastKnown ?? 'Last known'} ·` : (COPY.checked ?? 'Checked'),
          11,
          palette.muted
        )}
        {when(checkedAt, 11, palette.muted, 'short')}
      </HStack>
    );
  }
  const fill = <Spacer minLength={0} />;
  // The slack above the body: the design's gap first, so a shorter device
  // shrinks it before the body meets the footer.
  const lead = (height: number) => (
    <Spacer minLength={0} modifiers={[frame({ maxHeight: height }), layoutPriority(1)]} />
  );

  // ── locked: privacy, unavailable, signed out ──
  if (!content && status !== 'empty' && status !== 'waiting') {
    const message =
      status === 'signed_out'
        ? (COPY.signed_out ?? 'Sign in to see agents')
        : (COPY.privacy ?? 'Open Kilo to see agents');
    // The small card breaks the message at the word that balances its two lines.
    const words = message.split(' ');
    let lines = [message];
    for (let index = 1; index < words.length; index += 1) {
      const candidate = [words.slice(0, index).join(' '), words.slice(index).join(' ')];
      if (
        Math.max(candidate[0]?.length ?? 0, candidate[1]?.length ?? 0) <
        Math.max(...lines.map(line => line.length))
      ) {
        lines = candidate;
      }
    }
    // Lock glyph sizes, the gap to the message, and the room the design keeps
    // under the centred block: 26/6.6/1.7 small, 28/6.7/2.4 medium, 40/29/17 large.
    let lockSize = 26;
    let lockGap = 6.6;
    let messageSize = 13;
    let reserve = 1.7;
    if (wide) {
      lockSize = 28;
      lockGap = 6.7;
      messageSize = 15;
      reserve = 2.4;
    } else if (large) {
      lockSize = 40;
      lockGap = 29;
      messageSize = 20;
      reserve = 17;
    }
    const messageText = (line: string) => (
      <Text
        modifiers={[
          font({ size: messageSize, weight: 'semibold' }),
          lineLimit(1),
          multilineTextAlignment('center'),
          foregroundStyle(palette.fg),
        ]}
      >
        {line}
      </Text>
    );
    return (
      <VStack alignment="leading" spacing={0} modifiers={rootModifiers}>
        {header}
        {fill}
        <VStack
          alignment="center"
          spacing={0}
          modifiers={[frame({ maxWidth: 10_000, alignment: 'center' })]}
        >
          <Image
            systemName="lock.fill"
            color={palette.fg}
            modifiers={[
              resizable(),
              aspectRatio({ contentMode: 'fit' }),
              frame({ width: lockSize * 0.86, height: lockSize * 1.071 }),
            ]}
          />
          {shifted(lockGap, messageText(wide || large ? message : (lines[0] ?? message)))}
          {wide || large || lines[1] === undefined
            ? null
            : shifted(gap(108, 13, 125, 13), messageText(lines[1]))}
        </VStack>
        {fill}
        <Spacer minLength={0} modifiers={[frame({ height: reserve })]} />
      </VStack>
    );
  }

  // ── updating (first load): placeholder bars, no actions ──
  if (status === 'waiting') {
    let body = (
      <VStack alignment="leading" spacing={0}>
        {bar(44, 30, 26)}
        {bar(96, 12, 10)}
      </VStack>
    );
    if (wide) {
      body = (
        <HStack alignment="top" spacing={0}>
          <VStack
            alignment="leading"
            spacing={0}
            modifiers={[frame({ width: 160, alignment: 'leading' })]}
          >
            {bar(44, 34, 26)}
            {bar(96, 12, 8)}
          </VStack>
          <VStack alignment="leading" spacing={0}>
            {bar(150, 12, 30)}
            {bar(100, 10, 8)}
            {bar(140, 12, 12)}
            {bar(90, 10, 8)}
          </VStack>
        </HStack>
      );
    } else if (large) {
      body = (
        <VStack alignment="leading" spacing={0}>
          {bar(70, 60, 44)}
          {bar(140, 16, 12)}
          {bar(300, 14, 42)}
          {bar(180, 11, 8)}
          {bar(260, 14, 19)}
          {bar(160, 11, 8)}
        </VStack>
      );
    }
    return (
      <VStack alignment="leading" spacing={0} modifiers={rootModifiers}>
        {header}
        {body}
        {fill}
        {footer}
      </VStack>
    );
  }

  // ── nothing running ──
  if (!content) {
    const message = COPY.homeEmpty ?? 'Nothing running right now';
    // New agent pill: 28pt with a 12pt plus on medium, 36pt with a 14pt plus on large.
    const newAgentPill = canCreate
      ? createButton(
          <HStack
            alignment="center"
            spacing={large ? 9 : 8}
            modifiers={[
              padding({ leading: large ? 11 : 8, trailing: large ? 16 : 12 }),
              frame({ height: large ? 36 : 28 }),
              background(palette.secondary, shapes.capsule()),
            ]}
          >
            <Image
              systemName="plus"
              color={palette.fg}
              modifiers={[font({ size: large ? 16 : 14, weight: 'semibold' })]}
            />
            <Text
              modifiers={[
                font({ size: large ? 14 : 13, weight: 'semibold' }),
                lineLimit(1),
                foregroundStyle(palette.fg),
              ]}
            >
              {COPY.newAgent ?? 'New agent'}
            </Text>
          </HStack>
        )
      : null;
    let headlineSize = 17;
    if (large) {
      headlineSize = 22;
    } else if (wide) {
      headlineSize = 20;
    }
    const headline = (
      <Text
        modifiers={[
          font({ size: headlineSize, weight: 'semibold' }),
          lineLimit(2),
          multilineTextAlignment(large ? 'center' : 'leading'),
          foregroundStyle(palette.fg),
        ]}
      >
        {message}
      </Text>
    );
    if (large) {
      return (
        <VStack alignment="leading" spacing={0} modifiers={rootModifiers}>
          {header}
          {fill}
          <VStack
            alignment="center"
            spacing={0}
            modifiers={[frame({ maxWidth: 10_000, alignment: 'center' })]}
          >
            {headline}
            {shifted(198 - (176 + 0.241 * 22), newAgentPill)}
          </VStack>
          {fill}
          {footer}
        </VStack>
      );
    }
    return (
      <VStack alignment="leading" spacing={0} modifiers={rootModifiers}>
        {header}
        {fill}
        {headline}
        {wide ? shifted(106 - (92 + 0.241 * 20), newAgentPill) : null}
        {shifted(wide ? 141.53 - 134 : gap(124, 17, 152, 11), footer)}
      </VStack>
    );
  }

  // ── content ──
  const countText = (size: number) => (
    <Text
      modifiers={[
        font({ size, weight: 'bold' }),
        monospacedDigit(),
        lineLimit(1),
        fixedSize({ horizontal: true, vertical: false }),
        foregroundStyle(palette.fg),
        accessibilityLabel(`${count(primaryCount)} ${primaryLabel}`),
      ]}
    >
      {count(primaryCount)}
    </Text>
  );
  // The dot sits a hair inside the count's edge, 6pt before the label.
  const statusRow = (diameter: number, labelSize: number) => (
    <HStack
      alignment="center"
      spacing={6}
      modifiers={[padding({ leading: diameter > 8 ? 1.5 : 1 })]}
    >
      {dot(diameter, dotColors[primaryKind])}
      <Text
        modifiers={[
          font({ size: labelSize, weight: 'semibold' }),
          lineLimit(1),
          foregroundStyle(palette.fg),
        ]}
      >
        {primaryLabel}
      </Text>
    </HStack>
  );
  // One row's second line: why the agent waits, or when it wakes.
  const rowDetail = (row: Record<string, unknown>, size: number, style: 'short' | 'long') => {
    if (primaryKind === 'needsInput') {
      let reason = COPY.waitingToRetry ?? 'Waiting to retry';
      if (row.kind === 'permission') {
        reason = COPY.permissionRequired ?? 'Permission required';
      } else if (row.kind === 'question') {
        reason = COPY.answerNeeded ?? 'Answer needed';
      }
      return text(reason, size, palette.muted);
    }
    const date = validDate(row.scheduledAt);
    if (date === null) {
      return null;
    }
    if (date.getTime() <= today.getTime()) {
      return text(COPY.awaitingUpdate ?? 'Awaiting update', size, palette.muted);
    }
    return when(date, size, palette.muted, style);
  };
  const rowColor = primaryKind === 'scheduled' ? palette.info : palette.warn;
  const titleRow = (row: Record<string, unknown>, size: number) => (
    <HStack alignment="center" spacing={8}>
      {dot(8, rowColor)}
      {text(agentTitle(row.title), size, palette.fg)}
    </HStack>
  );
  const countRows = (spacing: number) => (
    <VStack alignment="leading" spacing={spacing}>
      {secondaryRows.map(row => (
        <HStack key={row.kind} alignment="center" spacing={8}>
          {dot(8, dotColors[row.kind])}
          <Text
            modifiers={[
              font({ size: 13 }),
              monospacedDigit(),
              lineLimit(1),
              foregroundStyle(palette.fg),
            ]}
          >
            {`${count(row.count)} ${labels[row.kind]}`}
          </Text>
        </HStack>
      ))}
    </VStack>
  );
  const sectionLabel = (label: string) => text(label, 12, palette.muted, 'semibold');
  // The scheduled line under the label: the next wake, Awaiting update, or the title.
  const scheduledLine = (size: number, color: string) => {
    if (awaitingUpdate) {
      return text(COPY.awaitingUpdate ?? 'Awaiting update', size, palette.muted);
    }
    if (scheduledAt !== null) {
      return (
        <HStack spacing={3}>
          {text(COPY.nextRun ?? 'Next run', size, color)}
          {when(scheduledAt, size, color, 'short')}
        </HStack>
      );
    }
    return title === null ? null : text(title, size, color);
  };

  if (large) {
    // One kind: count 88 @168, label 20 @203, rule 238, "Recent" @268, title 15 @292.
    let body = (
      <VStack alignment="leading" spacing={0}>
        {lead(168 - 0.952 * 88 - 36)}
        {countText(88)}
        {shifted(gap(168, 88, 203, 20), statusRow(10, 20))}
        {title === null ? null : rule(237.5 - (203 + 0.241 * 20))}
        {title === null
          ? null
          : shifted(268 - 0.952 * 12 - 238.5, sectionLabel(COPY.recent ?? 'Recent'))}
        {title === null ? null : shifted(gap(268, 12, 292, 15), text(title, 15, palette.fg))}
      </VStack>
    );
    if (primaryKind === 'scheduled') {
      // Count 80 @128, label 19 @158, line 13 @182, rule 206, "Next runs" @232, rows @258 + 34n.
      body = (
        <VStack alignment="leading" spacing={0}>
          {lead(128 - 0.952 * 80 - 36)}
          {countText(80)}
          {shifted(gap(128, 80, 158, 19), statusRow(10, 19))}
          {shifted(gap(158, 19, 182, 13), scheduledLine(13, palette.muted))}
          {rule(205.5 - (182 + 0.241 * 13))}
          {shifted(232 - 0.952 * 12 - 206.5, sectionLabel(COPY.nextScheduled ?? 'Next scheduled'))}
          {detailRows.map((row, index) => (
            <VStack
              key={index}
              alignment="leading"
              spacing={0}
              modifiers={[
                padding({
                  top: index === 0 ? gap(232, 12, 258, 14) : gap(258, 14, 292, 14),
                  leading: 1,
                }),
              ]}
            >
              <HStack alignment="firstTextBaseline" spacing={8}>
                {titleRow(row, 14)}
                <Spacer minLength={0} />
                {rowDetail(row, 12, 'long')}
              </HStack>
            </VStack>
          ))}
        </VStack>
      );
    } else if (primaryKind === 'needsInput') {
      // Count 64 @106 with the other counts beside it; rule 152; "Waiting for
      // you" @176; up to three rows @202 + 46n with their reason 17pt below.
      const rows = detailRows;
      body = (
        <VStack alignment="leading" spacing={0}>
          {lead(106 - 0.952 * 64 - 36)}
          <HStack alignment="top" spacing={0}>
            <VStack
              alignment="leading"
              spacing={0}
              modifiers={[frame({ width: 206, alignment: 'leading' })]}
            >
              {countText(64)}
              {shifted(gap(106, 64, 131, 17), statusRow(9, 17))}
            </VStack>
            {shifted(74 - 0.952 * 13 - (106 - 0.952 * 64), countRows(gap(74, 13, 96, 13)))}
          </HStack>
          {rule(151.5 - (131 + 0.241 * 17))}
          {rows.length > 0
            ? shifted(
                176 - 0.952 * 12 - 152.5,
                sectionLabel(COPY.waitingForYou ?? 'Waiting for you')
              )
            : null}
          {rows.map((row, index) => (
            <VStack
              key={index}
              alignment="leading"
              spacing={0}
              modifiers={[
                padding({
                  top: index === 0 ? gap(176, 12, 202, 14) : gap(219, 12, 248, 14),
                  leading: 1,
                }),
              ]}
            >
              {titleRow(row, 14)}
              {shifted(gap(202, 14, 219, 12), rowDetail(row, 12, 'long'), 16)}
            </VStack>
          ))}
          {rows.length === 0 && title !== null
            ? shifted(176 - 0.952 * 12 - 152.5, sectionLabel(COPY.recent ?? 'Recent'))
            : null}
          {rows.length === 0 && title !== null
            ? shifted(gap(176, 12, 200, 15), text(title, 15, palette.fg))
            : null}
        </VStack>
      );
    } else if (secondaryRows.length > 0) {
      // Mixed: count 64 @120 beside the other counts (@92 + 24n); rule 178;
      // "Recent" @210 and its title @234; "Next scheduled" @284 with one row.
      const next = scheduledAgents[0];
      body = (
        <VStack alignment="leading" spacing={0}>
          {lead(120 - 0.952 * 64 - 36)}
          <HStack alignment="top" spacing={0}>
            <VStack
              alignment="leading"
              spacing={0}
              modifiers={[frame({ width: 206, alignment: 'leading' })]}
            >
              {countText(64)}
              {shifted(gap(120, 64, 145, 17), statusRow(9, 17))}
            </VStack>
            {shifted(92 - 0.952 * 13 - (120 - 0.952 * 64), countRows(gap(92, 13, 116, 13)))}
          </HStack>
          {rule(177.5 - (145 + 0.241 * 17))}
          {title === null
            ? null
            : shifted(210 - 0.952 * 12 - 178.5, sectionLabel(COPY.recent ?? 'Recent'))}
          {title === null ? null : shifted(gap(210, 12, 234, 15), text(title, 15, palette.fg))}
          {next === undefined
            ? null
            : shifted(
                title === null ? 210 - 0.952 * 12 - 178.5 : gap(234, 15, 284, 12),
                sectionLabel(COPY.nextScheduled ?? 'Next scheduled')
              )}
          {next === undefined ? null : (
            <VStack
              alignment="leading"
              spacing={0}
              modifiers={[padding({ top: gap(284, 12, 308, 14), leading: 1 })]}
            >
              <HStack alignment="center" spacing={8}>
                {dot(8, palette.info)}
                {text(agentTitle(next.title), 14, palette.fg)}
              </HStack>
              {shifted(gap(308, 14, 326, 12), rowDetail(next, 12, 'long'), 16)}
            </VStack>
          )}
        </VStack>
      );
    }
    return (
      <VStack alignment="leading" spacing={0} modifiers={rootModifiers}>
        {header}
        {body}
        {fill}
        {footer}
      </VStack>
    );
  }

  if (wide) {
    // Left: count 44 @92 and the label @112. Right, from x 168: up to two
    // agent rows @74 + 42n, else the other counts @78 + 24n from x 172, else
    // "Recent" @88 and the title @106 from x 176.
    const countTop = 92 - 0.952 * 44;
    const rows = detailRows.slice(0, 2);
    let column: React.JSX.Element | null = null;
    if (rows.length > 0) {
      column = shifted(
        74 - 0.952 * 13 - countTop,
        <VStack alignment="leading" spacing={0}>
          {rows.map((row, index) => (
            <VStack
              key={index}
              alignment="leading"
              spacing={0}
              modifiers={[padding({ top: index === 0 ? 0 : gap(90, 11, 116, 13) })]}
            >
              {titleRow(row, 13)}
              {shifted(
                gap(74, 13, 90, 11),
                rowDetail(row, 11, 'long') ?? (
                  <Spacer minLength={0} modifiers={[frame({ height: 1.193 * 11 })]} />
                ),
                16
              )}
            </VStack>
          ))}
        </VStack>
      );
    } else if (secondaryRows.length > 0) {
      column = shifted(78 - 0.952 * 13 - countTop, countRows(gap(78, 13, 102, 13)), 4);
    } else if (title !== null) {
      column = shifted(
        88 - 0.952 * 11 - countTop,
        <VStack alignment="leading" spacing={0}>
          {text(COPY.recent ?? 'Recent', 11, palette.muted, 'semibold')}
          {shifted(gap(88, 11, 106, 13), text(title, 13, palette.fg))}
        </VStack>,
        8
      );
    }
    return (
      <VStack alignment="leading" spacing={0} modifiers={rootModifiers}>
        {header}
        {lead(countTop - 36)}
        <HStack alignment="top" spacing={0}>
          <VStack
            alignment="leading"
            spacing={0}
            modifiers={[frame({ width: 152, alignment: 'leading' })]}
          >
            {countText(44)}
            {shifted(gap(92, 44, 112, 14), statusRow(8, 14))}
          </VStack>
          <VStack
            alignment="leading"
            spacing={0}
            modifiers={[frame({ maxWidth: 10_000, alignment: 'leading' })]}
          >
            {column}
          </VStack>
        </HStack>
        {fill}
        {footer}
      </VStack>
    );
  }

  // Small: count 44 @78 right under the header, label @98, one line @117.
  let detail: React.JSX.Element | null = null;
  if (failed) {
    detail = text(COPY.couldNotApprove ?? 'Could not approve', 13, palette.warn, 'semibold');
  } else if (primaryKind === 'scheduled') {
    detail = scheduledLine(13, palette.fg);
  } else if (title !== null) {
    detail = text(title, 13, palette.fg);
  }
  return (
    <VStack alignment="leading" spacing={0} modifiers={rootModifiers}>
      {header}
      {countText(44)}
      {shifted(gap(78, 44, 98, 14), statusRow(8, 14))}
      {shifted(gap(98, 14, 117, 13), detail)}
      {fill}
      {footer}
    </VStack>
  );
};

export const WIDGET_NAME = 'ActiveAgentsWidget';
export const activeAgentsWidgetLayout = layout;
const registerLayout = () => createWidget<WidgetProps>(WIDGET_NAME, withGlanceableCopy(layout));
export const ActiveAgentsWidget = registerLayout();

/**
 * The kind the widget extension draws in the gallery: the same layout over
 * sample props. `HomeWidgetTimelineProvider.swift` reads it as `<name>Preview`
 * for a preview snapshot and falls back to the placed widget's entry until the
 * app has written it.
 */
const WIDGET_GALLERY_PREVIEW_NAME = `${WIDGET_NAME}Preview`;

/** Re-bake both layouts in the active language and re-write the gallery sample. */
export function refreshActiveAgentsWidgetCopy(): void {
  registerLayout();
  createWidget<WidgetProps>(WIDGET_GALLERY_PREVIEW_NAME, withGlanceableCopy(layout)).updateSnapshot(
    buildGalleryPreviewProps(key => i18n.t(key))
  );
}
