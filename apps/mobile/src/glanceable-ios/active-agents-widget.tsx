/* eslint-disable max-lines -- every family, the in-place action buttons, and the newest-result footer compose inside one stringified 'widget' layout, which cannot be split across modules */
import { Button, type ButtonProps, HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityLabel,
  buttonStyle,
  containerBackground,
  controlSize,
  cornerRadius,
  type dynamicTypeSize,
  environment,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  monospacedDigit,
  multilineTextAlignment,
  resizable,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';
import { PlatformColor } from 'react-native';

import { withGlanceableCopy } from './layout-copy';
import { type GlanceableWidgetAction, type GlanceableWidgetProps } from './view-props';
import { withWidgetLogo } from './widget-logo';

/* eslint-disable new-cap -- PlatformColor is a React Native factory function, not a constructor */

// The layout function below is marked with the `'widget'` directive, so Babel
// stringifies it and the widget extension re-evaluates the source. Everything
// it references must be a widget global (`Text`, `VStack`, the modifiers,
// `PlatformColor`) or a built-in. Do not call `@/` helpers or i18n from here —
// translated copy arrives through `props`, and the gallery placeholder (which
// has no props) falls back to the baked copy below.
//
// Two values are resolved after stringification, both from literals below:
// `withWidgetLogo` swaps `__KILO_WIDGET_LOGO_URI__` for the app-group path of
// the mark, and `withGlanceableCopy` swaps `__KILO_GLANCEABLE_COPY__` for the
// translated copy.

// The timeline props: the builder's props plus the press marker a widget
// button's App Intent patches into the pressed entry (see GlanceableWidgetProps
// in view-props).
type WidgetProps = GlanceableWidgetProps;

/**
 * The press patch. `@expo/ui` types `onPress` as `() => void`, but in the
 * widget process the bundle calls the handler and merges the returned patch
 * into the pressed entry's props (its `findAndCallOnPress`), so the return
 * value is load-bearing. The app maps the marker back to the action (see
 * `pendingActionOf` in widget-actions).
 */
type WidgetPressPatch = {
  pendingAction: GlanceableWidgetAction;
};

/**
 * The shared Button with the widget press's real `onPress` contract: the
 * returned patch is load-bearing there. A local narrow cast, not a widening of
 * the shared UI types.
 */
type WidgetButtonProps = Omit<ButtonProps, 'onPress'> & {
  onPress?: () => WidgetPressPatch;
};

export type { WidgetProps };

// Babel replaces the annotated arrow with its source string, so `layout` is a
// string at runtime while TypeScript still checks it as a component.
const layout: (props: WidgetProps, widgetEnvironment: WidgetEnvironment) => React.JSX.Element = (
  props,
  widgetEnvironment
) => {
  'widget';

  // The literal, not the imported constant: the widget transform stringifies
  // this function's source, so an imported binding would be an undefined
  // global in the widget process. `withGlanceableCopy` replaces the token,
  // quotes included, with the translated copy as a JSON source literal. Until
  // then the value is the bare token, which is not JSON: falling back to an
  // empty copy renders the fallback literals below instead of throwing a
  // blank surface.
  // eslint-disable-next-line typescript-eslint/no-inferrable-types -- see above
  const copySource: string = '__KILO_GLANCEABLE_COPY__';
  const COPY = JSON.parse(copySource.startsWith('{') ? copySource : '{}') as Record<string, string>;
  // The tag SwiftUI formats the relative wait with; English when the bake is
  // somehow missing it, which is what the widget process would have used anyway.
  const locale = COPY.locale ?? 'en';

  // The counts are stringified here, not formatted: a pushed content state
  // carries raw numbers and this process has no formatter. `COPY.digits` is the
  // language's own ten, empty when it writes them the way `String` already
  // does, so an Arabic count reads "١" beside the "٢٦ د" SwiftUI formats.
  const digits = COPY.digits ?? '';
  const count = (value: number) =>
    digits.length === 10
      ? // eslint-disable-next-line unicorn/prefer-spread -- `replaceAll` and a spread both failed in the widget process; this form is the one verified on device
        String(value)
          .split('')
          .map(character => digits[Number(character)] ?? character)
          .join('')
      : String(value);

  const family = widgetEnvironment.widgetFamily;
  // Guarded, not a bare `?? []`: a widget extension can evaluate this layout
  // against props a *different* app version wrote to the app group (a placed
  // widget keeps its stored timeline across an app update), and a non-array or
  // a null row would throw out of `counts.map` — which expo-widgets renders as
  // a red error box in every family, the gallery placeholder included.
  const counts = (Array.isArray(props.countLines) ? props.countLines : []).filter(
    // eslint-disable-next-line anti-slop/no-runtime-typeof, typescript-eslint/no-unnecessary-condition -- the widget process reads raw app-group JSON, not the typed props vitest renders
    line => line !== null && typeof line === 'object'
  );
  const primaryLabel = props.primaryLabel ?? null;
  const primaryKind = props.primaryKind ?? null;
  // Only the medium row and the tall large card are wide enough for a time
  // beside the label; in the small square the pair wraps and truncates both
  // halves, so it draws neither (the time is the first thing a narrow cell
  // drops).
  const large = family === 'systemLarge';
  const square = family === 'systemSmall';
  const wide = family === 'systemMedium';
  const timedRows = wide || large;
  const needsInputSince = props.needsInputSince ?? null;
  const scheduledAt = props.scheduledAt ?? null;
  // Labels draw at their full text size and never scale: in the widget
  // renderer a label with `minimumScaleFactor` always resolved at its minimum
  // scale, room or not, which drew the labels far smaller than their counts.
  // The square and the Lock Screen rectangle are the cells a wide row can
  // overflow, so there the mark gives its width up before a label truncates
  // (the count never does). The width measure available in this process is
  // the row's character count, count digits included: 12 keeps "2 Needs
  // input" beside the mark, and "128 Needs input" or German's "Eingabe
  // erforderlich" take its place.
  const widestRow = Math.max(
    0,
    ...counts.map(
      line =>
        // eslint-disable-next-line anti-slop/no-runtime-typeof -- the widget process reads raw app-group JSON, not the typed props vitest renders
        (typeof line.label === 'string' ? line.label.length : 0) + String(line.count).length
    )
  );
  const crowdedRows = widestRow > 12;
  // The rows carry zeros too, so their number never says whether work exists —
  // the ranked primary does, because it is null only when every count is zero.
  const hasCounts = primaryKind !== null;
  const primaryCount = props.primaryCount ?? 0;
  // A real frame always carries its status line. An entry with no status line
  // and no counts is the native fallback: no app has written a timeline yet
  // (never signed in) or the gallery placeholder. The Android widget shows
  // the same sign-in copy for a widget with no snapshot.
  const statusLine = props.statusLine ?? (hasCounts ? null : COPY.signed_out);

  // Circle-based glyphs whose shapes differ as well as their colors, because
  // the Lock Screen families render in an accented mode that flattens tint.
  const GLYPH = {
    needsInput: { icon: 'exclamationmark.circle.fill', color: PlatformColor('systemOrange') },
    running: { icon: 'circle.fill', color: PlatformColor('systemGreen') },
    scheduled: { icon: 'clock', color: PlatformColor('label') },
    idle: { icon: 'circle', color: PlatformColor('label') },
  } as const;

  // Total, never a bare index: a stale timeline entry or an older app version
  // can name a kind this build does not draw, and `GLYPH[unknown].icon` would
  // throw during stringified evaluation — the red error box the widget shows in
  // every family when the layout raises. An unknown kind falls back to the
  // neutral idle mark instead of blanking the surface.
  const glyphFor = (kind: string | null | undefined) => {
    if (kind !== null && kind !== undefined && Object.hasOwn(GLYPH, kind)) {
      return GLYPH[kind as keyof typeof GLYPH];
    }
    return GLYPH.idle;
  };

  const primaryForeground = foregroundStyle(PlatformColor('label'));
  // `secondaryLabel` in both appearances: `tertiaryLabel` on the light widget
  // background left the ranked-down rows too faint to read.
  const mutedForeground = foregroundStyle(PlatformColor('secondaryLabel'));
  const a11y = [
    // The widget process takes its locale from the device language, so without
    // this the relative wait would be formatted in a different language than
    // the labels the app translated into the props.
    environment({ key: 'locale', value: locale }),
    accessibilityElement('combine'),
    accessibilityLabel(props.accessibilityLabel ?? ''),
  ];

  // The literal, not the imported constant: the widget transform stringifies
  // this function's source, so an imported binding would be an undefined global
  // in the widget process. It must stay equal to `WIDGET_LOGO_PLACEHOLDER`, which
  // `withWidgetLogo` replaces with the app-group path.
  // The annotation widens the literal: the token is replaced after this file is
  // stringified, so the empty-path branch below is reachable at runtime.
  // eslint-disable-next-line typescript-eslint/no-inferrable-types -- see above
  const logoUri: string = '__KILO_WIDGET_LOGO_URI__';
  const logo = (size: number) =>
    logoUri.length === 0 ? null : (
      <Image
        uiImage={logoUri}
        modifiers={[resizable(), frame({ width: size, height: size }), cornerRadius(size * 0.24)]}
      />
    );

  // The row text size per surface. Every row shares one type size and one
  // glyph size so the counts and the labels line up on a grid; only the label
  // colour ranks them. The tall large card scales the rows up with its height
  // so it does not read empty, the medium row takes `footnote`, and the square
  // steps down to `caption2` so "Needs input" fits beside the mark.
  type RowStyle = 'caption' | 'caption2' | 'footnote' | 'title3';
  let rowStyle: RowStyle = 'footnote';
  let glyphSize = 13;
  let rowSpacing = 7;
  if (large) {
    rowStyle = 'title3';
    glyphSize = 17;
    rowSpacing = 9;
  } else if (square) {
    rowStyle = 'caption2';
  }
  // A time that cannot fit beside its label is dropped whole, never
  // truncated. The medium row holds every shipped label plus its time at
  // `footnote`; the large card's `title3` holds a time beside labels up to 15
  // characters (Spanish "En espera de respuesta" drops it).
  const timeLabelBudget = large ? 15 : 24;
  // `elapsed` is the repo-local @expo/ui style (patches/@expo+ui): the wait in
  // its one largest unit, seconds only under a minute ("31 minutes", "20
  // seconds"); before iOS 18 it is the relative style.
  const waitStyle = 'elapsed';
  // The rows a state actually has lead: a zero row is kept (the grid never
  // reflows as work appears) but sinks below every non-zero one, and draws
  // fully muted — glyph, number and label in the secondary colour, the number
  // without its emphasis. A stable sort keeps the kind order inside each group.
  const ledgerRows = [
    ...counts.filter(line => line.count > 0),
    ...counts.filter(line => line.count === 0),
  ];
  const mutedColor = PlatformColor('secondaryLabel');
  // `compact` is the Lock Screen rectangle: four `caption` rows beside the mark.
  const countRow = (
    line: { label: string; kind: string; count: number },
    isPrimary: boolean,
    compact: boolean
  ) => {
    const glyph = glyphFor(line.kind);
    const textStyle: RowStyle = compact ? 'caption' : rowStyle;
    const zero = line.count === 0;
    const timed = !compact && timedRows && line.label.length <= timeLabelBudget;
    // One time at most per row: a needs-input wait or a scheduled wake, never
    // both. The wait is a duration ("31 minutes") and the wake a clock time
    // ("9:00 AM"): a wait is an interval the user is enduring, a wake is the
    // moment the user asked for. The medium and large cards draw both in the
    // row's trailing column, so the two times line up.
    let timeAt: string | null = null;
    let timeStyle: 'elapsed' | 'time' = waitStyle;
    if (timed && line.kind === 'needsInput') {
      timeAt = needsInputSince;
    } else if (timed && line.kind === 'scheduled') {
      timeAt = scheduledAt;
      timeStyle = 'time';
    }
    return (
      <HStack
        key={line.label}
        alignment="center"
        spacing={compact ? 4 : rowSpacing}
        // A row that draws a trailing time fills the card's width, so its time
        // sits in the same trailing column as every other row's.
        modifiers={timedRows && !compact ? [frame({ maxWidth: 10_000, alignment: 'leading' })] : []}
      >
        <Image
          systemName={glyph.icon}
          color={zero ? mutedColor : glyph.color}
          size={compact ? 11 : glyphSize}
        />
        <Text
          modifiers={[
            font({ textStyle, weight: zero ? 'regular' : 'semibold' }),
            monospacedDigit(),
            // The number is the whole point of the row, so it takes its space
            // first: a long label truncates before the count does.
            layoutPriority(1),
            zero ? mutedForeground : primaryForeground,
          ]}
        >
          {count(line.count)}
        </Text>
        <Text
          modifiers={[
            font({ textStyle }),
            // One line at the row's own size. Do not add `minimumScaleFactor`:
            // in the widget renderer it always drew the label at its minimum.
            lineLimit(1),
            // A live time reserves more width than it draws, so without the
            // priority it took the label's room ("Eingabe erforde…" beside
            // "31 Minuten" with space to spare).
            layoutPriority(1),
            isPrimary && !zero ? primaryForeground : mutedForeground,
          ]}
        >
          {line.label}
        </Text>
        {timedRows && !compact ? <Spacer /> : null}
        {timeAt === null ? null : (
          <Text
            date={new Date(timeAt)}
            dateStyle={timeStyle}
            // A live time reserves more width than it draws and draws at the
            // leading edge of that box: trailing alignment puts the wait flush
            // with the wake.
            modifiers={[
              font({ textStyle }),
              monospacedDigit(),
              lineLimit(1),
              multilineTextAlignment('trailing'),
              mutedForeground,
            ]}
          />
        )}
      </HStack>
    );
  };

  // accessoryCircular has room for one number, and accessoryInline for one
  // glyph plus one line of text, so neither carries the mark.
  if (family === 'accessoryCircular') {
    return (
      <VStack alignment="center" spacing={0} modifiers={[widgetURL('kiloapp:///cloud/sessions')]}>
        {primaryKind === null ? null : (
          <Image
            systemName={glyphFor(primaryKind).icon}
            color={glyphFor(primaryKind).color}
            size={17}
          />
        )}
        <Text
          modifiers={[
            font({ textStyle: 'title2', weight: 'bold' }),
            monospacedDigit(),
            primaryForeground,
            ...a11y,
          ]}
        >
          {hasCounts ? count(primaryCount) : '—'}
        </Text>
      </VStack>
    );
  }

  if (family === 'accessoryInline') {
    const label = hasCounts
      ? `${count(primaryCount)}${primaryLabel !== null ? ` ${primaryLabel}` : ''}`
      : (statusLine ?? '');
    return (
      <HStack
        alignment="center"
        spacing={4}
        modifiers={[widgetURL('kiloapp:///cloud/sessions'), ...a11y]}
      >
        {primaryKind === null ? null : <Image systemName={glyphFor(primaryKind).icon} size={12} />}
        <Text>{label}</Text>
      </HStack>
    );
  }

  // accessoryRectangular is the Lock Screen row: the mark plus the two
  // top-ranked lines is all that fits.
  if (family === 'accessoryRectangular') {
    return (
      <HStack
        alignment="center"
        spacing={6}
        modifiers={[widgetURL('kiloapp:///cloud/sessions'), ...a11y]}
      >
        {crowdedRows ? null : logo(18)}
        {hasCounts ? (
          <VStack alignment="leading" spacing={1}>
            {ledgerRows.map(line => countRow(line, line.kind === primaryKind, true))}
          </VStack>
        ) : (
          <Text modifiers={[font({ textStyle: 'subheadline' })]}>{statusLine}</Text>
        )}
        <Spacer />
      </HStack>
    );
  }

  const systemRows = hasCounts ? (
    // The Home Screen families keep the four rows inside one fixed card height,
    // so the medium row and the small square run them tighter than the tall
    // large card, whose extra height affords the wider gap.
    <VStack alignment="leading" spacing={large ? 10 : 2}>
      {ledgerRows.map(line => countRow(line, line.kind === primaryKind, false))}
    </VStack>
  ) : (
    // Only the medium row draws a status this way; the square and the large
    // card centre theirs. `subheadline` so the line is not lost in the card.
    <Text modifiers={[font({ textStyle: 'subheadline' }), mutedForeground]}>{statusLine}</Text>
  );

  // The newest-session slot and the action row are Home Screen families only:
  // the Lock Screen families keep their generic layout, which is what the
  // snapshot privacy contract protects.
  //
  // The height is declared inside this function, not at module scope: the
  // widget transform stringifies this function's source alone and the widget
  // process evaluates it against widget globals, so a module-scope binding
  // would be a `ReferenceError` at render.
  const NEWEST_SLOT_HEIGHT = 16;
  const newestLine = props.newestTitle ?? null;
  const actions = props.actions ?? { approve: false, newAgent: false };
  // The slot is laid out whether or not it carries a line, so a title arriving
  // after a process restart, or an approve's progress line replacing it, moves
  // neither the count rows above nor the actions below.
  const newestSlot = (
    <VStack alignment="leading" spacing={0} modifiers={[frame({ height: NEWEST_SLOT_HEIGHT })]}>
      {newestLine === null ? null : (
        <Text
          modifiers={[
            font({ textStyle: square ? 'caption2' : 'caption' }),
            lineLimit(1),
            mutedForeground,
          ]}
        >
          {newestLine}
        </Text>
      )}
    </VStack>
  );

  // The patch a press returns marks the action in the pressed entry's props;
  // the app sweeps it up and runs it. `onPress` is the shared prop that
  // @expo/ui's widget Button turns into the native `onButtonPress` event the
  // widget bundle dispatches — the body keeps its own `widgetURL` deep link for
  // taps beside the buttons. `WidgetButton` is the narrow local view of the
  // shared Button whose `onPress` carries the patch the bundle reads; the
  // shared `onPress: () => void` type would forbid the value-returning handler
  // the widget press depends on.
  //
  // Approve answers in place, so its intent stays in the background. New agent
  // needs the composer: `openAppWhenRun` selects the foregrounding intent in
  // the patched expo-widgets button view, so the tap brings Kilo up and the
  // app's press listener opens the new-session screen. Without it the intent
  // only marked the timeline, and nothing happened until the next launch. It
  // is a prop of that view, not of `@expo/ui`'s `Button`, so it travels as the
  // plain extra prop the widget process serialises with the rest.
  const WidgetButton = Button as (props: WidgetButtonProps) => React.JSX.Element;
  const openButtonProps = { openAppWhenRun: true };
  // `regular` is the tall card's centred empty composition, whose mark and
  // status line scale up with the card; every count-bearing family takes the
  // small control.
  const actionButtons = (size: 'small' | 'regular') => (
    <HStack alignment="center" spacing={8}>
      {actions.approve ? (
        <WidgetButton
          label={COPY.approve}
          modifiers={[
            buttonStyle('borderedProminent'),
            controlSize(size),
            font({ textStyle: size === 'small' ? 'caption' : 'body' }),
          ]}
          onPress={() => ({ pendingAction: 'approve' })}
        />
      ) : null}
      {actions.newAgent ? (
        <WidgetButton
          {...openButtonProps}
          label={COPY.newAgent}
          modifiers={[
            buttonStyle('bordered'),
            controlSize(size),
            font({ textStyle: size === 'small' ? 'caption' : 'body' }),
          ]}
          onPress={() => ({ pendingAction: 'new-agent' })}
        />
      ) : null}
    </HStack>
  );

  // Home Screen text cannot grow without bound: the four count rows, the
  // reserved slot and the action row share one fixed card height, so the small
  // square and the medium row cap growth at the default body size and the tall
  // large card caps at an accessibility size. The factory is read off the
  // widget global, not the imported binding: the stringified layout is
  // evaluated in the widget process against widget globals, and the vitest
  // swift-ui mock does not list `dynamicTypeSize`, so the import is only a type
  // and a missing factory (an older `@expo/ui`, or the test harness) simply
  // leaves the text uncapped.
  const typeCeiling = family === 'systemLarge' ? 'accessibility2' : 'large';
  const widgetGlobals = globalThis as typeof globalThis & {
    dynamicTypeSize?: typeof dynamicTypeSize;
  };
  const typeCap = widgetGlobals.dynamicTypeSize;
  const typeModifiers = typeCap === undefined ? [] : [typeCap({ max: typeCeiling })];
  const systemModifiers = [
    widgetURL('kiloapp:///cloud/sessions'),
    containerBackground(PlatformColor('systemBackground'), 'widget'),
    ...typeModifiers,
    ...a11y,
  ];

  // The large card's lower third. A stale frame keeps the counts but drops the
  // claim that they are current, so the footer prefers the delayed copy where
  // the relative time would otherwise assert a freshness the snapshot no
  // longer has.
  const newestResultKind = props.newestResultKind ?? null;
  const newestResultLabel = props.newestResultLabel ?? null;
  const newestResultAt = props.newestResultAt ?? null;
  const newestResultBody = () => {
    if (statusLine !== null) {
      return (
        <Text modifiers={[font({ textStyle: 'footnote' }), mutedForeground]}>{statusLine}</Text>
      );
    }
    if (newestResultKind === null || newestResultLabel === null || newestResultAt === null) {
      return null;
    }
    return (
      <HStack alignment="center" spacing={6}>
        <Image
          systemName={glyphFor(newestResultKind).icon}
          color={glyphFor(newestResultKind).color}
          size={13}
        />
        <Text
          modifiers={[
            font({ textStyle: 'subheadline', weight: 'semibold' }),
            lineLimit(1),
            primaryForeground,
          ]}
        >
          {newestResultLabel}
        </Text>
        <Spacer />
        <Text
          date={new Date(newestResultAt)}
          // `ago` words the age as a past reference ("3 minutes ago"), the way
          // the Android widget and the session list read it; a bare duration
          // there reads as one still running.
          dateStyle="ago"
          modifiers={[
            font({ textStyle: 'subheadline' }),
            monospacedDigit(),
            lineLimit(1),
            mutedForeground,
          ]}
        />
      </HStack>
    );
  };

  // The locked frames draw their status line through `systemRows` instead, so
  // the footer is absent entirely there rather than repeating that copy.
  const footerBody = newestResultBody();
  const newestResultFooter =
    !hasCounts || footerBody === null ? null : (
      <VStack alignment="leading" spacing={4}>
        <Text modifiers={[font({ textStyle: 'footnote' }), mutedForeground]}>
          {COPY.newestResult}
        </Text>
        {footerBody}
      </VStack>
    );

  const hasAction = actions.approve || actions.newAgent;

  // A state with no counts (empty, signed out, waiting, locked, expired) in
  // the square and the tall card: one centred composition — the mark, the
  // status line, and New agent when offered — instead of one line stuck in a
  // corner of a blank card. The tall card scales the mark, the status line and
  // the control up with its height, or the composition reads as a stamp in a
  // big card.
  if (!hasCounts && (large || square)) {
    return (
      <VStack alignment="center" spacing={large ? 18 : 8} modifiers={systemModifiers}>
        <Spacer />
        {logo(large ? 56 : 28)}
        <Text
          modifiers={[
            font({ textStyle: large ? 'title3' : 'footnote' }),
            multilineTextAlignment('center'),
            lineLimit(2),
            mutedForeground,
          ]}
        >
          {statusLine}
        </Text>
        {hasAction ? actionButtons(large ? 'regular' : 'small') : null}
        <Spacer />
      </VStack>
    );
  }

  // StandBy draws this family on a charging phone in landscape. A header row
  // holds the mark and the action, the count rows sit in the middle at a size
  // that fills the card, and the newest result owns the bottom. An Approve in
  // flight or failed says so under its button: the large card has no reserved
  // slot for it. The spacers hold the rows in place as the footer appears and
  // disappears, so a state change cannot shift the counts.
  const actionLine = props.actionLine ?? null;
  if (large) {
    return (
      <VStack alignment="leading" spacing={0} modifiers={systemModifiers}>
        <HStack alignment="center" spacing={8} modifiers={[frame({ minHeight: 30 })]}>
          {logo(28)}
          <Spacer />
          {hasAction ? actionButtons('small') : null}
        </HStack>
        {actionLine === null ? null : (
          <HStack alignment="center" spacing={0}>
            <Spacer />
            <Text modifiers={[font({ textStyle: 'footnote' }), lineLimit(1), mutedForeground]}>
              {actionLine}
            </Text>
          </HStack>
        )}
        <Spacer />
        {systemRows}
        <Spacer />
        {newestResultFooter}
      </VStack>
    );
  }

  // The medium family is wide, not tall: the mark sits beside the rows and the
  // whole block centres, the same composition as the Live Activity banner. A
  // vertical layout there left the right half of the card empty. The body
  // column's spacing is tightened so the four rows, the reserved slot and the
  // action row stay inside the card's ~126 pt content box.
  if (wide) {
    return (
      <HStack alignment="center" spacing={12} modifiers={systemModifiers}>
        {logo(28)}
        <VStack alignment="leading" spacing={3}>
          {systemRows}
          {hasCounts ? newestSlot : null}
          {hasAction ? actionButtons('small') : null}
        </VStack>
      </HStack>
    );
  }

  // The small square is the tightest Home Screen family: four count rows, the
  // reserved slot and the action row fill its ~126 pt content box, so the mark
  // sits beside the body rather than above it. A label too long for the square
  // takes the mark's width instead.
  return (
    <HStack alignment="center" spacing={8} modifiers={systemModifiers}>
      {crowdedRows ? null : logo(18)}
      <VStack alignment="leading" spacing={3}>
        {systemRows}
        {newestSlot}
        {hasAction ? actionButtons('small') : null}
      </VStack>
    </HStack>
  );
};

export const WIDGET_NAME = 'ActiveAgentsWidget';

/**
 * The unpatched layout function, exported for unit tests: under vitest no
 * widget transform runs, so this still holds the real function, and the
 * unpatched copy token parses to an empty copy (see the COPY fallback above).
 * Registration wraps it with `withGlanceableCopy(withWidgetLogo(...))`.
 */
export const activeAgentsWidgetLayout = layout;

const registerLayout = () =>
  createWidget<WidgetProps>(WIDGET_NAME, withGlanceableCopy(withWidgetLogo(layout)));

export const ActiveAgentsWidget = registerLayout();

/**
 * Re-bake the stored layout in the active language. Only the gallery
 * placeholder reads this copy — a placed widget gets translated copy through
 * its timeline props — but the placeholder is the first thing the user sees in
 * the widget picker, so it must not stay English after a language change.
 */
export function refreshActiveAgentsWidgetCopy(): void {
  registerLayout();
}
