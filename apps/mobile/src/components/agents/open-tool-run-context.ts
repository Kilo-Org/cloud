import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { createContext, useContext } from 'react';

/**
 * Single test seam for condensed-row press behavior. Mounted once per transcript
 * surface by `ToolRunSheetHost`; condensed rows read it to open the run sheet.
 * Lives in its own module with no component imports so the row module and the
 * sheet module do not form an import cycle (mirrors
 * `open-part-detail-context.ts`).
 */
export const OpenToolRunContext = createContext<((parts: readonly ToolPart[]) => void) | null>(
  null
);

export function useOpenToolRun(): ((parts: readonly ToolPart[]) => void) | null {
  return useContext(OpenToolRunContext);
}
