import { Check, X } from '@/components/ui/icons';
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { i18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { ChoiceRow } from '@/components/ui/choice-row';
import { RadioGroup } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';
import { type AgentSessionSortBy } from '@/lib/agent-session-sort';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { subscribePrivacyCover } from '@/lib/privacy-cover-events';
import { cn } from '@/lib/utils';

const PLATFORM_FILTERS = [
  'cloud-agent',
  'extension',
  'cli',
  'slack',
  'github',
  'linear',
  'other',
] as const;
const chipScrollContentStyle = { paddingHorizontal: 22, paddingVertical: 8, gap: 8 };

export type ProjectFilterOption = {
  gitUrl: string;
  displayName: string;
};

type SessionFilters = {
  platformFilter: string[];
  projectFilter: string[];
  sortBy: AgentSessionSortBy;
};

type SessionFilterChipsProps = Omit<SessionFilters, 'sortBy'> & {
  projectOptions: ProjectFilterOption[];
  onRemovePlatform: (platform: string) => void;
  onRemoveProject: (gitUrl: string) => void;
};

type SessionFilterModalProps = {
  selectedPlatforms: string[];
  selectedProjects: string[];
  selectedSortBy: AgentSessionSortBy;
  projectOptions: ProjectFilterOption[];
  onClose: () => void;
  onApply: (filters: SessionFilters) => void;
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
      return i18n.t('agentChat.sessionFilter.platformGithub');
    }
    case 'linear': {
      return i18n.t('agentChat.sessionFilter.platformLinear');
    }
    case 'other': {
      return i18n.t('agentChat.sessionFilter.platformOther');
    }
    default: {
      return p;
    }
  }
}

function projectFilterLabel(gitUrl: string, projectOptions: ProjectFilterOption[]): string {
  return projectOptions.find(project => project.gitUrl === gitUrl)?.displayName ?? gitUrl;
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

export function SessionFilterChips({
  platformFilter,
  projectFilter,
  projectOptions,
  onRemovePlatform,
  onRemoveProject,
}: Readonly<SessionFilterChipsProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();

  if (platformFilter.length === 0 && projectFilter.length === 0) {
    return null;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={chipScrollContentStyle}
    >
      {projectFilter.map(gitUrl => {
        const label = projectFilterLabel(gitUrl, projectOptions);
        return (
          <Pressable
            key={`project-${gitUrl}`}
            className="flex-row items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 active:opacity-70"
            onPress={() => {
              onRemoveProject(gitUrl);
            }}
            accessibilityRole="button"
            accessibilityLabel={t('agentChat.sessionFilter.removeProjectFilter', { label })}
          >
            <Text
              className="font-mono-medium text-[11px] uppercase tracking-[0.6px] text-accent-soft-foreground"
              numberOfLines={1}
            >
              {label}
            </Text>
            <X size={12} color={colors.accentSoftForeground} />
          </Pressable>
        );
      })}
      {platformFilter.map(platform => (
        <Pressable
          key={`platform-${platform}`}
          className="flex-row items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 active:opacity-70"
          onPress={() => {
            onRemovePlatform(platform);
          }}
          accessibilityRole="button"
          accessibilityLabel={t('agentChat.sessionFilter.removePlatformFilter', {
            label: platformFilterLabel(platform),
          })}
        >
          <Text className="font-mono-medium text-[11px] uppercase tracking-[0.6px] text-accent-soft-foreground">
            {platformFilterLabel(platform)}
          </Text>
          <X size={12} color={colors.accentSoftForeground} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

export function SessionFilterModal({
  selectedPlatforms,
  selectedProjects,
  selectedSortBy,
  projectOptions,
  onClose,
  onApply,
}: Readonly<SessionFilterModalProps>) {
  const { t } = useTranslation();
  const [draftPlatforms, setDraftPlatforms] = useState<string[]>(selectedPlatforms);
  const [draftProjects, setDraftProjects] = useState<string[]>(selectedProjects);
  const [draftSortBy, setDraftSortBy] = useState<AgentSessionSortBy>(selectedSortBy);
  const sortOptions: readonly { value: AgentSessionSortBy; label: string }[] = [
    { value: 'updated_at', label: t('agentChat.sessionFilter.sortLastUpdated') },
    { value: 'created_at', label: t('agentChat.sessionFilter.sortCreated') },
  ];

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
          <Text className="text-base font-semibold">{t('agentChat.sessionFilter.title')}</Text>
          <ScrollView showsVerticalScrollIndicator={false}>
            <View className="gap-4">
              <View className="gap-1">
                <Text variant="eyebrow" className="px-3">
                  {t('agentChat.sessionFilter.sortBy')}
                </Text>
                <RadioGroup label={t('agentChat.sessionFilter.sortBy')}>
                  {sortOptions.map(option => (
                    <ChoiceRow
                      key={option.value}
                      label={option.label}
                      selected={draftSortBy === option.value}
                      onPress={() => {
                        setDraftSortBy(option.value);
                      }}
                      className="rounded-lg px-3"
                    />
                  ))}
                </RadioGroup>
              </View>
              <View className="gap-1">
                <Text variant="eyebrow" className="px-3">
                  {t('agentChat.sessionFilter.platform')}
                </Text>
                {PLATFORM_FILTERS.map(platform => (
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
              {projectOptions.length > 0 && (
                <View className="gap-1">
                  <Text variant="eyebrow" className="px-3">
                    {t('agentChat.sessionFilter.project')}
                  </Text>
                  {projectOptions.map(project => (
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
                  sortBy: draftSortBy,
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
