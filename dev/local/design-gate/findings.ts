export type Rect = readonly [x: number, y: number, width: number, height: number];

export type Severity = 'error' | 'warning';

export const RULE_IDS = [
  'clipped',
  'cut-off',
  'overlap',
  'touch-overlap',
  'row-misaligned',
  'ink-off-center',
  'touch-target',
  'inset-asymmetry',
  'layout-shift',
  'rtl-mirror',
  'safe-area',
  'leading-gap',
  'unsettled',
  'loading-placeholder',
  'capture-alignment',
  'blank-frame',
  'env-mismatch',
  'link-unopened',
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export type ElementRef = {
  index: number;
  path: string;
  tag: string;
  owners?: string[];
  text?: string;
  testID?: string;
  label?: string;
  rect: Rect;
};

export type Finding = {
  rule: RuleId;
  severity: Severity;
  cell: string;
  target: string;
  element: ElementRef;
  related?: ElementRef[];
  measured: number;
  expected: string;
  unit: 'dp' | 'ms' | 'ratio';
  message: string;
};

export type FindingInput = Omit<Finding, 'cell' | 'target'>;

export function finding(input: FindingInput): Finding {
  return { ...input, cell: '', target: '', measured: Math.round(input.measured * 100) / 100 };
}
