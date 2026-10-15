import { type Ref } from 'react';
import Animated, { Extrapolation, interpolate, useAnimatedStyle } from 'react-native-reanimated';
import { ActivityIndicator, View } from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import {
  ChatComposer,
  type ChatComposerControl,
  type ChatComposerSendOptions,
} from '@/components/agents/chat-composer';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { ChatFailureRow } from './chat-failure-row';

/* eslint-disable require-await, @typescript-eslint/require-await, no-empty-function -- the composer's session callbacks; a chat creates, restarts and exits nothing */
async function noSessionCommand(): Promise<boolean> {
  return false;
}
async function noSessionChange(): Promise<boolean> {
  return false;
}
async function noSessionExit(): Promise<void> {}
/* eslint-enable require-await, @typescript-eslint/require-await, no-empty-function */

type ChatComposerAreaProps = {
  /** The harness chat state the area draws its status from. */
  status: 'opening' | 'idle' | 'working';
  /** Set while the turn is failing; the Retry may be withheld while a question waits. */
  failureKey: string | null;
  /** False while a typed question still waits; then the Retry is withheld. */
  retryable: boolean;
  onRetry: () => void;
  onSend: (text: string, options?: ChatComposerSendOptions) => void;
  /** Imperative handle the host uses to set composer text (Retry / Copy to composer). */
  composerControlRef: Ref<ChatComposerControl>;
  onStop: () => void;
  /** The model the chat's next message goes to, and its effort variant. */
  model: string;
  variant: string;
  onModelSelect: (modelId: string, variant: string) => void;
  modelOptions: (ModelOption | SessionModelOption)[];
  attachmentsEnabled: boolean;
  organizationId?: string;
  disabled?: boolean;
};

/**
 * The transcript-adjacent half of the conversation: the reserved status slot,
 * the failure row, and the composer.
 */
export function ChatComposerArea({
  status,
  failureKey,
  retryable,
  onRetry,
  onSend,
  composerControlRef,
  onStop,
  model,
  variant,
  onModelSelect,
  modelOptions,
  attachmentsEnabled,
  organizationId,
  disabled = false,
}: Readonly<ChatComposerAreaProps>) {
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  // A conversation fills the screen: the tab bar is gone and the composer sits
  // on the home indicator. `KeyboardAvoidingView` already lifts the whole body
  // by the keyboard's own height, and that lift clears the home indicator, so
  // this inset has to reach zero in step with it. Interpolating it on the same
  // keyboard progress puts the lift and the inset in one transition; flipping it
  // on the keyboard's visible flag moved the composer a second time, after the
  // keyboard had finished moving (video V0 ~4.0s, V1 ~5.3s and ~19s).
  const { progress } = useReanimatedKeyboardAnimation();
  const composerInset = useAnimatedStyle(
    () => ({
      paddingBottom: interpolate(progress.value, [0, 1], [bottom, 0], Extrapolation.CLAMP),
    }),
    [bottom]
  );

  return (
    <>
      <View testID="chat-status-slot" className="h-10 flex-row items-center gap-2 px-4">
        {status === 'working' ? (
          <>
            <ActivityIndicator />
            <AccessibleStatus
              message={t('common.generating')}
              tone="status"
              className="text-sm font-medium text-foreground"
            />
          </>
        ) : null}
      </View>

      {status === 'idle' && failureKey !== null ? (
        <ChatFailureRow failureKey={failureKey} onRetry={retryable ? onRetry : undefined} />
      ) : null}

      <Animated.View style={composerInset}>
        <ChatComposer
          toolbarClassName="pb-1"
          controlRef={composerControlRef}
          onSend={onSend}
          onSendCommand={noSessionCommand}
          onCreateSession={noSessionChange}
          onRestartSession={noSessionChange}
          onExitSession={noSessionExit}
          onStop={onStop}
          isStreaming={status === 'working'}
          placeholder={t('common.message')}
          model={model}
          variant={variant}
          modelOptions={modelOptions}
          onModelSelect={onModelSelect}
          attachmentsEnabled={attachmentsEnabled}
          attachmentDelivery="local"
          activeSessionType={null}
          organizationId={organizationId}
          disabled={disabled}
        />
      </Animated.View>
    </>
  );
}
