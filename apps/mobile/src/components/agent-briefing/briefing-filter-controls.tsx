import { type ComponentRef, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { I18nManager, Platform, ScrollView } from 'react-native';

import { FilterChip } from '@/components/ui/filter-chip';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { tabEntryA11y } from '@/lib/a11y/tab-entry';

type BriefingOrganizationFilter = {
  organizationId: string;
  organizationName: string;
};

type BriefingFilterControlsProps = {
  /** True while the history list replaces the available reports. */
  history: boolean;
  onSelectHistory: (history: boolean) => void;
  /**
   * `undefined` reads every context, `null` personal only, and an organization
   * id narrows the list to that membership.
   */
  organizationId: string | null | undefined;
  organizations: readonly BriefingOrganizationFilter[];
  onSelectOrganization: (organizationId: string | null | undefined) => void;
};

const VIEW_OPTIONS = [
  { value: 'available' as const, labelKey: 'agentBriefing.available' },
  { value: 'history' as const, labelKey: 'agentBriefing.history' },
];

/**
 * The available/History switch and the context filter chips above the briefing
 * list. The switch is a `SegmentedControl`, the control every other view switch
 * in the app uses; chips stay for the filters, so the two rows keep their
 * hierarchy. Both rows pick one option at a time, so every option carries
 * `accessibilityState.selected` for the active one; the chips row announces as
 * a tablist, and each row carries the name that says what its options narrow.
 */
export function BriefingFilterControls({
  history,
  onSelectHistory,
  organizationId,
  organizations,
  onSelectOrganization,
}: Readonly<BriefingFilterControlsProps>) {
  const { t } = useTranslation();
  // iOS anchors a horizontal scroller's content to the physical left edge, so a
  // chip row wider than its box hides its start chip past the box in a
  // right-to-left interface (measured on iOS 26.5: a 394 pt row in a 374 pt box
  // put the first chip 20 pt beyond it, cut at the screen edge). Once the
  // content has a size the row moves itself to the interface's start edge; a
  // row that fits, and every left-to-right cell, is left untouched.
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const rowWidth = useRef(0);
  const contentWidth = useRef(0);
  const alignToStartEdge = useCallback(() => {
    if (Platform.OS !== 'ios' || !I18nManager.isRTL) {
      return;
    }
    const offset = contentWidth.current - rowWidth.current;
    if (offset > 0) {
      scroller.current?.scrollTo({ x: offset, animated: false });
    }
  }, []);
  return (
    <>
      <SegmentedControl
        options={VIEW_OPTIONS.map(option => ({
          value: option.value,
          label: t(option.labelKey),
        }))}
        value={history ? 'history' : 'available'}
        onChange={value => {
          onSelectHistory(value === 'history');
        }}
        // The switch has no visible group name of its own; the screen title
        // names it without adding copy.
        accessibilityLabel={t('agentBriefing.title')}
      />
      {/* One row that scrolls sideways. The row bleeds past the block's own
          gutter through the negative margin and paints that gutter inside its
          content instead, so the first chip starts on the gutter and the last
          one can reach the screen edge — inside a padded parent the row clipped
          its trailing chip at the padding edge, and in RTL that cut the last
          chip's label ("lab org" for a longer name). */}
      <ScrollView
        ref={scroller}
        horizontal
        showsHorizontalScrollIndicator={false}
        className="-mx-4 grow-0"
        contentContainerClassName="items-center gap-2 px-4"
        accessibilityRole="tablist"
        accessibilityLabel={t('agentBriefing.filterByContext')}
        onLayout={event => {
          rowWidth.current = event.nativeEvent.layout.width;
          alignToStartEdge();
        }}
        onContentSizeChange={width => {
          contentWidth.current = width;
          alignToStartEdge();
        }}
      >
        <FilterChip
          {...tabEntryA11y({ selected: organizationId === undefined })}
          selected={organizationId === undefined}
          label={t('agentBriefing.contextAll')}
          onPress={() => {
            onSelectOrganization(undefined);
          }}
        />
        <FilterChip
          {...tabEntryA11y({ selected: organizationId === null })}
          selected={organizationId === null}
          label={t('common.personal')}
          onPress={() => {
            onSelectOrganization(null);
          }}
        />
        {organizations.map(organization => (
          <FilterChip
            key={organization.organizationId}
            {...tabEntryA11y({ selected: organizationId === organization.organizationId })}
            selected={organizationId === organization.organizationId}
            label={organization.organizationName}
            onPress={() => {
              onSelectOrganization(organization.organizationId);
            }}
          />
        ))}
      </ScrollView>
    </>
  );
}
