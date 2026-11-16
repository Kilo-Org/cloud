import { canManageOrganization } from '@kilocode/app-shared/organizations';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { issueMessage } from '@/components/organization/guardrails-copy';
import { InputGuardrailsSection } from '@/components/organization/guardrails-input-section';
import { OutputGuardrailsSection } from '@/components/organization/guardrails-output-section';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { EmptyState } from '@/components/empty-state';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Lock } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useOrgGuardrails, useSaveOrgGuardrails } from '@/lib/hooks/use-org-settings-queries';
import { useOrgBoundary, useOrgWithMembers } from '@/lib/hooks/use-organization-queries';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { configKey, draftsEqual } from '@/lib/organization/guardrails-config-key';
import {
  buildUpdateInput,
  type GuardrailsDraft,
  type OrgGuardrails,
  type OrgGuardrailsConfig,
  toDraft,
} from '@/lib/organization/guardrails-draft';
import { guardrailsIssues } from '@/lib/organization/guardrails-issues';
import { type SettingsSaveFailure, settingsSaveStatus } from '@/lib/organization/settings-save';

const TITLE_KEY = 'organizationGuardrails.title';

/**
 * The organization's AI guardrails, natively: the input guardrail and the
 * output guardrail the web page configures, with the same detectors, the same
 * options, and the same cap on saved rules. The web page autosaves; the phone
 * saves on request, so a flaky connection cannot half-apply a configuration.
 */
export function OrganizationGuardrailsScreen() {
  const { t } = useTranslation();
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  const membership = useOrgWithMembers(organizationId);
  const allowed = canManageOrganization(role);
  const guardrailsAvailable = membership.data?.settings.kilo_encrypt === true;
  const query = useOrgGuardrails(organizationId, allowed && guardrailsAvailable);

  if (isResolving || organizationId == null || org == null) {
    return <OrganizationBoundary title={t(TITLE_KEY)} />;
  }

  if (!allowed) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t(TITLE_KEY)} />
        <PermissionDenied description={t('organizationGuardrails.permissionDenied')} />
      </View>
    );
  }

  if (membership.data == null) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t(TITLE_KEY)} />
        {membership.isError ? (
          <QueryError
            className="bg-background"
            message={t('organizationGuardrails.loadError')}
            onRetry={() => void membership.refetch()}
            isRetrying={membership.isFetching}
          />
        ) : (
          <View className="gap-3 px-6 pt-4">
            <Skeleton className="h-40 w-full rounded-lg bg-muted-soft" />
            <Skeleton className="h-64 w-full rounded-lg bg-muted-soft" />
          </View>
        )}
      </View>
    );
  }

  if (!guardrailsAvailable) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t(TITLE_KEY)} />
        <EmptyState
          className="bg-background"
          icon={Lock}
          title={t(TITLE_KEY)}
          description={t('organizationGuardrails.unavailable')}
        />
      </View>
    );
  }

  if (query.isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t(TITLE_KEY)} />
        <View className="gap-3 px-6 pt-4">
          <Skeleton className="h-40 w-full rounded-lg bg-muted-soft" />
          <Skeleton className="h-64 w-full rounded-lg bg-muted-soft" />
        </View>
      </View>
    );
  }

  if (query.isError && query.data == null) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t(TITLE_KEY)} />
        <QueryError
          className="bg-background"
          message={t('organizationGuardrails.loadError')}
          onRetry={() => void query.refetch()}
          isRetrying={query.isFetching}
        />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t(TITLE_KEY)} />
      <TabScreenScrollView
        automaticallyAdjustKeyboardInsets
        className="flex-1"
        contentContainerClassName="px-4 gap-4 pt-4"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <GuardrailsForm organizationId={organizationId} data={query.data} />
      </TabScreenScrollView>
    </View>
  );
}

function GuardrailsForm({
  organizationId,
  data,
}: Readonly<{ organizationId: string; data: OrgGuardrails }>) {
  const { t } = useTranslation();
  const save = useSaveOrgGuardrails(organizationId);
  const { feedback, begin, clearWhere } = useSurfaceFeedback<SettingsSaveFailure>();
  const outputAvailable = data.output_available;
  const { groups } = data;
  const config: OrgGuardrailsConfig = {
    enabled: data.enabled,
    group_id: data.group_id,
    detectors: data.detectors,
    output: data.output,
  };
  const serverKey = configKey(config, outputAvailable);
  const [syncedKey, setSyncedKey] = useState(serverKey);
  const [baseline, setBaseline] = useState(() => toDraft(config));
  const [draft, setDraft] = useState(() => toDraft(config));
  // Both sections' text fields are uncontrolled: they read their `defaultValue`
  // on mount, so replacing the whole draft (a rebase, a save's answer, Cancel)
  // remounts them rather than leaving text the draft no longer holds.
  const [draftGeneration, setDraftGeneration] = useState(0);
  const replaceDraft = (next: GuardrailsDraft) => {
    setDraft(next);
    setDraftGeneration(generation => generation + 1);
  };

  // A refetch that moved the server's configuration rebases the form, unless
  // the form holds edits of its own: those win, and the next save replaces the
  // newer settings.
  if (serverKey !== syncedKey) {
    setSyncedKey(serverKey);
    const next = toDraft(config);
    const clean = draftsEqual(draft, baseline, outputAvailable);
    setBaseline(next);
    if (clean) {
      replaceDraft(next);
    }
  }

  const issues = guardrailsIssues(draft, outputAvailable);
  const dirty = !draftsEqual(draft, baseline, outputAvailable);
  const firstIssue = issues[0];
  const saving = feedback.status === 'pending';
  const editDraft = (update: (current: GuardrailsDraft) => GuardrailsDraft) => {
    clearWhere(() => true);
    setDraft(update);
  };

  const onSave = async () => {
    const attempt = begin();
    if (attempt === null) {
      return;
    }
    try {
      const result = await save.mutateAsync({
        organizationId,
        ...buildUpdateInput(draft, outputAvailable),
      });
      if (!attempt.owns()) {
        return;
      }
      const saved: OrgGuardrailsConfig = {
        enabled: result.enabled,
        group_id: result.group_id,
        detectors: result.detectors,
        output: result.output,
      };
      setSyncedKey(configKey(saved, outputAvailable));
      setBaseline(toDraft(saved));
      replaceDraft(toDraft(saved));
      attempt.succeed();
    } catch (error) {
      attempt.fail({
        kind: 'save-failed',
        message: error instanceof Error ? error.message : t('organizationGuardrails.statusFailed'),
      });
    }
  };

  const statusMessage = settingsSaveStatus({
    t,
    feedback,
    draftIsDirty: dirty,
    blockingIssue: firstIssue === undefined ? null : issueMessage(t, firstIssue),
  });

  return (
    <View className="gap-4">
      {data.invalid_saved_detectors ? (
        <View className="gap-1 rounded-lg border border-destructive p-3">
          <Text className="text-sm font-medium text-foreground">
            {t('organizationGuardrails.invalidSavedTitle')}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {t('organizationGuardrails.invalidSavedBody')}
          </Text>
        </View>
      ) : null}
      {outputAvailable && data.invalid_saved_output_detectors ? (
        <View className="gap-1 rounded-lg border border-destructive p-3">
          <Text className="text-sm font-medium text-foreground">
            {t('organizationGuardrails.invalidSavedOutputTitle')}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {t('organizationGuardrails.invalidSavedOutputBody')}
          </Text>
        </View>
      ) : null}

      <InputGuardrailsSection
        key={`input-${draftGeneration}`}
        draft={draft}
        groups={groups}
        disabled={saving}
        onChange={editDraft}
      />

      {outputAvailable ? (
        <OutputGuardrailsSection
          key={`output-${draftGeneration}`}
          draft={draft}
          disabled={saving}
          onChange={editDraft}
        />
      ) : null}

      <View className="gap-2">
        {/* The slot keeps its height whether or not a message shows, so the
            buttons below never move when a save settles. */}
        <View className="min-h-5 justify-center">
          <AccessibleStatus
            message={statusMessage}
            tone={feedback.status === 'failed' ? 'error' : 'status'}
            className="text-sm"
          />
        </View>
        <View className="flex-row gap-3">
          <Button
            variant="outline"
            className="flex-1"
            disabled={!dirty || saving}
            onPress={() => {
              clearWhere(() => true);
              replaceDraft(baseline);
            }}
          >
            <Text>{t('common.cancel')}</Text>
          </Button>
          <Button
            className="flex-1"
            loading={saving}
            disabled={!dirty || saving || issues.length > 0}
            onPress={() => void onSave()}
          >
            <Text>{t('common.save')}</Text>
          </Button>
        </View>
      </View>
    </View>
  );
}
