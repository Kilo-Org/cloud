import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useTranslation } from 'react-i18next';
import { type TFunction } from 'i18next';
import { AlertCircle, Check, ChevronDown, Terminal } from '@/components/ui/icons';
import { type PreparationAttempt, type PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';

import { Text } from '@/components/ui/text';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { MonoScrollBlock } from './mono-scroll-block';
import {
  preparationDetailText,
  preparationErrorHeadline,
  preparationErrorText,
  preparationStepLabel,
} from './preparation-copy';
import {
  failedStageStep,
  findRestoreIncompleteStep,
  incompleteRestoreText,
  preparationGroupExpandedByDefault,
} from './preparation-group-state';

/** The caret column of a child row, shared by the caret and its empty slot. */
const STEP_CARET_SIZE = 14;
/** The status column of a child row: every drawn mark fits this box. */
const STEP_STATUS_SIZE = 16;

export function PreparationGroup({ attempt }: { attempt: PreparationAttempt }) {
  const { t } = useTranslation();
  const incompleteText = incompleteRestoreText(attempt);
  const incompleteReport =
    incompleteText === undefined ? undefined : preparationErrorText(incompleteText, t);
  const [expanded, setExpanded] = useState(() => preparationGroupExpandedByDefault(attempt));
  const colors = useThemeColors();
  useEffect(() => {
    setExpanded(attempt.status !== 'completed' || incompleteReport !== undefined);
  }, [attempt.id, attempt.status, incompleteReport]);
  const copy = groupCopy(attempt, incompleteReport, t);
  // The header names one step — the restore report, or the stage that failed —
  // so the body does not list that step under the same words again. It keeps
  // that step's own evidence instead, which the row would otherwise be the only
  // place to show.
  const steps =
    copy.namedStep === undefined
      ? attempt.steps
      : attempt.steps.filter(step => step.id !== copy.namedStep?.id);
  return (
    <View className="mx-4 my-2 overflow-hidden rounded-md border border-border bg-card">
      <Pressable
        onPress={() => {
          setExpanded(value => !value);
        }}
        accessibilityRole="button"
        accessibilityLabel={copy.title}
        accessibilityState={{ expanded }}
        className="flex-row items-center gap-2 px-3 py-3 active:bg-secondary"
      >
        {expanded ? (
          <ChevronDown size={16} color={colors.mutedForeground} />
        ) : (
          <DirectionalChevronRight size={16} color={colors.mutedForeground} />
        )}
        <AttemptIcon status={attempt.status} incomplete={incompleteReport !== undefined} />
        <Text
          numberOfLines={1}
          className={
            incompleteReport
              ? 'min-w-0 flex-1 text-sm font-medium text-destructive'
              : 'min-w-0 flex-1 text-sm font-medium'
          }
        >
          {copy.title}
        </Text>
      </Pressable>
      {expanded && (
        <View className="gap-2 border-t border-border px-3 py-2">
          {copy.detail !== undefined ? (
            <Text selectable className="text-sm text-destructive">
              {copy.detail}
            </Text>
          ) : null}
          {copy.namedStep === undefined ? null : <PreparationStepDetails step={copy.namedStep} />}
          {steps.map(step => (
            <PreparationStepRow key={step.id} step={step} />
          ))}
        </View>
      )}
    </View>
  );
}

function AttemptIcon({
  status,
  incomplete,
  spinnerSize = 20,
}: {
  status: PreparationAttempt['status'];
  incomplete: boolean;
  spinnerSize?: number;
}) {
  const colors = useThemeColors();
  if (incomplete) {
    return <AlertCircle size={16} color={colors.destructive} />;
  }
  if (status === 'running') {
    return <ActivityIndicator size={spinnerSize} color={colors.mutedForeground} />;
  }
  if (status === 'completed') {
    return <Check size={16} color={colors.good} />;
  }
  return <AlertCircle size={16} color={colors.destructive} />;
}

/** A group's header line, the body line under it, and the step it has named. */
type GroupCopy = {
  title: string;
  detail: string | undefined;
  namedStep: PreparationStepSnapshot | undefined;
};

/**
 * What a group's header says, and the step it has thereby already named. The
 * restore status owns both when the attempt carries it. Otherwise the header
 * states the attempt's own state: a failed attempt names the stage that failed,
 * and an attempt that failed before any stage ran takes the failure's own first
 * sentence as its title, which is what tells two of them apart, leaving the
 * rest of that sentence in the body.
 *
 * A named step's evidence is shown in the body instead of a repeated row, so
 * the body carries no separate cause line: the step's own error is that cause.
 */
function groupCopy(
  attempt: PreparationAttempt,
  incompleteReport: string | undefined,
  t: TFunction
): GroupCopy {
  if (incompleteReport !== undefined) {
    return {
      title: t('agentChat.preparation.stepRestoreIncomplete'),
      detail: undefined,
      namedStep: findRestoreIncompleteStep(attempt),
    };
  }
  if (attempt.status === 'running') {
    return {
      title: t('agentChat.preparation.preparingEnvironment'),
      detail: undefined,
      namedStep: undefined,
    };
  }
  if (attempt.status === 'completed') {
    return {
      title: t('agentChat.preparation.preparationComplete'),
      detail: undefined,
      namedStep: undefined,
    };
  }
  const stage = failedStageStep(attempt);
  if (stage !== undefined) {
    return {
      title: t('agentChat.preparation.preparationStageFailed', {
        stage: setupCommandLabel(stage, t) ?? preparationStepLabel(stage, t),
      }),
      detail: undefined,
      namedStep: stage,
    };
  }
  if (attempt.safeError === undefined || attempt.safeError === '') {
    return {
      title: t('agentChat.preparation.preparationFailed'),
      detail: undefined,
      namedStep: undefined,
    };
  }
  const sentence = preparationErrorHeadline(attempt.safeError, t);
  return { title: sentence.title, detail: sentence.detail, namedStep: undefined };
}

function setupCommandLabel(step: PreparationStepSnapshot, t: TFunction): string | null {
  if (step.kind !== 'setup_command' || step.commandIndex === undefined) {
    return null;
  }
  if (step.commandCount) {
    return t('agentChat.preparation.setupCommandOf', {
      index: formatNumber(step.commandIndex + 1, i18n.language),
      count: step.commandCount,
      displayCount: formatNumber(step.commandCount, i18n.language),
    });
  }
  return t('agentChat.preparation.setupCommand', {
    index: formatNumber(step.commandIndex + 1, i18n.language),
  });
}

function PreparationStepRow({ step }: { step: PreparationStepSnapshot }) {
  const [expanded, setExpanded] = useState(step.status !== 'completed');
  const colors = useThemeColors();
  const { t } = useTranslation();
  useEffect(() => {
    setExpanded(step.status !== 'completed');
  }, [step.id, step.status]);
  const hasDetails = [
    step.command,
    step.latestDetail,
    step.outputTail,
    step.safeError,
    step.exitCode,
  ].some(value => value !== undefined && value !== '');
  const label = setupCommandLabel(step, t) ?? preparationStepLabel(step, t);
  const DetailsIcon = expanded ? ChevronDown : DirectionalChevronRight;
  return (
    <View className="overflow-hidden rounded border border-border">
      <Pressable
        disabled={!hasDetails}
        onPress={() => {
          setExpanded(value => !value);
        }}
        accessibilityRole={hasDetails ? 'button' : undefined}
        accessibilityLabel={label}
        accessibilityState={hasDetails ? { expanded } : undefined}
        className="flex-row items-center gap-2 px-2 py-2.5 active:bg-secondary"
      >
        {hasDetails ? (
          <DetailsIcon size={STEP_CARET_SIZE} color={colors.mutedForeground} />
        ) : (
          // The caret column stays reserved at the caret's own width on a row
          // that cannot expand, so the status marks and labels of sibling rows
          // start at one inset.
          // eslint-disable-next-line react-native/no-inline-styles -- the slot must equal the caret's numeric size
          <View style={{ width: STEP_CARET_SIZE }} />
        )}
        {step.kind === 'setup_command' ? (
          <Terminal size={STEP_CARET_SIZE} color={colors.mutedForeground} />
        ) : (
          // A running step draws a spinner at the settled glyphs' own size, so
          // the status column keeps one width across rows.
          <AttemptIcon
            status={step.status}
            incomplete={step.safeError !== undefined && step.safeError !== ''}
            spinnerSize={STEP_STATUS_SIZE}
          />
        )}
        <Text className="min-w-0 flex-1 text-sm" numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
      {expanded && hasDetails ? <PreparationStepDetails step={step} divided /> : null}
    </View>
  );
}

/**
 * A step's own evidence: the command, the progress line, the failure, the exit
 * code and the tail. A row shows it under its header when expanded, and a group
 * whose header already names the step shows it on its own, so naming a step in
 * the header never hides what that step recorded.
 */
function PreparationStepDetails({
  step,
  divided = false,
}: {
  step: PreparationStepSnapshot;
  divided?: boolean;
}) {
  const { t } = useTranslation();
  const hasDetails = [
    step.command,
    step.latestDetail,
    step.outputTail,
    step.safeError,
    step.exitCode,
  ].some(value => value !== undefined && value !== '');
  if (!hasDetails) {
    return null;
  }
  return (
    <View className={divided ? 'gap-2 border-t border-border px-3 py-2' : 'gap-2'}>
      {step.command ? (
        <Text selectable className="rounded bg-secondary p-2 font-mono text-xs">
          {step.command}
        </Text>
      ) : null}
      {step.latestDetail ? (
        <Text className="text-sm text-muted-foreground">
          {preparationDetailText(step.latestDetail, t)}
        </Text>
      ) : null}
      {step.safeError ? (
        <Text selectable className="text-sm text-destructive">
          {preparationErrorText(step.safeError, t)}
        </Text>
      ) : null}
      {step.exitCode !== undefined ? (
        <Text className="text-xs text-muted-foreground">
          {t('agentChat.preparation.exitCode', { code: step.exitCode })}
        </Text>
      ) : null}
      {step.outputTail ? (
        <>
          {step.outputTruncated ? (
            <Text className="text-xs text-muted-foreground">
              {t('agentChat.preparation.earlierOutputOmitted')}
            </Text>
          ) : null}
          <MonoScrollBlock
            content={step.outputTail}
            containerClassName="rounded bg-secondary p-2"
            textClassName="text-foreground"
            inTranscript
          />
        </>
      ) : null}
    </View>
  );
}
