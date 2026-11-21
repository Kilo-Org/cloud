import { Pressable, View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Text } from '@/components/ui/text';
import { UNDER_COPY_ACTION_BOX_CLASS, UNDER_COPY_ACTION_HIT_SLOP } from '@/lib/a11y/tap-target';
import { type TrialRefusalAction } from '@/lib/trial-refusal';
import { cn } from '@/lib/utils';

type RefusalStatusProps = Readonly<{
  /** The explanation to paint, already translated. `null` renders nothing. */
  message: string | null;
  /**
   * The step that ends the refusal, when the reader can take it. A refusal
   * whose reader cannot act on it hands over no action and keeps the copy
   * alone.
   */
  action?: TrialRefusalAction;
  className?: string;
}>;

/**
 * A refusal as one line of a form: the status text, plus the optional step
 * under it.
 *
 * This is the inline sibling of `components/organization/plan-refusal.tsx`,
 * not a replacement for it. That element is a block — a tinted surface with an
 * alert icon that holds a refusal on its own — while a form's submit line
 * already sits in the form's surface and only has room for the sentence and one
 * step. Both wear the same ink and the same under-copy hit box, so the step
 * reads as the same affordance in either place.
 *
 * `AccessibleStatus` owns the announcement, so nothing here announces twice; the
 * action is a plain button and adds no live region of its own.
 */
export function RefusalStatus({ message, action, className }: RefusalStatusProps) {
  const status = <AccessibleStatus message={message} tone="error" className={className} />;
  const step = message == null ? undefined : action;
  if (step === undefined) {
    return status;
  }
  return (
    <View className="gap-2">
      {status}
      <Pressable
        onPress={() => {
          step.onPress();
        }}
        accessibilityRole="button"
        accessibilityLabel={step.label}
        hitSlop={UNDER_COPY_ACTION_HIT_SLOP}
        className={cn(
          'justify-center self-start rounded-md active:opacity-70',
          UNDER_COPY_ACTION_BOX_CLASS
        )}
      >
        <Text className="text-sm font-semibold text-destructive underline">{step.label}</Text>
      </Pressable>
    </View>
  );
}
