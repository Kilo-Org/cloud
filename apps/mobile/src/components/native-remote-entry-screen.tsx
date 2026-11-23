import { NativeSyncClient } from '@kilocode/cloud-agent-sdk';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { NativeRemoteDemo } from '@/components/native-remote/native-remote-demo';
import { NativeRemoteTranscript } from '@/components/native-remote/native-remote-transcript';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { SectionHeaderSkeleton } from '@/components/ui/section-header-skeleton';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth/auth-context';
import { SESSION_SYNC_URL } from '@/lib/config';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import {
  nativeRemoteFixtureClient,
  type NativeRemoteFixtureName,
  nativeRemoteFixtureSummary,
  readNativeRemoteFixture,
} from '@/lib/native-remote-fixture';
import { nativeRemoteCredential } from '@/lib/native-remote-credential';
import { useNativeSession } from '@/lib/native-remote/use-native-session';
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
