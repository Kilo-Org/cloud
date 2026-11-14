import { type TerminalViewHandle } from '../../../../modules/kilo-ssh/src';
import * as Clipboard from 'expo-clipboard';
import { type ReactNode, type RefObject, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { pasteToShell } from '@/components/ssh/session/terminal-input';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';

type TerminalPaste = Readonly<{
  /** Pastes the clipboard, asking first when it holds several lines. */
  pasteFromClipboard: () => Promise<void>;
  /** The confirm sheet, for the screen to render beside the terminal. */
  sheet: ReactNode;
}>;

/**
 * The paste key's behaviour, shared by the SSH and sandbox terminals: one line
 * goes straight into the shell, several lines ask first because a paste that
 * spans lines is several commands sent at once.
 */
export function useTerminalPaste(terminalRef: RefObject<TerminalViewHandle | null>): TerminalPaste {
  const { t } = useTranslation();
  const [pending, setPending] = useState<string | null>(null);

  const pasteFromClipboard = useCallback(async () => {
    const text = await Clipboard.getStringAsync().catch(() => '');
    if (text.length === 0) {
      return;
    }
    if (text.includes('\n')) {
      setPending(text);
      return;
    }
    await pasteToShell(terminalRef.current, text);
  }, [terminalRef]);

  const sheet = (
    <Sheet
      visible={pending !== null}
      onClose={() => {
        setPending(null);
      }}
    >
      <View className="gap-4 px-4 pb-4">
        <Text className="text-sm font-medium text-foreground">{t('ssh.session.pasteTitle')}</Text>
        <Text className="text-sm text-muted-foreground">{t('ssh.session.pasteMultiLine')}</Text>
        <View className="flex-row gap-2">
          <Button
            variant="outline"
            className="flex-1"
            onPress={() => {
              setPending(null);
            }}
          >
            <Text>{t('common.cancel')}</Text>
          </Button>
          <Button
            className="flex-1"
            onPress={() => {
              const text = pending;
              setPending(null);
              if (text !== null) {
                void pasteToShell(terminalRef.current, text);
              }
            }}
          >
            <Text>{t('ssh.session.paste')}</Text>
          </Button>
        </View>
      </View>
    </Sheet>
  );

  return { pasteFromClipboard, sheet };
}
