import { type TerminalViewHandle } from '@kilocode/react-native-ssh';
import * as Clipboard from 'expo-clipboard';
import { usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useColorScheme, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { SshHostKeyBlocked } from '@/components/ssh/session/ssh-host-key-blocked';
import { SshSessionNotice } from '@/components/ssh/session/ssh-session-notice';
import { SshSessionStage } from '@/components/ssh/session/ssh-session-stage';
import { SshSessionSwitcher } from '@/components/ssh/session/ssh-session-switcher';
import { TerminalKeyBar } from '@/components/ssh/session/terminal-key-bar';
import { TerminalSurface } from '@/components/ssh/session/terminal-surface';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { RefreshCw, Rows3, Terminal, WifiOff } from '@/components/ui/icons';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { openExternalUrl } from '@/lib/external-link';
import { useTerminalFontSize } from '@/lib/hooks/use-terminal-font-size';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  closeSession,
  consumePendingCommand,
  decideHostKey,
  endShell,
  retrySession,
} from '@/lib/ssh/session/manager';
import { closeReasonMessage } from '@/lib/ssh/session/phase-copy';
import { needsPrompt, type SshSessionPhase } from '@/lib/ssh/session/types';
import { useSshSession, useSshSessions } from '@/lib/ssh/session/use-sessions';
import {
  SSH_HOSTS_ROUTE,
  SSH_KNOWN_HOSTS_ROUTE,
  sshPromptPath,
  sshSessionPath,
} from '@/lib/ssh/routes';
import { encodeTerminalInput } from '@/lib/ssh/terminal-bytes';

type SshTerminalScreenProps = Readonly<{ sessionId: string }>;

/**
 * One shell: the native terminal, the key bar under it, and the strip that
 * says why it is not live. The session itself outlives this screen, so every
 * decision goes through the session manager rather than local state.
 */
export function SshTerminalScreen({ sessionId }: SshTerminalScreenProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const colors = useThemeColors();
  const dark = useColorScheme() === 'dark';
  const session = useSshSession(sessionId);
  const sessions = useSshSessions();
  const { fontSize, setFontSize } = useTerminalFontSize();
  const terminalRef = useRef<TerminalViewHandle>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [pasteText, setPasteText] = useState<string | null>(null);
  const [shellTitle, setShellTitle] = useState<string | null>(null);

  const phase: SshSessionPhase | null = session?.phase ?? null;
  const promptWaiting = phase !== null && needsPrompt(phase);
  const promptOnTop = pathname.includes('/ssh/prompt/');
  const shellId = session?.shellId ?? null;
  const pendingCommand = session?.pendingCommand ?? null;

  useEffect(() => {
    if (promptWaiting && !promptOnTop) {
      router.push(sshPromptPath(sessionId));
    }
  }, [promptWaiting, promptOnTop, router, sessionId]);

  // The tmux attach is typed into the pty once, as soon as the view that owns
  // the source has mounted.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (pendingCommand === null || shellId === null || terminal === null) {
      return;
    }
    void typeOnce(terminal, sessionId, pendingCommand);
  }, [pendingCommand, shellId, sessionId]);

  const send = useCallback((text: string) => {
    void sendToShell(terminalRef.current, text);
  }, []);

  async function pasteFromClipboard() {
    const text = await Clipboard.getStringAsync().catch(() => '');
    if (text.length === 0) {
      return;
    }
    if (text.includes('\n')) {
      setPasteText(text);
      return;
    }
    await terminalRef.current?.paste(text).catch(() => undefined);
  }

  if (session === null || phase === null) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('ssh.session.closedTitle')} backFallback={SSH_HOSTS_ROUTE} />
        <EmptyState
          icon={Terminal}
          title={t('ssh.session.closedTitle')}
          description={t('ssh.session.closedDescription')}
          action={
            <Button
              className={STATE_ACTION_CLASS}
              onPress={() => {
                router.replace(SSH_HOSTS_ROUTE);
              }}
            >
              <Text>{t('ssh.session.backToHosts')}</Text>
            </Button>
          }
        />
      </View>
    );
  }

  const blockedHostKey =
    phase.kind === 'awaiting-host-key' && phase.hostKey.knownFingerprintSha256 !== null
      ? { ...phase.hostKey, knownFingerprintSha256: phase.hostKey.knownFingerprintSha256 }
      : null;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={session.label}
        subtitle={shellTitle ?? session.target}
        backFallback={SSH_HOSTS_ROUTE}
        headerRight={
          <IconButton
            accessibilityLabel={t('ssh.session.switcherTitle')}
            onPress={() => {
              setSwitcherOpen(true);
            }}
          >
            <Rows3 size={20} color={colors.foreground} />
          </IconButton>
        }
      />

      {phase.kind === 'reconnecting' ? (
        <SshSessionNotice
          tone="warn"
          icon={WifiOff}
          title={t('ssh.session.reconnectingTitle', { attempt: phase.attempt })}
          message={closeReasonMessage(t, phase.reason)}
          action={
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onPress={() => {
                retrySession(sessionId);
              }}
            >
              <RefreshCw size={14} color={colors.foreground} />
              <Text>{t('ssh.session.retryNow')}</Text>
            </Button>
          }
        />
      ) : null}

      {blockedHostKey === null ? (
        <KeyboardAvoidingView className="flex-1" behavior="padding">
          <View className="flex-1 bg-background">
            {shellId === null ? (
              <SshSessionStage
                phase={phase}
                target={session.target}
                onRetry={() => {
                  retrySession(sessionId);
                }}
                onClose={() => {
                  void closeSession(sessionId);
                }}
              />
            ) : (
              <TerminalSurface
                handleRef={terminalRef}
                sourceId={shellId}
                fontSize={fontSize}
                dark={dark}
                onLinkPress={url => {
                  void openExternalUrl(url);
                }}
                onTitleChange={setShellTitle}
                onFontSizeChange={setFontSize}
                onClosed={error => {
                  endShell(sessionId, error);
                }}
              />
            )}
          </View>
          {shellId === null ? null : (
            <TerminalKeyBar
              disabled={false}
              onSend={send}
              onPaste={() => {
                void pasteFromClipboard();
              }}
            />
          )}
        </KeyboardAvoidingView>
      ) : (
        <SshHostKeyBlocked
          hostKey={blockedHostKey}
          onOpenKnownHosts={() => {
            decideHostKey(sessionId, 'cancel');
            router.push(SSH_KNOWN_HOSTS_ROUTE);
          }}
          onClose={() => {
            void closeSession(sessionId);
          }}
        />
      )}

      <SshSessionSwitcher
        visible={switcherOpen}
        sessions={sessions}
        activeId={sessionId}
        onSelect={id => {
          setSwitcherOpen(false);
          if (id !== sessionId) {
            router.replace(sshSessionPath(id));
          }
        }}
        onNewSession={() => {
          setSwitcherOpen(false);
          router.push(SSH_HOSTS_ROUTE);
        }}
        onClose={() => {
          setSwitcherOpen(false);
        }}
      />

      <Sheet
        visible={pasteText !== null}
        onClose={() => {
          setPasteText(null);
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
                setPasteText(null);
              }}
            >
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button
              className="flex-1"
              onPress={() => {
                const text = pasteText;
                setPasteText(null);
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
    </View>
  );
}

/**
 * Types the pending command — the tmux attach — and then records that it was
 * sent. The shell can end between the mount and the keystroke, which is not a
 * failure this screen can act on.
 */
async function typeOnce(
  terminal: TerminalViewHandle,
  sessionId: string,
  command: string
): Promise<void> {
  try {
    await terminal.sendInput(encodeTerminalInput(command));
    consumePendingCommand(sessionId, command);
  } catch {
    // The shell closed before the command reached it.
  }
}

/** Sends one key sequence to the shell, ignoring a shell that already closed. */
async function sendToShell(terminal: TerminalViewHandle | null, text: string): Promise<void> {
  try {
    await terminal?.sendInput(encodeTerminalInput(text));
  } catch {
    // The shell closed under this key.
  }
}

/** Sends pasted text through the view's own paste, ignoring a closed shell. */
async function pasteToShell(terminal: TerminalViewHandle | null, text: string): Promise<void> {
  try {
    await terminal?.paste(text);
  } catch {
    // The shell closed before the paste.
  }
}
