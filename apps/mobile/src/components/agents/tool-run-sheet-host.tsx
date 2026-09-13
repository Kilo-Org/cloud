import { type StoredMessage, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { type ReactNode, useCallback, useState } from 'react';

import { useOpenPartDetail } from './open-part-detail-context';
import { OpenToolRunContext } from './open-tool-run-context';
import { findPartById } from './part-detail-model';
import { isToolPart } from './part-types';
import { ToolRunSheet } from './tool-run-sheet';

type ToolRunSheetHostProps = {
  messages: readonly StoredMessage[];
  children: ReactNode;
};

/**
 * Per-transcript-surface host: provides the run opener to the condensed rows it
 * wraps and mounts the run sheet. Stores only the open run's part ids and
 * re-resolves the parts from the live `messages` prop on every render, so an
 * open sheet tracks statuses as they stream. A row press closes the run sheet
 * and forwards to the part detail opener.
 */
export function ToolRunSheetHost({ messages, children }: Readonly<ToolRunSheetHostProps>) {
  const [openPartIds, setOpenPartIds] = useState<readonly string[] | null>(null);
  const openPartDetail = useOpenPartDetail();

  const parts = (openPartIds ?? [])
    .map(partId => findPartById(messages, partId))
    .filter((part): part is ToolPart => part !== null && isToolPart(part));

  const open = useCallback((runParts: readonly ToolPart[]) => {
    setOpenPartIds(runParts.map(part => part.id));
  }, []);

  const close = useCallback(() => {
    setOpenPartIds(null);
  }, []);

  const handleOpenPart = useCallback(
    (partId: string) => {
      setOpenPartIds(null);
      openPartDetail?.(partId);
    },
    [openPartDetail]
  );

  return (
    <>
      <OpenToolRunContext.Provider value={open}>{children}</OpenToolRunContext.Provider>
      <ToolRunSheet
        visible={openPartIds !== null}
        parts={parts}
        onClose={close}
        onOpenPart={handleOpenPart}
      />
    </>
  );
}
