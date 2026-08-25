import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
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

export function PreparationGroup({ attempt }: { attempt: PreparationAttempt }) {
  const [expanded, setExpanded] = useState(attempt.status !== 'completed');
  const colors = useThemeColors();
  const { t } = useTranslation();
  useEffect(() => {
    setExpanded(attempt.status !== 'completed');
  }, [attempt.id, attempt.status]);
  const title = attemptTitle(attempt.status, t);
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
        <AttemptIcon status={attempt.status} />
        <Text className="text-sm font-medium">{title}</Text>
      </Pressable>
      {expanded && (
        <View className="gap-2 border-t border-border px-3 py-2">
          {attempt.safeError && attempt.steps.length === 0 ? (
            <Text selectable className="text-sm text-destructive">
              {attempt.safeError}
            </Text>
          ) : null}
          {attempt.steps.map(step => (
            <PreparationStepRow key={step.id} step={step} />
          ))}
        </View>
      )}
    </View>
  );
}

function AttemptIcon({ status }: { status: PreparationAttempt['status'] }) {
  const colors = useThemeColors();
  if (status === 'running') {
    return <ActivityIndicator size="small" color={colors.mutedForeground} />;
  }
  if (status === 'completed') {
    return <Check size={16} color={colors.good} />;
  }
  return <AlertCircle size={16} color={colors.destructive} />;
}

function attemptTitle(status: PreparationAttempt['status'], t: TFunction): string {
  if (status === 'running') {
    return t('agentChat.preparation.preparingEnvironment');
  }
  if (status === 'completed') {
    return t('agentChat.preparation.preparationComplete');
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
  const label = setupCommandLabel(step, t) ?? step.label;
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
          <AttemptIcon status={step.status} />
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
            <Text className="text-sm text-muted-foreground">{step.latestDetail}</Text>
          ) : null}
          {step.safeError ? (
            <Text selectable className="text-sm text-destructive">
              {step.safeError}
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
