import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Keyboard, Pressable } from 'react-native';
import { ChevronDown } from '@/components/ui/icons';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  formatSandboxDefaultLabel,
  formatSandboxOptionLabel,
  type SandboxAllocation,
  type SandboxSelectionCapabilities,
} from '@/lib/sandbox-allocation-label';
import { sandboxPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { cn } from '@/lib/utils';

type SandboxSelectorProps = {
  /** The picked allocation; `undefined` is the backend's own default. */
  value: SandboxAllocation | undefined;
  /** The backend's offered sandboxes, handed to the picker verbatim. */
  capabilities: SandboxSelectionCapabilities;
  /** The route's scope; the picker re-queries it so its list stays fresh. */
  organizationId: string | undefined;
  onChange: (next: SandboxAllocation | undefined) => void;
  disabled?: boolean;
};

/**
 * The closed Sandbox field for the new-session form. Like `InstanceSelector`,
 * it owns the bridge write and the push: the picker route is display-only, and
 * this closure is what turns a pick into the form's `onChange`.
 */
export function SandboxSelector({
  value,
  capabilities,
  organizationId,
  onChange,
  disabled = false,
}: Readonly<SandboxSelectorProps>) {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();

  const label = value
    ? formatSandboxOptionLabel(value)
    : formatSandboxDefaultLabel(capabilities.defaultDestination);

  function handlePress() {
    if (disabled) {
      return;
    }
    sandboxPickerSlot.set(UNFENCED_ROUTE_KEY, {
      organizationId,
      options: capabilities.options,
      defaultDestination: capabilities.defaultDestination,
      currentValue: value,
      onSelect: onChange,
    });
    // See ModelSelector: the sheet never re-anchors after the keyboard hides,
    // so the keyboard must be down before this push.
    Keyboard.dismiss();
    router.push('/(app)/agent-chat/sandbox-picker' as Href);
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={t('agentChat.newSession.sandboxAccessibility', { label })}
      accessibilityState={{ disabled }}
      className={cn(
        'flex-row items-center justify-between rounded-lg border border-border bg-secondary px-3 py-3 active:opacity-70',
        disabled && 'opacity-50'
      )}
    >
      <Text
        className={cn('flex-1 text-base', value ? 'text-foreground' : 'text-muted-foreground')}
        numberOfLines={1}
      >
        {label}
      </Text>
      <ChevronDown size={14} color={colors.mutedForeground} />
    </Pressable>
  );
}
