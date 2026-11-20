/* eslint-disable max-lines -- one form owns the two lists, the gateways tab and the durable-draft restore; the state rebases onto the server's answer in one place, and splitting it would let two copies disagree */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ModelDenyList, ProviderAllowList } from '@/components/organization/model-access-lists';
import { GatewaySettingsSection } from '@/components/organization/providers-gateways-section';
import { useMetadataLeaveGuard } from '@/components/profiles/use-metadata-leave-guard';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import {
  type OrgGatewaySettings,
  useSaveOrgModelAccess,
} from '@/lib/hooks/use-org-settings-queries';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { knownServerErrorMessage } from '@/lib/server-error-copy';
import {
  type AvailableModel,
  type CatalogModel,
  denyListModels,
  draftsEqual,
  initialDraft,
  isModelAccessFormDraft,
  type ModelAccessDraft,
  modelAccessSave,
  providerRows,
} from '@/lib/organization/model-access';
import { type SettingsSaveFailure, settingsSaveStatus } from '@/lib/organization/settings-save';
import { orgModelAccessFormDraftKey } from '@/lib/persist/drafts';
import { useFormDraft } from '@/lib/persist/use-form-draft';

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
 * rebase to the whole gateway catalog, the baseline takes the server's list, and
 * the draft keeps its own provider list while it holds edits — the same rule the
 * deny list moves under — so a restored draft is not overwritten before the
 * person sees it. Without this the first toggle after a retry would write the
 * provisional rows as the organization's whole allow list.
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
  // The provider list itself, not the whole draft: a draft dirtied only by a
  // model toggle still carries the provisional rows, which must not survive the
  // arrival as the organization's allow list.
  const providersMoved =
    state.draft.providerAllowList.join('\n') !== state.baseline.providerAllowList.join('\n');
  let baseline = savedListsMoved ? params.serverDraft : state.baseline;
  let draft = savedListsMoved && clean ? params.serverDraft : state.draft;
  if (catalogArrived) {
    baseline = {
      providerAllowList: params.serverDraft.providerAllowList,
      modelDenyList: baseline.modelDenyList,
    };
    // The draft's own provider list survives the arrival when the person moved
    // it — a restored draft changed it, and replacing it here would silently
    // drop that before they could see it, exactly as it would drop a deny-list
    // edit. A list the draft did not move has nothing of its own, so it takes
    // the server's.
    draft = {
      providerAllowList: providersMoved
        ? draft.providerAllowList
        : params.serverDraft.providerAllowList,
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
 *
 * The web page autosaves; the phone saves on request, so the draft can sit
 * unsaved while a person leaves. The keep-editing gate below therefore reads
 * the draft's own dirty derivation, and Back asks Keep editing / Discard while
 * the draft holds edits.
 */
export function ModelAccessForm({
  organizationId,
  canEdit,
  canManageBilling = false,
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
  /** Whether the reader may change the plan; it picks the refusal's sentence. */
  canManageBilling?: boolean;
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
  // The screen resolves the reader's role once and hands it down: this form
  // renders no billing step beside the failure line, so a money role reads the
  // sentence that names the destination instead of one that claims an owner
  // must act.
  const save = useSaveOrgModelAccess(organizationId, canManageBilling);
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

  // The lists also live in the account-scoped encrypted store: a device language
  // change that flips the text direction reloads the bundle, which kills this
  // tree without running its cleanup, and the toggles would come back as the
  // server's. The form has the saved lists to show, so it renders from them at
  // once and applies a restored draft once, only while the person has moved
  // nothing.
  const { userId, isLoading: isIdentityLoading } = useCurrentUserId();
  const formDraft = useFormDraft<ModelAccessDraft>({
    userId,
    isIdentityLoading,
    entityKey: orgModelAccessFormDraftKey(organizationId),
    validate: isModelAccessFormDraft,
  });
  // An edit or a tab change owns the form: a stored draft that lands later never
  // replaces what the person already moved, and a restore runs once per mount.
  const touchedRef = useRef(false);
  const restoredRef = useRef(false);
  const restoredDraft = formDraft.kind === 'ready' ? formDraft.value : null;
  useEffect(() => {
    if (restoredDraft === null || touchedRef.current || restoredRef.current) {
      return;
    }
    restoredRef.current = true;
    // Both lists move together, so the restored draft replaces the pair;
    // `dirty` recomputes against the baseline, which is what enables Save.
    setForm(previous => ({ ...previous, draft: restoredDraft }));
  }, [restoredDraft]);

  const dirty = !draftsEqual(draft, baseline);
  const saving = feedback.status === 'pending';
  // Back — the header arrow, Android Back and the back gesture — must not drop
  // the draft silently, so it asks Keep editing / Discard, the way the
  // guardrails, mode and group forms do. The dirty flag is a derivation of this
  // form's own state, including the two rebases `syncedFormState` applies during
  // render, so the guard recomputes it on every render instead of taking it from
  // a change event. A save in flight owns the route: the guard drops the removal
  // rather than offering a Discard for a request that still lands.
  const guard = useMetadataLeaveGuard({
    // The controls are disabled for a viewer who may not manage the
    // organization, so the route never holds a draft of that viewer's making.
    enabled: canEdit,
    isDirty: () => dirty,
    saving,
    // A confirmed Discard is the person dropping the edits on purpose, so the
    // stored draft goes with them; Cancel drops it the same way. Without this
    // the next mount would restore exactly what they threw away.
    onDiscard: formDraft.clear,
  });
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
    touchedRef.current = true;
    setForm(previous => ({ ...previous, draft: next }));
    // The whole draft, on every edit: a reload may follow any of them, and the
    // hook writes through while it still reports `loading`.
    formDraft.save(next);
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
      // The draft became the saved policy; nothing is left to restore.
      restoredRef.current = true;
      formDraft.clear();
      attempt.succeed();
    } catch (error) {
      attempt.fail({
        kind: 'save-failed',
        message:
          knownServerErrorMessage(error, canManageBilling, 'absent') ??
          t('organizationGuardrails.statusFailed'),
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
          onChange={nextTab => {
            // A tab change is the person looking elsewhere: a draft that lands
            // after it must not move the lists under the tab they chose.
            touchedRef.current = true;
            setTab(nextTab);
          }}
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
              // Cancel is a deliberate discard: the stored copy goes with the
              // screen's, or a language-direction reload would restore exactly
              // the edits the person just threw away.
              touchedRef.current = true;
              formDraft.clear();
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
          canManageBilling={canManageBilling}
          settings={gateway}
          isError={gatewayIsError}
          isFetching={gatewayIsFetching}
          canEdit={canEdit}
          onRetry={onRetryGateway}
        />
      ) : null}
      {guard.dialog}
    </View>
  );
}
