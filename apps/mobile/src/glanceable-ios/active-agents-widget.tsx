/* eslint-disable max-lines -- the 'widget' layout function is stringified whole, so its helpers cannot be extracted to module scope; every family stays in one function */
import { Button, type ButtonProps, HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityLabel,
  buttonStyle,
  containerBackground,
  controlSize,
  cornerRadius,
  environment,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  monospacedDigit,
  resizable,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';
import { PlatformColor } from 'react-native';

import { withGlanceableCopy } from './layout-copy';
import { type GlanceableWidgetAction, type GlanceableWidgetProps } from './view-props';
import { withWidgetLogo } from './widget-logo';

/* eslint-disable new-cap -- PlatformColor is a React Native factory */

export type WidgetProps = GlanceableWidgetProps;
type WidgetPressPatch = { pendingAction: GlanceableWidgetAction; pendingApprovalKey?: string };
type WidgetButtonProps = Omit<ButtonProps, 'onPress'> & {
  onPress?: () => WidgetPressPatch;
};

// Everything this stringified function uses must be a widget global or a builtin.
const layout = (props: WidgetProps, widgetEnvironment: WidgetEnvironment): React.JSX.Element => {
  'widget';

  // Both literals are replaced after Babel stringifies this function.
  // eslint-disable-next-line typescript-eslint/no-inferrable-types -- replaced source literal
  const copySource: string = '__KILO_GLANCEABLE_COPY__';
  const COPY = JSON.parse(copySource.startsWith('{') ? copySource : '{}') as Record<string, string>;
  // eslint-disable-next-line typescript-eslint/no-inferrable-types -- replaced source literal
  const logoUri: string = '__KILO_WIDGET_LOGO_URI__';
  const digits = COPY.digits ?? '';
  const count = (value: number) => {
    const text = String(value);
    return digits.length === 10
      ? // eslint-disable-next-line unicorn/prefer-spread -- `replaceAll` and a spread both failed in the widget process; this form is the one verified on device
        text
          .split('')
          .map(character => (/[0-9]/.test(character) ? digits[Number(character)] : character))
          .join('')
      : text;
  };
  const labels = {
    needsInput: COPY.needsInput ?? 'Needs input',
    running: COPY.running ?? 'Working',
    scheduled: COPY.scheduled ?? 'Scheduled',
    idle: COPY.idle ?? 'Idle',
  };
  const glyphs = {
    needsInput: { icon: 'exclamationmark.circle.fill', color: PlatformColor('systemOrange') },
    running: { icon: 'circle.fill', color: PlatformColor('systemGreen') },
    scheduled: { icon: 'clock', color: PlatformColor('label') },
    idle: { icon: 'circle', color: PlatformColor('label') },
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
  const primaryForeground = foregroundStyle(PlatformColor('label'));
  const mutedForeground = foregroundStyle(PlatformColor('secondaryLabel'));
  const localeModifier = environment({ key: 'locale', value: COPY.locale ?? 'en' });
  const bodyURL = widgetURL('kiloapp:///cloud/sessions');
  const genericA11y = [
    localeModifier,
    accessibilityElement('combine'),
    accessibilityLabel(safeText(props.accessibilityLabel) ?? ''),
  ];
  const family = widgetEnvironment.widgetFamily;

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

  // Accessories deliberately ignore Home titles, feedback and retained work.
  const genericKind = kindOf(props.primaryKind);
  const genericCount = safeCount(props.primaryCount);
  const genericStatus = safeText(props.statusLine) ?? COPY.signed_out ?? 'Sign in to see agents';
  const genericLabel =
    safeText(props.primaryLabel) ?? (genericKind === null ? '' : labels[genericKind]);
  if (family === 'accessoryCircular') {
    return (
      <VStack alignment="center" spacing={0} modifiers={[bodyURL, ...genericA11y]}>
        {genericKind === null ? (
          <Image systemName={statusGlyph} size={24} />
        ) : (
          <Image systemName={glyphs[genericKind].icon} size={15} />
        )}
        {genericKind === null ? null : (
          <Text
            modifiers={[
              font({ textStyle: 'title2', weight: 'bold' }),
              monospacedDigit(),
              lineLimit(1),
            ]}
          >
            {count(genericCount)}
          </Text>
        )}
      </VStack>
    );
  }
  if (family === 'accessoryInline') {
    return (
      <HStack spacing={4} modifiers={[bodyURL, ...genericA11y]}>
        {genericKind === null ? null : <Image systemName={glyphs[genericKind].icon} size={12} />}
        <Text modifiers={[lineLimit(1)]}>
          {genericKind === null ? genericStatus : `${count(genericCount)} ${genericLabel}`}
        </Text>
      </HStack>
    );
  }
  if (family === 'accessoryRectangular') {
    const rows = (Array.isArray(props.countLines) ? props.countLines : [])
      .filter(
        row =>
          // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- the widget process reads raw app-group JSON, not the typed props vitest renders
          row !== null &&
          // eslint-disable-next-line anti-slop/no-runtime-typeof -- the widget process reads raw app-group JSON, not the typed props vitest renders
          typeof row === 'object' &&
          kindOf(row.kind) !== null &&
          safeCount(row.count) > 0
      )
      .slice(0, 2);
    return (
      <VStack alignment="leading" spacing={3} modifiers={[bodyURL, ...genericA11y]}>
        <Text modifiers={[font({ textStyle: 'caption', weight: 'semibold' })]}>Kilo</Text>
        {rows.length === 0 ? (
          <Text modifiers={[font({ textStyle: 'caption' }), lineLimit(2)]}>{genericStatus}</Text>
        ) : (
          rows.map(row => (
            <HStack key={row.kind} spacing={5}>
              <Image systemName={glyphs[kindOf(row.kind) ?? 'idle'].icon} size={11} />
              <Text
                modifiers={[
                  font({ textStyle: 'caption', weight: 'semibold' }),
                  monospacedDigit(),
                  layoutPriority(1),
                ]}
              >
                {count(safeCount(row.count))}
              </Text>
              <Text modifiers={[font({ textStyle: 'caption' }), lineLimit(1)]}>
                {safeText(row.label) ?? labels[kindOf(row.kind) ?? 'idle']}
              </Text>
            </HStack>
          ))
        )}
      </VStack>
    );
  }

  const primaryKind = home === undefined ? genericKind : kindOf(home.primaryKind);
  const primaryCount = home === undefined ? genericCount : safeCount(home.primaryCount);
  const status = home?.status ?? (genericKind === null ? 'signed_out' : 'content');
  const content = status === 'content' && primaryKind !== null;
  const stale = home?.stale === true;
  const primaryLabel = primaryKind === null ? '' : labels[primaryKind];
  let statusLabel = COPY.signed_out ?? genericStatus;
  if (status === 'empty') {
    statusLabel = COPY.homeEmpty ?? 'Nothing running right now';
  } else if (status === 'waiting') {
    statusLabel = COPY.waiting ?? 'Checking agents';
  } else if (status === 'privacy' || status === 'unavailable') {
    statusLabel = COPY.privacy ?? 'Open Kilo to see agents';
  }
  const scheduledAt = validDate(home?.scheduledAt ?? props.scheduledAt);
  const checkedAt = validDate(home?.checkedAt);
  const awaitingUpdate = home?.awaitingUpdate === true;
  const actionLine = content ? safeText(props.actionLine) : null;
  const title = filledText(home === undefined ? props.newestTitle : home.primaryTitle);
  let secondarySource: readonly { kind: string; count: number }[] = [];
  if (Array.isArray(home?.secondaryCounts)) {
    secondarySource = home.secondaryCounts;
  } else if (home === undefined && Array.isArray(props.countLines)) {
    secondarySource = props.countLines;
  }
  const secondaryRows = secondarySource
    .filter(
      row =>
        content &&
        // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- the widget process reads raw app-group JSON, not the typed props vitest renders
        row !== null &&
        // eslint-disable-next-line anti-slop/no-runtime-typeof -- the widget process reads raw app-group JSON, not the typed props vitest renders
        typeof row === 'object' &&
        kindOf(row.kind) !== null &&
        safeCount(row.count) > 0 &&
        row.kind !== primaryKind
    )
    .slice(0, 3);
  const canCreate =
    home === undefined
      ? props.actions?.newAgent === true
      : // eslint-disable-next-line typescript-eslint/no-unnecessary-boolean-literal-compare -- the widget process reads raw app-group JSON, not the typed props vitest renders
        (status === 'content' || status === 'empty') && home.canCreate === true;
  const approvalKey = home === undefined ? null : safeText(home.approvalKey);
  const canApprove = content && home?.canApprove === true && approvalKey !== null;
  const large = family === 'systemLarge';
  const wide = family === 'systemMedium';
  const square = !large && !wide;
  const waitingAgents = (Array.isArray(home?.waitingAgents) ? home.waitingAgents : [])
    // eslint-disable-next-line anti-slop/no-runtime-typeof, typescript-eslint/no-unnecessary-condition -- the widget process reads raw app-group JSON, not the typed props vitest renders
    .filter(row => row !== null && typeof row === 'object')
    .slice(0, 3);
  const scheduledAgents = (Array.isArray(home?.scheduledAgents) ? home.scheduledAgents : [])
    // eslint-disable-next-line anti-slop/no-runtime-typeof, typescript-eslint/no-unnecessary-condition -- the widget process reads raw app-group JSON, not the typed props vitest renders
    .filter(row => row !== null && typeof row === 'object')
    .slice(0, 3);
  const detailSource = waitingAgents.length > 0 ? waitingAgents : scheduledAgents;
  const detailRows = content ? detailSource : [];
  // Medium prints up to two entry rows in its right column; large prints up to
  // three below the count band. Both draw the same title + wait-kind row.
  const mediumRows = wide ? detailRows.slice(0, 2) : [];
  const WidgetButton = Button as (props: WidgetButtonProps) => React.JSX.Element;
  const foregroundIntent = { openAppWhenRun: true };
  const modifiers = [
    bodyURL,
    containerBackground(PlatformColor('systemBackground'), 'widget'),
    localeModifier,
  ];
  const today = widgetEnvironment.date instanceof Date ? widgetEnvironment.date : new Date();
  const wakeTime = (date: Date, stacked = false) => {
    const day =
      date.toDateString() === today.toDateString() ? null : (
        <Text
          date={date}
          dateStyle="date"
          modifiers={[font({ textStyle: 'caption2' }), lineLimit(1), mutedForeground]}
        />
      );
    const time = (
      <Text
        date={date}
        dateStyle="time"
        modifiers={[
          font({ textStyle: 'caption2' }),
          lineLimit(1),
          monospacedDigit(),
          mutedForeground,
        ]}
      />
    );
    return stacked ? (
      <VStack alignment="leading" spacing={0}>
        {day}
        {time}
      </VStack>
    ) : (
      <HStack spacing={4}>
        {day}
        {time}
      </HStack>
    );
  };
  const supportLine = () => {
    if (actionLine !== null) {
      return (
        <Text modifiers={[font({ textStyle: 'caption' }), lineLimit(1), primaryForeground]}>
          {actionLine}
        </Text>
      );
    }
    if (content && primaryKind === 'scheduled') {
      if (awaitingUpdate || scheduledAt === null) {
        return (
          <Text modifiers={[font({ textStyle: 'caption' }), lineLimit(1), mutedForeground]}>
            {COPY.awaitingUpdate ?? 'Awaiting update'}
          </Text>
        );
      }
      return (
        <HStack spacing={4}>
          {large ? (
            <Text modifiers={[font({ textStyle: 'caption' }), lineLimit(1), mutedForeground]}>
              {COPY.nextRun ?? 'Next run'}
            </Text>
          ) : null}
          {wakeTime(scheduledAt, !large)}
        </HStack>
      );
    }
    if (content && large && primaryKind === 'needsInput') {
      return (
        <Text modifiers={[font({ textStyle: 'caption' }), lineLimit(1), mutedForeground]}>
          {COPY.waitingForYou ?? 'Waiting for you'}
        </Text>
      );
    }
    if (title !== null && content) {
      return (
        <Text
          modifiers={[font({ textStyle: 'caption' }), lineLimit(square ? 2 : 1), mutedForeground]}
        >
          {title}
        </Text>
      );
    }
    if (secondaryRows[0] !== undefined && square) {
      return (
        <Text
          modifiers={[font({ textStyle: 'caption' }), lineLimit(1), mutedForeground]}
        >{`${count(safeCount(secondaryRows[0].count))} ${labels[kindOf(secondaryRows[0].kind) ?? 'idle']}`}</Text>
      );
    }
    let fallbackLine = COPY.openAgents ?? 'Open agents';
    if (!content && status === 'empty') {
      fallbackLine = COPY.newAgent ?? 'New agent';
    } else if (!content && status === 'waiting') {
      fallbackLine = COPY.awaitingUpdate ?? 'Awaiting update';
    }
    return (
      <Text modifiers={[font({ textStyle: 'caption' }), lineLimit(1), mutedForeground]}>
        {fallbackLine}
      </Text>
    );
  };
  const supportSlot = (
    <VStack
      alignment="leading"
      spacing={0}
      modifiers={[frame({ minHeight: large ? 20 : 26, maxWidth: 10_000, alignment: 'leading' })]}
    >
      {supportLine()}
    </VStack>
  );
  const heroDigits = String(primaryCount).length;
  // The rounded digit glyph is about 0.65em wide, so this keeps the widest count
  // inside the 122pt hero column of the width-limited families.
  const heroCap = Math.max(24, Math.floor(120 / (0.65 * heroDigits)));
  let heroSize = 40;
  if (heroDigits > 9) {
    heroSize = 16;
  } else if (heroDigits > 6) {
    heroSize = 22;
  } else if (heroDigits > 4) {
    heroSize = 26;
  } else if (large) {
    heroSize = 48;
  } else if (square) {
    heroSize = 26;
  }
  // A large card owes its body a whole composition rather than a full top block and
  // a hole above the footer. It prints four blocks — the header, one hero block (the
  // count, its label and the support line), the entry rows and the footer — with a
  // spacer of the same height between each. Two flexible spacers split their
  // remainder by their own interior rules, which is what left ~22pt more above the
  // footer than below the header, so the height is arithmetic here instead.
  const entryCount = large ? detailRows.length : 0;
  // Three entry rows share one band and step up a smaller slot so the count keeps
  // its size; a lone row has no pitch to read and can afford the room.
  let entryHeight = 40;
  if (large && entryCount === 1) {
    entryHeight = 44;
  } else if (large && entryCount === 3) {
    entryHeight = 34;
  }
  // A scheduled agent with no usable wake time draws a single line where a waiting
  // agent draws the title and its wait, so those rows must be counted shorter or
  // their frames pad the block into gaps.
  const shortRows = large
    ? detailRows.filter(row => !('scheduledAt' in row) && !('kind' in row)).length
    : 0;
  const rowsHeight =
    entryCount === 0
      ? 0
      : (entryCount - shortRows) * entryHeight + shortRows * 18 + (entryCount - 1) * 10;
  const rowMinHeight = (row: (typeof detailRows)[number]) =>
    'scheduledAt' in row || 'kind' in row ? entryHeight : 18;
  // Only a stale card's footer is two lines: "Last known" over "Checked".
  // A card with no checked time still anchors its bottom — the waiting card prints
  // the surface's own affordance there — while a locked card keeps its copy in the
  // hero alone, because repeating "Open agents" under it read as a duplicate.
  const lockedState = status === 'privacy' || status === 'unavailable' || status === 'signed_out';
  const footerNote = checkedAt === null && !lockedState ? (COPY.openAgents ?? 'Open agents') : null;
  let footerHeight = stale ? 28 : 24;
  if (checkedAt === null) {
    footerHeight = footerNote === null ? 0 : 24;
  }

  // With no entry rows there are two interior gaps, not three, so they take the
  // thirds the rows would have split.
  const gapCount = entryCount === 0 ? 2 : 3;
  const gapBase = 14;
  // What is left of the large card's ~328pt body once the fixed parts are placed:
  // the 28pt header, the label's single 21pt line, the 20pt support slot, the rows,
  // the footer and the gaps. The count's 1.2em line box fills the rest.
  const countBudget = 328 - 28 - 21 - 20 - rowsHeight - footerHeight - gapCount * gapBase;
  if (large) {
    heroSize = Math.max(18, Math.min(heroCap, Math.floor(countBudget / 1.2)));
  }
  const secondaryHeight =
    secondaryRows.length === 0 ? 0 : secondaryRows.length * 15 + (secondaryRows.length - 1) * 7;
  // Equal gaps; a count capped for a wide number hands its leftover to them rather
  // than leaving one hole.
  const largeGap = large
    ? gapBase +
      Math.floor(Math.max(0, countBudget - Math.max(heroSize * 1.2, secondaryHeight)) / gapCount)
    : gapBase;
  let heroMinHeight = 61;
  if (large) {
    heroMinHeight = 80;
  } else if (square) {
    heroMinHeight = 44;
  }
  let heroValue = '—';
  if (content) {
    heroValue = count(primaryCount);
  } else if (status === 'empty') {
    heroValue = '0';
  }
  const heroNumber = (
    <Text
      modifiers={[
        font({ size: heroSize, weight: 'bold', design: 'rounded' }),
        monospacedDigit(),
        lineLimit(1),
        primaryForeground,
        accessibilityLabel(content ? `${count(primaryCount)} ${primaryLabel}` : statusLabel),
      ]}
    >
      {heroValue}
    </Text>
  );
  // The large card prints the label across the full card width, so it is always one
  // known 21pt line and the count above it can be sized to fill the body exactly.
  const heroLabel = (
    <Text
      modifiers={[
        font({ textStyle: large ? 'headline' : 'caption', weight: 'semibold' }),
        lineLimit(square || large ? 1 : 2),
        primaryForeground,
      ]}
    >
      {content ? primaryLabel : statusLabel}
    </Text>
  );
  const hero = (
    <VStack
      alignment="leading"
      spacing={0}
      modifiers={[
        frame({
          minHeight: heroMinHeight,
          maxWidth: wide || large ? 122 : 10_000,
          alignment: 'leading',
        }),
      ]}
    >
      {heroNumber}
      {heroLabel}
    </VStack>
  );
  const secondary = (
    <VStack alignment="leading" spacing={large ? 7 : 1}>
      {secondaryRows.map(row => (
        <HStack key={row.kind} spacing={6}>
          <Image
            systemName={glyphs[kindOf(row.kind) ?? 'idle'].icon}
            size={12}
            color={glyphs[kindOf(row.kind) ?? 'idle'].color}
          />
          <Text
            modifiers={[
              font({ textStyle: large ? 'caption' : 'caption2', weight: 'semibold' }),
              monospacedDigit(),
              layoutPriority(1),
              primaryForeground,
            ]}
          >
            {count(safeCount(row.count))}
          </Text>
          <Text
            modifiers={[
              font({ textStyle: large ? 'caption' : 'caption2' }),
              lineLimit(1),
              mutedForeground,
            ]}
          >
            {labels[kindOf(row.kind) ?? 'idle']}
          </Text>
        </HStack>
      ))}
    </VStack>
  );
  // One entry row: the agent's title and why it waits, or when it wakes. The
  // large card prints up to three below the count band; the medium card prints
  // up to two in its right column, so a waiting agent is named without the
  // large card's height.
  const agentRow = (row: (typeof detailRows)[number], index: number, minHeight: number) => {
    const date = 'scheduledAt' in row ? validDate(row.scheduledAt) : null;
    let detailLine: React.JSX.Element | null = null;
    if ('scheduledAt' in row) {
      detailLine =
        date === null || date.getTime() <= today.getTime() ? (
          <Text modifiers={[font({ textStyle: 'caption2' }), lineLimit(1), mutedForeground]}>
            {COPY.awaitingUpdate ?? 'Awaiting update'}
          </Text>
        ) : (
          wakeTime(date)
        );
    } else if ('kind' in row) {
      let waitLine = COPY.waitingToRetry ?? 'Waiting to retry';
      if (row.kind === 'permission') {
        waitLine = COPY.permissionRequired ?? 'Permission required';
      } else if (row.kind === 'question') {
        waitLine = COPY.answerNeeded ?? 'Answer needed';
      }
      detailLine = (
        <Text modifiers={[font({ textStyle: 'caption2' }), lineLimit(1), mutedForeground]}>
          {waitLine}
        </Text>
      );
    }
    return (
      <VStack
        key={index}
        alignment="leading"
        spacing={3}
        modifiers={[frame({ minHeight, maxWidth: 10_000, alignment: 'leading' })]}
      >
        <HStack spacing={6}>
          <Image systemName={'scheduledAt' in row ? 'clock' : 'exclamationmark.circle'} size={12} />
          <Text modifiers={[font({ textStyle: 'caption' }), lineLimit(1), primaryForeground]}>
            {filledText(row.title) ?? filledText(COPY.agent) ?? 'Agent'}
          </Text>
        </HStack>
        {detailLine}
      </VStack>
    );
  };
  // The medium's right column: the waiting/scheduled rows when there are any,
  // otherwise the support counts and the support line. The layout cannot use a
  // fragment (only widget globals are in scope), so the fallback is two children.
  const wideRows =
    wide && mediumRows.length > 0 ? mediumRows.map((row, index) => agentRow(row, index, 0)) : null;
  const wideFallback = wide && mediumRows.length === 0;
  const headerRow = (
    <HStack alignment="center" spacing={5} modifiers={[frame({ height: large ? 28 : 24 })]}>
      {logoUri.length === 0 ? null : (
        <Image
          uiImage={logoUri}
          modifiers={[resizable(), frame({ width: 18, height: 18 }), cornerRadius(4)]}
        />
      )}
      <Text
        modifiers={[
          font({ textStyle: 'caption', weight: 'bold' }),
          lineLimit(1),
          primaryForeground,
        ]}
      >
        Kilo
      </Text>
      <Spacer />
      <HStack spacing={4} modifiers={[frame({ width: 24, height: 24 })]}>
        {canApprove ? (
          <WidgetButton
            modifiers={[
              buttonStyle('plain'),
              controlSize('small'),
              accessibilityLabel(COPY.approve ?? 'Approve'),
            ]}
            onPress={() => ({ pendingAction: 'approve', pendingApprovalKey: approvalKey })}
          >
            <Image systemName="checkmark.circle" size={21} color={PlatformColor('label')} />
          </WidgetButton>
        ) : null}
      </HStack>
      <HStack spacing={0} modifiers={[frame({ width: 24, height: 24 })]}>
        {canCreate ? (
          <WidgetButton
            {...foregroundIntent}
            modifiers={[
              buttonStyle('plain'),
              controlSize('small'),
              accessibilityLabel(COPY.newAgent ?? 'New agent'),
            ]}
            onPress={() => ({ pendingAction: 'new-agent' })}
          >
            <Image systemName="plus.circle.fill" size={23} color={PlatformColor('label')} />
          </WidgetButton>
        ) : null}
      </HStack>
    </HStack>
  );
  // The footer carries the freshness line, or — before the first snapshot, when
  // there is no time to print — the surface's own affordance, so the large card is
  // anchored at both ends instead of trailing off into a blank band.
  const footerNoteRow =
    footerNote === null ? null : (
      <Text modifiers={[font({ textStyle: 'caption2' }), lineLimit(1), mutedForeground]}>
        {footerNote}
      </Text>
    );
  const footerChecked =
    checkedAt === null ? null : (
      <VStack alignment="leading" spacing={0}>
        {stale ? (
          <Text modifiers={[font({ textStyle: 'caption2' }), lineLimit(1), mutedForeground]}>
            {COPY.lastKnown ?? 'Last known'}
          </Text>
        ) : null}
        <HStack spacing={4}>
          <Text modifiers={[font({ textStyle: 'caption2' }), lineLimit(1), mutedForeground]}>
            {COPY.checked ?? 'Checked'}
          </Text>
          {square ? (
            // A square card has no room for a relative phrase, and "Checked 3
            // hours…" ellipsised. The clock time fits and matches Android.
            wakeTime(checkedAt)
          ) : (
            <Text
              date={checkedAt}
              dateStyle="ago"
              modifiers={[
                font({ textStyle: 'caption2' }),
                lineLimit(1),
                monospacedDigit(),
                mutedForeground,
              ]}
            />
          )}
        </HStack>
      </VStack>
    );
  const footerContent = checkedAt === null ? footerNoteRow : footerChecked;
  const footerRow = (
    <VStack
      alignment="leading"
      spacing={0}
      modifiers={[frame({ height: footerHeight, alignment: 'topLeading' })]}
    >
      {footerContent}
    </VStack>
  );
  if (large) {
    return (
      <VStack alignment="leading" spacing={0} modifiers={modifiers}>
        {headerRow}
        <Spacer minLength={0} modifiers={[frame({ height: largeGap })]} />
        <HStack alignment="center" spacing={16}>
          {heroNumber}
          <VStack
            alignment="leading"
            spacing={7}
            modifiers={[frame({ maxWidth: 10_000, alignment: 'leading' })]}
          >
            {secondary}
          </VStack>
        </HStack>
        {heroLabel}
        {supportSlot}
        {entryCount === 0 ? null : (
          <Spacer minLength={0} modifiers={[frame({ height: largeGap })]} />
        )}
        <VStack alignment="leading" spacing={10}>
          {detailRows.map((row, index) => agentRow(row, index, rowMinHeight(row)))}
        </VStack>
        <Spacer minLength={0} modifiers={[frame({ height: largeGap })]} />
        {footerRow}
      </VStack>
    );
  }
  return (
    <VStack alignment="leading" spacing={2} modifiers={modifiers}>
      {headerRow}
      {wide ? (
        <HStack alignment="center" spacing={16}>
          {hero}
          <VStack
            alignment="leading"
            spacing={mediumRows.length > 0 ? 7 : 2}
            modifiers={[frame({ maxWidth: 10_000, alignment: 'leading' })]}
          >
            {wideRows}
            {wideFallback ? secondary : null}
            {wideFallback ? supportSlot : null}
          </VStack>
        </HStack>
      ) : (
        // A square card has one column: the hero and its line centre in the body
        // so the slack splits above and below instead of pooling in one hole.
        <VStack
          alignment="leading"
          spacing={0}
          modifiers={[frame({ maxWidth: 10_000, maxHeight: 10_000, alignment: 'leading' })]}
        >
          {hero}
          {supportSlot}
        </VStack>
      )}
      {wide ? <Spacer minLength={0} /> : null}
      {footerRow}
    </VStack>
  );
};

export const WIDGET_NAME = 'ActiveAgentsWidget';
export const activeAgentsWidgetLayout = layout;
const registerLayout = () =>
  createWidget<WidgetProps>(WIDGET_NAME, withGlanceableCopy(withWidgetLogo(layout)));
export const ActiveAgentsWidget = registerLayout();

export function refreshActiveAgentsWidgetCopy(): void {
  registerLayout();
}
