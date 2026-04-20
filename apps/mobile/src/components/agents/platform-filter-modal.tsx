import { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { Check, X } from 'lucide-react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const PLATFORM_FILTERS = ['cloud-agent', 'extension', 'cli', 'slack', 'other'] as const;
const chipScrollContentStyle = { paddingHorizontal: 16, paddingVertical: 8, gap: 8 };

export type ProjectFilterOption = {
  gitUrl: string;
  displayName: string;
};

type SessionFilters = {
  platformFilter: string[];
  projectFilter: string[];
};

type SessionFilterChipsProps = SessionFilters & {
  projectOptions: ProjectFilterOption[];
  onRemovePlatform: (platform: string) => void;
  onRemoveProject: (gitUrl: string) => void;
};

type SessionFilterModalProps = {
  selectedPlatforms: string[];
  selectedProjects: string[];
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
      return 'Cloud';
    }
    case 'extension': {
      return 'Extension';
    }
    case 'cli': {
      return 'CLI';
    }
    case 'slack': {
      return 'Slack';
    }
    case 'other': {
      return 'Other';
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
            className="flex-row items-center gap-1 rounded-full bg-secondary px-3 py-1"
            onPress={() => {
              onRemoveProject(gitUrl);
            }}
            accessibilityLabel={`Remove ${label} project filter`}
          >
            <Text className="text-xs font-medium" numberOfLines={1}>
              {label}
            </Text>
            <X size={12} color={colors.mutedForeground} />
          </Pressable>
        );
      })}
      {platformFilter.map(platform => (
        <Pressable
          key={`platform-${platform}`}
          className="flex-row items-center gap-1 rounded-full bg-secondary px-3 py-1"
          onPress={() => {
            onRemovePlatform(platform);
          }}
          accessibilityLabel={`Remove ${platformFilterLabel(platform)} platform filter`}
        >
          <Text className="text-xs font-medium">{platformFilterLabel(platform)}</Text>
          <X size={12} color={colors.mutedForeground} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

export function SessionFilterModal({
  selectedPlatforms,
  selectedProjects,
  projectOptions,
  onClose,
  onApply,
}: Readonly<SessionFilterModalProps>) {
  const [draftPlatforms, setDraftPlatforms] = useState<string[]>(selectedPlatforms);
  const [draftProjects, setDraftProjects] = useState<string[]>(selectedProjects);

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
      <Pressable className="flex-1 justify-start px-6 pt-[20%]" onPress={onClose}>
        <View className="absolute inset-0 bg-black opacity-50" />
        <Pressable
          className="rounded-xl bg-card p-5 gap-4"
          onPress={e => {
            e.stopPropagation();
          }}
        >
          <Text className="text-base font-semibold">Filter Sessions</Text>
          <ScrollView showsVerticalScrollIndicator={false}>
            <View className="gap-4">
              <View className="gap-1">
                <Text className="px-3 text-xs font-semibold uppercase text-muted-foreground">
                  Platform
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
                  <Text className="px-3 text-xs font-semibold uppercase text-muted-foreground">
                    Project
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
              <Text>Cancel</Text>
            </Button>
            <Button
              onPress={() => {
                onApply({ platformFilter: draftPlatforms, projectFilter: draftProjects });
                onClose();
              }}
            >
              <Text className="text-primary-foreground">Apply</Text>
            </Button>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
