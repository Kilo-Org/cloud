import { type TerminalViewHandle } from '../../../../modules/kilo-ssh/src';
import { usePathname, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { ScreenHeader } from '@/components/screen-header';
import { SshSessionOverlays } from '@/components/ssh/session/ssh-session-overlays';
import { SshTerminalClosed } from '@/components/ssh/session/ssh-terminal-closed';
import { SnippetsSheet } from '@/components/ssh/snippets/snippets-sheet';
import { SshHostKeyBlocked } from '@/components/ssh/session/ssh-host-key-blocked';
import { SshSessionNotice } from '@/components/ssh/session/ssh-session-notice';
import { SshSessionStage } from '@/components/ssh/session/ssh-session-stage';
import { SshSessionSwitcher } from '@/components/ssh/session/ssh-session-switcher';
import { TerminalKeyBar } from '@/components/ssh/session/terminal-key-bar';
import { sendToShell } from '@/components/ssh/session/terminal-input';
import { useTerminalPaste } from '@/components/ssh/session/terminal-paste';
import { TerminalSurface } from '@/components/ssh/session/terminal-surface';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { FolderOpen, MoreHorizontal, RefreshCw, Rows3, WifiOff } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
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
import { useIdleNotifyArming } from '@/lib/ssh/session/use-idle-notify-arming';
import { closeReasonMessage } from '@/lib/ssh/session/phase-copy';
import { needsPrompt, type SshSessionPhase } from '@/lib/ssh/session/types';
import { useSshSession, useSshSessions } from '@/lib/ssh/session/use-sessions';
import {
  SSH_HOSTS_ROUTE,
  SSH_KNOWN_HOSTS_ROUTE,
  SSH_SNIPPETS_ROUTE,
  sshFilesPath,
  sshPromptPath,
  sshSessionPath,
} from '@/lib/ssh/routes';
import { type SshSnippet } from '@/lib/ssh/snippets';
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
  const session = useSshSession(sessionId);
  const sessions = useSshSessions();
  const { fontSize, setFontSize } = useTerminalFontSize();
  const terminalRef = useRef<TerminalViewHandle>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [forwardsOpen, setForwardsOpen] = useState(false);
  const [shellTitle, setShellTitle] = useState<string | null>(null);
  const paste = useTerminalPaste(terminalRef);

  const phase: SshSessionPhase | null = session?.phase ?? null;
  const promptWaiting = phase !== null && needsPrompt(phase);
  const promptOnTop = pathname.includes('/ssh/prompt/');
  const shellId = session?.shellId ?? null;
  const pendingCommand = session?.pendingCommand ?? null;

  useIdleNotifyArming(sessionId, shellId, phase?.kind ?? null);

  // A reconnect leaves the last output on screen and the strip above it as the
  // status; the keyboard would only cover that shell, so it closes.
  useEffect(() => {
    if (phase?.kind === 'reconnecting') {
      Keyboard.dismiss();
    }
  }, [phase?.kind]);

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

  async function sendSnippet(snippet: SshSnippet) {
    setSnippetsOpen(false);
    const terminal = terminalRef.current;
    await sendToShell(terminal, snippet.command);
    if (snippet.appendNewline) {
      await sendToShell(terminal, '\r');
    }
  }

  if (session === null || phase === null) {
    return <SshTerminalClosed />;
  }

  // A shell that exists keeps its view — and its buffer — through a reconnect,
  // so the strip above is the only status then. The wait and the endings own
  // the area only when there is no shell at all.
  const showStage = phase.kind === 'connecting' || phase.kind === 'closed';
  const terminalArea =
    shellId === null ? null : (
      <TerminalSurface
        handleRef={terminalRef}
        sourceId={shellId}
        fontSize={fontSize}
        onLinkPress={url => {
          void openExternalUrl(url);
        }}
        onTitleChange={setShellTitle}
        onFontSizeChange={setFontSize}
        onClosed={error => {
          endShell(sessionId, error);
        }}
      />
    );
  const stageArea = showStage ? (
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
  ) : null;

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
          <View className="flex-row items-center">
            <IconButton
              accessibilityLabel={t('ssh.files.openAction')}
              onPress={() => {
                router.push(sshFilesPath(sessionId));
              }}
            >
              <FolderOpen size={20} color={colors.foreground} />
            </IconButton>
            <IconButton
              accessibilityLabel={t('ssh.session.menuTitle')}
              onPress={() => {
                setMenuOpen(true);
              }}
            >
              <MoreHorizontal size={20} color={colors.foreground} />
            </IconButton>
            <IconButton
              accessibilityLabel={t('ssh.session.switcherTitle')}
              onPress={() => {
                setSwitcherOpen(true);
              }}
            >
              <Rows3 size={20} color={colors.foreground} />
            </IconButton>
          </View>
        }
        headerRightWidth={144}
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
            {/* A shell that exists stays mounted through a reconnect, with its
                buffer, so the strip above is the only status on the screen. */}
            {terminalArea ?? stageArea}
          </View>
          {shellId === null ? null : (
            <TerminalKeyBar
              disabled={phase.kind !== 'connected'}
              onSend={text => {
                void sendToShell(terminalRef.current, text);
              }}
              onPaste={() => {
                void paste.pasteFromClipboard();
              }}
              onSnippets={() => {
                setSnippetsOpen(true);
              }}
            />
          )}
        </KeyboardAvoidingView>
      ) : (
        <SshHostKeyBlocked
          hostKey={blockedHostKey}
          label={session.label}
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

      <SnippetsSheet
        visible={snippetsOpen}
        hostId={session.hostId}
        onSelect={snippet => {
          void sendSnippet(snippet);
        }}
        onManage={() => {
          setSnippetsOpen(false);
          router.push(SSH_SNIPPETS_ROUTE);
        }}
        onClose={() => {
          setSnippetsOpen(false);
        }}
      />

      <SshSessionOverlays
        sessionId={sessionId}
        hostId={session.hostId}
        nativeSessionId={session.nativeSessionId}
        shellId={shellId}
        menuOpen={menuOpen}
        forwardsOpen={forwardsOpen}
        onMenuClose={() => {
          setMenuOpen(false);
        }}
        onForwardsClose={() => {
          setForwardsOpen(false);
        }}
        onOpenFiles={() => {
          router.push(sshFilesPath(sessionId));
        }}
        onOpenForwards={() => {
          setMenuOpen(false);
          setForwardsOpen(true);
        }}
      />

      {paste.sheet}
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
