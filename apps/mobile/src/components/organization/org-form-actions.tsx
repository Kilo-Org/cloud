import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type OrgFormActionsProps = Readonly<{
  saving: boolean;
  removing: boolean;
  disabled: boolean;
  /** The destructive action's label; omitted while creating, when nothing exists yet. */
  deleteLabel?: string;
  onSave: () => void;
  onDelete?: () => void;
}>;

/**
 * The save action every organization record form ends with, and the destructive
 * action that removes the record it was opened on. A create form has no record to
 * remove, so it renders Save alone.
 */
export function OrgFormActions({
  saving,
  removing,
  disabled,
  deleteLabel,
  onSave,
  onDelete,
}: OrgFormActionsProps) {
  const { t } = useTranslation();
  return (
    <View className="gap-3">
      <Button loading={saving} disabled={disabled} onPress={onSave}>
        <Text>{t('common.save')}</Text>
      </Button>
      {deleteLabel === undefined || onDelete === undefined ? null : (
        <Button
          variant="outline-destructive"
          disabled={disabled}
          loading={removing}
          onPress={onDelete}
        >
          <Text className="text-destructive">{deleteLabel}</Text>
        </Button>
      )}
    </View>
  );
}
