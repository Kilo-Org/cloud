import { NativeSyncClient } from '@kilocode/cloud-agent-sdk';
import { Redirect } from 'expo-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { NativeRemoteDemo } from '@/components/native-remote/native-remote-demo';
import { ScreenHeader } from '@/components/screen-header';
import { SectionHeaderSkeleton } from '@/components/ui/section-header-skeleton';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth/auth-context';
import { SESSION_SYNC_URL } from '@/lib/config';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { nativeRemoteCredential } from '@/lib/native-remote-credential';
import { useOrganization } from '@/lib/organization-context';
import { cn } from '@/lib/utils';

function OwnedNativeRemoteDemo({
  epoch,
  baseUrl,
  organizationID,
}: {
  epoch: number;
  baseUrl: string;
  organizationID: string | undefined;
}) {
  const client = useMemo(
    () => new NativeSyncClient({ baseUrl, getCredential: () => nativeRemoteCredential(epoch) }),
    [baseUrl, epoch]
  );
  return <NativeRemoteDemo client={client} organizationID={organizationID} />;
}

/**
 * The inventory's own loading shape while the organization scope resolves: the
 * screen header and the two labelled sections, each reserving the block its
 * rows will take, so the real screen lands on the same frame instead of
 * replacing a bare rectangle.
 */
function NativeRemoteLoading() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('nativeRemote.title')} />
      <View className={cn(SCREEN_BODY_CLASS, 'flex-1')}>
        <View className="gap-6">
          <View className="gap-3">
            <SectionHeaderSkeleton />
            <Skeleton className="h-24 rounded-xl" />
          </View>
          <View className="gap-3">
            <SectionHeaderSkeleton />
            <Skeleton className="h-24 rounded-xl" />
          </View>
        </View>
      </View>
    </View>
  );
}

export function NativeRemoteEntryScreen() {
  const { token, authEpoch, isSigningOut } = useAuth();
  const { organizationId, isLoaded } = useOrganization();
  if (!__DEV__ || !SESSION_SYNC_URL || !token || isSigningOut) {
    return <Redirect href="/" />;
  }
  if (!isLoaded) {
    return <NativeRemoteLoading />;
  }
  return (
    <OwnedNativeRemoteDemo
      key={authEpoch}
      epoch={authEpoch}
      baseUrl={SESSION_SYNC_URL}
      organizationID={organizationId ?? undefined}
    />
  );
}
