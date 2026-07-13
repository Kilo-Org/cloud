import {
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Trash2,
} from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { toast } from 'sonner-native';

import { CATALOG_ICONS } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/external-link';
import {
  type useKiloClawMutations,
  type useKiloClawSecretCatalog,
} from '@/lib/hooks/use-kiloclaw-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type CatalogItem = NonNullable<ReturnType<typeof useKiloClawSecretCatalog>['data']>[number];
type CatalogField = CatalogItem['fields'][number];

function ExpandButton({
  expanded,
  label,
  onPress,
}: Readonly<{ expanded: boolean; label: string; onPress: () => void }>) {
  const colors = useThemeColors();
  const ExpandIcon = expanded ? ChevronUp : ChevronDown;
  return (
    <Button variant="outline" size="sm" className="flex-1 dark:bg-background" onPress={onPress}>
      <ExpandIcon size={14} color={colors.foreground} />
      <Text className="text-xs">{expanded ? 'Cancel' : label}</Text>
    </Button>
  );
}

function SecretField({
  field,
  configured,
  onChangeText,
}: Readonly<{
  field: CatalogField;
  configured: boolean;
  onChangeText: (val: string) => void;
}>) {
  const colors = useThemeColors();
  const [revealed, setRevealed] = useState(false);

  return (
    <View className="relative">
      <FormField
        label={field.label}
        placeholder={configured ? field.placeholderConfigured : field.placeholder}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType="none"
        secureTextEntry={!revealed}
        returnKeyType="done"
        className="pr-11"
      />
      <Pressable
        onPress={() => {
          setRevealed(r => !r);
        }}
        accessibilityRole="button"
        accessibilityLabel={revealed ? `Hide ${field.label}` : `Show ${field.label}`}
        className="absolute bottom-0 right-0 h-10 w-10 items-center justify-center active:opacity-70"
      >
        {revealed ? (
          <EyeOff size={16} color={colors.mutedForeground} />
        ) : (
          <Eye size={16} color={colors.mutedForeground} />
        )}
      </Pressable>
    </View>
  );
}

function ExpandedFields({
  item,
  canSave,
  isSaving,
  onFieldChange,
  onSave,
}: Readonly<{
  item: CatalogItem;
  canSave: boolean;
  isSaving: boolean;
  onFieldChange: (key: string, val: string) => void;
  onSave: () => void;
}>) {
  const colors = useThemeColors();
  const guideUrl = item.guideUrl;
  return (
    <Animated.View entering={FadeIn.duration(150)}>
      <View className="gap-3 border-t border-neutral-200 px-4 pb-3 pt-3 dark:border-neutral-700">
        {item.allFieldsRequired && item.fields.length > 1 && !item.configured && (
          <Text className="text-xs text-muted-foreground">
            All fields are required to connect {item.label}.
          </Text>
        )}
        {guideUrl && (
          <Pressable
            onPress={() => {
              void openExternalUrl(guideUrl, { label: item.guideText ?? 'setup guide' });
            }}
            accessibilityRole="link"
            accessibilityLabel={item.guideText ?? `${item.label} setup guide`}
            className="flex-row items-center gap-1.5 active:opacity-70"
          >
            <ExternalLink size={12} color={colors.primary} />
            <Text className="text-xs font-medium text-primary">
              {item.guideText ?? 'Setup guide'}
            </Text>
          </Pressable>
        )}
        {item.fields.map(field => (
          <SecretField
            key={field.key}
            field={field}
            configured={item.configured}
            onChangeText={val => {
              onFieldChange(field.key, val);
            }}
          />
        ))}
        <Button size="sm" disabled={!canSave || isSaving} onPress={onSave}>
          {isSaving ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Check size={14} color={colors.primaryForeground} />
          )}
          <Text className="text-xs text-primary-foreground">{isSaving ? 'Saving…' : 'Save'}</Text>
        </Button>
      </View>
    </Animated.View>
  );
}

export function SettingsCard({
  item,
  mutations,
  removeAlertTitle,
  removeAlertMessage,
  successMessage,
}: Readonly<{
  item: CatalogItem;
  mutations: ReturnType<typeof useKiloClawMutations>;
  removeAlertTitle: string;
  removeAlertMessage: string;
  successMessage?: string;
}>) {
  const [expanded, setExpanded] = useState(false);
  const [canSave, setCanSave] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const fieldValuesRef = useRef<Record<string, string>>({});
  const colors = useThemeColors();
  const ItemIcon = CATALOG_ICONS[item.id];

  const updateCanSave = useCallback(() => {
    const vals = fieldValuesRef.current;
    const filled = item.fields.filter(f => (vals[f.key] ?? '').trim().length > 0);
    // Initial connection needs every field at once when the provider requires
    // it; once connected, a single changed field is a valid rotation — the
    // backend keeps whichever fields are omitted from the patch (see
    // patchSecrets router comment).
    const next =
      item.configured || !item.allFieldsRequired
        ? filled.length > 0
        : filled.length === item.fields.length;
    setCanSave(next);
  }, [item.fields, item.allFieldsRequired, item.configured]);

  function handleSave() {
    const secrets: Record<string, string> = {};
    for (const f of item.fields) {
      const val = (fieldValuesRef.current[f.key] ?? '').trim();
      if (val) {
        secrets[f.key] = val;
      }
    }
    setIsSaving(true);
    mutations.patchSecrets.mutate(
      { secrets },
      {
        onSuccess: () => {
          fieldValuesRef.current = {};
          setCanSave(false);
          setExpanded(false);
          if (successMessage) {
            toast.success(successMessage);
          }
        },
        onSettled: () => {
          setIsSaving(false);
        },
      }
    );
  }

  function handleRemove() {
    Alert.alert(removeAlertTitle, removeAlertMessage, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          setIsRemoving(true);
          const secrets: Record<string, null> = {};
          for (const f of item.fields) {
            secrets[f.key] = null;
          }
          mutations.patchSecrets.mutate(
            { secrets },
            {
              onSettled: () => {
                setIsRemoving(false);
              },
            }
          );
        },
      },
    ]);
  }

  const toggleExpanded = useCallback(() => {
    setExpanded(prev => !prev);
  }, []);

  const helpUrl = item.helpUrl;

  return (
    <View className="mx-4 overflow-hidden rounded-lg bg-secondary">
      {/* Header row */}
      <View className="flex-row items-center gap-3 px-4 py-3">
        {/* Fall back to a neutral key icon for catalog items without a brand
            icon (e.g. Linear, Composio) so every row has one. */}
        {ItemIcon ? <ItemIcon size={18} /> : <KeyRound size={18} color={colors.mutedForeground} />}
        <View className="flex-1 gap-0.5">
          <Text className="text-sm font-medium">{item.label}</Text>
          {item.helpText &&
            (helpUrl ? (
              <Pressable
                onPress={() => {
                  void openExternalUrl(helpUrl, { label: item.label });
                }}
                accessibilityRole="link"
                accessibilityLabel={item.helpText}
                className="active:opacity-70"
              >
                <Text className="text-xs text-muted-foreground underline">{item.helpText}</Text>
              </Pressable>
            ) : (
              <Text className="text-xs text-muted-foreground">{item.helpText}</Text>
            ))}
        </View>
        {item.configured ? (
          <View className="rounded-full bg-good-tile-bg px-2 py-0.5">
            <Text className="text-xs font-medium text-good">Connected</Text>
          </View>
        ) : (
          <View className="rounded-full bg-muted px-2 py-0.5">
            <Text className="text-xs text-muted-foreground">Not connected</Text>
          </View>
        )}
      </View>

      {/* Action buttons */}
      <View className="flex-row gap-2 px-4 pb-3">
        <ExpandButton
          expanded={expanded}
          label={item.configured ? 'Update Token' : 'Connect'}
          onPress={toggleExpanded}
        />
        {item.configured && (
          <Button variant="destructive" size="sm" disabled={isRemoving} onPress={handleRemove}>
            {isRemoving ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <Trash2 size={14} color="white" />
            )}
            <Text className="text-xs text-destructive-foreground">
              {isRemoving ? 'Removing…' : 'Remove'}
            </Text>
          </Button>
        )}
      </View>

      {/* Expandable token input area */}
      {expanded && (
        <ExpandedFields
          item={item}
          canSave={canSave}
          isSaving={isSaving}
          onFieldChange={(key, val) => {
            fieldValuesRef.current[key] = val;
            updateCanSave();
          }}
          onSave={handleSave}
        />
      )}
    </View>
  );
}
