import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  MODE_TOOL_GROUPS,
  type ModeToolGroup,
} from '@/components/organization/org-mode-form-model';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { RowGroup } from '@/components/ui/row-group';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

const TOOL_LABEL_KEYS = {
  read: 'organization.modes.tool.read',
  edit: 'organization.modes.tool.edit',
  browser: 'organization.modes.tool.browser',
  command: 'organization.modes.tool.command',
  mcp: 'organization.modes.tool.mcp',
} as const satisfies Record<ModeToolGroup, string>;

type ModeToolsFieldsProps = Readonly<{
  groups: readonly ModeToolGroup[];
  editFileRegex: string;
  editRestrictionLabel: string;
  /** The identifier field's refusal message, already translated. */
  filePatternError: string | undefined;
  disabled: boolean;
  onToggleGroup: (group: ModeToolGroup, checked: boolean) => void;
  onChangeFilePattern: (value: string) => void;
  onChangeRestrictionLabel: (value: string) => void;
}>;

/**
 * The tool groups a mode may use, and the file restriction that belongs to the
 * `edit` group: a mode that may edit only some files says so with a pattern, and
 * the pattern is offered only while editing is enabled, because the server
 * rebuilds the group from it.
 */
export function ModeToolsFields({
  groups,
  editFileRegex,
  editRestrictionLabel,
  filePatternError,
  disabled,
  onToggleGroup,
  onChangeFilePattern,
  onChangeRestrictionLabel,
}: ModeToolsFieldsProps) {
  const { t } = useTranslation();
  return (
    <>
      <View className="gap-2">
        <FormFieldLabel label={t('profiles.agents.tools')} />
        <RowGroup>
          {MODE_TOOL_GROUPS.map(group => (
            <View
              key={group}
              className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-3 px-4 py-3')}
            >
              <Text className="flex-1 text-sm font-medium text-foreground">
                {t(TOOL_LABEL_KEYS[group])}
              </Text>
              <Switch
                value={groups.includes(group)}
                disabled={disabled}
                onValueChange={checked => {
                  onToggleGroup(group, checked);
                }}
                accessibilityLabel={t(TOOL_LABEL_KEYS[group])}
              />
            </View>
          ))}
        </RowGroup>
      </View>

      {groups.includes('edit') ? (
        <Card>
          <FormField
            label={t('organization.modes.restrictionPattern')}
            defaultValue={editFileRegex}
            autoCapitalize="none"
            autoCorrect={false}
            disabled={disabled}
            error={filePatternError}
            onChangeText={onChangeFilePattern}
          />
          <Text variant="caption">{t('organization.modes.restrictionHint')}</Text>
          <FormField
            label={t('organization.modes.restrictionLabel')}
            defaultValue={editRestrictionLabel}
            disabled={disabled}
            onChangeText={onChangeRestrictionLabel}
          />
        </Card>
      ) : null}
    </>
  );
}
