export type PaintState = Readonly<{
  env: Readonly<{ route: string; screen?: string }>;
  nodes: readonly Readonly<{
    rect: readonly number[];
    layoutRect?: readonly number[];
    parent?: number;
    tag?: string;
    text?: string;
    label?: string;
    testID?: string;
    role?: string;
    screenState?: number;
    style?: Readonly<Record<string, string | number>>;
  }>[];
}>;

/** Includes focused screen and paint inputs even when every frame stays fixed. */
export function paintSignature(dump: PaintState): string {
  return JSON.stringify([
    dump.env.route,
    dump.env.screen,
    dump.nodes.map(node => [
      node.parent,
      node.tag,
      node.rect,
      node.layoutRect,
      node.text,
      node.label,
      node.testID,
      node.role,
      node.screenState,
      Object.entries(node.style ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ]),
  ]);
}
