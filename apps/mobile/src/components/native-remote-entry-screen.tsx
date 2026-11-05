import { NativeSyncClient } from '@kilocode/cloud-agent-sdk';
import { Redirect } from 'expo-router';
import { useMemo } from 'react';
import { NativeRemoteDemo } from '@/components/native-remote/native-remote-demo';
import { useFeatureFlag } from '@/lib/analytics/posthog';
import { useAuth } from '@/lib/auth/auth-context';
import { SESSION_SYNC_URL } from '@/lib/config';
import { nativeRemoteCredential } from '@/lib/native-remote-credential';

function OwnedNativeRemoteDemo({ epoch, baseUrl }: { epoch: number; baseUrl: string }) {
  const client = useMemo(
    () => new NativeSyncClient({ baseUrl, getCredential: () => nativeRemoteCredential(epoch) }),
    [baseUrl, epoch]
  );
  return <NativeRemoteDemo client={client} />;
}

export function NativeRemoteEntryScreen() {
  const enabled = useFeatureFlag('native-remote-mobile', false);
  const { token, authEpoch, isSigningOut } = useAuth();
  if (!enabled || !SESSION_SYNC_URL || !token || isSigningOut) {
    return <Redirect href="/" />;
  }
  return <OwnedNativeRemoteDemo key={authEpoch} epoch={authEpoch} baseUrl={SESSION_SYNC_URL} />;
}
