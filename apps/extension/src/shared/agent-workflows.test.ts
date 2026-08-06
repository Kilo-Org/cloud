/* eslint-disable max-lines -- Comprehensive test suite covering all feature states; splitting would obscure coverage relationships. */
import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_INDEX_ENTRY_COUNT,
  WORKFLOW_SEARCH_RESULT_COUNT,
  MAX_WORKFLOW_SCRIPT_LENGTH,
  MAX_WORKFLOW_NAME_LENGTH,
  agentWorkflowSchema,
  agentWorkflowInputSchema,
  storedAgentWorkflowsSchema,
  findMissingRequiredParams,
  formatAgentWorkflowIndex,
  formatMissingParamsError,
  hashWorkflowScript,
  isWorkflowApproved,
  matchesWorkflowScope,
  searchAgentWorkflows,
} from './agent-workflows';
import type { AgentWorkflow } from './agent-workflows';

const workflow = (
  overrides: Partial<AgentWorkflow> & Pick<AgentWorkflow, 'id' | 'name' | 'script'>
): AgentWorkflow => ({
  createdAt: 1_700_000_000_000,
  description: 'A test workflow',
  scopeOrigin: 'https://shop.example.com',
  updatedAt: 1_700_000_000_001,
  ...overrides,
});

describe('workflow schemas', () => {
  it('strips unknown fields from agentWorkflowSchema', () => {
    const result = agentWorkflowSchema.safeParse({
      createdAt: 1,
      description: 'desc',
      extraField: 'should be stripped',
      id: 'abc',
      name: 'test',
      scopeOrigin: 'https://example.com',
      script: 'return { done: true, result: 1 };',
      updatedAt: 2,
    });
    expect(result.success).toBe(true);
    /* eslint-disable jest/no-conditional-in-test, jest/no-conditional-expect -- Discriminated union narrowing with preceding runtime assertion. */
    if (result.success) {
      expect(result.data).not.toHaveProperty('extraField');
    }
    /* eslint-enable jest/no-conditional-in-test, jest/no-conditional-expect */
  });

  it('rejects names longer than MAX_WORKFLOW_NAME_LENGTH', () => {
    const result = agentWorkflowSchema.safeParse({
      createdAt: 1,
      description: 'desc',
      id: 'abc',
      name: 'a'.repeat(MAX_WORKFLOW_NAME_LENGTH + 1),
      scopeOrigin: 'https://example.com',
      script: 'return { done: true, result: 1 };',
      updatedAt: 2,
    });
    expect(result.success).toBe(false);
  });

  it('rejects scripts longer than MAX_WORKFLOW_SCRIPT_LENGTH', () => {
    const result = agentWorkflowInputSchema.safeParse({
      description: 'desc',
      name: 'test',
      scopeOrigin: 'https://example.com',
      script: 's'.repeat(MAX_WORKFLOW_SCRIPT_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it('storedAgentWorkflowsSchema accepts unknown array entries', () => {
    const result = storedAgentWorkflowsSchema.safeParse([{ id: 'x' }, 42, null]);
    expect(result.success).toBe(true);
  });
});

describe('hashWorkflowScript function', () => {
  it('returns a stable SHA-256 hex digest', async () => {
    const hash = await hashWorkflowScript('console.log(1);');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it('returns the same hash for the same script', async () => {
    const hash1 = await hashWorkflowScript('return 1;');
    const hash2 = await hashWorkflowScript('return 1;');
    expect(hash1).toBe(hash2);
  });

  it('returns different hashes for different scripts', async () => {
    const hash1 = await hashWorkflowScript('return 1;');
    const hash2 = await hashWorkflowScript('return 2;');
    expect(hash1).not.toBe(hash2);
  });
});

describe('matchesWorkflowScope function', () => {
  const base = { scopeOrigin: 'https://shop.example.com' };

  it('returns false for a URL parse error', () => {
    expect(matchesWorkflowScope(base, 'not-a-url')).toBe(false);
  });

  it('rejects origin mismatch', () => {
    expect(matchesWorkflowScope(base, 'https://other.example.com/page')).toBe(false);
  });

  it('rejects http when origin is https', () => {
    expect(matchesWorkflowScope(base, 'http://shop.example.com/page')).toBe(false);
  });

  it('rejects port mismatch', () => {
    expect(matchesWorkflowScope(base, 'https://shop.example.com:8080/page')).toBe(false);
  });

  it('accepts exact origin match with any path', () => {
    expect(matchesWorkflowScope(base, 'https://shop.example.com/any/path')).toBe(true);
    expect(matchesWorkflowScope(base, 'https://shop.example.com/')).toBe(true);
    expect(matchesWorkflowScope(base, 'https://shop.example.com')).toBe(true);
  });

  it('rejects pathPrefix mismatch', () => {
    const withPrefix = { ...base, pathPrefix: '/products' };
    expect(matchesWorkflowScope(withPrefix, 'https://shop.example.com/about')).toBe(false);
  });

  it('accepts pathPrefix match', () => {
    const withPrefix = { ...base, pathPrefix: '/products' };
    expect(matchesWorkflowScope(withPrefix, 'https://shop.example.com/products/123')).toBe(true);
    expect(matchesWorkflowScope(withPrefix, 'https://shop.example.com/products')).toBe(true);
  });

  it('uses plain startsWith — /wish matches /wishlist', () => {
    const withPrefix = { ...base, pathPrefix: '/wish' };
    expect(matchesWorkflowScope(withPrefix, 'https://shop.example.com/wishlist')).toBe(true);
  });

  it('handles trailing-slash prefixes', () => {
    const withPrefix = { ...base, pathPrefix: '/checkout/' };
    expect(matchesWorkflowScope(withPrefix, 'https://shop.example.com/checkout/shipping')).toBe(
      true
    );
    expect(matchesWorkflowScope(withPrefix, 'https://shop.example.com/checkout')).toBe(false);
  });
});

describe('searchAgentWorkflows function', () => {
  const baseWorkflow = workflow;

  const workflows: AgentWorkflow[] = [
    baseWorkflow({
      createdAt: 30,
      description: 'Price tracker',
      id: 'a',
      name: 'Price Tracker',
      scopeOrigin: 'https://shop.example.com',
      script: 'return 1;',
      updatedAt: 30,
    }),
    baseWorkflow({
      createdAt: 20,
      description: 'Cart filler',
      id: 'b',
      name: 'Cart Filler',
      pathPrefix: '/cart',
      scopeOrigin: 'https://shop.example.com',
      script: 'return 2;',
      updatedAt: 20,
    }),
    baseWorkflow({
      createdAt: 10,
      description: 'Other site',
      id: 'c',
      name: 'Other',
      scopeOrigin: 'https://other.example.com',
      script: 'return 3;',
      updatedAt: 10,
    }),
  ];

  it('filters by scope and sorts by updatedAt desc', () => {
    const results = searchAgentWorkflows(workflows, 'https://shop.example.com/any');
    expect(results.map(wf => wf.id)).toStrictEqual(['a']);
  });

  it('filters by scope with pathPrefix match', () => {
    const results = searchAgentWorkflows(workflows, 'https://shop.example.com/cart/checkout');
    expect(results.map(wf => wf.id)).toStrictEqual(['a', 'b']);
  });

  it('filters by query with case-insensitive substring match', () => {
    const results = searchAgentWorkflows(workflows, 'https://shop.example.com/any', 'price');
    expect(results.map(wf => wf.id)).toStrictEqual(['a']);
  });

  it('filters by query on description and scopeOrigin', () => {
    const results = searchAgentWorkflows(
      workflows,
      'https://shop.example.com/cart/checkout',
      'Cart'
    );
    expect(results.map(wf => wf.id)).toStrictEqual(['b']);
  });

  it('returns all in-scope for an empty query', () => {
    const results = searchAgentWorkflows(workflows, 'https://shop.example.com/cart/checkout', '');
    expect(results.map(wf => wf.id)).toStrictEqual(['a', 'b']);
  });

  it('caps results at WORKFLOW_SEARCH_RESULT_COUNT', () => {
    const many = Array.from({ length: WORKFLOW_SEARCH_RESULT_COUNT + 5 }, (_unused, idx) =>
      baseWorkflow({
        createdAt: idx,
        id: `m-${idx}`,
        name: `Match ${idx}`,
        scopeOrigin: 'https://shop.example.com',
        script: `return ${idx};`,
        updatedAt: idx,
      })
    );
    const results = searchAgentWorkflows(many, 'https://shop.example.com/any');
    expect(results).toHaveLength(WORKFLOW_SEARCH_RESULT_COUNT);
    expect(results[0]?.id).toBe(`m-${WORKFLOW_SEARCH_RESULT_COUNT + 4}`);
  });
});

describe('formatAgentWorkflowIndex function', () => {
  it('returns undefined when no workflow matches the scope', () => {
    expect(
      formatAgentWorkflowIndex(
        [
          workflow({
            id: 'a',
            name: 'Test',
            scopeOrigin: 'https://other.example.com',
            script: '1',
          }),
        ],
        'https://shop.example.com'
      )
    ).toBeUndefined();
  });

  it('formats entries with escaped text, scope, and correct tag', () => {
    const index = formatAgentWorkflowIndex(
      [
        workflow({
          createdAt: 1,
          description: 'Older',
          id: 'old',
          name: 'Old',
          scopeOrigin: 'https://shop.example.com',
          script: '1',
          updatedAt: 1,
        }),
        workflow({
          createdAt: 2,
          description: 'New with <tag> & more',
          id: 'new',
          name: 'New',
          pathPrefix: '/products',
          scopeOrigin: 'https://shop.example.com',
          script: '2',
          updatedAt: 2,
        }),
      ],
      'https://shop.example.com/products/any'
    );

    expect(index).toBe(
      [
        '<workflows count="2">',
        '- [new] New — New with &lt;tag&gt; &amp; more (https://shop.example.com/products)',
        '- [old] Old — Older (https://shop.example.com)',
        '</workflows>',
      ].join('\n')
    );
  });

  it('sorts by updatedAt descending', () => {
    const index = formatAgentWorkflowIndex(
      [
        workflow({
          id: 'first',
          name: 'First',
          scopeOrigin: 'https://shop.example.com',
          script: '1',
          updatedAt: 10,
        }),
        workflow({
          id: 'third',
          name: 'Third',
          scopeOrigin: 'https://shop.example.com',
          script: '3',
          updatedAt: 30,
        }),
        workflow({
          id: 'second',
          name: 'Second',
          scopeOrigin: 'https://shop.example.com',
          script: '2',
          updatedAt: 20,
        }),
      ],
      'https://shop.example.com/any'
    );

    expect(index).toBeDefined();
    // eslint-disable-next-line jest/no-conditional-in-test -- Type guard after expect assertion, not a test conditional.
    if (typeof index !== 'string') {
      throw new TypeError('Expected string index');
    }
    const lines = index.split('\n');
    const entryLines = lines.filter(line => line.startsWith('- ['));
    expect(entryLines[0]).toContain('[third]');
    expect(entryLines[1]).toContain('[second]');
    expect(entryLines[2]).toContain('[first]');
  });

  it('caps listed entries and includes remaining count', () => {
    const many = Array.from({ length: WORKFLOW_INDEX_ENTRY_COUNT + 7 }, (_unused, idx) =>
      workflow({
        createdAt: idx,
        id: `id-${idx}`,
        name: `Name ${idx}`,
        scopeOrigin: 'https://shop.example.com',
        script: `${idx}`,
        updatedAt: idx,
      })
    );
    const index = formatAgentWorkflowIndex(many, 'https://shop.example.com/any');
    expect(index).toContain(`count="${WORKFLOW_INDEX_ENTRY_COUNT + 7}"`);
    expect(index).toContain('(7 more workflows — use search_workflows to find them.)');
    // eslint-disable-next-line jest/no-conditional-in-test -- Type guard after expect assertion, not a test conditional.
    if (typeof index !== 'string') {
      throw new TypeError('Expected string index');
    }
    const entries = index.split('\n').filter(line => line.startsWith('- ['));
    expect(entries).toHaveLength(WORKFLOW_INDEX_ENTRY_COUNT);
  });

  it('caps listed entries with correct item boundaries', () => {
    const many = Array.from({ length: WORKFLOW_INDEX_ENTRY_COUNT + 7 }, (_unused, idx) =>
      workflow({
        createdAt: idx,
        id: `id-${idx}`,
        name: `Name ${idx}`,
        scopeOrigin: 'https://shop.example.com',
        script: `${idx}`,
        updatedAt: idx,
      })
    );
    const index = formatAgentWorkflowIndex(many, 'https://shop.example.com/any');
    expect(index).toContain('- [id-26]');
    expect(index).not.toContain('- [id-0]');
  });

  it('sanitizes special characters in name and description', () => {
    const index = formatAgentWorkflowIndex(
      [
        workflow({
          description: '"double" & \'single\'',
          id: 'unsafe',
          name: '<script>alert(1)</script>',
          scopeOrigin: 'https://shop.example.com',
          script: '1',
          updatedAt: 1,
        }),
      ],
      'https://shop.example.com/any'
    );
    expect(index).toContain('&lt;script&gt;');
    expect(index).toContain('&amp;');
  });
});

describe('isWorkflowApproved function', () => {
  it('returns false when approvedScriptHash is undefined', async () => {
    const result = await isWorkflowApproved({
      approvedScriptHash: undefined,
      script: 'return 1;',
    });
    expect(result).toBe(false);
  });

  it('returns false when the hash differs from the stored one', async () => {
    const result = await isWorkflowApproved({
      approvedScriptHash: 'deadbeef',
      script: 'return 1;',
    });
    expect(result).toBe(false);
  });

  it('returns true when the hash matches', async () => {
    const script = 'return 42;';
    const hash = await hashWorkflowScript(script);
    const result = await isWorkflowApproved({
      approvedScriptHash: hash,
      script,
    });
    expect(result).toBe(true);
  });
});

describe('workflow params in the index and error formatting', () => {
  it('appends declared input names to index entries', () => {
    const index = formatAgentWorkflowIndex(
      [
        workflow({
          description: 'Search flights',
          id: 'fl',
          name: 'Flights',
          params: [
            { description: 'City', name: 'destination', required: true },
            { description: 'Date', name: 'date' },
          ],
          scopeOrigin: 'https://shop.example.com',
          script: '1',
        }),
      ],
      'https://shop.example.com'
    );

    expect(index).toContain('(inputs: destination, date)');
  });

  it('finds missing required params and formats an actionable error', () => {
    const params = [
      {
        description: 'City or airport to fly to',
        example: 'SFO',
        name: 'destination',
        required: true,
      },
      { description: 'Cabin class', name: 'cabin' },
    ];

    const emptyInput: Record<string, unknown> | undefined = undefined;

    expect({
      // eslint-disable-next-line typescript-eslint/no-non-null-assertion -- Fixture index is static.
      formatted: formatMissingParamsError([params[0]!]),
      missingForEmptyInput: findMissingRequiredParams({ params }, emptyInput),
      missingForProvided: findMissingRequiredParams({ params }, { destination: 'SFO' }),
      missingWithoutParams: findMissingRequiredParams({}, emptyInput),
    }).toStrictEqual({
      formatted:
        'Missing required input: "destination" — City or airport to fly to (e.g. "SFO"). Call run_workflow again with input: {"destination":"SFO"}.',
      missingForEmptyInput: [params[0]],
      missingForProvided: [],
      missingWithoutParams: [],
    });
  });
});

describe('cross-site workflow search', () => {
  const flights = workflow({
    description: 'Search Google Flights for one-way flights',
    id: 'flights',
    name: 'Google Flights Search',
    scopeOrigin: 'https://www.google.com',
    script: '1',
    updatedAt: 50,
  });
  const local = workflow({
    description: 'Reads the cart',
    id: 'cart',
    name: 'Cart reader',
    scopeOrigin: 'https://shop.example.com',
    script: '1',
    updatedAt: 100,
  });

  it('finds workflows on other sites when a query is given', () => {
    const results = searchAgentWorkflows(
      [flights, local],
      'https://shop.example.com/page',
      'flights'
    );
    expect(results.map(entry => entry.id)).toStrictEqual(['flights']);
  });

  it('ranks in-scope matches before out-of-scope matches', () => {
    const both = searchAgentWorkflows([flights, local], 'https://shop.example.com/page', 'reads');
    expect(both.map(entry => entry.id)).toStrictEqual(['cart']);

    const searchAll = searchAgentWorkflows(
      [flights, local],
      'https://shop.example.com/page',
      'search'
    );
    expect(searchAll.map(entry => entry.id)).toStrictEqual(['flights']);
  });

  it('still lists only in-scope workflows without a query', () => {
    const results = searchAgentWorkflows([flights, local], 'https://shop.example.com/page');
    expect(results.map(entry => entry.id)).toStrictEqual(['cart']);
  });
});
