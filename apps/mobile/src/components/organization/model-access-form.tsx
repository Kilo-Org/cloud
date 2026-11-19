/* eslint-disable max-lines -- The form composes the segments, the plan gate, the save machinery and the three lists on one screen. */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ModelDenyList, ProviderAllowList } from '@/components/organization/model-access-lists';
import { OrganizationPlanRefusal } from '@/components/organization/plan-refusal';
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
  planEnded,
  planMessage,
  planAction,
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
  /**
   * The organization's plan gate verdict: a hard-expired trial refuses every
   * organization mutation, so this disables the draft controls and the save,
   * and the plan-ended sentence replaces the read-only role sentence.
   */
  planEnded: boolean;
  /**
   * The lapsed-plan refusal's sentence and step, resolved by the screen from
   * the reader's role and the storefront rule — the same pair the hub paints.
   * The form owns neither: a sentence that offers a next step needs the step
   * beside it, and only the screen reads the role and the billing link.
   */
  planMessage: string;
  planAction?: { label: string; onPress: () => void };
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

  // The gateways tab exists only when the settings read reports it is
  // available, like the web page's Advanced policies tab: an unavailable
  // organization has nothing to show on it. A read that failed keeps the
  // segment offered so the section's error-and-retry branch stays reachable —
  // the section is the only surface that can refetch this read. A read that
  // lands or changes while the tab is selected falls back to the models tab;
  // the effect below makes that fallback persistent, so availability returning
  // later cannot move the user off the tab they picked.
  const gatewaysOffered = gateway?.available === true || (gateway == null && gatewayIsError);
  const activeTab = gatewaysOffered || tab !== 'gateways' ? tab : 'models';
  useEffect(() => {
    if (!gatewaysOffered) {
      setTab(current => (current === 'gateways' ? 'models' : current));
    }
  }, [gatewaysOffered]);

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
  // A hard-expired trial refuses every organization mutation on the server, so
  // the form states the blocker on its own controls instead of letting an
  // owner or admin build a draft only to collect the refusal — the same shape
  // as the hub's blocked rename control. The notice under the segments is the
  // one place the reason is painted; the status line stays clear because no
  // edit is possible while the gate holds. Cancel is exempt from that gate,
  // because it touches no server state and is the only way to discard a draft
  // the gate trapped.
  const cannotSave = planEnded || !dirty || saving || savePayload.kind !== 'ready';
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
          <View className="flex-row items-center gap-3 rounded-lg bg-muted-soft px-3 py-2">
            <Text className="flex-1 text-xs text-muted-foreground">
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
        {/* See the fallback above: the segment and the rendered list both read
            the derived tab, so a read that removes the gateways settings can
            never leave the control on a tab whose content it hides. */}
        <SegmentedControl
          options={[
            { value: 'models' as const, label: t('organizationModelAccess.tabModels') },
            { value: 'providers' as const, label: t('organizationModelAccess.tabProviders') },
            ...(gatewaysOffered
              ? [
                  {
                    value: 'gateways' as const,
                    label: t('organizationModelAccess.tabGateways'),
                  },
                ]
              : []),
          ]}
          value={activeTab}
          onChange={setTab}
          accessibilityLabel={t('organization.settingsOnWeb.providersAndModels')}
        />
        {/* The lapsed plan blocks every edit on this screen, so the block under
            the segments names that state, its cause and who can end it: the
            shared organization plan refusal, as the hub, the billing screen and
            the new-session form paint it. The sentence says "then try again",
            so the step the screen resolved rides under it. */}
        {planEnded ? <OrganizationPlanRefusal message={planMessage} action={planAction} /> : null}
        {!canEdit && !planEnded ? (
          <Text className="text-xs text-muted-foreground">
            {t('organizationModelAccess.readOnly')}
          </Text>
        ) : null}
        {/* The buttons keep their place while the draft is clean, so a save
            that settles never moves the list below them. A lapsed plan with a
            clean draft has no action left to offer — the gate has Save and
            Cancel is `!dirty` — so the row leaves instead of holding two dead
            controls under the sentence that already states the blocker. A
            dirty draft keeps it, because Cancel is then the only way to
            discard what the gate trapped. */}
        {planEnded && !dirty ? null : (
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
            <Button
              variant={planEnded ? 'outline' : 'default'}
              size="sm"
              loading={saving}
              disabled={cannotSave}
              onPress={() => void onSave()}
            >
              <Text>{t('common.save')}</Text>
            </Button>
          </View>
        )}
      </View>

      {activeTab === 'models' ? (
        <ModelDenyList
          models={denyRows}
          draft={draft}
          onChange={onDraftChange}
          disabled={planEnded || !canEdit || saving}
        />
      ) : null}
      {activeTab === 'providers' ? (
        <View className="flex-1">
          {catalogUnavailable ? (
            <Text className="px-4 pb-2 text-xs text-muted-foreground">
              {t('organizationModelAccess.providersNeedCatalog')}
            </Text>
          ) : null}
          <ProviderAllowList
            providers={providers}
            draft={draft}
            onChange={onDraftChange}
            disabled={planEnded || !canEdit || saving || catalogUnavailable}
          />
        </View>
      ) : null}
      {activeTab === 'gateways' ? (
        <GatewaySettingsSection
          organizationId={organizationId}
          settings={gateway}
          isError={gatewayIsError}
          isFetching={gatewayIsFetching}
          canEdit={canEdit && !planEnded}
          onRetry={onRetryGateway}
        />
      ) : null}
    </View>
  );
}
