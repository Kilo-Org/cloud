import { type TerminalViewHandle } from '../../../../modules/kilo-ssh/src';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { SnippetsSheet } from '@/components/ssh/snippets/snippets-sheet';
import { SshSessionNotice } from '@/components/ssh/session/ssh-session-notice';
import { TerminalKeyBar } from '@/components/ssh/session/terminal-key-bar';
import { sendToShell } from '@/components/ssh/session/terminal-input';
import { useTerminalPaste } from '@/components/ssh/session/terminal-paste';
import { TerminalSurface } from '@/components/ssh/session/terminal-surface';
import { Button } from '@/components/ui/button';
import { RefreshCw, Terminal, WifiOff } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/external-link';
import { useTerminalFontSize } from '@/lib/hooks/use-terminal-font-size';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type TerminalFailureReason } from '@/lib/ssh/cloud-agent/terminal-connection';
import { useSandboxTerminal } from '@/lib/ssh/cloud-agent/use-sandbox-terminal';
import { SSH_HOSTS_ROUTE, SSH_SNIPPETS_ROUTE } from '@/lib/ssh/routes';
import { type SshSnippet } from '@/lib/ssh/snippets';

type SandboxTerminalScreenProps = Readonly<{
  cloudAgentSessionId: string;
  organizationId?: string;
  /** The session's title; the shell's own title replaces it when it reports one. */
  sessionTitle?: string;
}>;

/**
 * A terminal in a Cloud Agent sandbox: the Worker's pty over a JavaScript
 * socket, drawn by the native view the SSH sessions use. The screen owns the
 * four ways a terminal can end — a retryable reconnect, a sleeping sandbox, a
 * shell that exited, and a refusal — and leaves the pty's own lifecycle to the
 * connection.
 */
export function SandboxTerminalScreen({
  cloudAgentSessionId,
  organizationId,
  sessionTitle,
}: SandboxTerminalScreenProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const colors = useThemeColors();
  const { fontSize, setFontSize } = useTerminalFontSize();
  const { sourceId, state, retry } = useSandboxTerminal({ cloudAgentSessionId, organizationId });
  const terminalRef = useRef<TerminalViewHandle>(null);
  const [shellTitle, setShellTitle] = useState<string | null>(null);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const paste = useTerminalPaste(terminalRef);

  // A reconnect keeps the buffer and puts its status in the strip above, where
  // the keyboard would only cover it.
  useEffect(() => {
    if (state.kind === 'reconnecting' || state.kind === 'stopped') {
      Keyboard.dismiss();
    }
  }, [state.kind]);

  async function sendSnippet(snippet: SshSnippet) {
    setSnippetsOpen(false);
    const terminal = terminalRef.current;
    await sendToShell(terminal, snippet.command);
    if (snippet.appendNewline) {
      await sendToShell(terminal, '\r');
    }
  }

  const terminalArea =
    sourceId === null ? null : (
      <TerminalSurface
        handleRef={terminalRef}
        sourceId={sourceId}
        autoFocus
        fontSize={fontSize}
        onLinkPress={url => {
          void openExternalUrl(url);
        }}
        onTitleChange={setShellTitle}
        onFontSizeChange={setFontSize}
      />
    );

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={sessionTitle ?? t('ssh.sandbox.title')}
        subtitle={shellTitle ?? t('ssh.sandbox.subtitle')}
        backFallback={SSH_HOSTS_ROUTE}
      />

      {state.kind === 'connecting' ? (
        <SshSessionNotice
          tone="warn"
          icon={Terminal}
          title={t('ssh.sandbox.connectingTitle')}
          message={t('ssh.sandbox.connectingMessage')}
        />
      ) : null}

      {state.kind === 'reconnecting' ? (
        <SshSessionNotice
          tone="warn"
          icon={WifiOff}
          title={t('ssh.session.reconnectingTitle', { attempt: state.attempt })}
          message={t('ssh.sandbox.reconnectingMessage')}
          action={
            <Button variant="outline" size="sm" className="self-start" onPress={retry}>
              <RefreshCw size={14} color={colors.foreground} />
              <Text>{t('ssh.session.retryNow')}</Text>
            </Button>
          }
        />
      ) : null}

      {state.kind === 'stopped' ? (
        <SshSessionNotice
          tone="warn"
          icon={Terminal}
          title={t('ssh.sandbox.stoppedTitle')}
          message={t('ssh.sandbox.stoppedMessage')}
          action={
            <Button variant="outline" size="sm" className="self-start" onPress={retry}>
              <RefreshCw size={14} color={colors.foreground} />
              <Text>{t('common.retry')}</Text>
            </Button>
          }
        />
      ) : null}

      {state.kind === 'exited' ? (
        <SshSessionNotice
          tone="warn"
          icon={Terminal}
          title={t('common.sessionExited')}
          message={t('ssh.sandbox.exitedMessage')}
          action={
            <Button variant="outline" size="sm" className="self-start" onPress={retry}>
              <RefreshCw size={14} color={colors.foreground} />
              <Text>{t('ssh.sandbox.newTerminal')}</Text>
            </Button>
          }
        />
      ) : null}

      {state.kind === 'failed' ? (
        <EmptyState
          icon={Terminal}
          title={t(FAILURE_COPY[state.reason].title)}
          description={t(FAILURE_COPY[state.reason].message)}
          action={
            <Button
              variant="outline"
              onPress={() => {
                router.replace(SSH_HOSTS_ROUTE);
              }}
            >
              <Text>{t('ssh.session.backToHosts')}</Text>
            </Button>
          }
        />
      ) : (
        <KeyboardAvoidingView className="flex-1" behavior="padding">
          <View className="flex-1 bg-background">{terminalArea}</View>
          <TerminalKeyBar
            disabled={state.kind !== 'connected'}
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
        </KeyboardAvoidingView>
      )}

      {paste.sheet}

      <SnippetsSheet
        visible={snippetsOpen}
        hostId={null}
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
    </View>
  );
}

/**
 * The copy a refusal reads as. A reason is one of the four the connection can
 * report, and each is final: none of them is retried from this screen.
 */
const FAILURE_COPY = {
  'not-found': {
    title: 'common.notFound',
    message: 'ssh.sandbox.notFoundMessage',
  },
  forbidden: {
    title: 'common.accessDenied',
    message: 'ssh.sandbox.forbiddenMessage',
  },
  unavailable: {
    title: 'ssh.sandbox.unavailableTitle',
    message: 'ssh.sandbox.unavailableMessage',
  },
  disconnected: {
    title: 'ssh.sandbox.disconnectedTitle',
    message: 'ssh.sandbox.disconnectedMessage',
  },
} satisfies Record<TerminalFailureReason, { title: string; message: string }>;
