import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { SettingsOverviewScreen } from '@/components/security-agent/settings-overview-screen';
import { i18n } from '@/i18n';
import { isSupportedLanguage } from '@/i18n/languages';
import { useTRPC } from '@/lib/trpc';

type PanelOutputs = inferRouterOutputs<MobileRouter>['securityAgent'];
type Config = PanelOutputs['getConfig'];
type PermissionStatus = PanelOutputs['getPermissionStatus'];
type Repositories = PanelOutputs['getRepositories'];

const permissionStatus: PermissionStatus = {
  hasIntegration: true,
  hasPermissions: true,
  integrationId: 'fixture-integration',
  reauthorizeUrl: null,
  authInvalidAt: null,
  authInvalidReason: null,
};

const config: Config = {
  hasConfig: true,
  configRevision: 1,
  isEnabled: true,
  slaCriticalDays: 15,
  slaHighDays: 30,
  slaMediumDays: 45,
  slaLowDays: 90,
  slaEnabled: true,
  autoSyncEnabled: true,
  repositorySelectionMode: 'selected',
  selectedRepositoryIds: [1, 2],
  modelSlug: 'fixture/model',
  triageModelSlug: 'fixture/model',
  analysisModelSlug: 'fixture/model',
  analysisMode: 'auto',
  autoDismissEnabled: true,
  autoDismissConfidenceThreshold: 'high',
  autoAnalysisEnabled: true,
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
  newFindingNotificationsEnabled: true,
  newFindingNotificationMinSeverity: 'high',
};

const repositories: Repositories = [101, 102].map(id => ({
  id,
  fullName: `fixture/repository-${id}`,
  name: `repository-${id}`,
  private: false,
  dependabotAlerts: 'unknown' as const,
}));

export function SettingsCountProofFixture() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ lang?: string | string[] }>();
  const requested = Array.isArray(params.lang) ? params.lang[0] : params.lang;
  const requestedLanguage = requested && isSupportedLanguage(requested) ? requested : undefined;

  useState(() => {
    queryClient.setQueryData(trpc.securityAgent.getPermissionStatus.queryKey(), permissionStatus);
    queryClient.setQueryData(trpc.securityAgent.getConfig.queryKey(), config);
    queryClient.setQueryData(trpc.securityAgent.getRepositories.queryKey(), repositories);
    return true;
  });

  useEffect(() => {
    if (requestedLanguage) {
      void i18n.changeLanguage(requestedLanguage);
    }
  }, [requestedLanguage]);

  return (
    <View className="flex-1 bg-background">
      <SettingsOverviewScreen scope="personal" />
    </View>
  );
}
