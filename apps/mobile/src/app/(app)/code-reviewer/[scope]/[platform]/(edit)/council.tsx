import {
  COUNCIL_AGGREGATION_STRATEGIES,
  COUNCIL_MAX_REQUIRED_LABELS,
  COUNCIL_MIN_SPECIALISTS,
  COUNCIL_REQUIRED_LABEL_MAX_LENGTH,
} from '@kilocode/app-shared/code-review';
import { useQuery } from '@tanstack/react-query';
import { type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { CouncilRefusalScreen } from '@/components/code-reviewer/council-refusal-screen';
import { CouncilSpecialistsSection } from '@/components/code-reviewer/council-specialists-section';
import { ReviewerErrorScreen } from '@/components/code-reviewer/reviewer-error-screen';
import { ReviewerHeader } from '@/components/code-reviewer/reviewer-header';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Users } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { PreferenceRow } from '@/components/ui/preference-row';
import { RadioGroup } from '@/components/ui/radio-group';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import {
  type CouncilConfig,
  PLATFORM_CAPABILITIES,
  type ReviewerPlatform,
} from '@/lib/code-reviewer-config';
import {
  councilSurface,
  parseRequiredLabels,
  STRATEGY_DESCRIPTION_KEYS,
  STRATEGY_LABEL_KEYS,
} from '@/lib/code-reviewer-council';
import { formatNumber } from '@/lib/format';
import {
  isPersonal,
  useGitHubRepositories,
  useGitLabRepositories,
  useReviewConfig,
  useSaveReviewConfig,
} from '@/lib/hooks/use-code-reviewer';
import { queryBodyFailure, useQueryBodyState } from '@/lib/hooks/use-query-body-state';
import {
  defaultCouncilConfig,
  enabledSpecialistCount,
  useCouncilGate,
} from '@/lib/hooks/use-reviewer-council';
import { useReviewerRouteParams } from '@/lib/hooks/use-reviewer-route-params';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { REWRITTEN_INPUT_AUTO_CORRECT } from '@/lib/input-suggestions';
import { useTRPC } from '@/lib/trpc';

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
  const trpc = useTRPC();
  // The same gate as the web page: an entitled organization behind the rollout
  // flag. A personal scope, an unentitled org, or a build older than the flag
  // never reaches the rows below. Bitbucket has no council on either client.
  const gate = useCouncilGate(scope);
  const capabilities = PLATFORM_CAPABILITIES[platform];
  // The personal refusal's action branches on what the account already has:
  // memberships let it switch to the organization that may unlock council, no
  // membership makes creating one the only step. Only the personal scope reads
  // it: the reviewer permission hook already runs this same read for an
  // organization scope, so that path stays cache-served. It must sit above the
  // early return below, with every other hook of this screen.
  const orgs = useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: isPersonal(scope),
  });
  let membershipState: 'none' | 'some' | 'unsettled' = 'unsettled';
  if (orgs.data !== undefined) {
    membershipState = orgs.data.length > 0 ? 'some' : 'none';
  }
  const surface = councilSurface({
    pending: gate.pending,
    allowed: gate.allowed,
    platformSupportsCouncil: capabilities.council,
  });
  const councilUiEnabled = surface === 'editor';
  const config = useReviewConfig(scope, platform, { enabled: councilUiEnabled });
  const configBody = useQueryBodyState(config, { restartable: councilUiEnabled });
  const save = useSaveReviewConfig(scope, platform);
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
  const stored = config.data?.council ?? null;
  // The switch reads the stored state: an organization that never saved a
  // council has none switched on, so a first visit starts from the default
  // draft with the council off rather than from an implicit "on".
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

  if (surface !== 'editor') {
    // An in-flight entitlement read keeps the surface blank rather than telling
    // an entitled organization that council is unavailable while it resolves.
    // A settled refusal names the reason the reader can act on: a personal
    // account never carries council, an organization's plan can lack it, and
    // Bitbucket has no council on either client. The personal scope offers the
    // one step that changes the answer: creating the organization.
    const refusalReason = gate.refusalReason ?? 'flagUnavailable';
    return (
      <View className="flex-1 bg-background">
        <ReviewerHeader
          title={t('codeReviewer.council.title')}
          eyebrow={t('common.codeReviewer')}
        />
        {surface === 'unavailable' ? (
          <CouncilRefusalScreen
            scope={scope}
            platformSupportsCouncil={capabilities.council}
            refusalReason={refusalReason}
            membershipState={membershipState}
          />
        ) : (
          <View className={SCREEN_BODY_CLASS}>
            <RowGroup leadingTile>
              <RowSkeleton tile subtitle />
              <RowSkeleton tile subtitle />
            </RowGroup>
          </View>
        )}
      </View>
    );
  }

  const failure = queryBodyFailure(configBody, config.isFetching);
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

  const disabled = save.isPending || configBody.body.status !== 'ready';
  const councilOn = council.enabled && !belowMinimum;
  const selectedRepositories = repositories.filter(repository =>
    selectedIds.includes(repository.id)
  );

  const writeCouncil = (next: CouncilConfig) => {
    save.mutate({ council: next });
  };

  const commitLabels = () => {
    const parsed = parseRequiredLabels(labelsText);
    if (!parsed.ok) {
      // The draft stays as typed: a partial save would gate on a list the user
      // never wrote. Both messages carry the server's own cap.
      announcingToast.error(
        parsed.problem === 'tooMany'
          ? t('codeReviewer.council.tooManyLabels', {
              maximum: formatNumber(COUNCIL_MAX_REQUIRED_LABELS, i18n.language),
            })
          : t('codeReviewer.council.labelTooLong', {
              maximum: formatNumber(COUNCIL_REQUIRED_LABEL_MAX_LENGTH, i18n.language),
            })
      );
      return;
    }
    if (parsed.labels.join(', ') === (config.data?.council?.required_labels ?? []).join(', ')) {
      return;
    }
    writeCouncil({ ...council, required_labels: parsed.labels });
  };

  const setRepositoryEnabled = (repositoryId: number | string, value: boolean) => {
    const next = value
      ? [...new Set([...councilRepoIds, repositoryId])]
      : councilRepoIds.filter(existing => existing !== repositoryId);
    // An opt-in only runs against a stored council (`isCouncilActive`), and the
    // org PATCH writes a council only when the patch carries one. An opt-in
    // sent alone would therefore persist ids that never run, so the write that
    // adds one also carries the council — the web form's unit of write.
    save.mutate(
      stored
        ? { councilEnabledRepositoryIds: next }
        : { council: { ...council, enabled: true }, councilEnabledRepositoryIds: next }
    );
  };

  return (
    <View className="flex-1 bg-background">
      <ReviewerHeader title={t('codeReviewer.council.title')} eyebrow={t('common.codeReviewer')} />
      <TabScreenScrollView className="flex-1" contentContainerClassName={SCREEN_BODY_CLASS}>
        <Section>
          <RowGroup leadingTile>
            <PreferenceRow
              icon={Users}
              title={t('codeReviewer.council.title')}
              subtitle={t('codeReviewer.council.subtitle')}
              value={council.enabled}
              disabled={disabled || (belowMinimum && !council.enabled)}
              onValueChange={value => {
                // Turning council off clears the opt-in list in the same save:
                // keeping the ids would reactivate every repository the user had
                // opted in, unreviewed, the moment the switch went back on.
                save.mutate(
                  value
                    ? { council: { ...council, enabled: true } }
                    : {
                        council: { ...council, enabled: false },
                        councilEnabledRepositoryIds: [],
                      }
                );
              }}
            />
          </RowGroup>
          {belowMinimum ? (
            <Text variant="muted" className="text-xs" accessibilityLiveRegion="polite">
              {t('codeReviewer.council.minSpecialists', {
                minimum: formatNumber(COUNCIL_MIN_SPECIALISTS, i18n.language),
                selected: formatNumber(specialists, i18n.language),
              })}
            </Text>
          ) : null}
        </Section>

        <Section label={t('common.repositories')}>
          {selectedRepositories.length === 0 ? (
            <Text variant="muted" className="text-xs">
              {t('codeReviewer.council.noRepositories')}
            </Text>
          ) : (
            <RowGroup>
              {selectedRepositories.map(repository => (
                <ChoiceRow
                  key={repository.id}
                  multi
                  label={repository.fullName}
                  selected={councilRepoIds.includes(repository.id)}
                  disabled={disabled || !councilOn}
                  onPress={() => {
                    setRepositoryEnabled(repository.id, !councilRepoIds.includes(repository.id));
                  }}
                />
              ))}
            </RowGroup>
          )}
        </Section>

        <CouncilSpecialistsSection council={council} disabled={disabled} onWrite={writeCouncil} />

        <Section label={t('codeReviewer.reviewDetail.decision')}>
          <RadioGroup label={t('codeReviewer.reviewDetail.decision')}>
            <RowGroup>
              {COUNCIL_AGGREGATION_STRATEGIES.map(strategy => (
                <ChoiceRow
                  key={strategy}
                  label={t(STRATEGY_LABEL_KEYS[strategy])}
                  description={t(STRATEGY_DESCRIPTION_KEYS[strategy])}
                  selected={council.aggregation_strategy === strategy}
                  disabled={disabled}
                  onPress={() => {
                    writeCouncil({ ...council, aggregation_strategy: strategy });
                  }}
                />
              ))}
            </RowGroup>
          </RadioGroup>
        </Section>

        <Section label={t('codeReviewer.council.labels')}>
          <Input
            value={labelsText}
            // A save/refetch rewrites the field's controlled value, so the
            // framework suggestion popup stays off — it crashes against
            // rewritten text (see REWRITTEN_INPUT_AUTO_CORRECT).
            autoCorrect={REWRITTEN_INPUT_AUTO_CORRECT}
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
        </Section>
      </TabScreenScrollView>
    </View>
  );
}
