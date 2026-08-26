// Route-scoped registry that replaces the process-global navigation bridges.
//
// Each bridge value is stored under a `routeKey` — a stable id for the flow
// that produced it: a session id for the agent-chat pickers, the PR
// owner/repo/number for the review bridges, or a branded scope for the
// security filter. A route reads its slot with `useRouteRegistry(routeKey)`
// which clears every slot under that key when the route unmounts, so a stale
// bridge never leaks into the next visit.

import { useEffect } from 'react';

import { type DiffSelection } from './pr-review/diff-selection-bridge';
import {
  type InstancePickerBridge,
  type ModelPickerBridge,
  type ModePickerBridge,
  type RepoPickerBridge,
} from './picker-bridge';
import { type SecurityFindingFilterBridge } from './security-finding-filter-bridge';

export type RouteKey = string;

/**
 * Route key for pickers opened outside a live session (new-session and the
 * unfenced code-reviewer/security selectors). Mirrors the
 * `sessionId: 'unscoped'` default in the model-picker selection scope.
 */
export const UNFENCED_ROUTE_KEY = 'unscoped';

/**
 * The security filter sheet is pushed from a screen that owns the scope but
 * does not pass it through the bridge, so the slot uses one fixed key. The
 * route clears it on unmount the same way as every other slot.
 */
export const SECURITY_FILTER_ROUTE_KEY = 'security-filter';

/** A file-navigator "scroll to file" listener. */
type FileNavigatorListener = (request: {
  owner: string;
  repo: string;
  number: number;
  path: string;
}) => void;

type SlotValue = {
  modelPicker: ModelPickerBridge;
  modePicker: ModePickerBridge;
  repoPicker: RepoPickerBridge;
  instancePicker: InstancePickerBridge;
  prFileNav: Set<FileNavigatorListener>;
  prDiffSelection: DiffSelection;
  securityFilter: SecurityFindingFilterBridge;
};

type SlotKind = keyof SlotValue;

type RegistrySlots = { [K in SlotKind]: Map<RouteKey, SlotValue[K]> };

const slots: RegistrySlots = {
  modelPicker: new Map<RouteKey, ModelPickerBridge>(),
  modePicker: new Map<RouteKey, ModePickerBridge>(),
  repoPicker: new Map<RouteKey, RepoPickerBridge>(),
  instancePicker: new Map<RouteKey, InstancePickerBridge>(),
  prFileNav: new Map<RouteKey, Set<FileNavigatorListener>>(),
  prDiffSelection: new Map<RouteKey, DiffSelection>(),
  securityFilter: new Map<RouteKey, SecurityFindingFilterBridge>(),
};

const ALL_SLOT_KINDS: readonly SlotKind[] = [
  'modelPicker',
  'modePicker',
  'repoPicker',
  'instancePicker',
  'prFileNav',
  'prDiffSelection',
  'securityFilter',
];

export type RouteSlot<K extends SlotKind> = {
  get: (routeKey: RouteKey) => SlotValue[K] | undefined;
  set: (routeKey: RouteKey, value: SlotValue[K]) => void;
  clear: (routeKey: RouteKey) => void;
  clearAll: () => void;
};

function createSlot<K extends SlotKind>(kind: K): RouteSlot<K> {
  const map = slots[kind];
  return {
    get: routeKey => map.get(routeKey),
    set: (routeKey, value) => {
      map.set(routeKey, value);
    },
    clear: routeKey => {
      map.delete(routeKey);
    },
    clearAll: () => {
      map.clear();
    },
  };
}

export const modelPickerSlot = createSlot('modelPicker');
export const modePickerSlot = createSlot('modePicker');
export const repoPickerSlot = createSlot('repoPicker');
export const instancePickerSlot = createSlot('instancePicker');
export const prFileNavSlot = createSlot('prFileNav');
export const prDiffSelectionSlot = createSlot('prDiffSelection');
export const securityFilterSlot = createSlot('securityFilter');

/**
 * Canonical route key for a PR review flow. Owner and repo are lowercased so
 * a selection or request made for one casing is never lost to another.
 */
export function prRouteKey(pr: { owner: string; repo: string; number: number }): RouteKey {
  return `${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}#${pr.number}`;
}

/**
 * Registers `routeKey` for the lifetime of the calling route. On unmount the
 * hook clears every slot stored under that key.
 */
export function useRouteRegistry(routeKey: RouteKey): void {
  useEffect(
    () => () => {
      for (const kind of ALL_SLOT_KINDS) {
        slots[kind].delete(routeKey);
      }
    },
    [routeKey]
  );
}
