import type { UiSnapshot } from './capture';
import { isRtlLanguage, TAP_TARGET } from './matrix';
import type { ProbeDump, ProbeNode } from './tree';

type Writable<T> = { -readonly [K in keyof T]: T[K] };

const TAGS: Record<string, string> = {
  TextView: 'Paragraph',
  EditText: 'AndroidTextInput',
  ImageView: 'Image',
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X'))
      return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    return ENTITIES[entity] ?? whole;
  });
}

function attributes(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of source.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    const [, key, value] = match;
    if (key !== undefined && value !== undefined) result.set(key, decode(value));
  }
  return result;
}

export function parseBounds(bounds: string): [number, number, number, number] | undefined {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(bounds);
  if (match === null) return undefined;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (left === undefined || top === undefined || right === undefined || bottom === undefined)
    return undefined;
  return [left, top, right, bottom];
}

export function uiautomatorTag(className: string): string {
  const short = className.slice(className.lastIndexOf('.') + 1);
  return TAGS[short] ?? (short.length > 0 ? short : 'View');
}

const round = (value: number) => Math.round(value * 100) / 100;

export function snapshotScrollAxes(tag: string): { x: boolean; y: boolean } {
  if (tag.includes('HorizontalScrollView')) return { x: true, y: false };
  if (tag.endsWith('ScrollView')) return { x: false, y: true };
  return { x: true, y: true };
}

export function uiautomatorToProbeDump(snapshot: UiSnapshot): ProbeDump {
  const scale = snapshot.densityDpi / 160;
  const nodes: Writable<ProbeNode>[] = [{ parent: -1, tag: 'View', rect: [0, 0, 0, 0] }];
  const stack: number[] = [0];
  let width = 0;
  let height = 0;
  for (const match of snapshot.xml.matchAll(/<(\/?)node\b([^>]*?)(\/?)>/g)) {
    const [, closing, body = '', selfClosing] = match;
    if (closing === '/') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs = attributes(body);
    const bounds = parseBounds(attrs.get('bounds') ?? '') ?? [0, 0, 0, 0];
    const [left, top, right, bottom] = bounds;
    width = Math.max(width, right);
    height = Math.max(height, bottom);
    const node: Writable<ProbeNode> = {
      parent: stack.at(-1) ?? 0,
      tag: uiautomatorTag(attrs.get('class') ?? ''),
      rect: [
        round(left / scale),
        round(top / scale),
        round((right - left) / scale),
        round((bottom - top) / scale),
      ],
    };
    const text = attrs.get('text');
    const label = attrs.get('content-desc');
    const resourceId = attrs.get('resource-id');
    if (text) node.text = text;
    if (label) node.label = label;
    if (resourceId) node.testID = resourceId.replace(/^.*:id\//, '');
    if (attrs.get('clickable') === 'true' || attrs.get('long-clickable') === 'true')
      node.pressable = true;
    if (attrs.get('scrollable') === 'true') node.scrollAxes = snapshotScrollAxes(node.tag);
    nodes.push(node);
    if (selfClosing !== '/') stack.push(nodes.length - 1);
  }
  const window = { width: round(width / scale), height: round(height / scale) };
  nodes[0] = { parent: -1, tag: 'View', rect: [0, 0, window.width, window.height] };
  const language = snapshot.language;
  return {
    version: 1,
    env: {
      source: 'uiautomator',
      platform: 'android',
      osVersion: snapshot.osVersion,
      route: '',
      window,
      pixelRatio: scale,
      fontScale: snapshot.fontScale,
      colorScheme: snapshot.colorScheme,
      isRTL: isRtlLanguage(language),
      language,
      languagePreference: language,
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      safeAreaKnown: false,
      tapTarget: TAP_TARGET,
    },
    nodes,
  };
}
