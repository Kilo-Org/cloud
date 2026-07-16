import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { AlertCircle, Check, ChevronRight, Terminal } from 'lucide-react-native';
import { type PreparationAttempt, type PreparationStepSnapshot } from 'cloud-agent-sdk';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function PreparationGroup({ attempt }: { attempt: PreparationAttempt }) {
  const [expanded, setExpanded] = useState(attempt.status !== 'completed');
  const colors = useThemeColors();
  useEffect(() => {
    setExpanded(attempt.status !== 'completed');
  }, [attempt.id, attempt.status]);
  const title = attemptTitle(attempt.status);
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
        <ChevronRight
          size={16}
          color={colors.mutedForeground}
          style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}
        />
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

function attemptTitle(status: PreparationAttempt['status']): string {
  if (status === 'running') {
    return 'Preparing environment';
  }
  if (status === 'completed') {
    return 'Preparation complete';
  }
  return 'Preparation failed';
}

function PreparationStepRow({ step }: { step: PreparationStepSnapshot }) {
  const [expanded, setExpanded] = useState(step.status !== 'completed');
  const colors = useThemeColors();
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
  const label =
    step.kind === 'setup_command' && step.commandIndex !== undefined
      ? `Setup command ${step.commandIndex + 1}${step.commandCount ? ` of ${step.commandCount}` : ''}`
      : step.label;
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
          <ChevronRight
            size={14}
            color={colors.mutedForeground}
            style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}
          />
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
            <Text className="text-xs text-muted-foreground">Exit code: {step.exitCode}</Text>
          ) : null}
          {step.outputTail ? (
            <>
              {step.outputTruncated ? (
                <Text className="text-xs text-muted-foreground">Earlier output omitted</Text>
              ) : null}
              <Text selectable className="rounded bg-secondary p-2 font-mono text-xs">
                {step.outputTail}
              </Text>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
