import { NativeSyncClient } from '@kilocode/cloud-agent-sdk';
import { Redirect } from 'expo-router';
import { useMemo } from 'react';
import { NativeRemoteDemo } from '@/components/native-remote/native-remote-demo';
import { useAuth } from '@/lib/auth/auth-context';
import { SESSION_SYNC_URL } from '@/lib/config';
import { nativeRemoteCredential } from '@/lib/native-remote-credential';
import { useOrganization } from '@/lib/organization-context';
import { Skeleton } from '@/components/ui/skeleton';

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

export function NativeRemoteEntryScreen() {
  const { token, authEpoch, isSigningOut } = useAuth();
  const { organizationId, isLoaded } = useOrganization();
  if (!__DEV__ || !SESSION_SYNC_URL || !token || isSigningOut) {
    return <Redirect href="/" />;
  }
  if (!isLoaded) {
    return <Skeleton className="m-4 h-48" />;
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
