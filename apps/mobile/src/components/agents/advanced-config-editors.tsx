import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  addCommand,
  commandRowA11yLabel,
  MAX_SETUP_COMMANDS,
  moveCommand,
  removeCommand,
  replaceCommand,
} from '@/components/profiles/profile-commands-model';
import {
  applyVariableEdit,
  type VariableEdit,
  variableRows,
} from '@/components/profiles/profile-variables-model';
import { VariableEditForm, VariableRowView } from '@/components/profiles/profile-variables-rows';
import { ReorderableItem, ReorderableItemActions } from '@/components/profiles/reorderable-item';
import { SetupCommandField } from '@/components/profiles/setup-command-field';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons';
import { RowGroup } from '@/components/ui/row-group';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { MAX_SESSION_ENV_VAR_VALUE_LENGTH } from '@/lib/agent-profile-forms';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type ManualEnvVarsEditorProps = Readonly<{
  vars: readonly VariableEdit[];
  disabled?: boolean;
  onChange: (next: VariableEdit[]) => void;
}>;

/**
 * The manual environment-variables editor: plain key/value rows, added and
 * edited inline. No JSON blob and no drag — a row is tapped to edit, a secret
 * can be revealed, and delete removes it from the draft.
 */
export function ManualEnvVarsEditor({
  vars,
  disabled = false,
  onChange,
}: Readonly<ManualEnvVarsEditorProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const rows = variableRows(vars);

  const saveEdit = async (edit: VariableEdit): Promise<boolean> => {
    onChange(applyVariableEdit(vars, edit));
    setEditingKey(null);
    await Promise.resolve();
    return true;
  };

  return (
    <Section label={t('profiles.variablesTitle')}>
      <RowGroup>
        {rows.map(row =>
          row.key === editingKey ? (
            <VariableEditForm
              key={editingKey}
              isNew={false}
              initial={{ key: row.key, value: row.value, isSecret: row.isSecret }}
              existingKeys={vars.map(variable => variable.key)}
              maxValueLength={MAX_SESSION_ENV_VAR_VALUE_LENGTH}
              isSaving={false}
              onCancel={() => {
                setEditingKey(null);
              }}
              onSave={saveEdit}
            />
          ) : (
            <VariableRowView
              key={row.key}
              row={row}
              revealed={revealed[row.key] === true}
              onToggleReveal={() => {
                setRevealed(current => ({ ...current, [row.key]: current[row.key] !== true }));
              }}
              onEdit={() => {
                setEditingKey(row.key);
              }}
              onDelete={() => {
                onChange(vars.filter(variable => variable.key !== row.key));
              }}
            />
          )
        )}
      </RowGroup>
      {editingKey === '' ? (
        <VariableEditForm
          isNew
          initial={{ key: '', value: '', isSecret: false }}
          existingKeys={vars.map(variable => variable.key)}
          maxValueLength={MAX_SESSION_ENV_VAR_VALUE_LENGTH}
          isSaving={false}
          onCancel={() => {
            setEditingKey(null);
          }}
          onSave={saveEdit}
        />
      ) : (
        <Button
          variant="outline"
          onPress={() => {
            setEditingKey('');
          }}
          disabled={disabled}
          accessibilityLabel={t('profiles.addVariable')}
        >
          <Plus size={16} color={colors.foreground} />
          <Text>{t('profiles.addVariable')}</Text>
        </Button>
      )}
    </Section>
  );
}

type ManualSetupCommandsEditorProps = Readonly<{
  commands: readonly string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}>;

/**
 * The manual setup-commands editor: one reorderable item per command, moved
 * with up/down controls (never drag) and removable. The list order is the
 * order the commands run in, and the item is the same one setup and slash
 * commands share everywhere else.
 */
export function ManualSetupCommandsEditor({
  commands,
  disabled = false,
  onChange,
}: Readonly<ManualSetupCommandsEditorProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  // Bumped on every reorder so the uncontrolled fields remount seeded in the
  // new order (their text belongs to the position, not the input instance).
  const [generation, setGeneration] = useState(0);

  return (
    <Section label={t('profiles.commandsTitle')}>
      <RowGroup>
        {commands.map((command, index) => {
          const isFirst = index === 0;
          const isLast = index === commands.length - 1;
          // Every row is a command slot, so a blank draft row keeps the position
          // it occupies in the list and its controls name that command.
          const position = index + 1;
          const rowHint = commandRowA11yLabel(index, commands.length);
          const upLabel = t('profiles.moveCommandUp', { position });
          const downLabel = t('profiles.moveCommandDown', { position });
          const deleteLabel = t('profiles.deleteCommand', { position });
          // The field's label is also its accessible name, so it carries the same
          // position the row's move and delete controls announce.
          const commandLabel = t('profiles.commandLabelPosition', { position });
          return (
            <ReorderableItem
              key={`${generation}-${index}`}
              actions={
                <ReorderableItemActions
                  moveUp={{
                    label: upLabel,
                    hint: rowHint,
                    disabled: isFirst,
                    onPress: () => {
                      onChange(moveCommand(commands, index, -1));
                      setGeneration(current => current + 1);
                    },
                  }}
                  moveDown={{
                    label: downLabel,
                    hint: rowHint,
                    disabled: isLast,
                    onPress: () => {
                      onChange(moveCommand(commands, index, 1));
                      setGeneration(current => current + 1);
                    },
                  }}
                  remove={{
                    label: deleteLabel,
                    hint: rowHint,
                    onPress: () => {
                      onChange(removeCommand(commands, index));
                      setGeneration(current => current + 1);
                    },
                  }}
                />
              }
            >
              <SetupCommandField
                command={command}
                label={commandLabel}
                disabled={disabled}
                accessibilityHint={rowHint}
                onChangeText={value => {
                  onChange(replaceCommand(commands, index, value));
                }}
              />
            </ReorderableItem>
          );
        })}
      </RowGroup>
      <Button
        variant="outline"
        onPress={() => {
          onChange(addCommand(commands));
          setGeneration(current => current + 1);
        }}
        disabled={disabled || commands.length >= MAX_SETUP_COMMANDS}
        accessibilityLabel={t('profiles.addCommand')}
      >
        <Plus size={16} color={colors.foreground} />
        <Text>{t('profiles.addCommand')}</Text>
      </Button>
    </Section>
  );
}
