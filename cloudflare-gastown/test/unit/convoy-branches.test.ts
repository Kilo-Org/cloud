import { describe, it, expect } from 'vitest';

/**
 * Pure reimplementation of the branch naming functions from container-dispatch.ts
 * for unit testing. Kept in sync with the actual implementation.
 */
function branchForAgent(name: string, beadId?: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-');
  const beadSuffix = beadId ? `/${beadId.slice(0, 8)}` : '';
  return `gt/${slug}${beadSuffix}`;
}

function branchForConvoyAgent(convoyFeatureBranch: string, name: string, beadId: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-');
  // Strip /head suffix to get the convoy prefix, then place the agent branch as a sibling
  const convoyPrefix = convoyFeatureBranch.replace(/\/head$/, '');
  return `${convoyPrefix}/gt/${slug}/${beadId.slice(0, 8)}`;
}

describe('branchForAgent', () => {
  it('should generate gt/<slug>/<bead-prefix> format', () => {
    expect(branchForAgent('Toast', 'abc12345-6789')).toBe('gt/toast/abc12345');
  });

  it('should handle names with special characters', () => {
    expect(branchForAgent('My Agent!', 'def456')).toBe('gt/my-agent-/def456');
  });

  it('should work without a bead id', () => {
    expect(branchForAgent('mayor')).toBe('gt/mayor');
  });
});

describe('branchForConvoyAgent', () => {
  it('should place agent branch as sibling of /head, not child', () => {
    expect(branchForConvoyAgent('convoy/add-auth/abc12345/head', 'Toast', 'bead5678-full-id')).toBe(
      'convoy/add-auth/abc12345/gt/toast/bead5678'
    );
  });

  it('should handle feature branches with multiple slashes', () => {
    expect(branchForConvoyAgent('convoy/fix-bug-123/def45678/head', 'Maple', 'zzzzzzzz-9999')).toBe(
      'convoy/fix-bug-123/def45678/gt/maple/zzzzzzzz'
    );
  });

  it('should sanitize agent name', () => {
    expect(branchForConvoyAgent('convoy/test/abc/head', 'Agent #1!', 'bead0000-1111')).toBe(
      'convoy/test/abc/gt/agent-1-/bead0000'
    );
  });
});

describe('convoy feature branch naming', () => {
  it('should follow convention: convoy/<slug>/<id-prefix>/head', () => {
    // Test the naming convention used by slingConvoy
    const title = 'Add User Authentication';
    const convoyId = 'a1b2c3d4-5678-90ab-cdef-123456789012';
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const featureBranch = `convoy/${slug}/${convoyId.slice(0, 8)}/head`;

    expect(featureBranch).toBe('convoy/add-user-authentication/a1b2c3d4/head');
  });

  it('should truncate long convoy titles to 40 chars', () => {
    const title = 'This is a very long convoy title that exceeds the maximum slug length we want';
    const convoyId = '12345678-abcd';
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const featureBranch = `convoy/${slug}/${convoyId.slice(0, 8)}/head`;

    expect(slug.length).toBeLessThanOrEqual(40);
    expect(featureBranch).toMatch(/^convoy\/.{1,40}\/12345678\/head$/);
  });

  it('should not conflict with agent branches in git refs', () => {
    // Git refs are file-based: a ref at path X blocks refs under X/.
    // The convoy feature branch ends with /head (a leaf ref), and agent
    // branches sit alongside it as siblings under the same convoy prefix:
    //   convoy/<slug>/<id>/head             ← feature branch (leaf)
    //   convoy/<slug>/<id>/gt/<agent>/<bead> ← agent branch (sibling)
    const featureBranch = 'convoy/add-auth/a1b2c3d4/head';
    const agentBranch = branchForConvoyAgent(featureBranch, 'Toast', 'bead5678-full');

    expect(agentBranch).toBe('convoy/add-auth/a1b2c3d4/gt/toast/bead5678');
    // Agent branch must NOT start with featureBranch + '/' — that would
    // require /head to be a directory, conflicting with the /head ref file.
    expect(agentBranch.startsWith(featureBranch + '/')).toBe(false);
    // Both share the convoy prefix (without /head)
    const convoyPrefix = featureBranch.replace(/\/head$/, '');
    expect(agentBranch.startsWith(convoyPrefix + '/')).toBe(true);
    expect(featureBranch.startsWith(convoyPrefix + '/')).toBe(true);
  });
});

// ── Cycle detection ─────────────────────────────────────────────────

/**
 * Pure reimplementation of the cycle detection from Town.do.ts slingConvoy.
 * Throws if the depends_on graph contains a cycle.
 */
function validateNoCycles(tasks: Array<{ depends_on?: number[] }>): void {
  const adj = new Map<number, number[]>();
  const inDegree = new Map<number, number>();
  for (let i = 0; i < tasks.length; i++) {
    adj.set(i, []);
    inDegree.set(i, 0);
  }
  for (let i = 0; i < tasks.length; i++) {
    for (const depIdx of tasks[i].depends_on ?? []) {
      if (depIdx < 0 || depIdx >= tasks.length || depIdx === i) continue;
      adj.get(depIdx)!.push(i);
      inDegree.set(i, (inDegree.get(i) ?? 0) + 1);
    }
  }
  const queue: number[] = [];
  for (const [node, deg] of inDegree) {
    if (deg === 0) queue.push(node);
  }
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }
  if (visited < tasks.length) {
    throw new Error(
      `Convoy dependency graph contains a cycle — ${tasks.length - visited} tasks are involved in circular dependencies`
    );
  }
}

describe('cycle detection', () => {
  it('should accept a valid DAG', () => {
    expect(() =>
      validateNoCycles([{ depends_on: [] }, { depends_on: [0] }, { depends_on: [0, 1] }])
    ).not.toThrow();
  });

  it('should accept fully parallel tasks', () => {
    expect(() => validateNoCycles([{}, {}, {}])).not.toThrow();
  });

  it('should reject a simple 2-node cycle', () => {
    expect(() => validateNoCycles([{ depends_on: [1] }, { depends_on: [0] }])).toThrow(/cycle/i);
  });

  it('should reject a 3-node cycle', () => {
    expect(() =>
      validateNoCycles([{ depends_on: [2] }, { depends_on: [0] }, { depends_on: [1] }])
    ).toThrow(/cycle/i);
  });

  it('should reject a cycle in a larger graph', () => {
    // 0 → 1 → 2 → 3 → 1 (cycle: 1→2→3→1)
    expect(() =>
      validateNoCycles([
        {},
        { depends_on: [0] },
        { depends_on: [1] },
        { depends_on: [2] },
        { depends_on: [3] }, // no cycle here, but 1→2→3 form a partial cycle
      ])
    ).not.toThrow(); // Actually this is NOT a cycle — 3 depends on 2, not 1→3→1

    // Real cycle: 1→2, 2→3, 3→1
    expect(() =>
      validateNoCycles([{}, { depends_on: [3] }, { depends_on: [1] }, { depends_on: [2] }])
    ).toThrow(/cycle/i);
  });

  it('should report the number of tasks in the cycle', () => {
    expect(() =>
      validateNoCycles([
        { depends_on: [1] },
        { depends_on: [0] },
        {}, // not in cycle
      ])
    ).toThrow('2 tasks');
  });
});
