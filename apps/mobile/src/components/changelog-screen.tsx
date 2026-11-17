import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import * as Application from 'expo-application';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { useSideInsetStyle } from '@/lib/screen-insets';

import changelog from '../../CHANGELOG.md';
import {
  changelogNotesArePending,
  type ChangelogSection,
  changelogSections,
} from './changelog-sections';

/**
 * The release notes the app ships with, as a reader sees them. `CHANGELOG.md` is
 * inlined into the bundle as a string by babel-plugin-inline-import, and
 * `changelogSections` drops the file's maintainer parts and turns each commit
 * subject into a sentence. The newest section here is the release before this
 * build: the Release workflow writes a build's section after its submission
 * lands, so the bytes this build compiled cannot carry their own entry (it
 * arrives in the next build's bundle).
 */
const CHANGELOG_SECTIONS = changelogSections(changelog);

/**
 * Whether the bundled sections stop short of the running build's version.
 * Read once: the app version is fixed for the life of the process, and the
 * bundled markdown cannot change without a new build.
 */
const NOTES_PENDING = changelogNotesArePending(changelog, Application.nativeApplicationVersion);

const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = {
  paddingHorizontal: 20,
  paddingTop: 16,
  paddingBottom: 40,
} satisfies ViewStyle;

const keyExtractor = (_section: ChangelogSection, index: number) => String(index);

function ReleaseSection({ section }: Readonly<{ section: ChangelogSection }>) {
  return (
    <View className="gap-2 pb-6">
      {section.version === null ? null : (
        <Text variant="h4" className="pt-2">
          {section.version}
        </Text>
      )}
      {section.notes.map((note, position) => (
        <View key={`${note}-${position}`} className="flex-row gap-2">
          <Text className="text-sm text-muted-foreground">•</Text>
          <Text className="flex-1 text-sm text-muted-foreground">{note}</Text>
        </View>
      ))}
    </View>
  );
}

export function ChangelogScreen() {
  const { t } = useTranslation();
  const sideInsetStyle = useSideInsetStyle();
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ChangelogSection>) => <ReleaseSection section={item} />,
    []
  );

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profile.changelog')} />
      <View style={sideInsetStyle} className="flex-1">
        {NOTES_PENDING ? (
          <Text variant="muted" className="px-5 pt-4">
            {t('profile.changelogVersionPending')}
          </Text>
        ) : null}
        <FlashList
          style={listStyle}
          data={CHANGELOG_SECTIONS}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={listContentContainerStyle}
          showsVerticalScrollIndicator={false}
        />
      </View>
    </View>
  );
}
