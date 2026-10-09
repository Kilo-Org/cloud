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

  // Accessories deliberately ignore Home titles, feedback and retained work.
  const genericKind = kindOf(props.primaryKind);
  const genericCount = safeCount(props.primaryCount);
  const genericStatus = safeText(props.statusLine) ?? COPY.signed_out ?? 'Sign in to see agents';
  const genericLabel =
    safeText(props.primaryLabel) ?? (genericKind === null ? '' : labels[genericKind]);
  if (family === 'accessoryCircular') {
    return (
      <VStack alignment="center" spacing={0} modifiers={[bodyURL, ...genericA11y]}>
        {genericKind === null ? null : <Image systemName={glyphs[genericKind].icon} size={15} />}
        <Text
          modifiers={[
            font({ textStyle: 'title2', weight: 'bold' }),
            monospacedDigit(),
            lineLimit(1),
          ]}
        >
          {genericKind === null ? '—' : count(genericCount)}
        </Text>
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

  // A placed widget can carry props from an older app. This compatibility path
  // only displays its existing values; freshness policy belongs to the shared builder.
  const rawHome = props.home;
  const home =
    // eslint-disable-next-line anti-slop/no-runtime-typeof, typescript-eslint/no-unnecessary-condition -- the widget process reads raw app-group JSON, not the typed props vitest renders
    rawHome !== null && typeof rawHome === 'object' ? rawHome : undefined;
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
        <Text modifiers={[font({ textStyle: 'caption' }), lineLimit(1), mutedForeground]}>
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
      modifiers={[frame({ height: large ? 20 : 26, alignment: 'leading' })]}
    >
      {supportLine()}
    </VStack>
  );
  const heroDigits = String(primaryCount).length;
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
      <Text
        modifiers={[
          font({ textStyle: large ? 'headline' : 'caption', weight: 'semibold' }),
          lineLimit(square ? 1 : 2),
          primaryForeground,
        ]}
      >
        {content ? primaryLabel : statusLabel}
      </Text>
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
  return (
    <VStack alignment="leading" spacing={large ? 8 : 2} modifiers={modifiers}>
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
      {wide || large ? (
        <HStack alignment="top" spacing={16}>
          {hero}
          <VStack
            alignment="leading"
            spacing={2}
            modifiers={[frame({ maxWidth: 10_000, alignment: 'leading' })]}
          >
            {secondary}
            {wide && primaryKind === 'scheduled' && title !== null ? (
              <Text modifiers={[font({ textStyle: 'caption2' }), lineLimit(1), mutedForeground]}>
                {title}
              </Text>
            ) : null}
            {wide ? supportSlot : null}
          </VStack>
        </HStack>
      ) : (
        <VStack alignment="leading" spacing={0}>
          {hero}
          {supportSlot}
        </VStack>
      )}
      {large ? supportSlot : null}
      {large ? (
        <VStack alignment="leading" spacing={7}>
          {detailRows.map((row, index) => {
            const date = 'scheduledAt' in row ? validDate(row.scheduledAt) : null;
            let detailLine: React.JSX.Element | null = null;
            if ('scheduledAt' in row) {
              detailLine =
                date === null || date.getTime() <= today.getTime() ? (
                  <Text
                    modifiers={[font({ textStyle: 'caption2' }), lineLimit(1), mutedForeground]}
                  >
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
                modifiers={[frame({ minHeight: 25, maxWidth: 10_000, alignment: 'leading' })]}
              >
                <HStack spacing={6}>
                  <Image
                    systemName={'scheduledAt' in row ? 'clock' : 'exclamationmark.circle'}
                    size={12}
                  />
                  <Text
                    modifiers={[font({ textStyle: 'caption' }), lineLimit(1), primaryForeground]}
                  >
                    {filledText(row.title) ?? filledText(COPY.agent) ?? 'Agent'}
                  </Text>
                </HStack>
                {detailLine}
              </VStack>
            );
          })}
        </VStack>
      ) : null}
      <Spacer minLength={0} />
      <VStack alignment="leading" spacing={0} modifiers={[frame({ height: 24 })]}>
        {checkedAt === null ? null : (
          <VStack alignment="leading" spacing={0}>
            <Text modifiers={[font({ textStyle: 'caption2' }), lineLimit(1), mutedForeground]}>
              {stale ? (COPY.lastKnown ?? 'Last known') : ''}
            </Text>
            <HStack spacing={4}>
              <Text modifiers={[font({ textStyle: 'caption2' }), lineLimit(1), mutedForeground]}>
                {COPY.checked ?? 'Checked'}
              </Text>
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
            </HStack>
          </VStack>
        )}
      </VStack>
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
