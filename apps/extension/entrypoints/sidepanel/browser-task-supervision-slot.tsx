import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

// The provider supplies controls later. Local cards add no wrapper or spacing.
export const BrowserTaskSupervisionContext = createContext<ReactNode>(null);

export const BrowserTaskSupervisionSlot = (): ReactNode =>
  useContext(BrowserTaskSupervisionContext);
