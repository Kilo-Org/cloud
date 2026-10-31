import { z } from 'zod';

import type { ElementRef, Rect } from './findings';

export type { Rect } from './findings';

const RectSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]).readonly();
const InsetsSchema = z.object({
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
  left: z.number(),
});

const ProbeNodeSchema = z.object({
  parent: z.number().int().min(-1),
  tag: z.string(),
  rect: RectSchema,
  layoutRect: RectSchema.optional(),
  owners: z.array(z.string()).optional(),
  text: z.string().optional(),
  testID: z.string().optional(),
  label: z.string().optional(),
  role: z.string().optional(),
  pressable: z.literal(true).optional(),
  hitSlop: InsetsSchema.optional(),
  lines: z.number().optional(),
  screenState: z.number().optional(),
  scrollAxes: z.object({ x: z.boolean(), y: z.boolean() }).optional(),
  style: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

const ProbeEnvSchema = z.object({
  platform: z.string(),
  osVersion: z.string(),
  route: z.string(),
  window: z.object({ width: z.number(), height: z.number() }),
  pixelRatio: z.number().positive(),
  fontScale: z.number(),
  colorScheme: z.string(),
  isRTL: z.boolean(),
  language: z.string(),
  languagePreference: z.string(),
  safeArea: InsetsSchema,
  safeAreaKnown: z.boolean().optional(),
  tapTarget: z.object({ min: z.number(), touch: z.number() }),
  source: z.enum(['probe', 'uiautomator', 'agent-device']).optional(),
});

export const ProbeDumpSchema = z
  .object({
    version: z.literal(1),
    env: ProbeEnvSchema,
    nodes: z.array(ProbeNodeSchema).min(1),
  })
  .superRefine((dump, ctx) => {
    dump.nodes.forEach((node, index) => {
      if (index === 0 ? node.parent !== -1 : node.parent < 0 || node.parent >= index) {
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', index, 'parent'],
          message: 'parent must precede the node in DFS pre-order; only nodes[0] is the root',
        });
      }
    });
  });

export type Insets = z.infer<typeof InsetsSchema>;
export type ProbeNode = z.infer<typeof ProbeNodeSchema>;
export type ProbeEnv = z.infer<typeof ProbeEnvSchema>;
export type ProbeDump = z.infer<typeof ProbeDumpSchema>;

export function parseDump(input: unknown): ProbeDump {
  return ProbeDumpSchema.parse(typeof input === 'string' ? JSON.parse(input) : input);
}

const TEXT_TAGS = new Set(['Paragraph', 'Text', 'RCTText']);
const TEXT_INPUT_TAGS = new Set([
  'TextInput',
  'AndroidTextInput',
  'RCTSinglelineTextInputView',
  'RCTMultilineTextInputView',
]);
const SCREEN_TAGS = new Set(['RNSScreen']);
const STACK_TAGS = new Set(['RNSScreenStack']);
const IGNORED_TAGS = new Set(['DebuggingOverlay', 'RNSScreenStackHeaderConfig']);
const LIST_OWNERS = new Set(['FlashList', 'RecyclerView']);
const CONTROL_ROLES = new Set(['button', 'link', 'tab', 'switch', 'menuitem']);
const GENERIC_OWNERS = new Set([
  'View',
  'Text',
  'TextInput',
  'Image',
  'ScrollView',
  'Pressable',
  'TouchableOpacity',
  'TouchableHighlight',
  'TouchableWithoutFeedback',
  'AnimatedComponent',
  'InternalTextInput',
  'Svg',
  'G',
  'Path',
  'Circle',
  'Rect',
  'Suspender',
  'Freeze',
  'DelayedFreeze',
  'ScreenContentWrapper',
  'DebugContainer',
]);

export const tags = {
  isText: (tag: string) => TEXT_TAGS.has(tag),
  isTextInput: (tag: string) => TEXT_INPUT_TAGS.has(tag),
  isScroll: (tag: string) => tag.endsWith('ScrollView'),
  isHorizontalScroll: (tag: string) => tag.endsWith('ScrollView') && tag.includes('Horizontal'),
  isScreen: (tag: string) => SCREEN_TAGS.has(tag),
  isStack: (tag: string) => STACK_TAGS.has(tag),
  isIgnored: (tag: string) => IGNORED_TAGS.has(tag),
  isListOwner: (owner: string) => LIST_OWNERS.has(owner),
  isControlRole: (role: string | undefined) => role !== undefined && CONTROL_ROLES.has(role),
  isGenericOwner: (owner: string) => GENERIC_OWNERS.has(owner) || owner.startsWith('Animated'),
  isGraphic: (tag: string) => tag.includes('Image') || tag.startsWith('RNSVGSvgView'),
};

const TRANSPARENT_COLORS = /^(transparent|#0000|#00000000|rgba\(.*,\s*0(\.0+)?\))$/i;

function visibleContainer(style: ProbeNode['style']): boolean {
  const background = style?.backgroundColor;
  const filled =
    typeof background === 'number'
      ? background >>> 24 !== 0
      : typeof background === 'string' && !TRANSPARENT_COLORS.test(background.trim());
  const border = style?.borderWidth;
  return filled || (typeof border === 'number' && border > 0);
}

export type LayoutNode = {
  index: number;
  tag: string;
  rect: Rect;
  visibleRect: Rect;
  probe: ProbeNode;
  parent?: LayoutNode;
  children: LayoutNode[];
  absolute: boolean;
  clips: boolean;
  scroll: { x: boolean; y: boolean };
  isText: boolean;
  isTextInput: boolean;
  isControl: boolean;
  pressable: boolean;
  hasContainer: boolean;
  paints: boolean;
  hasText: boolean;
  path: string;
  structuralPath: string;
  key?: string;
  ref: ElementRef;
};

export type LayoutTree = { env: ProbeEnv; nodes: LayoutNode[]; roots: LayoutNode[] };

export function right(rect: Rect): number {
  return rect[0] + rect[2];
}

export function bottom(rect: Rect): number {
  return rect[1] + rect[3];
}

export function intersection(a: Rect, b: Rect): Rect {
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  return [
    x,
    y,
    Math.max(0, Math.min(right(a), right(b)) - x),
    Math.max(0, Math.min(bottom(a), bottom(b)) - y),
  ];
}

export function contains(outer: Rect, inner: Rect, tolerance: number): boolean {
  return (
    inner[0] >= outer[0] - tolerance &&
    inner[1] >= outer[1] - tolerance &&
    right(inner) <= right(outer) + tolerance &&
    bottom(inner) <= bottom(outer) + tolerance
  );
}

export function ancestors(node: LayoutNode): LayoutNode[] {
  const result: LayoutNode[] = [];
  for (let current = node.parent; current; current = current.parent) result.push(current);
  return result;
}

function numeric(style: ProbeNode['style'], ...keys: string[]): number {
  for (const key of keys) {
    const value = style?.[key];
    if (typeof value === 'number') return value;
  }
  return 0;
}

export function contentBox(node: LayoutNode, isRTL: boolean): Rect {
  const style = node.probe.style;
  const border = numeric(style, 'borderWidth');
  const top =
    border +
    numeric(style, 'paddingTop', 'paddingBlockStart', 'paddingBlock', 'paddingVertical', 'padding');
  const bottomInset =
    border +
    numeric(
      style,
      'paddingBottom',
      'paddingBlockEnd',
      'paddingBlock',
      'paddingVertical',
      'padding'
    );
  const leftEdge = isRTL ? 'End' : 'Start';
  const rightEdge = isRTL ? 'Start' : 'End';
  const left =
    border +
    numeric(
      style,
      `paddingInline${leftEdge}`,
      `padding${leftEdge}`,
      'paddingLeft',
      'paddingInline',
      'paddingHorizontal',
      'padding'
    );
  const rightInset =
    border +
    numeric(
      style,
      `paddingInline${rightEdge}`,
      `padding${rightEdge}`,
      'paddingRight',
      'paddingInline',
      'paddingHorizontal',
      'padding'
    );
  const [x, y, width, height] = node.rect;
  return [
    x + left,
    y + top,
    Math.max(0, width - left - rightInset),
    Math.max(0, height - top - bottomInset),
  ];
}

function hidden(node: ProbeNode): boolean {
  return (
    tags.isIgnored(node.tag) ||
    node.style?.display === 'none' ||
    node.style?.opacity === 0 ||
    (tags.isScreen(node.tag) && node.screenState === 0)
  );
}

// A native stack keeps every pushed screen mounted and active; only its last screen is on top.
function coveredScreens(nodes: readonly ProbeNode[]): Set<number> {
  const lastScreen = new Map<number, number>();
  const covered = new Set<number>();
  nodes.forEach((node, index) => {
    if (!tags.isScreen(node.tag) || node.parent < 0) return;
    const stack = nodes[node.parent];
    if (!stack || !tags.isStack(stack.tag)) return;
    const previous = lastScreen.get(node.parent);
    if (previous !== undefined) covered.add(previous);
    lastScreen.set(node.parent, index);
  });
  return covered;
}

function ownerName(node: ProbeNode): string | undefined {
  return node.owners?.find(owner => !tags.isGenericOwner(owner));
}

function siblingLabel(node: LayoutNode): string {
  const siblings = node.parent?.children.filter(child => child.tag === node.tag) ?? [node];
  return siblings.length > 1 ? `${node.tag}[${siblings.indexOf(node)}]` : node.tag;
}

function ownerPath(node: LayoutNode): string {
  const owner = ownerName(node.probe);
  const chain = [node];
  if (owner) {
    for (
      let current = node.parent;
      current?.probe.owners?.includes(owner);
      current = current.parent
    ) {
      chain.unshift(current);
    }
  }
  const labels = chain.map(siblingLabel);
  return owner ? [owner, ...labels].join(' > ') : labels.join(' > ');
}

function scrollAxes(node: ProbeNode, children: readonly ProbeNode[]): { x: boolean; y: boolean } {
  if (node.scrollAxes) return node.scrollAxes;
  const scrolls = tags.isScroll(node.tag) || (node.owners ?? []).slice(0, 1).some(tags.isListOwner);
  if (!scrolls) return { x: false, y: false };
  const horizontal =
    tags.isHorizontalScroll(node.tag) ||
    children.some(
      child => child.style?.flexDirection === 'row' || child.style?.flexDirection === 'row-reverse'
    );
  return { x: horizontal, y: !horizontal };
}

export function normalize(dump: ProbeDump): LayoutTree {
  const { env } = dump;
  const windowRect: Rect = [0, 0, env.window.width, env.window.height];
  const childrenOf = new Map<number, ProbeNode[]>();
  dump.nodes.forEach(node => {
    if (node.parent >= 0)
      childrenOf.set(node.parent, [...(childrenOf.get(node.parent) ?? []), node]);
  });

  const placed: (LayoutNode | undefined)[] = [];
  const dropped = new Set<number>();
  const effectiveParent: (LayoutNode | undefined)[] = [];
  const clipOf: Rect[] = [];
  const nodes: LayoutNode[] = [];
  const roots: LayoutNode[] = [];

  const covered = coveredScreens(dump.nodes);
  dump.nodes.forEach((probe, index) => {
    if ((probe.parent >= 0 && dropped.has(probe.parent)) || covered.has(index)) {
      dropped.add(index);
      return;
    }
    const parent =
      probe.parent >= 0 ? (placed[probe.parent] ?? effectiveParent[probe.parent]) : undefined;
    const inheritedClip = probe.parent >= 0 ? clipOf[probe.parent] : windowRect;
    const visibleRect = intersection(probe.rect, inheritedClip);
    const overflow = probe.style?.overflow;
    const scroll = scrollAxes(probe, childrenOf.get(index) ?? []);
    const clips = overflow === 'hidden' || overflow === 'scroll' || scroll.x || scroll.y;
    const zeroArea = probe.rect[2] <= 0 || probe.rect[3] <= 0;
    if (hidden(probe) || (zeroArea && clips)) {
      dropped.add(index);
      return;
    }
    if (zeroArea) {
      effectiveParent[index] = parent;
      clipOf[index] = inheritedClip;
      return;
    }
    if (visibleRect[2] <= 0 || visibleRect[3] <= 0) {
      dropped.add(index);
      return;
    }
    clipOf[index] = clips ? intersection(inheritedClip, probe.rect) : inheritedClip;
    const isText = tags.isText(probe.tag);
    const isTextInput = tags.isTextInput(probe.tag);
    const pressable = probe.pressable === true;
    const node: LayoutNode = {
      index,
      tag: probe.tag,
      rect: probe.rect,
      visibleRect,
      probe,
      parent,
      children: [],
      absolute: probe.style?.position === 'absolute',
      clips,
      scroll,
      isText,
      isTextInput,
      isControl: pressable || tags.isControlRole(probe.role),
      pressable,
      hasContainer: visibleContainer(probe.style),
      paints: isText || isTextInput || tags.isGraphic(probe.tag) || visibleContainer(probe.style),
      hasText: isText || isTextInput,
      path: '',
      structuralPath: '',
      ref: { index, path: '', tag: probe.tag, rect: probe.rect },
    };
    placed[index] = node;
    if (parent) parent.children.push(node);
    else roots.push(node);
    nodes.push(node);
  });

  for (const node of [...nodes].reverse()) {
    if (node.hasText && node.parent) node.parent.hasText = true;
  }

  const keyCounts = new Map<string, number>();
  for (const node of nodes) {
    node.path = ownerPath(node);
    node.structuralPath = node.parent
      ? `${node.parent.structuralPath}/${siblingLabel(node)}`
      : siblingLabel(node);
    const { probe } = node;
    node.ref = {
      index: node.index,
      path: node.path,
      tag: node.tag,
      ...(probe.owners ? { owners: [...probe.owners] } : {}),
      ...(probe.text !== undefined ? { text: probe.text } : {}),
      ...(probe.testID !== undefined ? { testID: probe.testID } : {}),
      ...(probe.label !== undefined ? { label: probe.label } : {}),
      rect: node.rect,
    };
    const base = probe.testID
      ? `testID:${probe.testID}`
      : probe.label
        ? `label:${probe.label}`
        : probe.text
          ? `text:${node.tag}|${ownerName(probe) ?? ''}|${probe.text}`
          : undefined;
    if (base) {
      const seen = keyCounts.get(base) ?? 0;
      keyCounts.set(base, seen + 1);
      node.key = seen === 0 ? base : `${base}#${seen}`;
    }
  }

  return { env, nodes, roots };
}
