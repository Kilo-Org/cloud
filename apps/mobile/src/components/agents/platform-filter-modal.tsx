import { Check } from '@/components/ui/icons';
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
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
import { subscribePrivacyCover } from '@/lib/privacy-cover-events';
import { cn } from '@/lib/utils';

export { type ProjectFilterOption };

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
      return i18n.t(
        // i18n-dup-ok: 'common.github' — sole key for this copy; the base-catalog twin this scan cites was removed by the catalog consolidation
        'common.github'
      );
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

  // Close when the privacy cover fires (app backgrounds on a covered route).
  useEffect(() => subscribePrivacyCover(onClose), [onClose]);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        // Backdrop tap-to-dismiss. accessible={false} so it doesn't collapse the
        // whole sheet subtree into a single VoiceOver node (Pressable defaults to
        // accessible=true) — the inner controls stay individually navigable.
        accessible={false}
        className="flex-1 justify-start px-6 pt-[20%]"
        onPress={onClose}
      >
        <View className="absolute inset-0 bg-black opacity-50" />
        <Pressable
          // Catches taps to stop backdrop dismissal; accessible={false} so the
          // checkboxes/buttons inside stay individually navigable by VoiceOver
          // (a pressable defaults to accessible=true and would collapse them).
          accessible={false}
          className="gap-4 rounded-2xl bg-popover p-5"
          onPress={e => {
            e.stopPropagation();
          }}
        >
          <Text accessibilityRole="header" className="text-center text-base font-semibold">
            {t('agentChat.sessionFilter.title')}
          </Text>
          <ScrollView showsVerticalScrollIndicator={false}>
            <View className="gap-4">
              <View className="gap-1">
                <Text variant="eyebrow" className="px-3">
                  {t(
                    // i18n-dup-ok: 'common.platform' — sole key for this copy; the base-catalog twin this scan cites was removed by the catalog consolidation
                    'common.platform'
                  )}
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
