import { Fragment, type ReactElement } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { QueryError } from '@/components/query-error';
import { RepoSelector } from '@/components/agents/repo-selector';
import { RepositoryBranchSelector } from '@/components/agents/repository-branch-selector';
import { CollapsibleSection } from '@/components/security-agent/collapsible-section';
import {
  setConnectCtaCollapsed,
  useCollapsedConnectCtas,
} from '@/lib/hooks/use-collapsed-connect-ctas-preference';
import {
  RepositoryActionRow,
  RepositoryPartialNotice,
  RepositoryRefreshButton,
  RepositoryUnavailableCard,
} from '@/components/agents/repository-card-actions';
import { connectNoteKey, PROVIDER_COPY } from '@/components/agents/repository-provider-copy';
import {
  type NewSessionRepository,
  type RepositoryGroup,
  type RepositoryPlatform,
} from './new-session-repository-state';

type NewSessionRepositorySectionProps = {
  disabled: boolean;
  isRetrying: boolean;
  onChange: (fullName: string) => void;
  onConnect: (platform: RepositoryPlatform) => void;
  onRefreshRepos: () => void;
  repositories: NewSessionRepository[];
  /** Recently used rows for the picker's "Recently used" section. */
  recents: NewSessionRepository[];
  groups: RepositoryGroup[];
  value: string;
  /**
   * The route's organization scope; `undefined` is a personal session. The
   * branch query and the picker's Bitbucket note read it from here, so both
   * match the rows this section was given.
   */
  organizationId: string | undefined;
  /**
   * The Continue clone entry reuses the repository picker but submits through
   * the clone path, which has no `upstreamBranch` field: a branch row there
   * would show a choice the submit silently drops, so it is not rendered.
   */
  isCloneEntry: boolean;
};

/**
 * Provider-aware repository section. One group per provider renders its own
 * empty/error state independently, and the picker trigger always renders,
 * listing every repository plus the Recently used rows. A provider's expanded
 * connect prompt renders only before a repository is selected. Afterwards,
 * compact actions keep other providers reachable without contradicting the
 * completed selection or requiring it to be cleared.
 */
export function NewSessionRepositorySection({
  disabled,
  isRetrying,
  onChange,
  onConnect,
  onRefreshRepos,
  repositories,
  recents,
  groups,
  value,
  organizationId,
  isCloneEntry,
}: Readonly<NewSessionRepositorySectionProps>) {
  const { t } = useTranslation();
  const { collapsedCtas, hasLoaded: collapseStateLoaded } = useCollapsedConnectCtas();

  const hasRepos = repositories.length > 0;
  const anyLoading = groups.some(group => group.status === 'loading');

  // The picker reports `platform:fullName`; resolve it to the row so the branch
  // selector queries (and keys) the full repository identity. The prefill seeds
  // the same platform-qualified key, so no bare-fullName fallback is needed —
  // one would bind a same-named row on another provider.
  const selectedRepository =
    repositories.find(repository => `${repository.platform}:${repository.fullName}` === value) ??
    null;

  return (
    <View className="mt-5">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">
        {t('common.repository')}
      </Text>

      {/*
        The picker renders unconditionally. Its trigger always reserves its
        height and already covers loading ("Loading..."), empty ("Select
        repository") and disabled states, so gating it off (the old
        `hasRepos || anyLoading`) could leave the `Repository` heading as the
        section's only child — a blank void above Start session — while a
        provider query was paused (`isLoading === false`, no data) or a
        connect card was waiting on the persisted-collapse read. The web panel
        renders its repository trigger unconditionally too.
      */}
      <RepoSelector
        value={value}
        repositories={repositories}
        recents={recents}
        isLoading={!hasRepos && anyLoading}
        organizationId={organizationId ?? null}
        onChange={onChange}
        disabled={disabled}
      />

      {isCloneEntry ? null : (
        <RepositoryBranchSelector
          repository={selectedRepository}
          organizationId={organizationId}
          disabled={disabled}
        />
      )}

      {groups.map(group => (
        <Fragment key={group.key}>
          {group.notice === 'partial' ? (
            <RepositoryPartialNotice
              platform={group.key}
              onRefreshRepos={onRefreshRepos}
              isRetrying={isRetrying}
            />
          ) : null}
          {renderGroupCard(group.key, group.status)}
        </Fragment>
      ))}
    </View>
  );

  function renderGroupCard(
    platform: RepositoryPlatform,
    status: RepositoryGroup['status']
  ): ReactElement | null {
    switch (status) {
      case 'connect': {
        const noteKey = connectNoteKey(platform);
        return selectedRepository === null ? (
          renderConnectCard(platform)
        ) : (
          <View className="mt-3 gap-2">
            {noteKey ? <Text variant="muted">{t(noteKey)}</Text> : null}
            {renderConnectActions(platform)}
          </View>
        );
      }
      case 'connected-empty': {
        return renderConnectedEmptyCard(platform);
      }
      case 'unavailable': {
        return (
          <RepositoryUnavailableCard
            platform={platform}
            onConnect={onConnect}
            onRefreshRepos={onRefreshRepos}
            isRetrying={isRetrying}
          />
        );
      }
      case 'error': {
        return (
          <View className="mt-3">
            <QueryError
              placement="top"
              variant="server"
              title={t(PROVIDER_COPY[platform].errorTitle)}
              message={t('organization.boundary.loadErrorMessage')}
              onRetry={onRefreshRepos}
              // The error row's action is the same provider-list refresh the
              // connect and connected-empty cards offer, so it carries the same
              // name instead of the generic "Retry".
              retryLabel={t('agentChat.newSession.refreshRepositories')}
              isRetrying={isRetrying}
            />
          </View>
        );
      }
      case 'loading': {
        return null;
      }
      case 'repos': {
        return null;
      }
      default: {
        return null;
      }
    }
  }

  function renderConnectCard(platform: RepositoryPlatform): ReactElement | null {
    const copy = PROVIDER_COPY[platform];
    const noteKey = connectNoteKey(platform);
    // The persisted flag decides the card's height, so the card must not paint
    // expanded and then snap shut when the disk read lands (every row below it
    // would move). The read is already in flight from module import, so this
    // gate lasts a frame, not a spinner.
    if (!collapseStateLoaded) {
      return null;
    }
    return (
      <CollapsibleSection
        className="mt-3 gap-3 rounded-lg border border-border bg-card p-4"
        contentClassName="gap-3"
        titleClassName="font-semibold"
        title={t(copy.connectTitle)}
        // The card stacks under the repository picker in a scrolling column,
        // and the picker's height settles asynchronously (repos load, the
        // selection changes), while the branch row mounts above the card once a
        // repository is chosen. An animated layout here interpolates the card's
        // frame against a sibling that has already snapped, so it paints over
        // the row above it — the picker's bottom edge or the branch row.
        animateLayout={false}
        expanded={!collapsedCtas.includes(platform)}
        onToggle={() => {
          setConnectCtaCollapsed(platform, !collapsedCtas.includes(platform));
        }}
      >
        <View className="gap-1">
          <Text variant="muted">{t(copy.connectDescription)}</Text>
          {noteKey ? <Text variant="muted">{t(noteKey)}</Text> : null}
        </View>
        {renderConnectActions(platform)}
      </CollapsibleSection>
    );
  }

  function renderConnectActions(platform: RepositoryPlatform): ReactElement {
    const copy = PROVIDER_COPY[platform];
    return (
      <RepositoryActionRow
        platform={platform}
        labelKey={selectedRepository === null ? copy.openLabel : copy.connectTitle}
        onConnect={onConnect}
        onRefreshRepos={onRefreshRepos}
        isRetrying={isRetrying}
      />
    );
  }

  function renderConnectedEmptyCard(platform: RepositoryPlatform): ReactElement | null {
    const copy = PROVIDER_COPY[platform];
    return (
      <View className="mt-3 gap-3 rounded-lg border border-border bg-card p-4">
        <View className="gap-1">
          <Text className="text-sm font-semibold text-foreground">{t(copy.connectedTitle)}</Text>
          <Text variant="muted">{t(copy.emptyDescription)}</Text>
        </View>
        <View className="flex-row gap-2">
          <RepositoryRefreshButton onRefreshRepos={onRefreshRepos} isRetrying={isRetrying} />
        </View>
      </View>
    );
  }
}
