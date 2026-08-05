import { createContext, useContext } from 'react';

/**
 * Single test seam for row-press behavior. Mounted once per transcript surface
 * by `PartDetailSheetHost`; rows read it to open the detail sheet for a part.
 * Lives in its own module with no component imports so the card split compiles
 * before the sheet infrastructure exists.
 */
export const OpenPartDetailContext = createContext<((partId: string) => void) | null>(null);

export function useOpenPartDetail(): ((partId: string) => void) | null {
  return useContext(OpenPartDetailContext);
}
