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

/**
 * Whether a converted node scrolls its children. A scrolled list reports its
 * container frames already clipped to the pane that draws them, so it is the
 * one place where a container's frame and its children's frames are in
 * different spaces.
 */
function scrollsChildren(entry: ProbeNode): boolean {
  return (
    entry.scrollAxes !== undefined ||
    entry.tag.endsWith('ScrollView') ||
    entry.tag === 'RecyclerView'
  );
}

/**
 * A snapshot reports a scrolled list's container frames clipped to the pane
 * that draws them, while the text inside a row keeps the frame of the whole
 * row. A text run then measures outside the row that owns it, and
 * `touch-overlap` reports two tap owners where the platform has one.
 *
 * Mark every box inside a scrolling pane as one that clips what it draws, so
 * the layout model derives a visible frame for those children instead of the
 * raw snapshot rect. Each node keeps its own `rect`: the overflow rules still
 * see a plain card that really does paint outside itself, and the size rules
 * still measure a control's platform frame rather than the sliver of a pane
 * that shows it.
 */
function markScrolledBoxes(
  converted: Writable<ProbeNode>,
  parent: ProbeNode | undefined,
  insideScroller: boolean
): boolean {
  const inside = insideScroller || (parent !== undefined && scrollsChildren(parent));
  if (inside) {
    converted.style = { ...converted.style, overflow: 'hidden' };
    // The drawn frame is the one the parent's box holds. `rect` stays the
    // platform frame for the size rules; `layoutRect` is what the overflow
    // rules compare, so it takes the parent's clip and a scrolled row's
    // content-space child no longer reads as a child that paints outside.
    const clip = parent?.layoutRect ?? parent?.rect;
    if (clip !== undefined) {
      const left = Math.max(converted.rect[0], clip[0]);
      const top = Math.max(converted.rect[1], clip[1]);
      const right = Math.min(converted.rect[0] + converted.rect[2], clip[0] + clip[2]);
      const bottom = Math.min(converted.rect[1] + converted.rect[3], clip[1] + clip[3]);
      const clipped: [number, number, number, number] = [
        round(left),
        round(top),
        round(Math.max(0, right - left)),
        round(Math.max(0, bottom - top)),
      ];
      const same = clipped.every((value, index) => value === round(converted.rect[index] ?? 0));
      if (!same) converted.layoutRect = clipped;
    }
  }
  return inside;
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
  const scrolled = new Map<number, boolean>();
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
    scrolled.set(
      newIndex.get(node.index) ?? 0,
      markScrolledBoxes(converted, nodes[converted.parent], scrolled.get(converted.parent) ?? false)
    );
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
