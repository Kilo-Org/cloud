import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ModelDenyList, ProviderAllowList } from '@/components/organization/model-access-lists';
import { GatewaySettingsSection } from '@/components/organization/providers-gateways-section';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import {
  type OrgGatewaySettings,
  useSaveOrgModelAccess,
} from '@/lib/hooks/use-org-settings-queries';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import {
  type AvailableModel,
  type CatalogModel,
  denyListModels,
  draftsEqual,
  initialDraft,
  type ModelAccessDraft,
  modelAccessSave,
  providerRows,
} from '@/lib/organization/model-access';
import { type SettingsSaveFailure, settingsSaveStatus } from '@/lib/organization/settings-save';

type Tab = 'models' | 'providers' | 'gateways';

/** The reason a save is refused, by the refusal `modelAccessSave` returned. */
const BLOCKING_ISSUE_KEYS = {
  'empty-provider-list': 'organizationModelAccess.emptyProviderList',
  'empty-model-list': 'organizationModelAccess.emptyModelList',
} as const;

/**
 * The form's own state: the saved lists it is synced to, the baseline a cancel
 * returns to, the draft on screen, and whether the provider rows came from the
 * policy-filtered list while the catalog was unavailable. It is one object
 * because one render can move both the saved lists and the provider rows, and
 * two setters rebasing from that render's values would let the second write back
 * the deny list the first had just synced.
 */
type FormState = Readonly<{
  /** The `serverKey` the form's baseline was last synced to. */
  syncedKey: string;
  baseline: ModelAccessDraft;
  draft: ModelAccessDraft;
  providerRowsProvisional: boolean;
}>;

/**
 * Rebases the form onto the lists the server answered.
 *
 * A refetch that moved the saved lists rebases the baseline, and the draft too
 * unless the admin holds edits of its own: those win, and the next save replaces
 * the newer policy.
 *
 * The provider rows are provisional while the catalog is unavailable: they hold
 * only the providers the organization's own models name, and no provider edit is
 * possible in that state (the tab is read-only). When the catalog arrives they
 * rebase to the whole gateway catalog and keep only the edits the deny list
 * holds. Without this the first toggle after a retry would write the provisional
 * rows as the organization's whole allow list.
 *
 * Both rebases compose here, so a catalog that arrives in the same render as a
 * newer deny list keeps that deny list instead of restoring the values the
 * render started from.
 */
function syncedFormState(params: {
  state: FormState;
  serverKey: string;
  serverDraft: ModelAccessDraft;
  catalogUnavailable: boolean;
}): FormState {
  const { state } = params;
  const savedListsMoved = params.serverKey !== state.syncedKey;
  const catalogArrived = state.providerRowsProvisional && !params.catalogUnavailable;
  if (
    !savedListsMoved &&
    !catalogArrived &&
    state.providerRowsProvisional === params.catalogUnavailable
  ) {
    return state;
  }
  const clean = draftsEqual(state.draft, state.baseline);
  let baseline = savedListsMoved ? params.serverDraft : state.baseline;
  let draft = savedListsMoved && clean ? params.serverDraft : state.draft;
  if (catalogArrived) {
    baseline = {
      providerAllowList: params.serverDraft.providerAllowList,
      modelDenyList: baseline.modelDenyList,
    };
    draft = {
      providerAllowList: params.serverDraft.providerAllowList,
      modelDenyList: draft.modelDenyList,
    };
  }
  return {
    syncedKey: savedListsMoved ? params.serverKey : state.syncedKey,
    baseline,
    draft,
    providerRowsProvisional: params.catalogUnavailable,
  };
}

/**
 * The two lists the organization's routing policy is: which providers may
 * serve it, and which models it denies. Both save together, because the server
 * stores them as one policy.
 */
export function ModelAccessForm({
  organizationId,
  canEdit,
  models,
  catalog,
  catalogUnavailable,
  catalogIsFetching,
  onRetryCatalog,
  providerAllowList,
  modelDenyList,
  gateway,
  gatewayIsError,
  gatewayIsFetching,
  onRetryGateway,
}: Readonly<{
  organizationId: string;
  canEdit: boolean;
  models: readonly AvailableModel[];
  /** The gateway's whole catalog; empty while it is unavailable. */
  catalog: readonly CatalogModel[];
  /**
   * The catalog's own query failed, so the form shows the saved lists and the
   * organization's models and offers a retry instead of a full-screen error.
   */
  catalogUnavailable: boolean;
  catalogIsFetching: boolean;
  onRetryCatalog: () => void;
  providerAllowList: readonly string[] | undefined;
  modelDenyList: readonly string[] | undefined;
  gateway: OrgGatewaySettings | undefined;
  gatewayIsError: boolean;
  gatewayIsFetching: boolean;
  onRetryGateway: () => void;
}>) {
  const { t } = useTranslation();
  const save = useSaveOrgModelAccess(organizationId);
  const { feedback, begin, clearWhere } = useSurfaceFeedback<SettingsSaveFailure>();
  const [tab, setTab] = useState<Tab>('models');
  // A provider saved in the allow list but no longer served by any catalog model
  // still gates routing, so the list keeps it instead of hiding a value the
  // admin can then never remove. The rows themselves come from the whole
  // gateway catalog, because the organization's own model list omits every model
  // of a provider it may not use: a provider turned off would otherwise lose its
  // row and could never be turned back on.
  const providers = providerRows({
    catalog,
    available: models,
    savedAllowList: providerAllowList,
  });
  const serverDraft = initialDraft(
    { provider_allow_list: providerAllowList, model_deny_list: modelDenyList },
    providers
  );
  const serverKey = `${serverDraft.providerAllowList.join(',')}|${serverDraft.modelDenyList.join(',')}`;
  const [form, setForm] = useState<FormState>(() => ({
    syncedKey: serverKey,
    baseline: serverDraft,
    draft: serverDraft,
    providerRowsProvisional: catalogUnavailable,
  }));
  const synced = syncedFormState({ state: form, serverKey, serverDraft, catalogUnavailable });
  if (synced !== form) {
    setForm(synced);
  }
  const { baseline, draft } = form;

  const dirty = !draftsEqual(draft, baseline);
  const saving = feedback.status === 'pending';
  const savePayload = modelAccessSave({
    savedAllowList: providerAllowList,
    baseline,
    draft,
    providerCatalogLoaded: !catalogUnavailable,
    models: [...catalog, ...models],
  });
  const blockingIssue =
    savePayload.kind === 'ready' ? null : t(BLOCKING_ISSUE_KEYS[savePayload.kind]);
  const cannotSave = !dirty || saving || savePayload.kind !== 'ready';
  const onDraftChange = (next: ModelAccessDraft) => {
    clearWhere(() => true);
    setForm(previous => ({ ...previous, draft: next }));
  };

  const onSave = async () => {
    if (savePayload.kind !== 'ready') {
      return;
    }
    const attempt = begin();
    if (attempt === null) {
      return;
    }
    try {
      await save.mutateAsync({
        organizationId,
        ...(savePayload.providerAllowList === undefined
          ? {}
          : { provider_allow_list: [...savePayload.providerAllowList] }),
        model_deny_list: [...savePayload.modelDenyList],
      });
      if (!attempt.owns()) {
        return;
      }
      setForm(previous => ({
        ...previous,
        syncedKey: serverKey,
        baseline: previous.draft,
      }));
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
    blockingIssue,
  });

  // The organization's own catalog omits the models it denies, so the rows come
  // from the whole gateway catalog with its entries added: a denied model has
  // to stay on screen, or the admin can never allow it again.
  const denyRows = denyListModels({
    catalog,
    available: models,
    denyList: draft.modelDenyList,
  });

  return (
    <View className="flex-1">
      <View className="gap-3 px-4 pt-3">
        {catalogUnavailable ? (
          <View className="flex-row items-center gap-3 rounded-md bg-muted-soft px-3 py-2">
            <Text variant="caption" className="flex-1">
              {t('organizationModelAccess.catalogUnavailable')}
            </Text>
            <Button
              variant="outline"
              size="sm"
              loading={catalogIsFetching}
              onPress={onRetryCatalog}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          </View>
        ) : null}
        <SegmentedControl
          options={[
            { value: 'models' as const, label: t('organizationModelAccess.tabModels') },
            { value: 'providers' as const, label: t('organizationModelAccess.tabProviders') },
            { value: 'gateways' as const, label: t('organizationModelAccess.tabGateways') },
          ]}
          value={tab}
          onChange={setTab}
          accessibilityLabel={t('organization.settingsOnWeb.providersAndModels')}
        />
        {canEdit ? null : <Text variant="caption">{t('organizationModelAccess.readOnly')}</Text>}
        {/* The buttons keep their place while the draft is clean, so a save
            that settles never moves the list below them. */}
        <View className="flex-row items-center gap-2">
          <View className="min-h-5 flex-1 justify-center">
            <AccessibleStatus
              message={statusMessage}
              tone={feedback.status === 'failed' ? 'error' : 'status'}
              className="text-sm"
            />
          </View>
          <Button
            variant="outline"
            size="sm"
            disabled={!dirty || saving}
            onPress={() => {
              clearWhere(() => true);
              setForm(previous => ({ ...previous, draft: previous.baseline }));
            }}
          >
            <Text>{t('common.cancel')}</Text>
          </Button>
          <Button size="sm" loading={saving} disabled={cannotSave} onPress={() => void onSave()}>
            <Text>{t('common.save')}</Text>
          </Button>
        </View>
      </View>

      {tab === 'models' ? (
        <ModelDenyList
          models={denyRows}
          draft={draft}
          onChange={onDraftChange}
          disabled={!canEdit || saving}
        />
      ) : null}
      {tab === 'providers' ? (
        <View className="flex-1">
          {catalogUnavailable ? (
            <Text variant="caption" className="px-4 pb-2">
              {t('organizationModelAccess.providersNeedCatalog')}
            </Text>
          ) : null}
          <ProviderAllowList
            providers={providers}
            draft={draft}
            onChange={onDraftChange}
            disabled={!canEdit || saving || catalogUnavailable}
          />
        </View>
      ) : null}
      {tab === 'gateways' ? (
        <GatewaySettingsSection
          organizationId={organizationId}
          settings={gateway}
          isError={gatewayIsError}
          isFetching={gatewayIsFetching}
          canEdit={canEdit}
          onRetry={onRetryGateway}
        />
      ) : null}
    </View>
  );
}
