import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import * as Application from 'expo-application';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';

import { MarkdownText } from '@/components/agents/markdown-text';
import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { MIN_TAP_TARGET_DP } from '@/lib/a11y/tap-target';
import { useSideInsetStyle } from '@/lib/screen-insets';

import changelog from '../../CHANGELOG.md';
import { changelogNotesArePending, splitChangelogSections } from './changelog-sections';

/**
 * The release notes the app ships with. `CHANGELOG.md` is inlined into the
 * bundle as a string by babel-plugin-inline-import. The newest section here is
 * the release before this build: the Release workflow writes a build's section
 * after its submission lands, so the bytes this build compiled cannot carry
 * their own entry (it arrives in the next build's bundle).
 */
const CHANGELOG_SECTIONS = splitChangelogSections(changelog);

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

const keyExtractor = (_section: string, index: number) => String(index);

export function ChangelogScreen() {
  const { t } = useTranslation();
  const sideInsetStyle = useSideInsetStyle();
  // Every release bullet ends in an inline PR link, and the native markdown
  // renderer exposes that link's rectangle and accepts its tap as the text line
  // box. A span carries no box and no `hitSlop`, so this screen alone raises
  // the body line height to the inline-link target floor.
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<string>) => (
      <MarkdownText value={item} lineHeight={MIN_TAP_TARGET_DP} />
    ),
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
