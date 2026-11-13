import {
  watchPrMaintenancePolicySchema,
  type WatchPrMaintenancePolicy,
} from '@kilocode/db/cloud-agent-pr-maintenance';

export type MaintenanceInheritedSettings = {
  profileId: string | null;
  environmentId: string | null;
};

export type MaintenanceConsent = {
  automaticWritesConsent: boolean;
  historyRewriteConsent: boolean;
  noHardSpendCapConsent: boolean;
};

export const noMaintenanceConsent: MaintenanceConsent = {
  automaticWritesConsent: false,
  historyRewriteConsent: false,
  noHardSpendCapConsent: false,
};

type MaintenancePolicyDraft = MaintenanceConsent &
  Pick<WatchPrMaintenancePolicy, 'model' | 'variant' | 'trustedBotLogins' | 'categories'>;

export function maintenanceInheritedSettingsChanged(
  reviewed: MaintenanceInheritedSettings,
  current: MaintenanceInheritedSettings
): boolean {
  return (
    reviewed.profileId !== current.profileId || reviewed.environmentId !== current.environmentId
  );
}

export function buildMaintenanceEnablePolicy(
  draft: MaintenancePolicyDraft,
  reviewed: MaintenanceInheritedSettings,
  current: MaintenanceInheritedSettings
): { success: true; policy: WatchPrMaintenancePolicy } | { success: false; message: string } {
  if (maintenanceInheritedSettingsChanged(reviewed, current)) {
    return {
      success: false,
      message: 'Workspace settings changed. Review the current settings and give consent again.',
    };
  }
  const parsed = watchPrMaintenancePolicySchema.safeParse({
    version: 2,
    ...draft,
    profileId: reviewed.profileId,
    environmentId: reviewed.environmentId,
  });
  return parsed.success
    ? { success: true, policy: parsed.data }
    : {
        success: false,
        message: parsed.error.issues[0]?.message ?? 'Check the maintenance settings.',
      };
}
