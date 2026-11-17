import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import * as Application from 'expo-application';
import { type ReactElement, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { formatList } from '@/lib/format';
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
 * `changelogSections` drops the file's maintainer parts, turns each commit
 * subject into a sentence, and folds one version's builds into one list. The
 * newest section here is the release before this build: the Release workflow
 * writes a build's section after its submission lands, so the bytes this build
 * compiled cannot carry their own entry (it arrives in the next build's
 * bundle).
 */
const CHANGELOG_SECTIONS = changelogSections(changelog);

/**
 * The version the running app was installed as, or null before the platform
 * answers. The notice below names it, so a reader does not take the newest
 * section for this build's news.
 */
const INSTALLED_VERSION = Application.nativeApplicationVersion;

/**
 * Whether the bundled sections stop short of the running build's version.
 * Read once: the app version is fixed for the life of the process, and the
 * bundled markdown cannot change without a new build.
 */
const NOTES_PENDING = changelogNotesArePending(changelog, INSTALLED_VERSION);

const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = {
  paddingHorizontal: 20,
  paddingTop: 16,
  paddingBottom: 40,
} satisfies ViewStyle;

const keyExtractor = (section: ChangelogSection) => section.version;

function NoteRow({ text }: Readonly<{ text: string }>) {
  return (
    <View className="flex-row gap-2">
      <Text className="text-sm text-muted-foreground">•</Text>
      <Text className="flex-1 text-sm text-muted-foreground">{text}</Text>
    </View>
  );
}

/**
 * One version's notes: its heading, then a bullet per change. The 24 dp below a
 * version is the only break the reader gets, so every bullet of a version sits
 * one 8 dp gap from the next and a new heading starts the next block.
 */
function ReleaseSection({ section }: Readonly<{ section: ChangelogSection }>) {
  const { t, i18n } = useTranslation();
  return (
    <View className="pb-6">
      <Text variant="h4" className="pb-2">
        {section.version}
      </Text>
      <View className="gap-2">
        {section.notes.map((note, position) => (
          <NoteRow key={`${note}-${position}`} text={note} />
        ))}
        {section.translationLanguages.length === 0 ? null : (
          <NoteRow
            text={t('profile.changelogTranslationFixes', {
              languages: formatList(section.translationLanguages, i18n.language),
            })}
          />
        )}
      </View>
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
  // The notice belongs to the notes, not to the screen: as the list's header it
  // shares the list's 20 dp inset and scrolls away with the first version.
  const header: ReactElement | null = NOTES_PENDING ? (
    <Text variant="muted" className="pb-4">
      {t('profile.changelogVersionPending', { version: INSTALLED_VERSION })}
    </Text>
  ) : null;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profile.changelog')} />
      <View style={sideInsetStyle} className="flex-1">
        <FlashList
          style={listStyle}
          data={CHANGELOG_SECTIONS}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          ListHeaderComponent={header}
          contentContainerStyle={listContentContainerStyle}
          showsVerticalScrollIndicator={false}
        />
      </View>
    </View>
  );
}
