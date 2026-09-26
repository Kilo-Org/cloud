import { describe, expect, it } from 'vitest';
import {
  BROWSER_TOOL_CONTRACT,
  KILO_BROWSER_TOOL_NAMES,
  KILO_BROWSER_TOOL_PREFIX,
  SAFE_BROWSER_TOOL_NAMES,
  UPSTREAM_PLAYWRIGHT_MCP_VERSION,
  isSafeBrowserToolName,
  toKiloBrowserToolName,
} from './browser-tool-contract';
import type { BrowserToolContractEntry } from './browser-tool-contract';

// Pinned from `tools/list` on @playwright/mcp 0.0.81 in the order the server
// Returns them. Regenerate with the generator script in apps/extension/scripts.
const UPSTREAM_TOOL_NAMES = [
  'browser_close',
  'browser_resize',
  'browser_console_messages',
  'browser_handle_dialog',
  'browser_evaluate',
  'browser_file_upload',
  'browser_drop',
  'browser_find',
  'browser_fill_form',
  'browser_press_key',
  'browser_type',
  'browser_navigate',
  'browser_navigate_back',
  'browser_network_requests',
  'browser_network_request',
  'browser_run_code_unsafe',
  'browser_take_screenshot',
  'browser_snapshot',
  'browser_click',
  'browser_drag',
  'browser_hover',
  'browser_select_option',
  'browser_tabs',
  'browser_wait_for',
  'browser_webmcp_list',
  'browser_webmcp_call',
];

// The upstream tools annotated `readOnlyHint: true`, in contract order.
const READ_ONLY_TOOL_NAMES = [
  'browser_console_messages',
  'browser_find',
  'browser_network_requests',
  'browser_network_request',
  'browser_take_screenshot',
  'browser_snapshot',
  'browser_wait_for',
  'browser_webmcp_list',
];

const SCHEMA_KEYS = new Set(['$schema', 'additionalProperties', 'properties', 'required', 'type']);

const missingRequiredProperties = (entry: BrowserToolContractEntry): string[] => {
  const propertyNames = Object.keys(entry.inputSchema.properties);

  return (entry.inputSchema.required ?? []).filter(name => !propertyNames.includes(name));
};

describe('browser tool contract', () => {
  it('pins the vendored upstream version', () => {
    expect(UPSTREAM_PLAYWRIGHT_MCP_VERSION).toBe('0.0.81');
  });

  it('vendors every upstream tool once, in tools/list order', () => {
    expect(BROWSER_TOOL_CONTRACT.map(entry => entry.name)).toStrictEqual(UPSTREAM_TOOL_NAMES);
  });

  it('emits only the upstream contract fields for every entry', () => {
    for (const entry of BROWSER_TOOL_CONTRACT) {
      expect(Object.keys(entry).toSorted()).toStrictEqual([
        'description',
        'inputSchema',
        'name',
        'readOnly',
        'title',
      ]);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('classifies exactly the upstream read-only tools', () => {
    expect(SAFE_BROWSER_TOOL_NAMES).toStrictEqual(READ_ONLY_TOOL_NAMES);
    expect(
      BROWSER_TOOL_CONTRACT.filter(entry => entry.readOnly).map(entry => entry.name)
    ).toStrictEqual(READ_ONLY_TOOL_NAMES);

    for (const entry of BROWSER_TOOL_CONTRACT) {
      expect(isSafeBrowserToolName(entry.name)).toBe(entry.readOnly);
    }
  });

  it('maps every upstream tool one to one onto a kilo_ name without touching browser_', () => {
    expect(KILO_BROWSER_TOOL_PREFIX).toBe('kilo_');
    expect(KILO_BROWSER_TOOL_NAMES).toStrictEqual(UPSTREAM_TOOL_NAMES.map(name => `kilo_${name}`));
    expect(new Set(KILO_BROWSER_TOOL_NAMES).size).toBe(UPSTREAM_TOOL_NAMES.length);

    for (const name of UPSTREAM_TOOL_NAMES) {
      expect(toKiloBrowserToolName(name)).toBe(`kilo_${name}`);
      expect(toKiloBrowserToolName(name).slice(KILO_BROWSER_TOOL_PREFIX.length)).toBe(name);
    }

    expect(KILO_BROWSER_TOOL_NAMES).toContain('kilo_browser_snapshot');
    expect(KILO_BROWSER_TOOL_NAMES).not.toContain('kilo_snapshot');
  });

  it('vendors an object input schema for every tool', () => {
    for (const entry of BROWSER_TOOL_CONTRACT) {
      const { inputSchema } = entry;

      expect(inputSchema.type).toBe('object');
      expect(inputSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(Object.keys(inputSchema).every(key => SCHEMA_KEYS.has(key))).toBe(true);
      expect(missingRequiredProperties(entry)).toStrictEqual([]);
    }
  });
});
