import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';

type DeleteAccountCodeCardProps = {
  /** The code the delete hook holds when this block mounts. */
  initialCode: string;
  canSubmitCode: boolean;
  executing: boolean;
  onChangeCode: (code: string) => void;
  onSubmit: () => void;
};

/**
 * The delete flow's confirmation code and its destructive submit.
 *
 * The field is uncontrolled: the app never controls iOS text with `value` plus
 * state. It snapshots the code the hook holds when the block mounts, because
 * Settings search replaces the default list — unmounting this block and
 * remounting it once the query clears — while the hook keeps the entered code.
 * Seeding from that code brings the field back showing the value its submit
 * would send, instead of an empty field whose submit sends a hidden value.
 */
export function DeleteAccountCodeCard({
  initialCode,
  canSubmitCode,
  executing,
  onChangeCode,
  onSubmit,
}: DeleteAccountCodeCardProps) {
  const { t } = useTranslation();
  // The native input owns the text after mount; a later `initialCode` belongs
  // to a code the field did not type, so only the mount value can seed it.
  const [codeAtMount] = useState(initialCode);
  return (
    <Card className="gap-3">
      <FormField
        label={t('profile.confirmationCode')}
        placeholder={t('profile.confirmationCodePlaceholder')}
        keyboardType="number-pad"
        // Android only: keep the IME docked to the number-pad instead of
        // swapping to its full-screen extract editor, whose window parks over
        // the whole screen and buries the destructive submit below it. The
        // Profile screen's scroll view already reserves the docked IME height
        // and its reveal scrolls this block to its end, so `TabScreenScrollView`'s
        // occlusion reservation leaves the submit above the keyboard without a
        // dimensions change here.
        disableFullscreenUI
        defaultValue={codeAtMount || undefined}
        onChangeText={onChangeCode}
        editable={!executing}
      />
      <Button
        variant="destructive"
        loading={executing}
        disabled={executing || !canSubmitCode}
        onPress={onSubmit}
      >
        <Text>{t('profile.confirmDeletion')}</Text>
      </Button>
    </Card>
  );
}
