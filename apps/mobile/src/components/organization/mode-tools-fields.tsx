import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  MODE_TOOL_GROUPS,
  type ModeToolGroup,
} from '@/components/organization/org-mode-form-model';
import {
  orgCopy,
  type OrgCustomizationCopyKey,
} from '@/components/organization/org-customization-copy';
import { FormField } from '@/components/ui/form-field';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

const TOOL_LABEL_KEYS = {
  read: 'modesToolRead',
  edit: 'modesToolEdit',
  browser: 'modesToolBrowser',
  command: 'modesToolCommand',
  mcp: 'modesToolMcp',
} as const satisfies Record<ModeToolGroup, OrgCustomizationCopyKey>;

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
        <FormFieldLabel label={orgCopy(t, 'modesToolsLabel')} />
        <View className="overflow-hidden rounded-lg bg-secondary">
          {MODE_TOOL_GROUPS.map((group, index) => (
            <View
              key={group}
              className={cn(
                'flex-row items-center gap-3 px-4 py-3',
                index < MODE_TOOL_GROUPS.length - 1 && 'border-b-[0.5px] border-hair-soft'
              )}
            >
              <Text className="flex-1 text-sm text-foreground">
                {orgCopy(t, TOOL_LABEL_KEYS[group])}
              </Text>
              <Switch
                value={groups.includes(group)}
                disabled={disabled}
                onValueChange={checked => {
                  onToggleGroup(group, checked);
                }}
                accessibilityLabel={orgCopy(t, TOOL_LABEL_KEYS[group])}
              />
            </View>
          ))}
        </View>
      </View>

      {groups.includes('edit') ? (
        <View className="gap-4 rounded-lg border border-border p-4">
          <FormField
            label={orgCopy(t, 'modesRestrictionPattern')}
            defaultValue={editFileRegex}
            autoCapitalize="none"
            autoCorrect={false}
            disabled={disabled}
            error={filePatternError}
            onChangeText={onChangeFilePattern}
          />
          <Text variant="muted" className="text-xs">
            {orgCopy(t, 'modesRestrictionHint')}
          </Text>
          <FormField
            label={orgCopy(t, 'modesRestrictionLabel')}
            defaultValue={editRestrictionLabel}
            disabled={disabled}
            onChangeText={onChangeRestrictionLabel}
          />
        </View>
      ) : null}
    </>
  );
}
