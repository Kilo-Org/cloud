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
  type ChangelogArea,
  changelogNotesArePending,
  type ChangelogSection,
  changelogSections,
} from './changelog-sections';

/**
 * The release notes the app ships with, as a reader sees them. `CHANGELOG.md` is
 * inlined into the bundle as a string by babel-plugin-inline-import, and
 * `changelogSections` drops the file's maintainer parts, keeps the newest
 * features as sentences, and turns the fixes into the product areas they
 * touched. The newest section here is the release before this build: the
 * Release workflow writes a build's section after its submission lands, so the
 * bytes this build compiled cannot carry their own entry (it arrives in the
 * next build's bundle).
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

const groupLabelClass = 'uppercase tracking-wide text-muted-foreground';

/**
 * The catalog key that names each area. Six of the areas already carry a label
 * the app paints elsewhere, so the changelog reuses those keys instead of
 * wording the same product name a second time; only sign-in and the profile
 * have no existing label of their own.
 */
const AREA_LABEL_KEYS = {
  chat: 'common.chat',
  cloudAgent: 'agentChat.instancePicker.cloudAgent',
  securityAgent: 'common.securityAgent',
  codeReviewer: 'common.codeReviewer',
  signIn: 'profile.changelogAreas.signIn',
  profileOrganizations: 'profile.changelogAreas.profileOrganizations',
  notifications: 'common.notifications',
  integrations: 'integrations.title',
} as const satisfies Record<ChangelogArea, string>;

function NoteRow({ text }: Readonly<{ text: string }>) {
  return (
    <View className="flex-row gap-2">
      <Text className="text-sm text-muted-foreground">•</Text>
      <Text className="flex-1 text-sm text-muted-foreground">{text}</Text>
    </View>
  );
}

/**
 * One version: its heading, the New group, and the line that names the areas
 * the fixes touched. Bullets sit one 8 dp gap apart, the two groups 16 dp, and
 * the next version starts 24 dp down.
 */
function ReleaseSection({ section }: Readonly<{ section: ChangelogSection }>) {
  const { t, i18n } = useTranslation();
  const areas = section.fixesAreas.map(area => t(AREA_LABEL_KEYS[area]));
  const fixesLabel =
    areas.length === 0
      ? t('profile.changelogFixesAcrossApp')
      : t('profile.changelogFixesIn', { areas: formatList(areas, i18n.language) });
  const fixesClass =
    section.newNotes.length === 0
      ? 'text-sm text-muted-foreground'
      : 'pt-4 text-sm text-muted-foreground';
  return (
    <View className="pb-6">
      <Text variant="h4" className="pb-2">
        {section.version}
      </Text>
      {section.newNotes.length === 0 ? null : (
        <View className="gap-2">
          <Text variant="small" className={groupLabelClass}>
            {t('profile.changelogGroupNew')}
          </Text>
          {section.newNotes.map((note, position) => (
            <NoteRow key={`${note}-${position}`} text={note} />
          ))}
        </View>
      )}
      {section.hasFixes ? <Text className={fixesClass}>{fixesLabel}</Text> : null}
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
  // shares the list's 20 dp inset and scrolls away with the first version. It is
  // a caption — smaller than a bullet and muted — and its 16 dp foot is the gap
  // above the first version heading.
  const header: ReactElement | null = NOTES_PENDING ? (
    <Text className="pb-4 text-xs text-muted-foreground">
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
