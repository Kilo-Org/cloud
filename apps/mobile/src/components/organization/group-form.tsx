import { type Href, useNavigation, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { Search } from '@/components/ui/icons';

import { GroupMemberPicker } from '@/components/organization/group-member-picker';
import {
  isOrgGroupFormDirty,
  ORG_GROUP_DESCRIPTION_MAX_LENGTH,
  ORG_GROUP_NAME_MAX_LENGTH,
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
import { Input } from '@/components/ui/input';
import { useFormFieldScroll } from '@/lib/hooks/use-form-field-scroll';
import { type OrgGroup, useOrgGroupMutations } from '@/lib/hooks/use-org-groups-queries';
import {
  type ActiveOrgMember,
  isActiveOrgMember,
  useOrgWithMembers,
} from '@/lib/hooks/use-organization-queries';
import { usePopOnce } from '@/lib/navigation/pop-once';
import { armLeaveSettle } from '@/lib/navigation/leave-settle';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

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

type GroupFormProps = Readonly<{
  organizationId: string;
  /** The group being edited, or undefined to create one. */
  group: OrgGroup | undefined;
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
export function GroupForm({ organizationId, group }: GroupFormProps) {
  const router = useRouter();
  const navigation = useNavigation<StackNavigation>();
  const popOnce = usePopOnce();
  const stackSafeReplace = useStackSafeReplace();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const mutations = useOrgGroupMutations(organizationId);
  const orgWithMembers = useOrgWithMembers(organizationId);
  const nameRef = useRef(group?.name ?? '');
  const descriptionRef = useRef(group?.description ?? '');
  const memberSearchRef = useRef('');
  const [memberIds, setMemberIds] = useState<readonly string[]>(
    sortOrgGroupMemberIds(group?.memberIds ?? [])
  );
  const [memberQuery, setMemberQuery] = useState('');
  const [nameError, setNameError] = useState<'required' | 'tooLong' | null>(null);
  const [dirty, setDirty] = useState(false);
  const { scrollRef, fieldLayout, scrollToField } = useFormFieldScroll<'name'>();
  const saving = mutations.create.isPending || mutations.updateDetails.isPending;
  const removing = mutations.remove.isPending;
  const busy = saving || removing;
  const guard = useMetadataLeaveGuard({ enabled: true, saving: busy });
  const { confirm, dialog } = useConfirmDialog();
  const initial =
    group === undefined
      ? null
      : {
          name: group.name,
          description: group.description ?? '',
          memberIds: sortOrgGroupMemberIds(group.memberIds),
        };

  const syncDirty = (nextMemberIds: readonly string[] = memberIds) => {
    const next = isOrgGroupFormDirty(
      {
        name: nameRef.current,
        description: descriptionRef.current,
        memberIds: nextMemberIds,
      },
      initial
    );
    if (next !== dirty) {
      setDirty(next);
      guard.handleDirtyChange(next);
    }
  };

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

  const activeMembers: readonly ActiveOrgMember[] = (orgWithMembers.data?.members ?? []).filter(
    member => isActiveOrgMember(member)
  );
  const query = memberQuery.trim().toLowerCase();
  const visibleMembers =
    query.length === 0
      ? activeMembers
      : activeMembers.filter(member =>
          `${member.name} ${member.email}`.toLowerCase().includes(query)
        );
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
      { onSuccess: leaveToList }
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
        mutations.remove.mutate({ groupId: group.id }, { onSuccess: leaveToList });
      },
    });
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={group === undefined ? t('organization.groups.create') : group.name} />
      <TabScreenScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerClassName="gap-5 px-6 pb-10 pt-4"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
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
            syncDirty();
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
            syncDirty();
          }}
        />

        {group === undefined ? null : (
          <View className="gap-2">
            <FormFieldLabel label={t('organization.groups.membersLabel')} />
            <View className="flex-row items-center gap-2 rounded-lg bg-secondary px-3">
              <Search size={16} color={colors.mutedForeground} />
              <Input
                className="min-h-10 flex-1 border-0 bg-transparent pl-0"
                placeholder={t('organization.groups.searchMembers')}
                accessibilityLabel={t('organization.groups.membersLabel')}
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={value => {
                  memberSearchRef.current = value;
                  setMemberQuery(value);
                }}
              />
            </View>
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
                syncDirty(toggled);
              }}
              onToggleMember={(memberId, selected) => {
                const toggled = toggleOrgGroupMember(memberIds, memberId, selected);
                setMemberIds(toggled);
                syncDirty(toggled);
              }}
            />
          </View>
        )}

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
