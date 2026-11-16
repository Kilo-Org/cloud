import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';

import { MarkdownText } from '@/components/agents/markdown-text';
import { ScreenHeader } from '@/components/screen-header';
import { useSideInsetStyle } from '@/lib/screen-insets';

import changelog from '../../CHANGELOG.md';
import { splitChangelogSections } from './changelog-sections';

/**
 * The release notes the app ships with. `CHANGELOG.md` is inlined into the
 * bundle as a string by babel-plugin-inline-import. The newest section here is
 * the release before this build: the Release workflow writes a build's section
 * after its submission lands, so the bytes this build compiled cannot carry
 * their own entry (it arrives in the next build's bundle).
 */
const CHANGELOG_SECTIONS = splitChangelogSections(changelog);

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
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<string>) => <MarkdownText value={item} />,
    []
  );

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profile.changelog')} />
      <View style={sideInsetStyle} className="flex-1">
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
