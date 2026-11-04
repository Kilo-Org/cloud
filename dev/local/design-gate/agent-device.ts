import { InfraError } from './capture';
import { TAP_TARGET } from './matrix';
import { APP_ID } from './report';
import type { ProbeDump, ProbeNode } from './tree';
import { snapshotScrollAxes, uiautomatorTag } from './uiautomator';

type Writable<T> = { -readonly [K in keyof T]: T[K] };

type AgentRect = { x: number; y: number; width: number; height: number };

type AgentNode = {
  index: number;
  parentIndex?: number | null;
  type?: string;
  kind?: string;
  label?: string | null;
  contentDescription?: string | null;
  identifier?: string | null;
  bundleId?: string;
  systemBar?: string | null;
  hittable?: boolean | null;
  rect: AgentRect;
};

type AgentSnapshot = {
  androidSnapshot?: { pixelDensity?: unknown };
  viewport?: { width?: unknown; height?: unknown };
  nodes?: unknown;
};

export function agentDeviceArgs(session: string | undefined): string[] {
  return ['snapshot', '--json', '--raw', ...(session === undefined ? [] : ['--session', session])];
}

const round = (value: number) => Math.round(value * 100) / 100;

function isAgentNode(value: unknown): value is AgentNode {
  if (typeof value !== 'object' || value === null) return false;
  const { index, rect } = value as {
    index?: unknown;
    rect?: Partial<Record<keyof AgentRect, unknown>>;
  };
  return (
    typeof index === 'number' &&
    typeof rect === 'object' &&
    rect !== null &&
    typeof rect.x === 'number' &&
    typeof rect.y === 'number' &&
    typeof rect.width === 'number' &&
    typeof rect.height === 'number'
  );
}

export function snapshotInsets(
  nodes: readonly AgentNode[],
  width: number,
  height: number,
  density: number
) {
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  let known = false;
  for (const node of nodes) {
    if (!node.systemBar) continue;
    const { x, y, width: w, height: h } = node.rect;
    if (w <= 0 || h <= 0) continue;
    if (w >= width / 2 && h < height / 2) {
      if (y <= 0) {
        insets.top = Math.max(insets.top, round((y + h) / density));
        known = true;
      } else if (y + h >= height) {
        insets.bottom = Math.max(insets.bottom, round((height - y) / density));
        known = true;
      }
    } else if (h >= height / 2 && w < width / 2) {
      if (x <= 0) {
        insets.left = Math.max(insets.left, round((x + w) / density));
        known = true;
      } else if (x + w >= width) {
        insets.right = Math.max(insets.right, round((width - x) / density));
        known = true;
      }
    }
  }
  return { insets, known };
}

export function agentDeviceToProbeDump(json: string): ProbeDump {
  const data = (JSON.parse(json) as { data?: AgentSnapshot } | null)?.data;
  const density = data?.androidSnapshot?.pixelDensity;
  const width = data?.viewport?.width;
  const height = data?.viewport?.height;
  if (
    typeof density !== 'number' ||
    density <= 0 ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Array.isArray(data?.nodes)
  ) {
    throw new InfraError('agent-device snapshot has no Android pixelDensity, viewport, or nodes');
  }
  const all = data.nodes.filter(isAgentNode);
  const safeArea = snapshotInsets(all, width, height, density);
  const byIndex = new Map(all.map(node => [node.index, node]));
  const kept = all.filter(node => node.bundleId === APP_ID && !node.systemBar);
  const newIndex = new Map(kept.map((node, position) => [node.index, position + 1]));
  const window = { width: round(width / density), height: round(height / density) };
  const nodes: Writable<ProbeNode>[] = [
    { parent: -1, tag: 'View', rect: [0, 0, window.width, window.height] },
  ];
  for (const node of kept) {
    let parent = node.parentIndex ?? undefined;
    while (parent !== undefined && !newIndex.has(parent)) {
      parent = byIndex.get(parent)?.parentIndex ?? undefined;
    }
    const { x, y, width: w, height: h } = node.rect;
    const converted: Writable<ProbeNode> = {
      parent: parent === undefined ? 0 : (newIndex.get(parent) ?? 0),
      tag: uiautomatorTag(node.type ?? ''),
      rect: [round(x / density), round(y / density), round(w / density), round(h / density)],
    };
    const label = node.label ?? undefined;
    if (node.kind === 'text') {
      if (label) converted.text = label;
    } else {
      const accessibilityLabel = label ?? node.contentDescription ?? undefined;
      if (accessibilityLabel) converted.label = accessibilityLabel;
    }
    if (node.identifier && !node.identifier.startsWith('com.android.')) {
      converted.testID = node.identifier;
    }
    if (node.hittable === true && node.kind !== 'scroll-area') converted.pressable = true;
    if (node.kind === 'scroll-area') converted.scrollAxes = snapshotScrollAxes(converted.tag);
    nodes.push(converted);
  }
  return {
    version: 1,
    env: {
      source: 'agent-device',
      platform: 'android',
      osVersion: '',
      route: '',
      window,
      pixelRatio: density,
      fontScale: 1,
      colorScheme: 'unknown',
      isRTL: false,
      language: 'unknown',
      languagePreference: 'unknown',
      safeArea: safeArea.insets,
      safeAreaKnown: safeArea.known,
      tapTarget: TAP_TARGET,
    },
    nodes,
  };
}
