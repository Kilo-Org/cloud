/**
 * Tool permission helpers for the Agents tab.
 *
 * Cloud sessions run in a sandbox where every tool is allowed by default; the
 * only customization this UI surfaces is "turn this tool off for this agent",
 * which emits `deny` for the tool. The CLI's richer permission shapes
 * (per-tool `ask`/`allow`, per-pattern maps, the `null` delete sentinel) are
 * stored verbatim but not editable here, so saving keeps them exactly as
 * loaded. A whole-agent permission (one action for every tool at once) is not
 * representable by per-tool toggles and is also kept as loaded.
 */
import type { AgentConfig, PermissionAction, PermissionRule } from '@kilocode/db/schema-types';

/** Tools the UI exposes as disableable per agent. */
export const PERMISSION_TOOLS = [
  'read',
  'edit',
  'bash',
  'glob',
  'grep',
  'list',
  'task',
  'skill',
  'webfetch',
  'websearch',
  'codesearch',
  'mcp',
] as const;

export type PermissionTool = (typeof PERMISSION_TOOLS)[number];

function isPermissionTool(value: string): value is PermissionTool {
  return (PERMISSION_TOOLS as readonly string[]).includes(value);
}

/** The whole-agent action a stored permission applies to every tool, if any. */
export function readWholeToolAction(
  permission: AgentConfig['permission'] | undefined
): PermissionAction | undefined {
  return typeof permission === 'string' ? permission : undefined;
}

/**
 * Tools the stored permission denies today, which is how the checkboxes are
 * seeded. A whole-agent `deny` denies every tool; a whole-agent `ask`/`allow`
 * denies none. Other stored rules render as enabled because their action is
 * not a plain denial.
 */
export function readDisabledTools(
  permission: AgentConfig['permission'] | undefined
): Set<PermissionTool> {
  const out = new Set<PermissionTool>();
  if (permission === 'deny') {
    for (const tool of PERMISSION_TOOLS) out.add(tool);
    return out;
  }
  if (!permission || typeof permission !== 'object') return out;
  for (const [key, rule] of Object.entries(permission)) {
    if (rule === 'deny' && isPermissionTool(key)) out.add(key);
  }
  return out;
}

/**
 * Apply the UI's per-tool toggles onto the stored permission map.
 *
 * A tool the user turned off gets `deny`. A tool whose stored rule is `deny`
 * and is now on loses its entry. Every other stored rule keeps its loaded
 * value, including per-tool `ask`/`allow`, per-pattern maps, `null`, tool keys
 * this UI does not list, and a tool the user turned off and back on in the
 * same edit. Unrelated keys are retained.
 *
 * A whole-agent permission (one action for every tool) cannot be expressed by
 * these toggles, so it is returned untouched instead of being rewritten into a
 * per-tool map that would drop the tools this UI does not list.
 */
export function mergePermissions(
  existing: AgentConfig['permission'] | undefined,
  disabledTools: ReadonlySet<PermissionTool>
): AgentConfig['permission'] | undefined {
  if (typeof existing === 'string') return existing;
  const base: Record<string, PermissionRule> = existing ? { ...existing } : {};
  for (const tool of PERMISSION_TOOLS) {
    if (disabledTools.has(tool)) {
      base[tool] = 'deny';
    } else if (base[tool] === 'deny') {
      delete base[tool];
    }
  }
  return Object.keys(base).length > 0 ? base : undefined;
}
