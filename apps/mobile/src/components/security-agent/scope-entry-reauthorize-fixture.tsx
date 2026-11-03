import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { ScopeEntryScreen } from '@/components/security-agent/scope-entry-screen';
import { i18n } from '@/i18n';
import { isSupportedLanguage } from '@/i18n/languages';
import { useTRPC } from '@/lib/trpc';

type RouterOutputs = inferRouterOutputs<MobileRouter>;
type PermissionStatus = RouterOutputs['securityAgent']['getPermissionStatus'];
type Config = RouterOutputs['securityAgent']['getConfig'];

// Development-only reauthorize fixture, reached through the app's dev fixture
// link with an optional language tag. It seeds the personal-scope query cache so
// the real ScopeEntryScreen renders its reauthorize view, then hands the screen
// the values below. No account, no API call, no stored result: these fixtures
// are the only data the screen reads.
const permissionStatus: PermissionStatus = {
  hasIntegration: true,
  hasPermissions: false,
  integrationId: 'fixture-integration',
  // The screen only hands this value to the open action, which the fixture never
  // presses; a placeholder keeps the capture free of a real install link.
  reauthorizeUrl: 'fixture-github-install-link',
  authInvalidAt: null,
  authInvalidReason: null,
};

const config: Config = {
  hasConfig: false,
  configRevision: 1,
  isEnabled: false,
  slaCriticalDays: 15,
  slaHighDays: 30,
  slaMediumDays: 45,
  slaLowDays: 90,
  slaEnabled: false,
  autoSyncEnabled: true,
  repositorySelectionMode: 'all',
  selectedRepositoryIds: [],
  modelSlug: 'fixture/model',
  triageModelSlug: 'fixture/model',
  analysisModelSlug: 'fixture/model',
  analysisMode: 'auto',
  autoDismissEnabled: false,
  autoDismissConfidenceThreshold: 'high',
  autoAnalysisEnabled: false,
  autoAnalysisMinSeverity: 'high',
  autoAnalysisIncludeExisting: false,
  autoRemediationEnabled: false,
  autoRemediationMinSeverity: 'high',
  autoRemediationIncludeExisting: false,
  autoRemediationRequireApproval: true,
  autoRemediationEnabledAt: null,
  remediationModelSlug: 'fixture/model',
  slaNotificationsEnabled: false,
  slaNotificationMinSeverity: 'high',
  slaNotificationWarningDays: 3,
  newFindingNotificationsEnabled: false,
  newFindingNotificationMinSeverity: 'high',
};

export function ScopeEntryReauthorizeFixture() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ lang?: string | string[] }>();
  const requested = Array.isArray(params.lang) ? params.lang[0] : params.lang;
  const requestedLanguage = requested && isSupportedLanguage(requested) ? requested : undefined;

  // Seed before the screen mounts: the cache is fresh, so its queries answer from
  // these values instead of the network.
  useState(() => {
    queryClient.setQueryData(trpc.securityAgent.getPermissionStatus.queryKey(), permissionStatus);
    queryClient.setQueryData(trpc.securityAgent.getConfig.queryKey(), config);
    queryClient.setQueryData(trpc.securityAgent.getRepositories.queryKey(), []);
    return true;
  });

  // A capture needs the catalog the reader would see. The switch stays in memory:
  // the picker's direction change reloads the app, and this route exists to show
  // copy, not to persist a language on the device.
  useEffect(() => {
    if (requestedLanguage) {
      void i18n.changeLanguage(requestedLanguage);
    }
  }, [requestedLanguage]);

  return (
    <View className="flex-1 bg-background">
      <ScopeEntryScreen scope="personal" />
    </View>
  );
}
