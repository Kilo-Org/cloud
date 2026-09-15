import { type ReactNode } from 'react';
import { View } from 'react-native';
import { type TFunction } from 'i18next';

import { SandboxSelector } from '@/components/agents/sandbox-selector';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  type SandboxAllocation,
  type SandboxSelectionCapabilities,
  type SandboxSelectionErrorReason,
} from '@/lib/sandbox-allocation-label';
import { type SandboxSelectionStatus } from '@/lib/hooks/use-sandbox-selection';

/** Everything the Sandbox section renders until the form supplies `t` and the busy flag. */
export type NewSessionSandboxState = {
  status: SandboxSelectionStatus;
  capabilities: SandboxSelectionCapabilities | undefined;
  value: SandboxAllocation | undefined;
  error: SandboxSelectionErrorReason | undefined;
  organizationId: string | undefined;
  onChange: (next: SandboxAllocation | undefined) => void;
  onRetry: () => void;
  onUseDefault: () => void;
};

type RenderSandboxSectionArgs = NewSessionSandboxState & {
  t: TFunction;
  /** True while the session is being created: the recovery control locks. */
  disabled: boolean;
};

/**
 * The new-session Sandbox section, between the repository and Changes blocks.
 * The empty state renders no section at all: disabled capabilities mean there
 * is nothing to choose between, so the section has no CTA. Loading and both
 * failures render in the field's own slot so the sections below never move.
 * Lives in this module so the configure form stays under its line limit.
 */
export function renderSandboxSection(args: Readonly<RenderSandboxSectionArgs>): ReactNode {
  const { t, status, capabilities } = args;
  if (status === 'ready' && capabilities?.enabled !== true) {
    return null;
  }
  return (
    <View className="mt-5">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">
        {t('agentChat.newSession.sandbox')}
      </Text>
      {renderSandboxField(args)}
    </View>
  );
}

function renderSandboxField({
  t,
  status,
  capabilities,
  value,
  error,
  organizationId,
  disabled,
  onChange,
  onRetry,
  onUseDefault,
}: Readonly<RenderSandboxSectionArgs>): ReactNode {
  if (status === 'loading') {
    return <Skeleton className="h-[50px] w-full rounded-lg" />;
  }
  if (status === 'error') {
    return (
      <View className="min-h-[50px] flex-row items-center gap-2">
        <Text className="flex-1 text-sm text-destructive">
          {t('agentChat.newSession.sandboxCouldNotLoad')}
        </Text>
        <Button variant="link" size="sm" onPress={onRetry} accessibilityLabel={t('common.retry')}>
          <Text>{t('common.retry')}</Text>
        </Button>
      </View>
    );
  }
  if (error) {
    return (
      <View className="min-h-[50px] flex-row items-center gap-2">
        <Text className="flex-1 text-sm text-destructive">
          {t('agentChat.newSession.sandboxUnavailable')}
        </Text>
        <Button
          variant="link"
          size="sm"
          onPress={onUseDefault}
          disabled={disabled}
          accessibilityLabel={t('agentChat.newSession.sandboxUseDefault')}
        >
          <Text>{t('agentChat.newSession.sandboxUseDefault')}</Text>
        </Button>
      </View>
    );
  }
  return capabilities ? (
    <SandboxSelector
      value={value}
      capabilities={capabilities}
      organizationId={organizationId}
      onChange={onChange}
      disabled={disabled}
    />
  ) : null;
}
