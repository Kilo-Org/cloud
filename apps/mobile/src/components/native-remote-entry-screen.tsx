import { NativeSyncClient } from '@kilocode/cloud-agent-sdk';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { NativeRemoteDemo } from '@/components/native-remote/native-remote-demo';
import { NativeRemoteTranscript } from '@/components/native-remote/native-remote-transcript';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { useAuth } from '@/lib/auth/auth-context';
import { SESSION_SYNC_URL } from '@/lib/config';
import {
  nativeRemoteFixtureClient,
  type NativeRemoteFixtureName,
  nativeRemoteFixtureSummary,
  readNativeRemoteFixture,
} from '@/lib/native-remote-fixture';
import { nativeRemoteCredential } from '@/lib/native-remote-credential';
import { useNativeSession } from '@/lib/native-remote/use-native-session';
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

function FixtureNativeRemote({ fixture }: { fixture: NativeRemoteFixtureName }) {
  const { t } = useTranslation();
  const client = useMemo(() => nativeRemoteFixtureClient(fixture), [fixture]);
  const remote = useNativeSession(client, nativeRemoteFixtureSummary);
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('nativeRemote.title')} />
      <TabScreenScrollView className="flex-1" contentContainerClassName="gap-4 px-4 pt-4 pb-8">
        <NativeRemoteTranscript sessionID={nativeRemoteFixtureSummary.sessionID} remote={remote} />
      </TabScreenScrollView>
    </View>
  );
}

function fixtureParam(value: string | undefined): NativeRemoteFixtureName | undefined {
  return value === 'reconnecting' || value === 'gaps' ? value : undefined;
}

export function NativeRemoteEntryScreen() {
  const { token, authEpoch, isSigningOut } = useAuth();
  const { organizationId, isLoaded } = useOrganization();
  // The link handler (`+native-intent.tsx`) is the documented fixture entry
  // point, but its selection is process-global and only sets what links name;
  // the live route parameter wins when both name a state.
  const { nativeRemoteFixture } = useLocalSearchParams<{ nativeRemoteFixture?: string }>();
  const fixture = fixtureParam(nativeRemoteFixture) ?? readNativeRemoteFixture();
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  if (fixture) {
    return <FixtureNativeRemote fixture={fixture} />;
  }
  if (!SESSION_SYNC_URL || !token || isSigningOut) {
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
