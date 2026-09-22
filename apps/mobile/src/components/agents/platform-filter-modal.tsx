import { Check } from '@/components/ui/icons';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { i18n } from '@/i18n';
import {
  formatGitUrlProject,
  PLATFORM_FILTERS,
  type ProjectFilterOption,
} from '@/components/agents/session-list-helpers';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { type AgentSessionFilters } from '@/lib/agent-session-filters';
import { platformLabel } from '@/lib/platform-label';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

export { type ProjectFilterOption };

/** Gap kept between the sheet and the window edges (matches the `px-6` gutter). */
const SHEET_EDGE_MARGIN = 24;

type SessionFilterModalProps = {
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

function platformFilterLabel(p: string): string {
  switch (p) {
    case 'cloud-agent': {
      return i18n.t('agentChat.sessionFilter.platformCloud');
    }
    case 'extension': {
      return i18n.t('agentChat.sessionFilter.platformExtension');
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

function FilterCheckboxRow({ label, isChecked, onPress }: Readonly<FilterCheckboxRowProps>) {
  const colors = useThemeColors();

  return (
    <Pressable
      className="flex-row items-center gap-3 rounded-lg px-3 py-2.5 active:bg-secondary"
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: isChecked }}
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
  selectedPlatforms,
  selectedProjects,
  projectOptions,
  platformOptions = PLATFORM_FILTERS,
  onClose,
  onApply,
}: Readonly<SessionFilterModalProps>) {
  const { t } = useTranslation();
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Yoga resolves vertical percentage padding against the parent's WIDTH, so the
  // old `pt-[20%]` grew with the screen width and pushed the pinned Cancel/Apply
  // row past the bottom of a short (landscape) window. Cap the sheet to the
  // window minus the safe areas instead: the option list then scrolls inside the
  // card and the action row stays visible.
  const sheetMaxHeight = Math.max(
    0,
    windowHeight - insets.top - insets.bottom - SHEET_EDGE_MARGIN * 2
  );
  const [draftPlatforms, setDraftPlatforms] = useState<string[]>(selectedPlatforms);
  const [draftProjects, setDraftProjects] = useState<string[]>(selectedProjects);
  const platforms = [...new Set([...platformOptions, ...selectedPlatforms])];
  const projectsByUrl = new Map(projectOptions.map(project => [project.gitUrl, project]));
  for (const gitUrl of selectedProjects) {
    if (!projectsByUrl.has(gitUrl)) {
      projectsByUrl.set(gitUrl, { gitUrl, displayName: formatGitUrlProject(gitUrl) });
    }
  }

  const togglePlatform = (platform: string) => {
    setDraftPlatforms(prev =>
      prev.includes(platform) ? prev.filter(value => value !== platform) : [...prev, platform]
    );
  };

  const toggleProject = (gitUrl: string) => {
    setDraftProjects(prev =>
      prev.includes(gitUrl) ? prev.filter(value => value !== gitUrl) : [...prev, gitUrl]
    );
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        // Backdrop tap-to-dismiss. accessible={false} so it doesn't collapse the
        // whole sheet subtree into a single VoiceOver node (Pressable defaults to
        // accessible=true) — the inner controls stay individually navigable.
        accessible={false}
        className="flex-1 justify-center px-6"
        style={{
          paddingTop: insets.top + SHEET_EDGE_MARGIN,
          paddingBottom: insets.bottom + SHEET_EDGE_MARGIN,
        }}
        onPress={onClose}
      >
        <View className="absolute inset-0 bg-black opacity-50" />
        <Pressable
          // Catches taps to stop backdrop dismissal; accessible={false} so the
          // checkboxes/buttons inside stay individually navigable by VoiceOver
          // (a pressable defaults to accessible=true and would collapse them).
          accessible={false}
          // Bounded so the row list can grow to the server's full recent-repository
          // set without pushing the Apply/Cancel row off-screen: the ScrollView
          // below shrinks into this cap and scrolls. The inline maxHeight tightens
          // that bound to the visible window minus the safe-area insets.
          className="max-h-[80%] gap-4 rounded-2xl bg-popover p-5"
          style={{ maxHeight: sheetMaxHeight }}
          onPress={e => {
            e.stopPropagation();
          }}
        >
          <Text accessibilityRole="header" className="text-center text-base font-semibold">
            {t('agentChat.sessionFilter.title')}
          </Text>
          <ScrollView className="shrink" showsVerticalScrollIndicator={false}>
            <View className="gap-4">
              <View className="gap-1">
                <Text variant="eyebrow" className="px-3">
                  {t('common.platform')}
                </Text>
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
              </View>
              {projectsByUrl.size > 0 && (
                <View className="gap-1">
                  <Text variant="eyebrow" className="px-3">
                    {t('agentChat.sessionFilter.project')}
                  </Text>
                  {[...projectsByUrl.values()].map(project => (
                    <FilterCheckboxRow
                      key={project.gitUrl}
                      label={project.displayName}
                      isChecked={draftProjects.includes(project.gitUrl)}
                      onPress={() => {
                        toggleProject(project.gitUrl);
                      }}
                    />
                  ))}
                </View>
              )}
            </View>
          </ScrollView>
          <View className="flex-row justify-end gap-3">
            <Button variant="outline" onPress={onClose}>
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button
              onPress={() => {
                onApply({
                  platformFilter: draftPlatforms,
                  projectFilter: draftProjects,
                });
                onClose();
              }}
            >
              <Text className="text-primary-foreground">{t('common.apply')}</Text>
            </Button>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
