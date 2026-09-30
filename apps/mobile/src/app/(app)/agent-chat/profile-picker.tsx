import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ProfilePickerSheet } from '@/components/agents/profile-picker-sheet';
import { resolveSessionProfilePicker } from '@/components/agents/session-profile-picker-model';
import { useEffectiveAgentProfile } from '@/components/agents/use-effective-agent-profile';
import { PickerSheet } from '@/components/picker-sheet';
import { getProfilesPath } from '@/lib/profile-agent-navigation';
import { profilePickerSlot, UNFENCED_ROUTE_KEY, useRouteRegistry } from '@/lib/route-registry';

/**
 * The new-session profile picker, presented as the standard native formSheet.
 * The bridge carries the current pick and the context; the route re-queries the
 * same profiles scope so an open sheet is fresh and a failure has a Retry.
 */
export default function ProfilePickerScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  useRouteRegistry(UNFENCED_ROUTE_KEY);
  // Lazy init reads the slot synchronously on first render — no effect, no
  // "Options expired" flash before a later effect populates state.
  const [bridge] = useState(() => profilePickerSlot.get(UNFENCED_ROUTE_KEY));

  const { allProfiles, effectiveDefaultId, isLoading, isError, refetch } = useEffectiveAgentProfile(
    bridge?.organizationId,
    bridge?.selectedOverrideProfileId ?? null
  );

  if (!bridge) {
    return (
      <PickerSheet
        title={t('agentChat.newSession.pickProfile')}
        onDone={() => {
          router.back();
        }}
        scrollable={false}
        expired
      />
    );
  }

  const picker = resolveSessionProfilePicker({
    profiles: allProfiles,
    repoBindingProfileId: bridge.repoBindingProfileId,
    effectiveDefaultProfileId: effectiveDefaultId,
    selectedOverrideProfileId: bridge.selectedOverrideProfileId,
  });

  function close() {
    profilePickerSlot.clear(UNFENCED_ROUTE_KEY);
    router.back();
  }

  return (
    <ProfilePickerSheet
      candidates={picker.candidates}
      hasProfiles={allProfiles.length > 0}
      selectedOverrideProfileId={bridge.selectedOverrideProfileId}
      // A default exists, so clearing the override is not "no profile": the
      // server resolves that default on top of any repository binding.
      defaultProfileApplies={effectiveDefaultId !== null}
      isLoading={isLoading}
      isError={isError}
      needsAttention={picker.overrideNeedsAttention}
      onSelect={id => {
        bridge.onSelect(id);
        close();
      }}
      onManageProfiles={() => {
        close();
        router.push(getProfilesPath());
      }}
      onRetry={() => {
        void refetch();
      }}
      onClose={close}
    />
  );
}
