import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfigureRow } from '@/components/ui/configure-row';
import { Archive } from '@/components/ui/icons';

/**
 * The artifacts sheet's own module graph reaches the file system and the share
 * sheet, which no session that never opens it needs. The row loads it on the
 * first press and keeps it mounted afterwards, so opening it again is the sheet
 * it left rather than a fresh mount.
 */
const LazySessionArtifactsSheet = lazy(async () => {
  const module = await import('./session-artifacts-sheet');
  return { default: module.SessionArtifactsSheet };
});

type SessionArtifactsRowProps = {
  /** The session whose saved files the sheet lists; a stored-only session has none. */
  cloudAgentSessionId: string | null;
  /** Set for an organization-owned session, which reads through its own router. */
  organizationId: string | undefined;
};

/**
 * Session-level entry to the files the worker kept from the sandbox's
 * /artifacts folder. A session with no control-plane id has no artifacts to
 * list, so the row is absent rather than disabled.
 */
export function SessionArtifactsRow({
  cloudAgentSessionId,
  organizationId,
}: Readonly<SessionArtifactsRowProps>) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const [visible, setVisible] = useState(false);
  if (cloudAgentSessionId === null) {
    return null;
  }
  const label = t('cloudAgent.artifacts.title');
  return (
    <>
      <ConfigureRow
        testID="session-context-sheet-artifacts"
        icon={Archive}
        title={label}
        variant="navigation"
        accessibilityLabel={label}
        onPress={() => {
          setOpened(true);
          setVisible(true);
        }}
      />
      {opened ? (
        <Suspense fallback={null}>
          <LazySessionArtifactsSheet
            visible={visible}
            onClose={() => {
              setVisible(false);
            }}
            cloudAgentSessionId={cloudAgentSessionId}
            organizationId={organizationId}
          />
        </Suspense>
      ) : null}
    </>
  );
}
