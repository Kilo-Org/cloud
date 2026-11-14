import { usePathname, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
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
import { blurShell, sendToShell } from '@/components/ssh/session/terminal-input';
import { useTerminalPaste } from '@/components/ssh/session/terminal-paste';
import { TerminalSurface } from '@/components/ssh/session/terminal-surface';
import { useTerminalShell } from '@/components/ssh/session/use-terminal-shell';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { FolderOpen, MoreHorizontal, RefreshCw, Rows3, WifiOff } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/external-link';
import { useTerminalFontSize } from '@/lib/hooks/use-terminal-font-size';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { closeSession, decideHostKey, endShell, retrySession } from '@/lib/ssh/session/manager';
import { useIdleNotifyArming } from '@/lib/ssh/session/use-idle-notify-arming';
import { closeReasonMessage } from '@/lib/ssh/session/phase-copy';
import { needsPrompt, type SshSessionPhase } from '@/lib/ssh/session/types';
import {
  useSshSession,
  useSshSessions,
  useSshSessionsRehydrated,
} from '@/lib/ssh/session/use-sessions';
import {
  SSH_HOSTS_ROUTE,
  SSH_KNOWN_HOSTS_ROUTE,
  SSH_SNIPPETS_ROUTE,
  sshFilesPath,
  sshPromptPath,
  sshSessionPath,
} from '@/lib/ssh/routes';
import { type SshSnippet } from '@/lib/ssh/snippets';

type SshTerminalScreenProps = Readonly<{ sessionId: string; initialKeyBarEditor?: boolean }>;

/**
 * One shell: the native terminal, the key bar under it, and the strip that
 * says why it is not live. The session itself outlives this screen, so every
 * decision goes through the session manager rather than local state.
 */
export function SshTerminalScreen({ sessionId, initialKeyBarEditor }: SshTerminalScreenProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const colors = useThemeColors();
  const session = useSshSession(sessionId);
  const sessions = useSshSessions();
  const rehydrated = useSshSessionsRehydrated();
  const { fontSize, setFontSize } = useTerminalFontSize();
  const { terminalRef, displayedShellId, surface, autoFocus, inputReady, onLayout, onSourceBound } =
    useTerminalShell(sessionId, session);
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

  useIdleNotifyArming(sessionId, shellId, phase?.kind ?? null);

  useEffect(() => {
    if (promptWaiting && !promptOnTop) {
      router.push(sshPromptPath(sessionId));
    }
  }, [promptWaiting, promptOnTop, router, sessionId]);

  async function sendSnippet(snippet: SshSnippet) {
    setSnippetsOpen(false);
    const terminal = terminalRef.current;
    await sendToShell(terminal, snippet.command);
    if (snippet.appendNewline) {
      await sendToShell(terminal, '\r');
    }
  }

  if (session === null || phase === null) {
    // A reload empties the JS store before the registry's sessions are adopted,
    // and the router restores this route in that window: an absent session here
    // is not yet a closed one, so the ending waits for the adoption pass.
    return rehydrated ? <SshTerminalClosed /> : null;
  }

  const showStage = surface?.stage ?? false;
  const terminalArea =
    !surface?.terminal || displayedShellId === null ? null : (
      <TerminalSurface
        handleRef={terminalRef}
        sourceId={displayedShellId}
        autoFocus={autoFocus}
        fontSize={fontSize}
        onLayout={onLayout}
        onSourceBound={onSourceBound}
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

      {surface?.reconnecting && (phase.kind === 'connecting' || phase.kind === 'reconnecting') ? (
        <SshSessionNotice
          tone="warn"
          icon={WifiOff}
          title={t('ssh.session.reconnectingTitle', {
            attempt: phase.attempt,
          })}
          message={
            phase.kind === 'reconnecting'
              ? closeReasonMessage(t, phase.reason)
              : t('ssh.session.reconnectingStage', {
                  target: session.target,
                  attempt: phase.attempt,
                })
          }
          action={
            phase.kind === 'reconnecting' ? (
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
            ) : null
          }
        />
      ) : null}

      {blockedHostKey === null ? (
        <KeyboardAvoidingView className="flex-1" behavior="padding">
          <View className="flex-1 bg-background">{terminalArea ?? stageArea}</View>
          {!surface?.terminal ? null : (
            <TerminalKeyBar
              disabled={!inputReady}
              initialEditing={initialKeyBarEditor}
              onSend={text => {
                void sendToShell(terminalRef.current, text);
              }}
              onPaste={() => {
                void paste.pasteFromClipboard();
              }}
              onSnippets={() => {
                setSnippetsOpen(true);
              }}
              onHideKeyboard={() => {
                void blurShell(terminalRef.current);
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
