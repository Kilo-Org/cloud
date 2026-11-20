/* eslint-disable max-lines -- one form: the wrapper that owns the durable draft, the loading shape it gates a create on, and the body that seeds from it */
import { type Href, useNavigation, useRouter } from 'expo-router';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { GroupMemberPicker } from '@/components/organization/group-member-picker';
import {
  filterOrgGroupMembers,
  isOrgGroupFormDirty,
  isOrgGroupFormDraft,
  ORG_GROUP_DESCRIPTION_MAX_LENGTH,
  ORG_GROUP_NAME_MAX_LENGTH,
  type OrgGroupFormDraft,
  orgGroupFormExit,
  orgGroupNameError,
  selectOrgGroupMemberPickerState,
  sortOrgGroupMemberIds,
  toggleOrgGroupMember,
  toggleOrgGroupMembers,
} from '@/components/organization/org-group-form-model';
import { OrgFormActions } from '@/components/organization/org-form-actions';
import { useMetadataLeaveGuard } from '@/components/profiles/use-metadata-leave-guard';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { useConfirmDialog } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { SearchField } from '@/components/ui/search-field';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useFormFieldScroll } from '@/lib/hooks/use-form-field-scroll';
import { type OrgGroup, useOrgGroupMutations } from '@/lib/hooks/use-org-groups-queries';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import {
  type ActiveOrgMember,
  isActiveOrgMember,
  useOrgWithMembers,
} from '@/lib/hooks/use-organization-queries';
import { usePopOnce } from '@/lib/navigation/pop-once';
import { armLeaveSettle } from '@/lib/navigation/leave-settle';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
import { orgGroupFormDraftKey } from '@/lib/persist/drafts';
import { type FormDraftState, useFormDraft } from '@/lib/persist/use-form-draft';

const GROUPS_LIST_PATH = '/(app)/(tabs)/(3_profile)/organization/groups' as const;
const GROUP_FORM_PATH = '/(app)/(tabs)/(3_profile)/organization/group-form' as const;

/**
 * The route name the Groups list registers in the profile tab's Stack. Expo
 * Router names a screen after its file below the declaring layout, the way the
 * organization hub resolves its `index` name (`organization-navigation.ts`).
 */
const GROUPS_LIST_ROUTE_NAME = 'groups';

/** The navigation object a screen of a Stack sees. */
type StackNavigation = {
  getState: () => { index: number; routes: { key: string; name: string }[] };
  isFocused: () => boolean;
};

/** The branch of `useFormDraft` a mounted body reads. */
type ReadyFormDraft<T> = Extract<FormDraftState<T>, { kind: 'ready' }>;

/** A write the stand-in draft holds until the stored one answers. */
type PendingDraftWrite<T> =
  | { readonly kind: 'save'; readonly value: T }
  | { readonly kind: 'clear' };

type GroupFormProps = Readonly<{
  organizationId: string;
  /** The group being edited, or undefined to create one. */
  group: OrgGroup | undefined;
}>;

/**
 * One organization group, created or edited, on top of the form's durable draft.
 *
 * A device language change that flips the text direction reloads the JS bundle
 * (`apply-language.ts`), which kills the React tree without running its cleanup,
 * so the fields' text and the member selection live in the encrypted draft store
 * as well as in their refs. This wrapper owns that store: it loads the draft
 * under the current account and the group's own key, and hands the body the
 * loaded value.
 */
export function GroupForm({ organizationId, group }: GroupFormProps) {
  const { userId, isLoading: isIdentityLoading } = useCurrentUserId();
  const draft = useFormDraft<OrgGroupFormDraft>({
    userId,
    isIdentityLoading,
    entityKey: orgGroupFormDraftKey(organizationId, group?.id ?? null),
    validate: isOrgGroupFormDraft,
  });
  // The body reads a ready draft, and an edit form is on screen before the
  // stored one loads. This stand-in keeps that contract: its value is null (the
  // server row is the content) and its writes reach the hook's own `save` and
  // `clear` once the load settles.
  const latestDraftRef = useRef<ReadyFormDraft<OrgGroupFormDraft> | null>(null);
  if (draft.kind === 'ready') {
    latestDraftRef.current = draft;
  }
  // The form can be typed into, and cleared, before the store answers, so the
  // stand-in buffers those writes and replays them into the real draft; a
  // stand-in that only forwarded would drop the keystroke's snapshot.
  const pendingRef = useRef<PendingDraftWrite<OrgGroupFormDraft> | null>(null);
  const standbyDraft = useMemo<ReadyFormDraft<OrgGroupFormDraft>>(
    () => ({
      kind: 'ready',
      value: null,
      save: value => {
        const current = latestDraftRef.current;
        if (current !== null) {
          current.save(value);
          return;
        }
        pendingRef.current = { kind: 'save', value };
      },
      clear: () => {
        const current = latestDraftRef.current;
        if (current !== null) {
          current.clear();
          return;
        }
        pendingRef.current = { kind: 'clear' };
      },
    }),
    []
  );
  // A later save replaces an earlier buffered one, and a buffered clear
  // discards a buffered save: a clear means the person threw the draft away.
  useEffect(() => {
    if (draft.kind !== 'ready') {
      return;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending === null) {
      return;
    }
    if (pending.kind === 'clear') {
      draft.clear();
    } else {
      draft.save(pending.value);
    }
  }, [draft]);

  // A create gated on the draft and an edit does not: a create has nothing to
  // show without it — there is no server record — so it holds its loading state
  // until the store answers and its uncontrolled fields seed once, never
  // twice; an edit already has the server row, so it shows that at once and the
  // body applies a restored draft only while the person has not typed.
  if (group === undefined && draft.kind === 'loading') {
    return <GroupFormSkeleton />;
  }

  return (
    <GroupFormBody
      organizationId={organizationId}
      group={group}
      draft={draft.kind === 'ready' ? draft : standbyDraft}
    />
  );
}

/**
 * The create form's shape while its stored draft loads: the name row, the
 * description block, then the action bar.
 */
function GroupFormSkeleton() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('organization.groups.create')} />
      <View className={SCREEN_BODY_CLASS}>
        <Skeleton className="h-11 rounded-lg" />
        <Skeleton className="h-20 rounded-lg" />
        <Skeleton className="h-11 rounded-lg" />
      </View>
    </View>
  );
}

type GroupFormBodyProps = Readonly<{
  organizationId: string;
  group: OrgGroup | undefined;
  draft: ReadyFormDraft<OrgGroupFormDraft>;
}>;

/**
 * One organization group, created or edited.
 *
 * A create carries the name and description, which is all the create procedure
 * takes; the members belong to a record that exists, so the form offers them once
 * the group is saved and opens the new group for exactly that step. An edit saves
 * the metadata together with the member selection, which is the one
 * `updateDetails` call the web panel makes.
 *
 * The route admits an owner or admin only — the mutations are
 * `organizationAdminMutationProcedure` — and hands this form the group it resolves.
 */
function GroupFormBody({ organizationId, group, draft }: GroupFormBodyProps) {
  const router = useRouter();
  const navigation = useNavigation<StackNavigation>();
  const popOnce = usePopOnce();
  const stackSafeReplace = useStackSafeReplace();
  const { t } = useTranslation();
  const mutations = useOrgGroupMutations(organizationId);
  const orgWithMembers = useOrgWithMembers(organizationId);
  const initial =
    group === undefined
      ? null
      : {
          name: group.name,
          description: group.description ?? '',
          memberIds: sortOrgGroupMemberIds(group.memberIds),
        };
  // The best content this body already has: the restored draft, else the group
  // it edits, else an empty create form.
  const restored = draft.value;
  const seed: OrgGroupFormDraft = {
    name: restored?.name ?? initial?.name ?? '',
    description: restored?.description ?? initial?.description ?? '',
    memberIds: sortOrgGroupMemberIds(restored?.memberIds ?? initial?.memberIds ?? []),
    memberQuery: restored?.memberQuery ?? '',
  };
  const nameRef = useRef(seed.name);
  const descriptionRef = useRef(seed.description);
  const memberSearchRef = useRef(seed.memberQuery);
  const [memberIds, setMemberIds] = useState<readonly string[]>(seed.memberIds);
  const [memberQuery, setMemberQuery] = useState(seed.memberQuery);
  const [nameError, setNameError] = useState<'required' | 'tooLong' | null>(null);
  const [dirty, setDirty] = useState(false);
  // A restored draft that arrived after this body mounted re-seeds the
  // uncontrolled fields and the search by remounting them under this key.
  const [applyGeneration, setApplyGeneration] = useState(0);
  // Set by the first edit of any field: a restored draft never overwrites text
  // the person typed.
  const touchedRef = useRef(false);
  // A draft that already seeded the mount (or the create's gate) is applied.
  const appliedRef = useRef(draft.value !== null);
  const { scrollRef, fieldLayout, scrollToField } = useFormFieldScroll<'name'>();
  const saving = mutations.create.isPending || mutations.updateDetails.isPending;
  const removing = mutations.remove.isPending;
  const busy = saving || removing;
  const guard = useMetadataLeaveGuard({ enabled: true, saving: busy, onDiscard: draft.clear });
  const { confirm, dialog } = useConfirmDialog();

  const syncDirty = (nextMemberIds: readonly string[] = memberIds) => {
    const next = isOrgGroupFormDirty(
      {
        name: nameRef.current,
        description: descriptionRef.current,
        memberIds: nextMemberIds,
      },
      initial
    );
    setDirty(next);
    // Reported on every edit, not only on a change of this form's own verdict: a
    // caller-driven leave whose pop the navigator dropped leaves the form mounted
    // with `dirty` still true while the guard stands down, so a gated report would
    // never re-arm it and a later Back would leave silently with the draft. The
    // hook's `setState` bails out on an unchanged value, so repeating the verdict
    // costs nothing.
    guard.handleDirtyChange(next);
  };

  /** The whole form into the durable draft, since a reload runs no cleanup. */
  const saveDraftValues = (
    nextMemberIds: readonly string[] = memberIds,
    nextMemberQuery: string = memberQuery
  ) => {
    touchedRef.current = true;
    draft.save({
      name: nameRef.current,
      description: descriptionRef.current,
      memberIds: nextMemberIds,
      memberQuery: nextMemberQuery,
    });
  };

  /** One edit of the saved fields: the guard's verdict, then the draft. */
  const editValues = (nextMemberIds: readonly string[] = memberIds) => {
    syncDirty(nextMemberIds);
    saveDraftValues(nextMemberIds);
  };

  // The guard arms from the mount, not from the first keystroke: a body that
  // opened on a restored draft (the reload this draft exists for) would
  // otherwise let a Back leave without asking.
  useEffect(() => {
    syncDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one mount verdict over the content the body opened with
  }, []);

  // The restored draft that arrived after an edit body mounted: applied once,
  // and only while the person has not typed into any field.
  useEffect(() => {
    const arrived = draft.value;
    if (arrived === null || touchedRef.current || appliedRef.current) {
      return;
    }
    appliedRef.current = true;
    const arrivedMemberIds = sortOrgGroupMemberIds(arrived.memberIds);
    nameRef.current = arrived.name;
    descriptionRef.current = arrived.description;
    memberSearchRef.current = arrived.memberQuery;
    setMemberIds(arrivedMemberIds);
    setMemberQuery(arrived.memberQuery);
    setApplyGeneration(generation => generation + 1);
    syncDirty(arrivedMemberIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the restored value: the refs are one mutable object and the setters are stable
  }, [draft.value]);

  const leaveToList = () => {
    guard.leaveWithoutAsking(() => {
      // A save can settle after the reader left for another tab, which keeps
      // this stack mounted but blurred. Leaving then would arm the global
      // one-Back window the blurred tab never spends and dismiss a route that
      // is not the app's focused scene, swallowing the reader's Back; the
      // group already landed, so the settle needs no navigation.
      if (!navigation.isFocused()) {
        return;
      }
      const state = navigation.getState();
      const exit = orgGroupFormExit({
        routes: state.routes,
        currentIndex: state.index,
        listRouteName: GROUPS_LIST_ROUTE_NAME,
      });
      // The save or delete landed, so the leave targets the list. A pop-to over
      // the list beneath truncates every screen above it — including a create
      // form this screen replaced on the first save, whose retire can be lost —
      // so the reader never lands on a stale New-group form. The dismissal arms
      // the same one-Back window a self-pop arms (`usePopOnce`), naming the
      // list route the pop-to reveals: a press that lands while this pop
      // animates belongs to the form that is leaving, so one Back still closes
      // one screen.
      if (exit.kind === 'list') {
        armLeaveSettle(exit.listRouteKey);
        router.dismissTo(GROUPS_LIST_PATH as Href);
        return;
      }
      if (exit.kind === 'back') {
        popOnce();
        return;
      }
      stackSafeReplace.replace(GROUPS_LIST_PATH as Href);
    });
  };

  // The draft became the saved record (or the record is gone), so its stored
  // copy goes before the screen leaves.
  const leaveAfterSave = () => {
    draft.clear();
    leaveToList();
  };

  const activeMembers: readonly ActiveOrgMember[] = (orgWithMembers.data?.members ?? []).filter(
    member => isActiveOrgMember(member)
  );
  const visibleMembers = filterOrgGroupMembers(activeMembers, memberQuery);
  const visibleMemberIds = visibleMembers.map(member => member.id);
  const selectedVisibleCount = visibleMemberIds.filter(id => memberIds.includes(id)).length;
  const allVisibleSelected =
    visibleMembers.length > 0 && selectedVisibleCount === visibleMembers.length;
  const memberPicker = selectOrgGroupMemberPickerState(
    {
      isPending: orgWithMembers.isPending,
      isError: orgWithMembers.isError,
      hasData: orgWithMembers.data !== undefined,
    },
    visibleMembers.length
  );
  const save = () => {
    const name = nameRef.current.trim();
    const description = descriptionRef.current.trim();
    const found = orgGroupNameError(name);
    setNameError(found);
    if (found !== null) {
      scrollToField('name');
      return;
    }
    const payload = { name, description: description.length === 0 ? null : description };
    if (group === undefined) {
      mutations.create.mutate(payload, {
        onSuccess: created => {
          draft.clear();
          // Members belong to a group that exists, so the created group opens
          // its own form for that step instead of dropping the selection. The
          // form it replaces is retired once that push has landed: swapping two
          // screens of one native stack in a single commit is the other Android
          // Fabric crash `stack-safe-replace` exists for (KILO-APP-25).
          guard.leaveWithoutAsking(() => {
            stackSafeReplace.replace({
              pathname: GROUP_FORM_PATH,
              params: { groupId: created.result.id },
            });
          });
        },
      });
      return;
    }
    mutations.updateDetails.mutate(
      { groupId: group.id, ...payload, userIds: memberIds },
      { onSuccess: leaveAfterSave }
    );
  };

  const remove = () => {
    if (group === undefined) {
      return;
    }
    confirm({
      title: t('organization.groups.deleteTitle'),
      message: t('organization.groups.deleteMessage'),
      confirmLabel: t('organization.groups.deleteAction'),
      onConfirm: () => {
        mutations.remove.mutate({ groupId: group.id }, { onSuccess: leaveAfterSave });
      },
    });
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={group === undefined ? t('organization.groups.create') : group.name} />
      <TabScreenScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {/* Keyed by the applied draft: a remount re-reads every `defaultValue`
            from the refs and re-arms the search, which a live uncontrolled
            input would ignore. */}
        <Fragment key={applyGeneration}>
          <FormField
            label={t('organization.groups.nameLabel')}
            required
            containerOnLayout={fieldLayout('name')}
            defaultValue={nameRef.current}
            maxLength={ORG_GROUP_NAME_MAX_LENGTH}
            disabled={busy}
            error={
              nameError === null
                ? undefined
                : t(
                    nameError === 'required'
                      ? 'organization.groups.nameRequired'
                      : 'organization.groups.nameTooLong'
                  )
            }
            onChangeText={value => {
              nameRef.current = value;
              editValues();
              if (nameError !== null && orgGroupNameError(value) === null) {
                setNameError(null);
              }
            }}
          />
          <FormField
            label={t('organization.groups.descriptionLabel')}
            defaultValue={descriptionRef.current}
            multiline
            textAlignVertical="top"
            maxLength={ORG_GROUP_DESCRIPTION_MAX_LENGTH}
            className="min-h-20 leading-[1.25rem]"
            disabled={busy}
            onChangeText={value => {
              descriptionRef.current = value;
              editValues();
            }}
          />

          {group === undefined ? null : (
            <View className="gap-2">
              <FormFieldLabel label={t('organization.groups.membersLabel')} />
              <SearchField
                accessibilityLabel={t('organization.groups.membersLabel')}
                placeholder={t('organization.groups.searchMembers')}
                defaultValue={memberSearchRef.current}
                hasText={memberQuery !== ''}
                onChangeText={value => {
                  memberSearchRef.current = value;
                  setMemberQuery(value);
                  // The search is not a saved field, so the guard's verdict stays
                  // the metadata's; the draft still records it, because a reload
                  // that lost the filter would look like a different list.
                  saveDraftValues(memberIds, value);
                }}
              />
              <GroupMemberPicker
                picker={memberPicker}
                error={orgWithMembers.error}
                isRetrying={orgWithMembers.isFetching}
                onRetry={() => void orgWithMembers.refetch()}
                visibleMembers={visibleMembers}
                memberIds={memberIds}
                allVisibleSelected={allVisibleSelected}
                busy={busy}
                onToggleAll={selected => {
                  const toggled = toggleOrgGroupMembers(memberIds, visibleMemberIds, selected);
                  setMemberIds(toggled);
                  editValues(toggled);
                }}
                onToggleMember={(memberId, selected) => {
                  const toggled = toggleOrgGroupMember(memberIds, memberId, selected);
                  setMemberIds(toggled);
                  editValues(toggled);
                }}
              />
            </View>
          )}
        </Fragment>

        <OrgFormActions
          saving={saving}
          removing={removing}
          disabled={busy || !dirty}
          deleteLabel={group === undefined ? undefined : t('organization.groups.deleteAction')}
          onSave={save}
          onDelete={remove}
        />
      </TabScreenScrollView>
      {dialog}
      {guard.dialog}
    </View>
  );
}
