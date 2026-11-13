import {
  COUNCIL_AGGREGATION_STRATEGIES,
  COUNCIL_MIN_SPECIALISTS,
  COUNCIL_SPECIALIST_PRESETS,
} from '@kilocode/app-shared/code-review';
import { type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { ReviewerErrorScreen } from '@/components/code-reviewer/reviewer-error-screen';
import { ReviewerHeader } from '@/components/code-reviewer/reviewer-header';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { ToggleRow } from '@/components/security-agent/settings-toggle-row';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Input } from '@/components/ui/input';
import { RadioGroup } from '@/components/ui/radio-group';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import {
  type CouncilConfig,
  PLATFORM_CAPABILITIES,
  type ReviewerPlatform,
} from '@/lib/code-reviewer-config';
import {
  parseRequiredLabels,
  specialistCopy,
  STRATEGY_DESCRIPTION_KEYS,
  STRATEGY_LABEL_KEYS,
} from '@/lib/code-reviewer-council';
import {
  useGitHubRepositories,
  useGitLabRepositories,
  useReviewConfig,
  useReviewerPermission,
  useSaveReviewConfig,
} from '@/lib/hooks/use-code-reviewer';
import { reviewConfigFailure, useReviewConfigBody } from '@/lib/hooks/use-review-config-body';
import {
  defaultCouncilConfig,
  enabledSpecialistCount,
  useCouncilGate,
} from '@/lib/hooks/use-reviewer-council';
import { useReviewerRouteParams } from '@/lib/hooks/use-reviewer-route-params';

export default function CouncilRoute() {
  const params = useReviewerRouteParams();
  if (!params) {
    return <InvalidRouteState backTo={'/(app)/code-reviewer' as Href} />;
  }
  return <CouncilScreen scope={params.scope} platform={params.platform} />;
}

function CouncilScreen({
  scope,
  platform,
}: Readonly<{ scope: string; platform: ReviewerPlatform }>) {
  const { t } = useTranslation();
  // The same gate as the web page: an entitled organization behind the rollout
  // flag. A personal scope, an unentitled org, or a build older than the flag
  // never reaches the rows below. Bitbucket has no council on either client.
  const gate = useCouncilGate(scope);
  const councilUiEnabled = gate.allowed && PLATFORM_CAPABILITIES[platform].council;
  const config = useReviewConfig(scope, platform, { enabled: councilUiEnabled });
  const configBody = useReviewConfigBody(config, { restartable: councilUiEnabled });
  const save = useSaveReviewConfig(scope, platform);
  const permission = useReviewerPermission(scope);
  const githubRepos = useGitHubRepositories(scope, councilUiEnabled && platform === 'github');
  const gitlabRepos = useGitLabRepositories(scope, councilUiEnabled && platform === 'gitlab');
  // Both scopes' repository reads carry the same `repositories` list; only the
  // id/name pair is needed here, so each is narrowed to that shape once.
  const githubRows = githubRepos.data?.repositories ?? [];
  const gitlabRows = gitlabRepos.data?.repositories ?? [];
  const repositories = (platform === 'github' ? githubRows : gitlabRows).map(repository => ({
    id: repository.id,
    fullName: repository.fullName,
  }));
  const canEdit = permission.status === 'ready' && permission.canEdit;

  const stored = config.data?.council;
  const council = stored ?? defaultCouncilConfig();
  const selectedIds = config.data?.selectedRepositoryIds ?? [];
  const councilRepoIds = config.data?.councilEnabledRepositoryIds ?? [];
  const specialists = enabledSpecialistCount(council);
  const belowMinimum = specialists < COUNCIL_MIN_SPECIALISTS;

  // The labels field is a draft with an explicit commit (its own field, unlike
  // the switches), so it starts from the saved list and only follows the server
  // when a save changes it — a background refetch must not overwrite typing.
  const savedLabels = (config.data?.council?.required_labels ?? []).join(', ');
  const [labelsText, setLabelsText] = useState(savedLabels);
  const [labelsBaseline, setLabelsBaseline] = useState(savedLabels);
  useEffect(() => {
    if (labelsBaseline === savedLabels) {
      return;
    }
    setLabelsBaseline(savedLabels);
    setLabelsText(savedLabels);
  }, [labelsBaseline, savedLabels]);

  if (gate.pending || !gate.allowed) {
    // An in-flight entitlement read keeps the surface blank rather than telling
    // an entitled organization that council is unavailable while it resolves;
    // only a settled refusal shows that message.
    const settledRefusal = !gate.pending && !gate.allowed;
    return (
      <View className="flex-1 bg-background">
        <ReviewerHeader
          title={t('codeReviewer.council.title')}
          eyebrow={t('common.codeReviewer')}
        />
        {settledRefusal || !PLATFORM_CAPABILITIES[platform].council ? (
          <CenteredState contentContainerClassName="px-6">
            <Text className="text-center text-xs text-muted-foreground">
              {t('codeReviewer.council.unavailable')}
            </Text>
          </CenteredState>
        ) : (
          <View className="gap-3 px-6 pt-4">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
          </View>
        )}
      </View>
    );
  }

  const failure = reviewConfigFailure(configBody, config.isFetching);
  if (failure) {
    return (
      <ReviewerErrorScreen
        title={t('codeReviewer.council.title')}
        variant={failure.variant}
        onRetry={() => {
          failure.onRetry();
        }}
        isRetrying={failure.isRetrying}
      />
    );
  }

  const disabled = !canEdit || save.isPending || configBody.body.status !== 'ready';
  const councilOn = council.enabled && !belowMinimum;
  const selectedRepositories = repositories.filter(repository =>
    selectedIds.includes(repository.id)
  );

  const writeCouncil = (next: CouncilConfig) => {
    save.mutate({ council: next });
  };

  const setSpecialistEnabled = (id: string, value: boolean) => {
    if (council.specialists.some(specialist => specialist.id === id)) {
      writeCouncil({
        ...council,
        specialists: council.specialists.map(specialist =>
          specialist.id === id ? { ...specialist, enabled: value } : specialist
        ),
      });
      return;
    }
    const preset = COUNCIL_SPECIALIST_PRESETS.find(candidate => candidate.id === id);
    if (!preset) {
      return;
    }
    writeCouncil({
      ...council,
      specialists: [
        ...council.specialists,
        {
          id: preset.id,
          role: preset.role,
          name: preset.name,
          enabled: value,
          required: false,
          lens: preset.lens,
        },
      ],
    });
  };

  const commitLabels = () => {
    const parsed = parseRequiredLabels(labelsText);
    if (parsed.join(', ') === (config.data?.council?.required_labels ?? []).join(', ')) {
      return;
    }
    writeCouncil({ ...council, required_labels: parsed });
  };

  const setRepositoryEnabled = (repositoryId: number | string, value: boolean) => {
    save.mutate({
      councilEnabledRepositoryIds: value
        ? [...new Set([...councilRepoIds, repositoryId])]
        : councilRepoIds.filter(existing => existing !== repositoryId),
    });
  };

  return (
    <View className="flex-1 bg-background">
      <ReviewerHeader title={t('codeReviewer.council.title')} eyebrow={t('common.codeReviewer')} />
      <TabScreenScrollView className="flex-1" contentContainerClassName="gap-6 px-6 pt-4">
        <View className="gap-2">
          <ToggleRow
            title={t('codeReviewer.council.title')}
            subtitle={t('codeReviewer.council.subtitle')}
            value={council.enabled}
            disabled={disabled || (belowMinimum && !council.enabled)}
            onValueChange={value => {
              writeCouncil({ ...council, enabled: value });
            }}
          />
          {belowMinimum ? (
            <Text variant="muted" className="text-xs" accessibilityLiveRegion="polite">
              {t('codeReviewer.council.minSpecialists', {
                minimum: formatNumber(COUNCIL_MIN_SPECIALISTS, i18n.language),
                selected: formatNumber(specialists, i18n.language),
              })}
            </Text>
          ) : null}
        </View>

        <View className="gap-2">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('common.repositories')}
          </Text>
          {selectedRepositories.length === 0 ? (
            <Text variant="muted" className="text-xs">
              {t('codeReviewer.council.noRepositories')}
            </Text>
          ) : (
            selectedRepositories.map(repository => (
              <ToggleRow
                key={repository.id}
                title={repository.fullName}
                value={councilRepoIds.includes(repository.id)}
                disabled={disabled || !councilOn}
                onValueChange={value => {
                  setRepositoryEnabled(repository.id, value);
                }}
              />
            ))
          )}
        </View>

        <View className="gap-2">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('codeReviewer.council.specialists')}
          </Text>
          {COUNCIL_SPECIALIST_PRESETS.map(preset => {
            const copy = specialistCopy(preset.id);
            return (
              <ToggleRow
                key={preset.id}
                title={t(copy.nameKey)}
                subtitle={t(copy.descriptionKey)}
                value={council.specialists.some(
                  specialist => specialist.id === preset.id && specialist.enabled
                )}
                disabled={disabled}
                onValueChange={value => {
                  setSpecialistEnabled(preset.id, value);
                }}
              />
            );
          })}
        </View>

        <View className="gap-2">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('codeReviewer.reviewDetail.decision')}
          </Text>
          <RadioGroup label={t('codeReviewer.reviewDetail.decision')}>
            {COUNCIL_AGGREGATION_STRATEGIES.map(strategy => (
              <ChoiceRow
                key={strategy}
                label={t(STRATEGY_LABEL_KEYS[strategy])}
                description={t(STRATEGY_DESCRIPTION_KEYS[strategy])}
                selected={council.aggregation_strategy === strategy}
                disabled={disabled}
                className="border-b-[0.5px] border-hair-soft"
                onPress={() => {
                  writeCouncil({ ...council, aggregation_strategy: strategy });
                }}
              />
            ))}
          </RadioGroup>
        </View>

        <View className="gap-2">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('codeReviewer.council.labels')}
          </Text>
          <Input
            value={labelsText}
            editable={!disabled}
            accessibilityLabel={t('codeReviewer.council.labels')}
            placeholder={t('codeReviewer.council.labelsPlaceholder')}
            onChangeText={setLabelsText}
            onEndEditing={commitLabels}
            onSubmitEditing={commitLabels}
          />
          <Text variant="muted" className="text-xs">
            {t('codeReviewer.council.labelsDescription')}
          </Text>
        </View>

        {!canEdit ? (
          <Text variant="muted" className="text-center text-xs">
            {t('securityAgent.sla.permissionNote')}
          </Text>
        ) : null}
      </TabScreenScrollView>
    </View>
  );
}
