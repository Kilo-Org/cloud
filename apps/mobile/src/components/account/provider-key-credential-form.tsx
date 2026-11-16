import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Plus, X } from '@/components/ui/icons';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import { COMPACT_CONTROL_HIT_SLOP_DP, STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { CREDENTIAL_INPUT_PROPS } from '@/lib/byok/credential-input-props';
import {
  type BedrockAuthMode,
  type CredentialDraft,
  type CredentialFieldId,
  type CredentialForm,
  type ModelMapping,
} from '@/lib/byok/credential-fields';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * One Azure custom deployment. The rows are built on the fly, so each keeps an
 * id that survives removing the row above it; the values live in the draft ref
 * the screen reads on submit, never in this list's state.
 */
type MappingRow = Readonly<{ id: number }>;

type ProviderKeyCredentialFormProps = Readonly<{
  form: CredentialForm;
  mode: BedrockAuthMode;
  onModeChange: (mode: BedrockAuthMode) => void;
  /** The reader changed the credential, so a refusal about the old value is stale. */
  onEdit: () => void;
  disabled: boolean;
  values: { current: CredentialDraft };
  mappings: { current: Map<number, Partial<ModelMapping>> };
  errors: Partial<Record<CredentialFieldId, string>>;
}>;

/**
 * The fields one structured credential takes: Azure's key and resource name,
 * Bedrock's one authentication method, or Vertex's service account.
 *
 * The fields are the keys of the credential the web BYOK form accepts as JSON,
 * so both surfaces collect the same credential and the server stores the same
 * shape either way. Values are uncontrolled: iOS must not drive a text input
 * from state, so what is typed lives in the draft ref and state only tracks the
 * rows and the Bedrock method.
 */
export function ProviderKeyCredentialForm({
  form,
  mode,
  onModeChange,
  onEdit,
  disabled,
  values,
  mappings,
  errors,
}: ProviderKeyCredentialFormProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [rows, setRows] = useState<readonly MappingRow[]>([]);
  const [nextRowId, setNextRowId] = useState(0);

  return (
    <View className="gap-4">
      {form.showsAuthMode ? (
        <View className="gap-2">
          <Text className="text-sm font-medium text-foreground">
            {t('profile.providerKeys.authMethod')}
          </Text>
          <SegmentedControl
            options={[
              { value: 'apiKey', label: t('profile.providerKeys.apiKeyLabel') },
              { value: 'accessKeys', label: t('profile.providerKeys.authMethodAccessKeys') },
            ]}
            value={mode}
            onChange={onModeChange}
            accessibilityLabel={t('profile.providerKeys.authMethod')}
          />
        </View>
      ) : null}
      {form.fields.map(field => (
        <FormField
          key={field.id}
          label={t(field.labelKey)}
          required
          {...CREDENTIAL_INPUT_PROPS}
          secureTextEntry={field.secret}
          multiline={field.multiline}
          showSoftInputOnFocus={!field.multiline}
          {...(field.multiline
            ? {
                numberOfLines: 4,
                className: 'min-h-[88px]',
                placeholder: t('profile.providerKeys.apiKeyPlaceholder'),
              }
            : {})}
          disabled={disabled}
          error={errors[field.id]}
          onChangeText={value => {
            values.current[field.id] = value;
            onEdit();
          }}
        />
      ))}
      {form.showsModelMappings ? (
        <View className="gap-3">
          <View className="gap-1">
            <Text className="text-sm font-medium text-foreground">
              {t('profile.providerKeys.modelMappings')}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {t('profile.providerKeys.modelMappingsDescription')}
            </Text>
          </View>
          {rows.map((row, index) => (
            <View key={row.id} className="gap-2 rounded-lg bg-secondary p-3">
              <View className="flex-row items-center justify-between">
                <Text className="text-xs font-medium text-muted-foreground">
                  {t('profile.providerKeys.mappingTitle', { number: index + 1 })}
                </Text>
                <Button
                  variant="ghost"
                  size="icon"
                  hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
                  disabled={disabled}
                  accessibilityLabel={t('profile.providerKeys.removeMapping', {
                    number: index + 1,
                  })}
                  onPress={() => {
                    mappings.current.delete(row.id);
                    setRows(current => current.filter(candidate => candidate.id !== row.id));
                  }}
                >
                  <X size={16} color={colors.mutedForeground} />
                </Button>
              </View>
              <FormField
                label={t('profile.providerKeys.mappingGatewayModel')}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                disabled={disabled}
                onChangeText={value => {
                  mappings.current.set(row.id, {
                    ...mappings.current.get(row.id),
                    gatewayModelSlug: value,
                  });
                  onEdit();
                }}
              />
              <FormField
                label={t('profile.providerKeys.mappingCustomModel')}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                disabled={disabled}
                onChangeText={value => {
                  mappings.current.set(row.id, {
                    ...mappings.current.get(row.id),
                    customModelId: value,
                  });
                  onEdit();
                }}
              />
            </View>
          ))}
          <Button
            variant="outline"
            className={STATE_ACTION_CLASS}
            disabled={disabled}
            onPress={() => {
              setRows(current => [...current, { id: nextRowId }]);
              setNextRowId(current => current + 1);
            }}
          >
            <Plus size={16} color={colors.foreground} />
            <Text>{t('profile.providerKeys.addMapping')}</Text>
          </Button>
        </View>
      ) : null}
    </View>
  );
}
