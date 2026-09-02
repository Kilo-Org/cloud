import { type ComponentProps, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { ReviewSpectator } from '@/components/code-reviewer/review-spectator';
import { SheetHeader } from '@/components/sheet-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

export function ReviewSpectatorSheet(props: Readonly<ComponentProps<typeof ReviewSpectator>>) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const title = t('agentChat.session.transcriptAccessibility');
  const handleClose = () => {
    setVisible(false);
  };

  return (
    <>
      <View className="px-6 pt-4">
        <Button
          variant="secondary"
          accessibilityLabel={title}
          onPress={() => {
            setVisible(true);
          }}
        >
          <Text>{title}</Text>
        </Button>
      </View>
      <SessionPageSheet visible={visible} onClose={handleClose}>
        <SheetHeader title={title} onDone={handleClose} />
        <ReviewSpectator {...props} />
      </SessionPageSheet>
    </>
  );
}
