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
  /**
   * True once the capabilities load has outlasted the reserve grace
   * (`SANDBOX_SLOW_LOAD_GRACE_MS`); gates the loading slot below.
   */
  isSlowLoading: boolean;
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
 * The empty state (feature off, nothing picked) renders no section at all:
 * there is nothing to choose between and no recovery to offer. With a settled
 * error the pick may still be set, so the section stays to show the reason and
 * the way out. While the capabilities load, the section renders nothing until
 * the load outlasts the reserve grace: most owners get a fast settled disabled
 * verdict, and a slot painted for them would collapse when the verdict lands,
 * moving the sections below. Once the load is slow the slot holds the label
 * plus a skeleton sized like the field, so the field replaces the skeleton in
 * place and the sections below never move. The retryable failure renders in
 * the field's own slot once settled.
 * Lives in this module so the configure form stays under its line limit.
 */
export function renderSandboxSection(args: Readonly<RenderSandboxSectionArgs>): ReactNode {
  const { t, status, capabilities, error, isSlowLoading } = args;
  if (status === 'loading' && !isSlowLoading) {
    return null;
  }
  if (status === 'loading') {
    return (
      <View className="mt-5">
        <Text className="mb-2 text-sm font-medium text-muted-foreground">
          {t('agentChat.newSession.sandbox')}
        </Text>
        {/* The field's rendered box: px-3 py-3 around the text-base line. */}
        <Skeleton className="h-[44.6px] w-full rounded-lg" />
      </View>
    );
  }
  if (status === 'ready' && capabilities?.enabled !== true && !error) {
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
    // Non-retryable: the picked sandbox is unavailable (or the feature is off
    // with a pick still set). The reason row keeps the field's slot and Use
    // Default is the one-tap way out; the selector stays rendered below so
    // the copy's "choose another sandbox" is actually satisfiable.
    return (
      <View className="gap-2">
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
        {capabilities ? (
          <SandboxSelector
            value={value}
            capabilities={capabilities}
            organizationId={organizationId}
            onChange={onChange}
            disabled={disabled}
          />
        ) : null}
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
