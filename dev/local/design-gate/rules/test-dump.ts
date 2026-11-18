import { normalize, type LayoutTree, type ProbeDump, type ProbeEnv, type ProbeNode } from '../tree';

export const baseEnv: ProbeEnv = {
  platform: 'android',
  osVersion: '15',
  route: '/test',
  window: { width: 400, height: 800 },
  pixelRatio: 2,
  fontScale: 1,
  colorScheme: 'light',
  isRTL: false,
  language: 'en',
  languagePreference: 'en',
  safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
  tapTarget: { min: 28, touch: 44 },
};

export function dump(children: ProbeNode[], env: Partial<ProbeEnv> = {}): ProbeDump {
  return {
    version: 1,
    env: { ...baseEnv, ...env },
    nodes: [{ parent: -1, tag: 'View', rect: [0, 0, 400, 800] }, ...children],
  };
}

export function tree(children: ProbeNode[], env: Partial<ProbeEnv> = {}): LayoutTree {
  return normalize(dump(children, env));
}
