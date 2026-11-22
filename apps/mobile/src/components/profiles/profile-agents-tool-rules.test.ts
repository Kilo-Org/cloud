import { describe, expect, it } from 'vitest';

import {
  type AgentPermissionMap,
  PERMISSION_TOOLS,
  readDisabledTools,
  readToolRules,
} from '@/components/profiles/profile-agents-model';

/**
 * The rules a tool's switch cannot show. The switch says only on or off, and
 * off emits `deny`, so a stored `ask` or a per-pattern map has to be named on
 * the row; these cases pin what the note reads and when it stays absent.
 */
describe('readToolRules', () => {
  it('names a per-tool ask as the stored rule', () => {
    expect([...readToolRules({ read: 'ask' })]).toEqual([['read', 'ask']]);
  });

  it("joins a per-pattern map as pattern: action, in the map's own key order", () => {
    expect([...readToolRules({ bash: { 'git *': 'allow', '*': 'ask' } })]).toEqual([
      ['bash', 'git *: allow · *: ask'],
    ]);
  });

  it('skips a null entry, which carries no rule, and keeps the rest of the map', () => {
    expect([...readToolRules({ bash: { 'git *': 'deny', mcp: null } })]).toEqual([
      ['bash', 'git *: deny'],
    ]);
  });

  it('says nothing for a map whose entries are all null sentinels', () => {
    expect([...readToolRules({ bash: { mcp: null } })]).toEqual([]);
  });

  it('says nothing for the rules a switch already shows as they are', () => {
    expect([...readToolRules({ read: 'allow', edit: 'deny' })]).toEqual([]);
    expect([...readToolRules({})]).toEqual([]);
    expect([...readToolRules(undefined)]).toEqual([]);
    expect([...readToolRules(null)]).toEqual([]);
  });

  it('says nothing for a whole-agent action, which has its own sentence', () => {
    expect([...readToolRules('ask')]).toEqual([]);
    expect([...readToolRules('allow')]).toEqual([]);
    expect([...readToolRules('deny')]).toEqual([]);
  });

  it('ignores a key this editor does not list', () => {
    const listed = new Set(PERMISSION_TOOLS);
    expect(listed.has('external_directory')).toBe(false);
    expect([...readToolRules({ external_directory: 'ask' })]).toEqual([]);
  });

  it('reads a whole permission the way the merge and the switch state do', () => {
    const loaded: AgentPermissionMap = { read: 'ask', bash: { 'git *': 'allow', '*': 'ask' } };
    expect([...readDisabledTools(loaded)]).toEqual([]);
    expect([...readToolRules(loaded)].map(([tool]) => tool)).toEqual(['read', 'bash']);
  });
});
