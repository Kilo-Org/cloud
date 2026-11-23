import { type ComponentType, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  type CustomRendererProps,
  type TBlock,
  TChildrenRenderer,
  TNodeChildrenRenderer,
} from '@native-html/render';
import { useTranslation } from 'react-i18next';

import { ChevronDown, ChevronUp } from '@/components/ui/icons';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { withRtlWritingDirection } from '@/lib/rtl-text';
import { cn } from '@/lib/utils';

type HtmlDetailsProps = CustomRendererProps<TBlock> & { resetKey: string };

/**
 * `<details>` as a collapsible block, collapsed unless it carries `open`. The
 * summary is a pressable row with a chevron; a details element without one
 * gets the browser's "Details" label.
 */
export const HtmlDetails: ComponentType<HtmlDetailsProps> = function HtmlDetails({
  tnode,
  style,
  resetKey,
}) {
  const { t } = useTranslation();
  const open = tnode.attributes.open !== undefined;
  const [expanded, setExpanded] = useState(open);
  const [expandedOpen, setExpandedOpen] = useState(open);
  // The engine keys children by their structural path, so a different
  // `<details>` element rendered at the same path (a recycled row, a new part
  // in the same sheet) reuses this instance. Reset to the incoming element's
  // own `open` presence during render, before anything from the last one
  // shows.
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    setExpanded(open);
    setExpandedOpen(open);
  } else if (expandedOpen !== open) {
    // A streaming publish can swap the node while this component instance stays
    // mounted, and the `open` attribute can arrive in that later publish. The
    // state re-reads the attribute only when its presence changes: a reader's
    // own expansion of a details element without the attribute survives every
    // publish of the same segment, because an absent `open` never resets state.
    setExpandedOpen(open);
    setExpanded(open);
  }
  const summary = tnode.children.find(child => child.tagName === 'summary');
  const body = tnode.children.filter(child => child !== summary);
  const iconColor = tnode.styles.nativeTextFlow.color?.toString();
  // A disclosure caret, not a navigation chevron: it names the block's state,
  // and its up/down pair reads the same in either writing direction (the
  // transcript's other disclosures use the same pair).
  const Chevron = expanded ? ChevronUp : ChevronDown;
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
