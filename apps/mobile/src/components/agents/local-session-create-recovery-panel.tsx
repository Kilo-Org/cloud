import { AlertCircle } from 'lucide-react-native';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { type RecoveryCtaAction } from '@/lib/hooks/local-session-create-recovery-actions';

type LocalSessionCreateRecoveryPanelProps = {
  message: string;
  action: RecoveryCtaAction;
  disabled: boolean;
};

/**
 * Recovery surface for the local-session create screen. The panel:
 *
 * - Always renders the exact orchestrator-supplied message verbatim — the
 *   message is the only content the user must read, so it must not be
 *   paraphrased, prefixed, or suffixed.
 * - Renders a CTA only when the resolver returns a non-`none` action. The
 *   non-retryable branches (CLI upgrade, malformed response) have no CTA
 *   and the panel must therefore render zero buttons.
 * - Disables its CTA while the submit is in flight. The button is still
 *   mounted, so the layout does not shift, but it cannot be re-pressed.
 */
export function LocalSessionCreateRecoveryPanel({
  message,
  action,
  disabled,
}: LocalSessionCreateRecoveryPanelProps) {
  return (
    <View className="mt-5 rounded-2xl border border-border bg-card p-4">
      <View className="flex-row items-start gap-3">
        <AlertCircle size={20} className="mt-0.5 text-muted-foreground" />
        <Text className="flex-1 text-sm text-foreground">{message}</Text>
      </View>
      {action.kind === 'none' ? null : (
        <View className="mt-3 flex-row justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onPress={() => {
              action.onPress();
            }}
            accessibilityLabel={action.label}
          >
            <Text>{action.label}</Text>
          </Button>
        </View>
      )}
    </View>
  );
}
