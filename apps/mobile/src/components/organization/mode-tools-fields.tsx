import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, View } from 'react-native';

import {
  MODE_TOOL_GROUPS,
  type ModeToolGroup,
} from '@/components/organization/org-mode-form-model';
import { FormField } from '@/components/ui/form-field';
import { InlineCodeText } from '@/components/ui/inline-code-text';
import { PreferenceRow } from '@/components/ui/preference-row';
import { RowGroup } from '@/components/ui/row-group';
import { Section } from '@/components/ui/section';

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
      <Section label={t('profiles.agents.tools')}>
        <RowGroup>
          {MODE_TOOL_GROUPS.map(group => (
            <PreferenceRow
              key={group}
              title={t(TOOL_LABEL_KEYS[group])}
              value={groups.includes(group)}
              disabled={disabled}
              accessibilityLabel={t(TOOL_LABEL_KEYS[group])}
              onValueChange={checked => {
                onToggleGroup(group, checked);
              }}
            />
          ))}
        </RowGroup>
      </Section>

      {groups.includes('edit') ? (
        <>
          <View className="gap-1.5" onLayout={filePatternLayout}>
            <FormField
              label={t('organization.modes.restrictionPattern')}
              defaultValue={editFileRegex}
              autoCapitalize="none"
              autoCorrect={false}
              disabled={disabled}
              error={filePatternError}
              onChangeText={onChangeFilePattern}
            />
            <InlineCodeText
              variant="caption"
              // The mono variant is a step larger than the caption it sits in;
              // the example keeps the caption's size and muted color.
              codeClassName="text-muted-foreground text-xs"
              value={t('organization.modes.restrictionHint')}
            />
          </View>
          <FormField
            label={t('organization.modes.restrictionLabel')}
            defaultValue={editRestrictionLabel}
            disabled={disabled}
            onChangeText={onChangeRestrictionLabel}
          />
        </>
      ) : null}
    </>
  );
}
