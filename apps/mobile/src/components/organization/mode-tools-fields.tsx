import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, View } from 'react-native';

import {
  MODE_TOOL_GROUPS,
  type ModeToolGroup,
} from '@/components/organization/org-mode-form-model';
import { FormField } from '@/components/ui/form-field';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
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
  /** The restriction block's top inside the form's scroll content. */
  filePatternLayout?: (event: LayoutChangeEvent) => void;
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
  filePatternLayout,
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
        <View className="overflow-hidden rounded-lg bg-secondary">
          {MODE_TOOL_GROUPS.map((group, index) => (
            <View
              key={group}
              className={cn(
                'flex-row items-center gap-3 px-4 py-3',
                index < MODE_TOOL_GROUPS.length - 1 && 'border-b-[0.5px] border-hair-soft'
              )}
            >
              <Text className="flex-1 text-sm text-foreground">{t(TOOL_LABEL_KEYS[group])}</Text>
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
        </View>
      </View>

      {groups.includes('edit') ? (
        <View className="gap-4 rounded-lg border border-border p-4" onLayout={filePatternLayout}>
          <FormField
            label={t('organization.modes.restrictionPattern')}
            defaultValue={editFileRegex}
            autoCapitalize="none"
            autoCorrect={false}
            disabled={disabled}
            error={filePatternError}
            onChangeText={onChangeFilePattern}
          />
          <Text variant="muted" className="text-xs">
            {t('organization.modes.restrictionHint')}
          </Text>
          <FormField
            label={t('organization.modes.restrictionLabel')}
            defaultValue={editRestrictionLabel}
            disabled={disabled}
            onChangeText={onChangeRestrictionLabel}
          />
        </View>
      ) : null}
    </>
  );
}
