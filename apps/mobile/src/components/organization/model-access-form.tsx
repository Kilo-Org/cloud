/* eslint-disable max-lines -- one form owns the draft, both list policies and the leave guard; the Providers tab's display names add a prop to that whole, and splitting it would duplicate the shared state. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, useWindowDimensions, View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { clampLiftPad, type LiftFrameMeasurement } from '@/components/agents/owned-keyboard-lift';
import { KeyboardLiftView } from '@/components/keyboard-lift-view';
import { ModelDenyList, ProviderAllowList } from '@/components/organization/model-access-lists';
import { GatewaySettingsSection } from '@/components/organization/providers-gateways-section';
import { useMetadataLeaveGuard } from '@/components/profiles/use-metadata-leave-guard';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { ScreenFooter } from '@/components/ui/screen-footer';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import {
  type OrgGatewaySettings,
  useSaveOrgModelAccess,
} from '@/lib/hooks/use-org-settings-queries';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { useSideInsetStyle } from '@/lib/screen-insets';
import { knownServerErrorMessage } from '@/lib/server-error-copy';
import {
  type AvailableModel,
  canonicalDraft,
  type CatalogModel,
  catalogProviderSlugs,
  denyListModels,
  draftsEqual,
  initialDraft,
  isModelAccessFormDraft,
  type ModelAccessDraft,
  modelAccessSave,
  providerRows,
} from '@/lib/organization/model-access';
import { type SettingsSaveFailure, settingsSaveStatus } from '@/lib/organization/settings-save';
import {
  type FormState,
  providerDataNotice,
  providerListEditedBy,
  syncedFormState,
} from '@/lib/organization/model-access-form-state';
import { orgModelAccessFormDraftKey } from '@/lib/persist/drafts';
import { useFormDraft } from '@/lib/persist/use-form-draft';

type Tab = 'models' | 'providers' | 'gateways';

/** The reason a save is refused, by the refusal `modelAccessSave` returned. */
const BLOCKING_ISSUE_KEYS = {
  'provider-catalog-unavailable': 'organizationModelAccess.providersNeedCatalog',
  'empty-provider-list': 'organizationModelAccess.emptyProviderList',
  'empty-model-list': 'organizationModelAccess.emptyModelList',
} as const;

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
  providerNames,
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
  providerNames: Readonly<Record<string, string>>;
  gateway: OrgGatewaySettings | undefined;
  gatewayIsError: boolean;
  gatewayIsFetching: boolean;
  onRetryGateway: () => void;
}>) {
  const { t } = useTranslation();
  // The pinned footer rides the keyboard: the lift around the body and the bar
  // is the keyboard's own measured height, less the bottom inset the footer
  // already pads, so the actions sit just above the IME. The pad is clamped by
  // the room the list has, not by the whole form: the header block and the
  // pinned bar already claim part of the measured frame, so the clamp bounds the
  // pad by what is left once they are taken out, which keeps
  // `MIN_BODY_VIEWPORT` of the list on screen (`@/lib/body-viewport`).
  const { bottom } = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const keyboardHeight = useKeyboardState(state => state.height);
  const [frame, setFrame] = useState<LiftFrameMeasurement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [footerHeight, setFooterHeight] = useState(0);
  const handleFrameLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { height } = event.nativeEvent.layout;
      setFrame(previous =>
        previous?.height === height && previous.windowHeight === windowHeight
          ? previous
          : { height, windowHeight }
      );
    },
    [windowHeight]
  );
  const handleHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setHeaderHeight(previous => (previous === height ? previous : height));
  }, []);
  const handleFooterLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setFooterHeight(previous => (previous === height ? previous : height));
  }, []);
  const [tab, setTab] = useState<Tab>('models');
  // The list's own band: the frame with the header above it and the pinned bar
  // below it taken out. Those two already claim their points of the frame, so
  // clamping the pad against the frame alone would spend the viewport minimum
  // on them and leave the list at zero height. The Gateways tab commits each
  // control as it changes and renders no bar, and an unmounted bar never
  // reports a height of zero, so its last measurement would keep reserving
  // room the list has back: the band counts the bar only while it is drawn.
  const footerBand = tab === 'gateways' ? 0 : footerHeight;
  const bodyBand = frame === null ? null : Math.max(0, frame.height - headerHeight - footerBand);
  const keyboardLiftPad = clampLiftPad(
    Math.max(0, keyboardHeight - bottom),
    frame === null || bodyBand === null
      ? null
      : { height: bodyBand, windowHeight: frame.windowHeight },
    windowHeight
  );
  // The lists carry the window side insets on their own style; the header above
  // them takes the same ones, so the controls and the rows stay in one column
  // on a landscape display cutout.
  const sideInsetStyle = useSideInsetStyle();
  // The screen resolves the reader's role once and hands it down: this form
  // renders no billing step beside the failure line, so a money role reads the
  // sentence that names the destination instead of one that claims an owner
  // must act.
  const save = useSaveOrgModelAccess(organizationId, canManageBilling);
  const { feedback, begin, clearWhere } = useSurfaceFeedback<SettingsSaveFailure>();
  // A provider saved in the allow list but no longer served by any catalog model
  // still gates routing, so the list keeps it instead of hiding a value the
  // admin can then never remove. The rows themselves come from the whole
  // gateway catalog, because the organization's own model list omits every model
  // of a provider it may not use: a provider turned off would otherwise lose its
  // row and could never be turned back on.
  const providers = providerRows({ catalog, available: models, savedAllowList: providerAllowList });
  // The providers the gateway catalog itself names: the phone's only provider
  // evidence, so a saved slug is a value to keep, never proof the rest arrived.
  const catalogProviders = catalogProviderSlugs(catalog);
  // Rows come from the catalog plus the saved list: an empty set is missing data.
  const providersEmpty = providers.length === 0;
  const serverDraft = initialDraft(
    { provider_allow_list: providerAllowList, model_deny_list: modelDenyList },
    providers
  );
  const serverKey = `${serverDraft.providerAllowList.join(',')}|${serverDraft.modelDenyList.join(',')}`;
  // The rows stand for the whole provider universe only when the catalog names a
  // provider itself: a saved slug holds one row, not the ones a policy filter
  // dropped. So the draft's provider list stays provisional and rebases on
  // arrival, and no save writes the rows as the organization's whole list.
  const catalogProvidersEmpty = catalogProviders.length === 0;
  const providerRowsIncomplete = catalogUnavailable || catalogProvidersEmpty;
  const [form, setForm] = useState<FormState>(() => ({
    syncedKey: serverKey,
    baseline: serverDraft,
    draft: serverDraft,
    providerRowsProvisional: providerRowsIncomplete,
    providerListEdited: false,
  }));
  const synced = syncedFormState({ state: form, serverKey, serverDraft, providerRowsIncomplete });
  if (synced !== form) {
    setForm(synced);
  }
  // A role that fails the manage check mid-session — a refetch delivering a
  // demotion — turns the screen read-only without remounting it, and the screen
  // must then present the organization's saved policy alone. So the displayed
  // draft is the saved one for that viewer while `form.draft` keeps the person's
  // edits untouched: Save is disabled and `onSave` refuses, the draft is clean
  // so Cancel is disabled and no viewer press can clear the account's stored
  // copy, and a role that comes back within the same mount shows the edits again
  // instead of discarding them.
  const { baseline } = form;
  const draft = canEdit ? form.draft : baseline;

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
  const restoredValue = formDraft.kind === 'ready' ? formDraft.value : null;
  // A viewer who may not manage the organization never adopts a stored draft.
  // The displayed list is already the saved baseline for that viewer, and this
  // gate keeps `form.draft` clean too, so a role that returns within the same
  // mount shows the person's own edits rather than a stored draft written under
  // a viewer. The stored value stays where it is instead of being cleared: it is
  // the account's own unfinished work from a session that held the role, a
  // person may hold it again, and the durable draft exists to survive exactly
  // that reload. Nothing is lost for the viewer, who reads the saved policy, and
  // the next editor mount restores the draft as before.
  const restoredDraft = restoredValue === null ? null : canonicalDraft(restoredValue);
  useEffect(() => {
    if (!canEdit || restoredDraft === null || touchedRef.current || restoredRef.current) {
      return;
    }
    restoredRef.current = true;
    // Both lists move together, so the restored draft replaces the pair;
    // `dirty` recomputes against the baseline, which is what enables Save. A
    // restored provider list is the person's own, so a catalog that arrives
    // afterwards must not overwrite it with the saved list.
    setForm(previous => ({
      ...previous,
      draft: restoredDraft,
      providerListEdited: providerListEditedBy(previous, restoredDraft),
    }));
    // The role is a dependency too: a draft that lands while the role is still
    // unknown restores once the role arrives and says this person may edit.
  }, [canEdit, restoredDraft]);

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
    // A provider list the rows cannot stand for is not a policy of no providers.
    providerCatalogLoaded: !providerRowsIncomplete,
    providerListEdited: form.providerListEdited,
    models: [...catalog, ...models],
  });
  const blockingIssue =
    savePayload.kind === 'ready' ? null : t(BLOCKING_ISSUE_KEYS[savePayload.kind]);
  // A viewer who may not manage the organization cannot write, so Save is
  // disabled for the same reason the two lists are; the rest of the reading —
  // a clean draft, a save in flight, a refused payload — holds either way.
  const cannotSave = !canEdit || !dirty || saving || savePayload.kind !== 'ready';
  const noticeFacts = { catalogUnavailable, catalogProvidersEmpty, providersEmpty };
  const noticeKey = providerDataNotice(noticeFacts);
  const notice = noticeKey === null ? null : t(noticeKey);
  const onDraftChange = (next: ModelAccessDraft) => {
    clearWhere(() => true);
    touchedRef.current = true;
    setForm(previous => ({
      ...previous,
      draft: next,
      providerListEdited: providerListEditedBy(previous, next),
    }));
    // The whole draft, on every edit: a reload may follow any of them, and the
    // hook writes through while it still reports `loading`.
    formDraft.save(next);
  };

  const onSave = async () => {
    // The disabled control already refuses a viewer's press; this guard keeps a
    // stale one from reaching the mutation.
    if (!canEdit || savePayload.kind !== 'ready') {
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
  const denyRows = denyListModels({ catalog, available: models, denyList: draft.modelDenyList });

  return (
    <View className="flex-1" onLayout={handleFrameLayout}>
      {/* The keyboard lifts the whole surface, not just the bar: the body shrinks
          and the pinned footer rises with it. The lift is the keyboard's own
          measured height less the bottom inset the footer already pads, and it
          follows the keyboard instead of depending on a frame the platform
          reports late — the same reasoning as the new-session form. */}
      <KeyboardLiftView className="flex-1" height={keyboardLiftPad}>
        {/* The inset rides on this wrapper: inline padding on the padded block
            would replace the page gutter its class draws. */}
        <View style={sideInsetStyle} onLayout={handleHeaderLayout}>
          <View className="gap-3 px-4 pt-3">
            {/* The warning tile marks missing data; the message takes the body
                ink, because the muted neutral fails body-text contrast on it. */}
            {notice === null ? null : (
              <View className="flex-row items-center gap-3 rounded-xl border border-warn-tile-border bg-warn-tile-bg px-3 py-2">
                <Text className="flex-1 text-foreground">{notice}</Text>
                <Button
                  variant="outline"
                  size="sm"
                  loading={catalogIsFetching}
                  onPress={onRetryCatalog}
                >
                  <Text>{t('common.retry')}</Text>
                </Button>
              </View>
            )}
            <SegmentedControl
              options={[
                { value: 'models' as const, label: t('organizationModelAccess.tabModels') },
                { value: 'providers' as const, label: t('organizationModelAccess.tabProviders') },
                { value: 'gateways' as const, label: t('organizationModelAccess.tabGateways') },
              ]}
              value={tab}
              onChange={nextTab => {
                // A tab change is the person looking elsewhere: a draft that lands
                // after it must not move the lists under the tab they chose. A
                // viewer has no edits of their own on the form, because the lists
                // show the saved policy either way, so looking at another tab is
                // not the person touching anything: marking the form touched would
                // keep a stored draft from being adopted if the role arrives later
                // in the same mount, and the person's next edit would overwrite it.
                if (canEdit) {
                  touchedRef.current = true;
                }
                setTab(nextTab);
              }}
              accessibilityLabel={t('organization.settingsOnWeb.providersAndModels')}
            />
            {canEdit ? null : (
              <Text variant="caption">{t('organizationModelAccess.readOnly')}</Text>
            )}
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
        {/* An empty row set shows the screen-level notice above instead of a list
            whose only row would be a misleading empty-policy message. */}
        {tab === 'providers' && !providersEmpty ? (
          <View className="flex-1">
            {/* The refusal under the tabs carries this sentence only while no
                failure owns that line: a failed save shows its own message, so the
                caption stays to keep the read-only explanation on screen. */}
            {providerRowsIncomplete &&
            !(
              savePayload.kind === 'provider-catalog-unavailable' && feedback.status !== 'failed'
            ) ? (
              // The inset rides on this wrapper: an inline padding on the text
              // would replace the page gutter its class draws.
              <View style={sideInsetStyle}>
                <Text variant="caption" className="px-4 pb-2">
                  {t('organizationModelAccess.providersNeedCatalog')}
                </Text>
              </View>
            ) : null}
            <ProviderAllowList
              providers={providers}
              names={providerNames}
              draft={draft}
              onChange={onDraftChange}
              disabled={!canEdit || saving || providerRowsIncomplete}
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
        {/* The commit actions are the screen's one pinned footer, outside the
            body above, because both lists save together: a save that settles
            must never move the rows it just wrote. The Gateways tab saves each
            control as it changes, so it has nothing to commit and no footer.
            The bar pins itself to the bottom edge, because the Providers tab
            renders no `flex-1` list while its rows are missing. */}
        {tab === 'gateways' ? null : (
          <ScreenFooter keyboard="host" className="mt-auto" onLayout={handleFooterLayout}>
            <View className="gap-3">
              <View className="flex-row gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  disabled={!dirty || saving}
                  onPress={() => {
                    clearWhere(() => true);
                    // Cancel is a deliberate discard: the stored copy goes with
                    // the screen's, or a language-direction reload would restore
                    // exactly the edits the person just threw away.
                    touchedRef.current = true;
                    formDraft.clear();
                    setForm(previous => ({ ...previous, draft: previous.baseline }));
                  }}
                >
                  <Text>{t('common.cancel')}</Text>
                </Button>
                <Button
                  className="flex-1"
                  disabledFace="primary"
                  loading={saving}
                  disabled={cannotSave}
                  onPress={() => void onSave()}
                >
                  <Text>{t('common.save')}</Text>
                </Button>
              </View>
              {/* The status line keeps its place while the draft is clean, so a
                  save that settles never moves the actions: the reservation sits
                  here rather than on the line's own content. It follows the
                  actions, as the consent footer's does, because a reserve above
                  them leaves a band of empty page under the list's last row, and
                  the row card then reads as clipped short of the bar.
                  `min-h-10` is exactly two `text-sm` lines — 2.5 rem at the app's
                  14pt rem — and the status is clamped to those same two lines, so
                  the slot is one fixed height and the action row above it cannot
                  move in any shipped locale: a longer localised sentence ends in
                  the tail ellipsis instead of raising the pair. Only
                  `organizationModelAccess.providersNeedCatalog` is long enough to
                  truncate, and it is never the only copy of its reason: that state
                  also raises the screen's catalog notice above the tabs, which
                  wraps in full and carries the Retry, and the live region still
                  announces the whole status sentence through
                  `useStatusAnnouncement`. */}
              <View className="min-h-10 justify-center">
                <AccessibleStatus
                  message={statusMessage}
                  tone={feedback.status === 'failed' ? 'error' : 'status'}
                  numberOfLines={2}
                  className="text-sm"
                />
              </View>
            </View>
          </ScreenFooter>
        )}
      </KeyboardLiftView>
      {guard.dialog}
    </View>
  );
}
