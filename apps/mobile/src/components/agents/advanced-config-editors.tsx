import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import {
  addCommand,
  commandRowA11yLabel,
  MAX_SETUP_COMMAND_LENGTH,
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
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { ChevronDown, ChevronUp, Plus, Trash2 } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

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
    <View className="gap-2">
      <Text className="text-sm font-medium text-muted-foreground">
        {t('profiles.variablesTitle')}
      </Text>
      {rows.map(row =>
        row.key === editingKey ? (
          <VariableEditForm
            key={editingKey}
            isNew={false}
            initial={{ key: row.key, value: row.value, isSecret: row.isSecret }}
            existingKeys={vars.map(variable => variable.key)}
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
      {editingKey === '' ? (
        <VariableEditForm
          isNew
          initial={{ key: '', value: '', isSecret: false }}
          existingKeys={vars.map(variable => variable.key)}
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
    </View>
  );
}

type ManualSetupCommandsEditorProps = Readonly<{
  commands: readonly string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}>;

/**
 * The manual setup-commands editor: one plain row per command, reorderable
 * with up/down buttons (never drag) and removable. The list order is the order
 * the commands run in.
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

  const controlClass = (controlDisabled: boolean) =>
    cn('h-11 w-11 items-center justify-center active:opacity-70', controlDisabled && 'opacity-40');

  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-muted-foreground">
        {t('profiles.commandsTitle')}
      </Text>
      {commands.map((command, index) => {
        const isFirst = index === 0;
        const isLast = index === commands.length - 1;
        return (
          <View key={`${generation}-${index}`} className="gap-3 rounded-lg bg-secondary p-3">
            <FormField
              label={t('profiles.commandLabel')}
              defaultValue={command}
              placeholder={t('profiles.commandPlaceholder')}
              className="min-h-[44px] leading-[normal]"
              disabled={disabled}
              maxLength={MAX_SETUP_COMMAND_LENGTH}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              accessibilityHint={commandRowA11yLabel(index, commands.length)}
              onChangeText={value => {
                onChange(replaceCommand(commands, index, value));
              }}
            />
            <View className="flex-row items-center justify-end gap-1">
              <Pressable
                className={controlClass(isFirst)}
                disabled={isFirst}
                accessibilityRole="button"
                accessibilityLabel={t('profiles.moveUp')}
                onPress={() => {
                  onChange(moveCommand(commands, index, -1));
                  setGeneration(current => current + 1);
                }}
              >
                <ChevronUp size={20} color={colors.mutedForeground} />
              </Pressable>
              <Pressable
                className={controlClass(isLast)}
                disabled={isLast}
                accessibilityRole="button"
                accessibilityLabel={t('profiles.moveDown')}
                onPress={() => {
                  onChange(moveCommand(commands, index, 1));
                  setGeneration(current => current + 1);
                }}
              >
                <ChevronDown size={20} color={colors.mutedForeground} />
              </Pressable>
              <Pressable
                className="h-11 w-11 items-center justify-center active:opacity-70"
                accessibilityRole="button"
                accessibilityLabel={t('common.delete')}
                onPress={() => {
                  onChange(removeCommand(commands, index));
                  setGeneration(current => current + 1);
                }}
              >
                <Trash2 size={20} color={colors.destructive} />
              </Pressable>
            </View>
          </View>
        );
      })}
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
    </View>
  );
}
