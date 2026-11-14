import { SessionForwardsSheet } from '@/components/ssh/forwards/session-forwards-sheet';
import { SshSessionMenu } from '@/components/ssh/session/ssh-session-menu';
import { setIdleNotify } from '@/lib/ssh/session/idle-notify';

type SshSessionOverlaysProps = Readonly<{
  sessionId: string;
  hostId: string;
  nativeSessionId: string | null;
  shellId: string | null;
  menuOpen: boolean;
  forwardsOpen: boolean;
  onMenuClose: () => void;
  onForwardsClose: () => void;
  onOpenFiles: () => void;
  onOpenForwards: () => void;
}>;

/** The two sheets the terminal opens over itself: its menu and its forwards. */
export function SshSessionOverlays({
  sessionId,
  hostId,
  nativeSessionId,
  shellId,
  menuOpen,
  forwardsOpen,
  onMenuClose,
  onForwardsClose,
  onOpenFiles,
  onOpenForwards,
}: SshSessionOverlaysProps) {
  return (
    <>
      <SshSessionMenu
        visible={menuOpen}
        sessionId={sessionId}
        shellId={shellId}
        onOpenFiles={onOpenFiles}
        onOpenForwards={onOpenForwards}
        onNotifyChange={next => {
          setIdleNotify(sessionId, next);
        }}
        onClose={onMenuClose}
      />
      <SessionForwardsSheet
        visible={forwardsOpen}
        hostId={hostId}
        sessionId={sessionId}
        nativeSessionId={nativeSessionId}
        onClose={onForwardsClose}
      />
    </>
  );
}
