/* eslint-disable no-literal-copy/no-literal-copy -- Development-only render-recovery fixture; its labels never ship. */
import { useSyncExternalStore } from 'react';
import { ScrollView, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { useOrganizationsList } from '@/lib/hooks/use-organizations-list';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import {
  getRenderRecoveryFault,
  RENDER_RECOVERY_PAYLOAD_MARKER,
  subscribeRenderRecoveryFault,
} from '@/lib/render-recovery-fixture';
import { E2eInjectedFaultError } from '@/lib/telemetry/e2e-fault';

/**
 * The screen behind `/(app)/render-recovery-fixture`, reachable only through the
 * dev fixture links in `src/lib/render-recovery-fixture.ts`.
 *
 * It renders a real organization payload and throws while the harness has armed
 * a fault, so the authenticated stack's screen recovery can be exercised on a
 * build: the fault is a plain render failure of one route screen, produced by
 * the same reads and the same components a product screen uses. The declared
 * foreground-refresh keys are also the route's recovery scope, so `Retry` after
 * `clear` (and after the backend row no longer carries the marker) refetches the
 * payload instead of replaying the cached one.
 */
export function RenderRecoveryFixture() {
  useRouteForegroundRefresh([[['organizations']]]);
  const organizations = useOrganizationsList();
  const fault = useSyncExternalStore(subscribeRenderRecoveryFault, getRenderRecoveryFault);
  const organizationName = organizations.data?.[0]?.organizationName ?? '';

  if (fault === 'transient') {
    throw new E2eInjectedFaultError('render recovery fixture: armed transient render fault');
  }
  if (fault === 'payload' && organizationName.startsWith(RENDER_RECOVERY_PAYLOAD_MARKER)) {
    throw new E2eInjectedFaultError('render recovery fixture: armed payload render fault');
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Render recovery fixture" />
      <ScrollView contentContainerClassName="gap-3 px-4 pt-4">
        <Text className="text-sm text-muted-foreground">Organization</Text>
        <Text className="text-base text-foreground">
          {organizationName.length > 0 ? organizationName : 'None'}
        </Text>
        <Text className="text-sm text-muted-foreground">Armed fault: {fault}</Text>
      </ScrollView>
    </View>
  );
}
