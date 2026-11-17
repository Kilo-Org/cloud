import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  type CustomBlockRenderer,
  TChildrenRenderer,
  TNodeChildrenRenderer,
} from '@native-html/render';
import { useTranslation } from 'react-i18next';

import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { ChevronDown } from '@/components/ui/icons';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { withRtlWritingDirection } from '@/lib/rtl-text';
import { cn } from '@/lib/utils';

/**
 * `<details>` as a collapsible block, collapsed unless it carries `open`. The
 * summary is a pressable row with a chevron; a details element without one
 * gets the browser's "Details" label.
 */
export const HtmlDetails: CustomBlockRenderer = function HtmlDetails({ tnode, style }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(tnode.attributes.open !== undefined);
  const [expandedNode, setExpandedNode] = useState(tnode);
  // A streaming publish can swap the node while this component instance stays
  // mounted, so the collapsed state must be re-read from the attribute that
  // arrives with it. Both updates are unconditional in render, so React
  // re-renders once with the new node and stops.
  if (expandedNode !== tnode) {
    setExpandedNode(tnode);
    setExpanded(tnode.attributes.open !== undefined);
  }
  const summary = tnode.children.find(child => child.tagName === 'summary');
  const body = tnode.children.filter(child => child !== summary);
  const iconColor = tnode.styles.nativeTextFlow.color?.toString();
  const Chevron = expanded ? ChevronDown : DirectionalChevronRight;
  return (
    <View style={style}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-1.5 active:opacity-70')}
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
            <Text style={withRtlWritingDirection(tnode.styles.nativeTextFlow)}>
              {t('common.details')}
            </Text>
          )}
        </View>
      </Pressable>
      {expanded ? <TChildrenRenderer tchildren={body} /> : null}
    </View>
  );
};
