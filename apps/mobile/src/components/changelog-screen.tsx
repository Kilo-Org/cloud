import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { MarkdownText } from '@/components/agents/markdown-text';
import { ScreenHeader } from '@/components/screen-header';
import { useSideInsetStyle } from '@/lib/screen-insets';

import changelog from '../../CHANGELOG.md';

/**
 * The release notes the app ships with. `CHANGELOG.md` is inlined into the
 * bundle as a string by babel-plugin-inline-import, so the screen always shows
 * the file the Release workflow wrote into this build.
 */
export function ChangelogScreen() {
  const { t } = useTranslation();
  const sideInsetStyle = useSideInsetStyle();

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profile.changelog')} />
      <ScrollView
        className="flex-1"
        contentContainerStyle={sideInsetStyle}
        contentContainerClassName="px-5 pt-4 pb-10"
        showsVerticalScrollIndicator={false}
      >
        <MarkdownText value={changelog} />
      </ScrollView>
    </View>
  );
}
