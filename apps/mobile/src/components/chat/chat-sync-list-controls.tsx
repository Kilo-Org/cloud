import { useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SearchField } from '@/components/ui/search-field';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { SCREEN_GUTTER_CLASS } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { type ChatListFilters } from '@/lib/chat/sync/sync-list';

/**
 * The synced list's filters: title search, origin (all, mobile, CLI), and
 * whether archived sessions join the list. The search text lives in a ref
 * (iOS drops keystrokes under a controlled value); state carries only what
 * the field and the query read.
 */
export function ChatSyncListControls({
  filters,
  onChange,
}: {
  readonly filters: ChatListFilters;
  readonly onChange: (filters: ChatListFilters) => void;
}) {
  const { t } = useTranslation();
  const textRef = useRef(filters.q);
  const [hasText, setHasText] = useState(filters.q !== '');
  return (
    <View className={cn(SCREEN_GUTTER_CLASS, 'gap-3 pb-3 pt-2')}>
      <SearchField
        placeholder={t('modelChat.sync.searchPlaceholder')}
        hasText={hasText}
        onChangeText={text => {
          textRef.current = text;
          setHasText(text !== '');
          onChange({ ...filters, q: text });
        }}
        onClear={() => {
          textRef.current = '';
          setHasText(false);
          onChange({ ...filters, q: '' });
        }}
      />
      <SegmentedControl
        accessibilityLabel={t('modelChat.sync.originFilter')}
        semantics="tabs"
        value={filters.origin}
        onChange={origin => {
          onChange({ ...filters, origin });
        }}
        options={[
          { value: 'all', label: t('common.all') },
          { value: 'mobile', label: t('modelChat.sync.originMobile') },
          { value: 'cli', label: t('agentChat.sessionFilter.platformCli') },
        ]}
      />
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1">{t('modelChat.sync.includeArchived')}</Text>
        <Switch
          accessibilityLabel={t('modelChat.sync.includeArchived')}
          value={filters.includeArchived}
          onValueChange={checked => {
            onChange({ ...filters, includeArchived: checked });
          }}
        />
      </View>
    </View>
  );
}
