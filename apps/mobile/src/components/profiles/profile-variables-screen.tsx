import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import {
  applyVariableEdit,
  type ProfileVarSource,
  type VariableEdit,
  type VariableRow,
  variableRows,
} from '@/components/profiles/profile-variables-model';
import {
  VariableEditForm,
  VariableRowView,
  VariablesSkeleton,
} from '@/components/profiles/profile-variables-rows';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { KeyRound } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useAgentProfile, useAgentProfileMutations } from '@/lib/hooks/use-agent-profiles';

/** Stable empty fallback so the derived list is not a new array each render. */
const NO_VARS: readonly ProfileVarSource[] = [];

/**
 * The mutation hook toasts `error.message`; the screen only supplies a
 * fallback when the server sent nothing readable.
 */
function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
}

/**
 * The edit the inline form seeds from. A secret's value is never seeded: the
 * server returns a masked `***`, and saving that back would overwrite the
 * secret, so the user must enter a new value.
 */
function initialVariableEdit(row: VariableRow | undefined): VariableEdit {
  if (row === undefined) {
    return { key: '', value: '', isSecret: false };
  }
  if (row.isSecret) {
    return { key: row.key, value: '', isSecret: true };
  }
  return { key: row.key, value: row.value, isSecret: false };
}

export function ProfileVariablesScreen({
  profileId,
  organizationId,
}: Readonly<{ profileId: string; organizationId?: string }>) {
  const { t } = useTranslation();
  const profileQuery = useAgentProfile(profileId, organizationId);
  const { setVar, deleteVar } = useAgentProfileMutations(organizationId);

  const profile = profileQuery.data;
  const serverVars: readonly ProfileVarSource[] = profile?.vars ?? NO_VARS;
  // The screen owns the list so a saved edit shows immediately; the sync below
  // swaps in the server's copy whenever a refetch lands, so the list never
  // blanks and never drifts from server truth.
  const [vars, setVars] = useState<readonly ProfileVarSource[]>(serverVars);
  const [syncedVars, setSyncedVars] = useState<readonly ProfileVarSource[]>(serverVars);
  if (serverVars !== syncedVars) {
    setSyncedVars(serverVars);
    setVars(serverVars);
  }

  // `null` = closed, `''` = the add form, any other value = the key being edited.
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const rows = variableRows(vars);
  const isAdding = editingKey === '';

  const startAdd = () => {
    setEditingKey('');
  };

  const closeForm = () => {
    setEditingKey(null);
  };

  const saveEdit = async (edit: VariableEdit): Promise<boolean> => {
    try {
      await setVar.mutateAsync({
        profileId,
        key: edit.key,
        value: edit.value,
        isSecret: edit.isSecret,
      });
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.variablesSaveFailed'));
      }
      return false;
    }
    setVars(current => applyVariableEdit(current, edit));
    setEditingKey(null);
    return true;
  };

  const runDelete = async (key: string) => {
    if (deleteVar.isPending) {
      return;
    }
    try {
      await deleteVar.mutateAsync({ profileId, key });
    } catch (error) {
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.variablesSaveFailed'));
      }
      return;
    }
    setVars(current => current.filter(v => v.key !== key));
  };

  const confirmDelete = (key: string) => {
    if (deleteVar.isPending) {
      return;
    }
    Alert.alert(t('common.delete'), key, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          void runDelete(key);
        },
      },
    ]);
  };

  const renderEditForm = (isNew: boolean, initial: VariableEdit) => (
    <VariableEditForm
      key={editingKey ?? 'new'}
      isNew={isNew}
      initial={initial}
      isSaving={setVar.isPending}
      onCancel={closeForm}
      onSave={saveEdit}
    />
  );

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
    content = <VariablesSkeleton />;
  } else if (rows.length === 0 && !isAdding) {
    content = (
      <EmptyState
        icon={KeyRound}
        title={t('profiles.variablesEmpty')}
        description={null}
        placement="top"
        action={
          <Button onPress={startAdd}>
            <Text>{t('profiles.addVariable')}</Text>
          </Button>
        }
      />
    );
  } else {
    content = (
      <>
        {rows.map(row =>
          row.key === editingKey ? (
            renderEditForm(false, initialVariableEdit(row))
          ) : (
            <VariableRowView
              key={row.key}
              row={row}
              isDeleting={deleteVar.isPending}
              onEdit={() => {
                setEditingKey(row.key);
              }}
              onDelete={() => {
                confirmDelete(row.key);
              }}
            />
          )
        )}

        {isAdding ? renderEditForm(true, initialVariableEdit(undefined)) : null}

        {editingKey === null ? (
          <Button onPress={startAdd}>
            <Text>{t('profiles.addVariable')}</Text>
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profiles.variablesTitle')} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-6 pt-4 pb-8"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {content}
      </ScrollView>
    </View>
  );
}
