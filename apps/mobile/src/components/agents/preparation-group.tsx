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
  preparationErrorText,
  preparationStepLabel,
} from './preparation-copy';
import {
  failedStageStep,
  findRestoreIncompleteStep,
  incompleteRestoreText,
  preparationGroupExpandedByDefault,
} from './preparation-group-state';

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
  const title = groupTitle(attempt, incompleteReport !== undefined, t);
  const alertText = groupAlertText(attempt, incompleteReport, t);
  // The incomplete-restore step is the report the body already shows, so the
  // group does not list it a second time under its own status name.
  const steps =
    incompleteReport === undefined
      ? attempt.steps
      : attempt.steps.filter(step => step.id !== findRestoreIncompleteStep(attempt)?.id);
  return (
    <View className="mx-4 my-2 overflow-hidden rounded-md border border-border bg-card">
      <Pressable
        onPress={() => {
          setExpanded(value => !value);
        }}
        accessibilityRole="button"
        accessibilityLabel={title}
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
          {title}
        </Text>
      </Pressable>
      {expanded && (
        <View className="gap-2 border-t border-border px-3 py-2">
          {alertText !== undefined ? (
            <Text selectable className="text-sm text-destructive">
              {alertText}
            </Text>
          ) : null}
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
}: {
  status: PreparationAttempt['status'];
  incomplete: boolean;
}) {
  const colors = useThemeColors();
  if (incomplete) {
    return <AlertCircle size={16} color={colors.destructive} />;
  }
  if (status === 'running') {
    return <ActivityIndicator size="small" color={colors.mutedForeground} />;
  }
  if (status === 'completed') {
    return <Check size={16} color={colors.good} />;
  }
  return <AlertCircle size={16} color={colors.destructive} />;
}

/**
 * The warning line the expanded body opens with: the restore report when the
 * attempt carries one, otherwise the attempt's own failure sentence. The header
 * never repeats it, so a cause with no stage is still readable in full.
 */
function groupAlertText(
  attempt: PreparationAttempt,
  incompleteReport: string | undefined,
  t: TFunction
): string | undefined {
  if (incompleteReport !== undefined) {
    return incompleteReport;
  }
  if (attempt.safeError === undefined || attempt.safeError === '') {
    return undefined;
  }
  return preparationErrorText(attempt.safeError, t);
}

/**
 * A group's header line, kept short enough for one row: the restore status when
 * the attempt carries one, otherwise the attempt's own state. A failed attempt
 * names the stage that failed, so the header never restates the cause the body
 * carries.
 */
function groupTitle(attempt: PreparationAttempt, incomplete: boolean, t: TFunction): string {
  if (incomplete) {
    return t('agentChat.preparation.stepRestoreIncomplete');
  }
  if (attempt.status === 'running') {
    return t('agentChat.preparation.preparingEnvironment');
  }
  if (attempt.status === 'completed') {
    return t('agentChat.preparation.preparationComplete');
  }
  const stage = failedStageStep(attempt);
  if (stage !== undefined) {
    return t('agentChat.preparation.preparationStageFailed', {
      stage: setupCommandLabel(stage, t) ?? preparationStepLabel(stage, t),
    });
  }
  return t('agentChat.preparation.preparationFailed');
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
          <DetailsIcon size={14} color={colors.mutedForeground} />
        ) : (
          <View className="w-3.5" />
        )}
        {step.kind === 'setup_command' ? (
          <Terminal size={14} color={colors.mutedForeground} />
        ) : (
          <AttemptIcon
            status={step.status}
            incomplete={step.safeError !== undefined && step.safeError !== ''}
          />
        )}
        <Text className="min-w-0 flex-1 text-sm" numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
      {expanded && hasDetails ? (
        <View className="gap-2 border-t border-border px-3 py-2">
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
      ) : null}
    </View>
  );
}
