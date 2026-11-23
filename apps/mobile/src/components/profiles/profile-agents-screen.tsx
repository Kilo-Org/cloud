import { type Href } from 'expo-router';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { AgentFormSheet, type AgentSaveFailure } from '@/components/profiles/agent-form-sheet';
import { AgentRowView, AgentsSkeleton } from '@/components/profiles/profile-agents-row';
import { agentRows, type AgentSource } from '@/components/profiles/profile-agents-model';
import { ProfileManageSlot } from '@/components/profiles/profile-manage-slot';
import { selectProfileReadErrorView } from '@/components/profiles/profile-read-error-view';
import { ProfileSectionHeader } from '@/components/profiles/profile-section-header';
import { QueryError } from '@/components/query-error';
import { TabScreenScrollView } from '@/components/tab-screen';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Bot, Plus } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/icon-button';
import { RowGroup } from '@/components/ui/row-group';
import {
  type AgentProfileDetail,
  useAgentProfileAgents,
  useAgentProfileSectionMutations,
} from '@/lib/hooks/use-agent-profiles';
import { useCloseEditorOnDeniedPermission } from '@/lib/hooks/use-close-editor-on-denied-permission';
import { useOrganizationProfilePermission } from '@/lib/hooks/use-can-manage-profiles';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { useProfileFormDraft } from '@/lib/hooks/use-profile-form-draft';
import { MAX_PROFILE_AGENTS } from '@/lib/agent-profile-forms';
import { isolateBidiText } from '@/lib/bidi';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useSheetRowTapGuard } from '@/lib/hooks/use-sheet-row-tap-guard';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { readTrpcErrorField } from '@/lib/trpc-error';

/** Stable empty fallback so the derived list is not a new array each render. */
const NO_AGENTS: AgentProfileDetail['agents'] = [];

/** The mutation hook toasts `error.message`; the screen supplies a fallback otherwise. */
function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
}

export function ProfileAgentsScreen({
  profileId,
  organizationId,
  backFallback,
}: Readonly<{
  profileId: string;
  organizationId?: string;
  backFallback: Href;
}>) {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const profileQuery = useAgentProfileAgents(profileId, organizationId);
  const committedConnectivity = useCommittedConnectivityStatus();
  const readError = selectProfileReadErrorView({
    error: profileQuery.error,
    connectivity: committedConnectivity,
  });
  // A failed read with no retry the screen offers leaves nothing to act on, so
  // the header's create control stays out of the way of the error state.
  const readErrorTerminal = profileQuery.isError && !readError.showRetry;
  const colors = useThemeColors();
  const { createAgent, updateAgent, deleteAgent } = useAgentProfileSectionMutations(organizationId);
  const permission = useOrganizationProfilePermission(organizationId);
  const canManage = permission === 'allowed';

  const agents = profileQuery.data ?? NO_AGENTS;
  const rows = agentRows(agents);
  // The server counts every row this profile holds and the list returns every
  // row unfiltered, so the loaded length is the count the cap compares.
  const atAgentCap = agents.length >= MAX_PROFILE_AGENTS;
  // `null` = closed, the add form, or the agent being edited. The form and the
  // fields it holds are a draft (`lib/form-draft`), so a remount reopens it on
  // what was typed instead of dropping it. The screen offers the sheet only
  // while the permission allows the write, and a denial closes it and drops
  // that draft, so a remount cannot reopen it.
  const draftScope = `profiles:agents:${profileId}`;
  // A save the server refused leaves one note the sheet renders: a slug the
  // profile already uses shows under the slug field, a create past the cap
  // names the cap, and any other refusal is one line in the sheet. The note is
  // the form's own, so opening or closing the form resets it with the draft.
  const form = useProfileFormDraft<AgentSource, AgentSaveFailure | null>(draftScope, agents, null);
  // The list sits underneath the sheet, and a sheet dismisses natively, so the
  // second tap of a Save double tap would land on the row just saved.
  const { markClosed: markSheetClosed, guard: guardRowPress } = useSheetRowTapGuard();
  const { startAdd: handleStartAdd } = form;

  const handleClose = () => {
    markSheetClosed();
    form.close();
  };

  useCloseEditorOnDeniedPermission(permission, handleClose);

  const saveAgent = async (
    target: AgentSource | null,
    payload: { slug: string; name: string; config: Record<string, unknown> }
  ) => {
    // The form this save belongs to. A remount keeps it alive; a later open or
    // close replaces it, and this attempt must then leave the new form alone.
    const generation = form.generation();
    form.setNotes(null);
    try {
      await (target === null
        ? createAgent.mutateAsync({ profileId, ...payload })
        : updateAgent.mutateAsync({ profileId, agentId: target.id, ...payload }));
    } catch (error) {
      if (!form.isCurrent(generation)) {
        return;
      }
      // A CONFLICT from the agent mutations is the per-profile slug index.
      if (readTrpcErrorField(error, 'code') === 'CONFLICT') {
        form.setNotes({ kind: 'slug-conflict' });
        return;
      }
      // Only a create can pass the per-profile cap, and its service refuses it
      // with this code and no other meaning on that path.
      if (target === null && readTrpcErrorField(error, 'code') === 'PRECONDITION_FAILED') {
        form.setNotes({ kind: 'limit' });
        return;
      }
      form.setNotes({ kind: 'refused' });
      return;
    }
    if (form.isCurrent(generation)) {
      handleClose();
    }
  };

  const runDelete = async (agentId: string) => {
    try {
      await deleteAgent.mutateAsync({ profileId, agentId });
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.agents.deleteFailed'));
      }
    }
  };

  const confirmDelete = (target: AgentSource) => {
    confirm({
      // The name is free text, so its own first strong character picks the direction.
      title: t('profiles.agents.deleteTitle', { name: isolateBidiText(target.name) }),
      message: t('profiles.agents.deleteMessage'),
      confirmLabel: t('profiles.agents.deleteConfirm'),
      onConfirm: () => {
        void runDelete(target.id);
      },
    });
  };

  let content: ReactNode = null;
  if (profileQuery.isPending) {
    content = <AgentsSkeleton />;
  } else if (rows.length === 0) {
    content = (
      <EmptyState
        icon={Bot}
        title={t('profiles.agents.empty')}
        // A read-only member cannot add, so its state names the rule instead of
        // an action the screen withholds.
        description={permission === 'read-only' ? t('profiles.organizationRoleRequired') : null}
        placement="top"
      />
    );
  } else {
    content = (
      <View className="gap-3">
        <RowGroup leadingTile>
          {rows.map((row, index) => {
            const source = agents[index];
            if (source === undefined) {
              return null;
            }
            return (
              <AgentRowView
                key={source.id}
                name={source.name}
                visibility={row.visibility}
                description={row.description}
                model={row.model}
                onEdit={
                  canManage
                    ? guardRowPress(() => {
                        form.startEdit(source);
                      })
                    : undefined
                }
                onDelete={
                  canManage
                    ? guardRowPress(() => {
                        confirmDelete(source);
                      })
                    : undefined
                }
              />
            );
          })}
        </RowGroup>
        <ProfileManageSlot permission={permission}>
          {atAgentCap ? (
            <AccessibleStatus
              message={t('profiles.agents.limitReached', { max: MAX_PROFILE_AGENTS })}
              tone="warn"
              className="text-sm"
            />
          ) : null}
        </ProfileManageSlot>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ProfileSectionHeader
        profileId={profileId}
        organizationId={organizationId}
        title={t('profiles.agents.title')}
        backFallback={backFallback}
        headerRight={
          canManage && !readErrorTerminal ? (
            <IconButton
              accessibilityLabel={t('profiles.agents.add')}
              disabled={atAgentCap}
              onPress={handleStartAdd}
            >
              <Plus size={22} color={colors.foreground} />
            </IconButton>
          ) : undefined
        }
      />
      {profileQuery.isError ? (
        // The read owns the surface, so it centres in the band the header and
        // the bottom band leave instead of scrolling as a banner.
        <QueryError
          variant={readError.variant}
          placement="center"
          title={readError.titleKey ? t(readError.titleKey) : undefined}
          message={readError.descriptionKey ? t(readError.descriptionKey) : undefined}
          onRetry={readError.showRetry ? () => void profileQuery.refetch() : undefined}
          isRetrying={profileQuery.isRefetching}
        />
      ) : (
        <TabScreenScrollView
          className="flex-1"
          contentContainerClassName={SCREEN_BODY_CLASS}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          showsVerticalScrollIndicator={false}
        >
          {content}
        </TabScreenScrollView>
      )}

      {form.isOpen && canManage && !readErrorTerminal ? (
        <AgentFormSheet
          draftScope={draftScope}
          agent={form.editing}
          existingSlugs={agents
            .filter(candidate => candidate.id !== form.editing?.id)
            .map(candidate => candidate.slug)}
          organizationId={organizationId}
          isSaving={createAgent.isPending || updateAgent.isPending}
          saveFailure={form.notes}
          onClose={handleClose}
          onSave={payload => saveAgent(form.editing, payload)}
        />
      ) : null}

      {dialog}
    </View>
  );
}
