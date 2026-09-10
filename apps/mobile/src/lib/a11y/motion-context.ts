import { createContext, useContext } from 'react';

export type MotionPolicy = {
  scrollAnimated: boolean;
  reducedMotion: boolean;
};

export const MotionContext = createContext<MotionPolicy | null>(null);

export function useProvidedMotionPolicy() {
  return useContext(MotionContext);
}
