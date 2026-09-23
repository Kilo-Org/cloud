import { type Part, type StoredMessage, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { type ReactNode, useCallback, useMemo, useState } from 'react';

import { useOpenPartDetail } from './open-part-detail-context';
import { OpenToolRunContext } from './open-tool-run-context';
import { isToolPart } from './part-types';
import { ToolRunSheet } from './tool-run-sheet';

type ToolRunSheetHostProps = {
  messages: readonly StoredMessage[];
  children: ReactNode;
};

/**
 * Index every part of a surface's live messages by id in a single pass. Part
 * ids are unique, so the map's last write and `findPartById`'s first match are
 * the same lookup; the index replaces the per-render scan over every message
 * and part. It holds every part kind, so callers narrow to the kind they need.
 */
export function indexPartsById(messages: readonly StoredMessage[]): Map<string, Part> {
  const partById = new Map<string, Part>();
  for (const message of messages) {
    for (const part of message.parts) {
      partById.set(part.id, part);
    }
  }
  return partById;
}

/**
 * Per-transcript-surface host: provides the run opener to the condensed rows it
 * wraps and mounts the run sheet. Stores only the open run's part ids and
 * re-resolves the parts through a `messages`-keyed id index on every render, so
 * an open sheet tracks statuses as they stream. A row press closes the run
 * sheet and forwards to the part detail opener.
 */
export function ToolRunSheetHost({ messages, children }: Readonly<ToolRunSheetHostProps>) {
  const [openPartIds, setOpenPartIds] = useState<readonly string[] | null>(null);
  const openPartDetail = useOpenPartDetail();
  const partById = useMemo(() => indexPartsById(messages), [messages]);

  const parts = (openPartIds ?? [])
    .map(partId => partById.get(partId))
    .filter((part): part is ToolPart => part !== undefined && isToolPart(part));

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
