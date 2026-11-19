/* eslint-disable no-literal-copy/no-literal-copy -- Development-only fixture; its heading never ships. */
import { Redirect } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { GgufDownloadControls } from '@/components/chat/gguf-model-section';
import { ScreenHeader } from '@/components/screen-header';
import { type GgufDownloadsSnapshot } from '@/lib/chat/gguf-records';

const FILE_ID = 'fixture';
const NAME = 'Fixture model';
/** The size both rows state, so the two progress lines differ only in wording. */
const TOTAL_BYTES = 104857600;

function snapshotOf(written: number, retrying: boolean): GgufDownloadsSnapshot {
  return {
    models: [],
    download: {
      fileId: FILE_ID,
      name: NAME,
      phase: 'downloading',
      pending: false,
      written,
      total: TOTAL_BYTES,
      retrying,
    },
    failure: null,
    loadFailed: false,
  };
}

/**
 * Development-only route for the design gate: the GGUF row's retrying line and
 * its plain downloading line on one screen, so both are measured without
 * restarting a real transfer. The development fixture path in
 * `src/app/+native-intent.tsx` maps to it, and a release build refuses the path
 * outright so the fixture is never reachable. It sends no requests.
 */
export default function GgufRetryFixtureRoute() {
  if (!__DEV__) {
    return <Redirect href="/" />;
  }
  return (
    <View className="flex-1 bg-background" testID="gguf-retrying-fixture">
      <ScreenHeader title="GGUF retry row" />
      <ScrollView contentContainerClassName="gap-6 p-4">
        <View className="gap-2">
          <GgufDownloadControls
            fileId={FILE_ID}
            name={NAME}
            snapshot={snapshotOf(8388608, true)}
            onDownload={undefined}
            downloadDetail={undefined}
          />
        </View>
        <View className="gap-2">
          <GgufDownloadControls
            fileId={FILE_ID}
            name={NAME}
            snapshot={snapshotOf(0, false)}
            onDownload={undefined}
            downloadDetail={undefined}
          />
        </View>
      </ScrollView>
    </View>
  );
}
