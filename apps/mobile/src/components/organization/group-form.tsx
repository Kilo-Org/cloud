import { type Href, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { Search } from '@/components/ui/icons';

import {
  isOrgGroupFormDirty,
  ORG_GROUP_DESCRIPTION_MAX_LENGTH,
  ORG_GROUP_NAME_MAX_LENGTH,
  orgGroupNameError,
  sortOrgGroupMemberIds,
  toggleOrgGroupMember,
  toggleOrgGroupMembers,
} from '@/components/organization/org-group-form-model';
import { OrgFormActions } from '@/components/organization/org-form-actions';
import { useMetadataLeaveGuard } from '@/components/profiles/use-metadata-leave-guard';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ChoiceRow } from '@/components/ui/choice-row';
import { useConfirmDialog } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { type OrgGroup, useOrgGroupMutations } from '@/lib/hooks/use-org-groups-queries';
import {
  type ActiveOrgMember,
  isActiveOrgMember,
  useOrgWithMembers,
} from '@/lib/hooks/use-organization-queries';
import { usePopOnce } from '@/lib/navigation/pop-once';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const GROUPS_LIST_PATH = '/(app)/(tabs)/(3_profile)/organization/groups' as const;
const GROUP_FORM_PATH = '/(app)/(tabs)/(3_profile)/organization/group-form' as const;

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
  const guard = useMetadataLeaveGuard({ enabled: true });
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
      if (router.canGoBack()) {
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

  const save = () => {
    const name = nameRef.current.trim();
    const description = descriptionRef.current.trim();
    const found = orgGroupNameError(name);
    setNameError(found);
    if (found !== null) {
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

  const saving = mutations.create.isPending || mutations.updateDetails.isPending;
  const removing = mutations.remove.isPending;
  const busy = saving || removing;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={group === undefined ? t('organization.groups.create') : group.name} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-5 px-6 pb-10 pt-4"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        <FormField
          label={t('organization.groups.nameLabel')}
          required
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
            {visibleMembers.length === 0 ? (
              <Text variant="muted" className="text-sm">
                {t('organization.groups.membersEmpty')}
              </Text>
            ) : (
              <View className="overflow-hidden rounded-lg bg-secondary">
                <ChoiceRow
                  label={t('organization.groups.selectAllVisible')}
                  selected={allVisibleSelected}
                  multi
                  disabled={busy}
                  onPress={() => {
                    const toggled = toggleOrgGroupMembers(
                      memberIds,
                      visibleMemberIds,
                      !allVisibleSelected
                    );
                    setMemberIds(toggled);
                    syncDirty(toggled);
                  }}
                  className={cn('border-b-[0.5px] border-hair-soft')}
                />
                {visibleMembers.map((member, index) => (
                  <ChoiceRow
                    key={member.id}
                    label={member.name}
                    description={member.email}
                    selected={memberIds.includes(member.id)}
                    multi
                    disabled={busy}
                    onPress={() => {
                      const selected = !memberIds.includes(member.id);
                      const toggled = toggleOrgGroupMember(memberIds, member.id, selected);
                      setMemberIds(toggled);
                      syncDirty(toggled);
                    }}
                    className={cn(
                      index < visibleMembers.length - 1 && 'border-b-[0.5px] border-hair-soft'
                    )}
                  />
                ))}
              </View>
            )}
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
