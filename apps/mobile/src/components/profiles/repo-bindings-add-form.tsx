import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { type ChosenProfile, type ChosenRepo } from '@/components/profiles/repo-bindings-add-model';
import { PickerField } from '@/components/profiles/repo-bindings-rows';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';

/**
 * The Add default form: the repo and profile fields with the cancel and add
 * actions under them. Add stays disabled until both fields hold a choice the
 * device can submit — the web dialog's behaviour — so no invalid submit is
 * possible.
 */
export function RepoBindingsAddForm({
  chosenRepo,
  chosenProfile,
  isPending,
  canAdd,
  onPickRepo,
  onPickProfile,
  onCancel,
  onAdd,
}: Readonly<{
  chosenRepo: ChosenRepo;
  chosenProfile: ChosenProfile;
  /** The add mutation is in flight; both fields and the buttons are inert. */
  isPending: boolean;
  canAdd: boolean;
  onPickRepo: () => void;
  onPickProfile: () => void;
  onCancel: () => void;
  onAdd: () => void;
}>) {
  const { t } = useTranslation();
  return (
    <Card>
      <PickerField
        label={t('profiles.repoBindings.repo')}
        value={chosenRepo.kind === 'chosen' ? chosenRepo.repo.fullName : null}
        hint={null}
        reserveHint={null}
        accessibilityLabel={
          chosenRepo.kind === 'chosen'
            ? t('profiles.repoBindings.repoValue', { name: chosenRepo.repo.fullName })
            : t('profiles.repoBindings.repo')
        }
        disabled={isPending}
        onPress={onPickRepo}
      />
      <PickerField
        label={t('profiles.repoBindings.profile')}
        value={chosenProfile.kind === 'chosen' ? chosenProfile.profile.name : null}
        /* A profile that left the list is said out loud, in the line this field
           always reserves, so the buttons under it stay put. */
        hint={
          chosenProfile.kind === 'missing' ? t('profiles.repoBindings.profileUnavailable') : null
        }
        reserveHint={t('profiles.repoBindings.profileUnavailable')}
        accessibilityLabel={
          chosenProfile.kind === 'chosen'
            ? t('profiles.repoBindings.profileValue', { name: chosenProfile.profile.name })
            : t('profiles.repoBindings.profile')
        }
        disabled={isPending}
        onPress={onPickProfile}
      />
      <View className="flex-row justify-end gap-2">
        <Button variant="ghost" disabled={isPending} onPress={onCancel}>
          <Text>{t('common.cancel')}</Text>
        </Button>
        <Button
          disabled={!canAdd}
          loading={isPending}
          accessibilityLabel={t('profiles.repoBindings.add')}
          onPress={onAdd}
        >
          <Text>{t('profiles.repoBindings.add')}</Text>
        </Button>
      </View>
    </Card>
  );
}
