import { Check, ChevronDown, ChevronUp, Trash2 } from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { toast } from 'sonner-native';

import { CATALOG_ICONS } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import {
  type useKiloClawMutations,
  type useKiloClawSecretCatalog,
} from '@/lib/hooks/use-kiloclaw-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type CatalogItem = NonNullable<ReturnType<typeof useKiloClawSecretCatalog>['data']>[number];

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
  return (
    <Animated.View entering={FadeIn.duration(150)}>
      <View className="gap-3 border-t border-neutral-200 px-4 pb-3 pt-3 dark:border-neutral-700">
        {item.allFieldsRequired && item.fields.length > 1 && (
          <Text className="text-xs text-muted-foreground">
            All fields are required to connect {item.label}.
          </Text>
        )}
        {item.fields.map(field => (
          <View key={field.key} className="gap-1.5">
            <Text className="text-xs font-medium text-muted-foreground">{field.label}</Text>
            <TextInput
              className="rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-5 text-foreground"
              placeholder={item.configured ? field.placeholderConfigured : field.placeholder}
              placeholderTextColor={colors.mutedForeground}
              onChangeText={val => {
                onFieldChange(field.key, val);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              returnKeyType="done"
            />
          </View>
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
  const ItemIcon = CATALOG_ICONS[item.id];

  const updateCanSave = useCallback(() => {
    const vals = fieldValuesRef.current;
    const filled = item.fields.filter(f => (vals[f.key] ?? '').trim().length > 0);
    const next = item.allFieldsRequired ? filled.length === item.fields.length : filled.length > 0;
    setCanSave(next);
  }, [item.fields, item.allFieldsRequired]);

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

  return (
    <View className="mx-4 overflow-hidden rounded-lg bg-secondary">
      {/* Header row */}
      <View className="flex-row items-center gap-3 px-4 py-3">
        {ItemIcon && <ItemIcon size={18} />}
        <View className="flex-1 gap-0.5">
          <Text className="text-sm font-medium">{item.label}</Text>
          {item.helpText && <Text className="text-xs text-muted-foreground">{item.helpText}</Text>}
        </View>
        {item.configured ? (
          <View className="rounded-full bg-green-500/15 px-2 py-0.5">
            <Text className="text-xs font-medium text-green-600 dark:text-green-400">
              Connected
            </Text>
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
