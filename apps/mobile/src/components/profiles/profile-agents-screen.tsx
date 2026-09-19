import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { AgentFormSheet } from '@/components/profiles/agent-form-sheet';
import { agentRows, type AgentSource } from '@/components/profiles/profile-agents-model';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Bot, Pencil, Trash2 } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  type AgentProfileDetail,
  useAgentProfile,
  useAgentProfileSectionMutations,
} from '@/lib/hooks/use-agent-profiles';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/** Stable empty fallback so the derived list is not a new array each render. */
const NO_AGENTS: AgentProfileDetail['agents'] = [];

/** The mutation hook toasts `error.message`; the screen supplies a fallback otherwise. */
function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
}

type AgentRowViewProps = Readonly<{
  name: string;
  slug: string;
  visibility: string;
  description: string;
  model: string;
  onEdit: () => void;
  onDelete: () => void;
}>;

/** One agent row: name, slug, visibility, optional model and description, edit/delete. */
function AgentRowView({
  name,
  slug,
  visibility,
  description,
  model,
  onEdit,
  onDelete,
}: AgentRowViewProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <View className="min-h-16 flex-row items-start gap-1 rounded-lg bg-secondary px-3 py-2">
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row flex-wrap items-center gap-2">
          <Bot size={16} color={colors.mutedForeground} />
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            {name}
          </Text>
          <Text variant="mono" className="text-xs text-muted-foreground" numberOfLines={1}>
            {slug}
          </Text>
          <Text className="text-xs uppercase tracking-wide text-muted-foreground">
            {visibility}
          </Text>
        </View>
        {model.length > 0 ? (
          <Text variant="mono" className="text-xs text-muted-foreground" numberOfLines={1}>
            {model}
          </Text>
        ) : null}
        {description.length > 0 ? (
          <Text className="text-xs text-muted-foreground" numberOfLines={2}>
            {description}
          </Text>
        ) : null}
      </View>
      <Pressable
        className="h-11 w-11 items-center justify-center active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={t('profiles.agents.edit')}
        onPress={onEdit}
      >
        <Pencil size={18} color={colors.mutedForeground} />
      </Pressable>
      <Pressable
        className="h-11 w-11 items-center justify-center active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={t('common.delete')}
        onPress={onDelete}
      >
        <Trash2 size={18} color={colors.destructive} />
      </Pressable>
    </View>
  );
}

/** Content-shaped rows in the same slots as a loaded agent row. */
function AgentsSkeleton() {
  return (
    <View className="gap-3">
      {[0, 1, 2].map(index => (
        <Skeleton key={index} className="h-16 w-full rounded-lg bg-muted-soft" />
      ))}
    </View>
  );
}

export function ProfileAgentsScreen({
  profileId,
  organizationId,
}: Readonly<{ profileId: string; organizationId?: string }>) {
  const { t } = useTranslation();
  const profileQuery = useAgentProfile(profileId, organizationId);
  const { createAgent, updateAgent, deleteAgent } = useAgentProfileSectionMutations(organizationId);

  const agents = profileQuery.data?.agents ?? NO_AGENTS;
  const rows = agentRows(agents);
  // `null` = closed, `{ source: null }` = add, `{ source }` = edit that agent.
  const [form, setForm] = useState<{ source: AgentSource | null } | null>(null);

  const startAdd = () => {
    setForm({ source: null });
  };

  const closeForm = () => {
    setForm(null);
  };

  const saveAgent = async (
    target: AgentSource | null,
    payload: { slug: string; name: string; config: Record<string, unknown> }
  ) => {
    try {
      await (target === null
        ? createAgent.mutateAsync({ profileId, ...payload })
        : updateAgent.mutateAsync({ profileId, agentId: target.id, ...payload }));
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.agents.saveFailed'));
      }
      return;
    }
    closeForm();
  };

  const runDelete = async (agentId: string) => {
    try {
      await deleteAgent.mutateAsync({ profileId, agentId });
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.agents.saveFailed'));
      }
    }
  };

  const confirmDelete = (target: AgentSource) => {
    Alert.alert(t('common.delete'), target.name, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          void runDelete(target.id);
        },
      },
    ]);
  };

  let content: ReactNode = null;
  if (profileQuery.isError) {
    content = (
      <QueryError
        variant="server"
        placement="top"
        title={t('profiles.loadFailed')}
        onRetry={() => void profileQuery.refetch()}
        isRetrying={profileQuery.isRefetching}
      />
    );
  } else if (profileQuery.isPending) {
    content = <AgentsSkeleton />;
  } else if (rows.length === 0) {
    content = (
      <EmptyState
        icon={Bot}
        title={t('profiles.agents.empty')}
        description={null}
        placement="top"
        action={
          <Button onPress={startAdd}>
            <Text>{t('profiles.agents.add')}</Text>
          </Button>
        }
      />
    );
  } else {
    content = (
      <>
        {rows.map((row, index) => {
          const source = agents[index];
          if (source === undefined) {
            return null;
          }
          return (
            <AgentRowView
              key={source.id}
              name={source.name}
              slug={source.slug}
              visibility={row.visibility}
              description={row.description}
              model={row.model}
              onEdit={() => {
                setForm({ source });
              }}
              onDelete={() => {
                confirmDelete(source);
              }}
            />
          );
        })}
        <Button onPress={startAdd}>
          <Text>{t('profiles.agents.add')}</Text>
        </Button>
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profiles.agents.title')} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-6 pt-4 pb-8"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {content}
      </ScrollView>

      {form !== null ? (
        <AgentFormSheet
          agent={form.source}
          organizationId={organizationId}
          isSaving={createAgent.isPending || updateAgent.isPending}
          onClose={closeForm}
          onSave={payload => {
            void saveAgent(form.source, payload);
          }}
        />
      ) : null}
    </View>
  );
}
