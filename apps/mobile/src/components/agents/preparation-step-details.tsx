import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { type PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { MonoScrollBlock } from './mono-scroll-block';
import { preparationDetailText, preparationErrorText } from './preparation-copy';

/**
 * Whether a step carries more than its name. A progress line the caller drops
 * does not count, so a failed stage with nothing else renders no empty block.
 */
export function hasStepDetails(step: PreparationStepSnapshot, showProgress: boolean): boolean {
  return [
    step.command,
    showProgress ? step.latestDetail : undefined,
    step.outputTail,
    step.safeError,
    step.exitCode,
  ].some(value => value !== undefined && value !== '');
}

/**
 * A step's own evidence: the command, the progress line, the failure, the exit
 * code and the tail. A row shows it under its header when expanded, and a group
 * whose header already names the step shows it on its own, so naming a step in
 * the header never hides what that step recorded.
 *
 * A named failed step drops the progress line. The header already says that
 * step failed, so the line it had reached before it stopped would contradict
 * the header. Its failure, command, exit code and tail stay.
 */
export function PreparationStepDetails({
  step,
  divided = false,
  showProgress = true,
}: {
  step: PreparationStepSnapshot;
  divided?: boolean;
  showProgress?: boolean;
}) {
  const { t } = useTranslation();
  if (!hasStepDetails(step, showProgress)) {
    return null;
  }
  return (
    <View className={divided ? 'gap-2 border-t border-border px-3 py-2' : 'gap-2'}>
      {step.command ? (
        <Text selectable className="rounded bg-secondary p-2 font-mono text-xs">
          {step.command}
        </Text>
      ) : null}
      {showProgress && step.latestDetail ? (
        <Text className="text-sm text-muted-foreground">
          {preparationDetailText(step.latestDetail, t)}
        </Text>
      ) : null}
      {step.safeError ? (
        <Text selectable className="text-sm text-muted-foreground">
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
