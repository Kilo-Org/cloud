import { Check } from '@/components/ui/icons';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { i18n } from '@/i18n';
import { buildProjectRows, mergePlatformOptions } from '@/components/agents/platform-filter-rows';
import {
  knownPlatformBucket,
  PLATFORM_FILTERS,
  type ProjectFilterOption,
  projectOptionKey,
} from '@/components/agents/session-list-helpers';
import { SheetHeader } from '@/components/sheet-header';
import { RowGroup } from '@/components/ui/row-group';
import { Section } from '@/components/ui/section';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { selectableRowA11y } from '@/lib/a11y/selectable-row';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { type AgentSessionFilters } from '@/lib/agent-session-filters';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { platformLabel } from '@/lib/platform-label';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

export { type ProjectFilterOption };

// Android lays out this hosted footer at the expanded height, so use one
// full detent rather than hiding Apply below the partially visible sheet.
const SHEET_SNAP_POINTS = ['100%'];

type SessionFilterModalProps = {
  visible: boolean;
  selectedPlatforms: string[];
  selectedProjects: string[];
  projectOptions: ProjectFilterOption[];
  /** Platform rows to offer. Defaults to every known platform. */
  platformOptions?: readonly string[];
  onClose: () => void;
  onApply: (filters: AgentSessionFilters) => void;
};

type FilterCheckboxRowProps = {
  label: string;
  isChecked: boolean;
  onPress: () => void;
};

/** Every git URL that renders to one project label, offered as a single row. */
type ProjectFilterGroup = {
  gitUrls: string[];
  displayName: string;
};

function platformFilterLabel(p: string): string {
  switch (p) {
    case 'cloud-agent': {
      return i18n.t('agentChat.sessionFilter.platformCloud');
    }
    case 'extension': {
      return i18n.t('agentChat.sessionFilter.platformExtension');
    }
    case 'desktop': {
      return i18n.t('agentChat.sessionFilter.platformDesktop');
    }
    case 'cli': {
      return i18n.t('agentChat.sessionFilter.platformCli');
    }
    case 'slack': {
      return i18n.t('agentChat.sessionFilter.platformSlack');
    }
    case 'github': {
      return i18n.t('common.github');
    }
    case 'linear': {
      return i18n.t('agentChat.sessionFilter.platformLinear');
    }
    case 'other': {
      return i18n.t('agentChat.sessionFilter.platformOther');
    }
    default: {
      return platformLabel(p);
    }
  }
}

/** Collapse a persisted platform variant into the single bucket row it maps to.
 * An unknown platform keeps its own row. */
function normalisePlatform(platform: string): string {
  return knownPlatformBucket(platform) ?? platform;
}

function FilterCheckboxRow({ label, isChecked, onPress }: Readonly<FilterCheckboxRowProps>) {
  const colors = useThemeColors();

  return (
    <Pressable
      className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-3 px-4 py-3 active:opacity-70')}
      onPress={onPress}
      {...selectableRowA11y({ multi: true, selected: isChecked })}
    >
      <View
        className={cn(
          'h-5 w-5 items-center justify-center rounded border',
          isChecked ? 'border-primary bg-primary' : 'border-border bg-transparent'
        )}
      >
        {isChecked && <Check size={12} color={colors.primaryForeground} />}
      </View>
      <Text className="flex-1 text-sm" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function SessionFilterModal({
  visible,
  ...contentProps
}: Readonly<SessionFilterModalProps>) {
  const { onClose: handleClose } = contentProps;
  return (
    <Sheet
      visible={visible}
      onClose={handleClose}
      dismissGestures={false}
      snapPoints={SHEET_SNAP_POINTS}
    >
      <SessionFilterContent {...contentProps} />
    </Sheet>
  );
}

function SessionFilterContent({
  selectedPlatforms,
  selectedProjects,
  projectOptions,
  platformOptions = PLATFORM_FILTERS,
  onClose,
  onApply,
}: Readonly<Omit<SessionFilterModalProps, 'visible'>>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [draftPlatforms, setDraftPlatforms] = useState<string[]>(() => [
    ...new Set(selectedPlatforms.map(platform => normalisePlatform(platform))),
  ]);
  const [draftProjects, setDraftProjects] = useState<string[]>(selectedProjects);
  // The sheet re-renders on every checkbox toggle, so the merged platform rows
  // and the project lookup derive from the props only. Keying the memos on those
  // props keeps the derived values stable while the draft selection changes, so
  // a toggle never rebuilds the recent-repository map.
  const platforms = useMemo(
    () =>
      mergePlatformOptions(
        platformOptions,
        selectedPlatforms.map(platform => normalisePlatform(platform))
      ),
    [platformOptions, selectedPlatforms]
  );
  // One row per visible project label, in first-seen order. Two git URLs that
  // `formatGitUrlProject` renders identically (https vs ssh, a `.git` suffix,
  // host case) share a group, so the sheet never shows the same project twice.
  const projectGroups = useMemo(() => {
    const groups = new Map<string, ProjectFilterGroup>();
    for (const project of buildProjectRows(projectOptions, selectedProjects).values()) {
      const key = projectOptionKey(project.gitUrl);
      const group = groups.get(key);
      if (group) {
        if (!group.gitUrls.includes(project.gitUrl)) {
          group.gitUrls.push(project.gitUrl);
        }
      } else {
        groups.set(key, { gitUrls: [project.gitUrl], displayName: project.displayName });
      }
    }
    return groups;
  }, [projectOptions, selectedProjects]);

  const togglePlatform = (platform: string) => {
    setDraftPlatforms(prev =>
      prev.includes(platform) ? prev.filter(value => value !== platform) : [...prev, platform]
    );
  };

  // Toggle the whole group: every alias is stored or removed together, so the
  // server query keeps the sessions of both variants filtered in.
  const toggleProjectGroup = (group: ProjectFilterGroup) => {
    setDraftProjects(prev =>
      group.gitUrls.some(gitUrl => prev.includes(gitUrl))
        ? prev.filter(gitUrl => !group.gitUrls.includes(gitUrl))
        : [...prev, ...group.gitUrls.filter(gitUrl => !prev.includes(gitUrl))]
    );
  };

  return (
    <View className="flex-1">
      <SheetHeader
        title={t('agentChat.sessionFilter.title')}
        onDone={() => {
          onApply({
            platformFilter: draftPlatforms,
            projectFilter: draftProjects,
          });
          onClose();
        }}
        doneLabel={t('common.apply')}
        onCancel={onClose}
        topInset="ios-page-sheet"
      />
      <ScrollView
        nestedScrollEnabled
        className="flex-1"
        contentContainerClassName={cn(SCREEN_BODY_CLASS, 'pb-6')}
        showsVerticalScrollIndicator={false}
      >
        {/* The rows are derived from the live sessions, so a list whose rows all
            have an unknown origin (`liveSessionPlatformBucket` returns null)
            offers no platform at all and nothing is selected. Rendering the
            label then leaves an orphaned section header above PROJECT (spot
            defect e4-filter); the section is omitted exactly as PROJECT already
            is when it has no rows. */}
        {platforms.length > 0 ? (
          <Section label={t('common.platform')}>
            <RowGroup>
              {platforms.map(platform => (
                <FilterCheckboxRow
                  key={platform}
                  label={platformFilterLabel(platform)}
                  isChecked={draftPlatforms.includes(platform)}
                  onPress={() => {
                    togglePlatform(platform);
                  }}
                />
              ))}
            </RowGroup>
          </Section>
        ) : null}
        {projectGroups.size > 0 ? (
          <Section label={t('agentChat.sessionFilter.project')}>
            <RowGroup>
              {[...projectGroups.entries()].map(([key, group]) => (
                <FilterCheckboxRow
                  key={key}
                  label={group.displayName}
                  isChecked={group.gitUrls.some(gitUrl => draftProjects.includes(gitUrl))}
                  onPress={() => {
                    toggleProjectGroup(group);
                  }}
                />
              ))}
            </RowGroup>
          </Section>
        ) : null}
      </ScrollView>
      <View style={{ height: insets.bottom }} />
    </View>
  );
}
