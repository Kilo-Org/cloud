import { type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { type ReactNode, useCallback, useState } from 'react';

import { OpenPartDetailContext } from './open-part-detail-context';
import { findPartById } from './part-detail-model';
import { PartDetailSheet } from './part-detail-sheet';

type PartDetailSheetHostProps = {
  messages: readonly StoredMessage[];
  children: ReactNode;
};

/**
 * Per-transcript-surface host: provides the context opener to the rows it
 * wraps and mounts the detail sheet. Stores only the open part id and
 * re-resolves the part from the live `messages` prop on every render, so an
 * open sheet tracks the part as it streams without a close/reopen. The
 * fragment never wraps children in a layout view — the FlashList needs
 * flex-1 passthrough.
 */
export function PartDetailSheetHost({ messages, children }: Readonly<PartDetailSheetHostProps>) {
  const [openPartId, setOpenPartId] = useState<string | null>(null);

  const part = openPartId ? findPartById(messages, openPartId) : null;

  const open = useCallback((partId: string) => {
    setOpenPartId(partId);
  }, []);

  const close = useCallback(() => {
    setOpenPartId(null);
  }, []);

  return (
    <>
      <OpenPartDetailContext.Provider value={open}>{children}</OpenPartDetailContext.Provider>
      <PartDetailSheet visible={openPartId !== null} part={part} onClose={close} />
    </>
  );
}
