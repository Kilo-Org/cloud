import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  type CustomBlockRenderer,
  TChildrenRenderer,
  TNodeChildrenRenderer,
} from '@native-html/render';
import { useTranslation } from 'react-i18next';

import { ChevronDown, ChevronRight } from '@/components/ui/icons';

/**
 * `<details>` as a collapsible block, collapsed unless it carries `open`. The
 * summary is a pressable row with a chevron; a details element without one
 * gets the browser's "Details" label.
 */
export const HtmlDetails: CustomBlockRenderer = function HtmlDetails({ tnode, style }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(tnode.attributes.open !== undefined);
  const summary = tnode.children.find(child => child.tagName === 'summary');
  const body = tnode.children.filter(child => child !== summary);
  const iconColor = tnode.styles.nativeTextFlow.color?.toString();
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <View style={style}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        className="min-h-11 flex-row items-center gap-1.5 active:opacity-70"
        onPress={() => {
          setExpanded(current => !current);
        }}
      >
        <Chevron size={16} color={iconColor} />
        {/* Selectable summary text would take the tap on Android; the row owns it. */}
        <View className="pointer-events-none flex-1">
          {summary ? (
            <TNodeChildrenRenderer tnode={summary} />
          ) : (
            <Text style={tnode.styles.nativeTextFlow}>{t('common.details')}</Text>
          )}
        </View>
      </Pressable>
      {expanded ? <TChildrenRenderer tchildren={body} /> : null}
    </View>
  );
};
