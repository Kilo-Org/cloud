// @vitest-environment jsdom
/* eslint-disable max-lines, id-length, jest/no-hooks, jest/no-conditional-in-test, jest/require-top-level-describe, typescript-eslint/no-unsafe-type-assertion, typescript-eslint/no-unsafe-call -- Executes injected page code against jsdom; the DOM shims and envelope casts are test-only. */
/**
 * Executes the built workflow page code against a real DOM (jsdom), so the
 * text-based helpers (clickText, fillLabel, waitForText, readText, hasText)
 * and the dry-run recording rules are tested end to end, not by string
 * inspection.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildWorkflowPageCode } from './agent-workflow-runner';

interface Envelope {
  dryRunActions: { action: string; selector: string }[];
  dryRunUnverified?: boolean;
  error?: string;
  ok: boolean;
  value?: unknown;
}

const runPageCode = async (
  script: string,
  { dryRun = false, input = {} }: { dryRun?: boolean; input?: unknown } = {}
): Promise<Envelope> => {
  const code = buildWorkflowPageCode(script, { input }, dryRun, input);
  // eslint-disable-next-line eslint/no-new-func, typescript-eslint/no-implied-eval -- mirrors the tab injection path
  const value = await (new Function(`return (async () => { ${code} })()`)() as Promise<unknown>);
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only envelope
  return value as Envelope;
};

beforeEach(() => {
  document.body.innerHTML = '';
  // Jsdom has no layout: give every element a visible rect.
  Element.prototype.getBoundingClientRect = () =>
    ({ bottom: 20, height: 20, left: 0, right: 100, top: 0, width: 100, x: 0, y: 0 }) as DOMRect;
  // Jsdom has no innerText: mirror textContent for the helpers that read it.
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? '';
    },
  });
});

describe('clickText', () => {
  it('clicks a button by its visible text', async () => {
    document.body.innerHTML = '<button id="go">Search flights</button>';
    let clicked = false;
    document.querySelector('#go')?.addEventListener('click', () => {
      clicked = true;
    });

    const result = await runPageCode(
      'await page.clickText("Search flights"); return { done: true, result: "ok" };'
    );

    expect(result.ok).toBe(true);
    expect(clicked).toBe(true);
  });

  it('prefers an exact match over a partial match', async () => {
    document.body.innerHTML =
      '<button id="a">Search everything on this site</button><button id="b">Search</button>';
    let hit = '';
    document.querySelector('#a')?.addEventListener('click', () => {
      hit = 'a';
    });
    document.querySelector('#b')?.addEventListener('click', () => {
      hit = 'b';
    });

    await runPageCode('await page.clickText("search"); return { done: true, result: null };');

    expect(hit).toBe('b');
  });

  it('matches by aria-label', async () => {
    document.body.innerHTML = '<button id="x" aria-label="Close dialog">×</button>';
    let clicked = false;
    document.querySelector('#x')?.addEventListener('click', () => {
      clicked = true;
    });

    await runPageCode('await page.clickText("Close dialog"); return { done: true, result: null };');

    expect(clicked).toBe(true);
  });

  it('fails with a clear error when nothing matches', async () => {
    document.body.innerHTML = '<button>Other</button>';

    const result = await runPageCode(
      'await page.clickText("Missing"); return { done: true, result: null };'
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('No clickable element with text: Missing');
  });
});

describe('fillLabel', () => {
  it('fills an input matched by placeholder and fires input/change', async () => {
    document.body.innerHTML = '<input id="q" placeholder="Where to?">';
    const events: string[] = [];
    const inputEl = document.querySelector<HTMLInputElement>('#q');
    inputEl?.addEventListener('input', () => events.push('input'));
    inputEl?.addEventListener('change', () => events.push('change'));

    const result = await runPageCode(
      'await page.fillLabel("where to?", input.destination); return { done: true, result: null };',
      { input: { destination: 'Paris' } }
    );

    expect(result.ok).toBe(true);
    expect(inputEl?.value).toBe('Paris');
    expect(events).toStrictEqual(['input', 'change']);
  });

  it('fills an input through its <label for>', async () => {
    document.body.innerHTML = '<label for="city">City, St</label><input id="city" name="c">';

    await runPageCode(
      'await page.fillLabel("City, St", "SF"); return { done: true, result: null };'
    );

    expect(document.querySelector<HTMLInputElement>('#city')?.value).toBe('SF');
  });

  it('selects a select option by its text', async () => {
    document.body.innerHTML =
      '<select aria-label="Cabin class"><option value="e">Economy</option><option value="b">Business</option></select>';

    await runPageCode(
      'await page.fillLabel("Cabin class", "Business"); return { done: true, result: null };'
    );

    expect(document.querySelector('select')?.value).toBe('b');
  });

  it('fails with a clear error when no input matches', async () => {
    const result = await runPageCode(
      'await page.fillLabel("Missing", "x"); return { done: true, result: null };'
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('No input with label, placeholder, or aria-label: Missing');
  });
});

describe('readText and hasText', () => {
  it('returns the visible page text, bounded', async () => {
    document.body.innerHTML = '<main>Flights to Paris from €245</main>';

    const result = await runPageCode('return { done: true, result: page.readText() };');

    expect(result.ok).toBe(true);
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only shape
    expect(
      (
        result.value as {
          result: string;
        }
      ).result ?? ''
    ).toContain('Paris');
  });

  it('caps readText output at the requested limit', async () => {
    document.body.innerHTML = `<main>${'x'.repeat(9000)}</main>`;

    const result = await runPageCode('return { done: true, result: page.readText(100) };');

    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only shape
    expect((result.value as { result: string }).result.length).toBeLessThanOrEqual(101);
  });

  it('hasText matches case-insensitively', async () => {
    document.body.innerHTML = '<p>Loading Results</p>';

    const result = await runPageCode('return { done: true, result: page.hasText("loading") };');

    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only shape
    expect((result.value as { result: boolean }).result).toBe(true);
  });
});

describe('waitForText', () => {
  it('resolves immediately when the text is present', async () => {
    document.body.innerHTML = '<p>results ready</p>';

    const result = await runPageCode(
      'await page.waitForText("results ready", 500); return { done: true, result: "ok" };'
    );

    expect(result.ok).toBe(true);
  });

  it('times out with a clear error when the text never appears', async () => {
    const result = await runPageCode(
      'await page.waitForText("never", 300); return { done: true, result: "ok" };'
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Timed out waiting for text: never');
  });
});

describe('dry-run recording', () => {
  it('records clickText and fillLabel instead of acting', async () => {
    document.body.innerHTML = '<button id="go">Go</button><input placeholder="City">';
    let clicked = false;
    document.querySelector('#go')?.addEventListener('click', () => {
      clicked = true;
    });

    const result = await runPageCode(
      'await page.fillLabel("City", "SF"); await page.clickText("Go"); return { done: true, result: null };',
      { dryRun: true }
    );

    expect(result.ok).toBe(true);
    expect(clicked).toBe(false);
    expect(document.querySelector('input')?.value).toBe('');
    expect(result.dryRunActions).toStrictEqual([
      { action: 'fillLabel', selector: 'City' },
      { action: 'clickText', selector: 'Go' },
    ]);
  });

  it('keeps waits real before the first recorded action', async () => {
    document.body.innerHTML = '<p>ready</p>';

    const result = await runPageCode(
      'await page.waitForText("ready", 300); return { done: true, result: page.readText() };',
      { dryRun: true }
    );

    expect(result.ok).toBe(true);
    expect(result.dryRunActions).toStrictEqual([]);
  });

  it('records waits after the first recorded action', async () => {
    document.body.innerHTML = '<button>Go</button>';

    const result = await runPageCode(
      'await page.clickText("Go"); await page.waitForText("never appears", 100); return { done: true, result: null };',
      { dryRun: true }
    );

    expect(result.ok).toBe(true);
    expect(result.dryRunActions).toStrictEqual([
      { action: 'clickText', selector: 'Go' },
      { action: 'waitForText', selector: 'never appears' },
    ]);
  });

  it('marks a missing target after a recorded action as dry-run unverified', async () => {
    document.body.innerHTML = '<button>Go</button>';

    const result = await runPageCode(
      'await page.clickText("Go"); await page.clickText("Only after go"); return { done: true, result: null };',
      { dryRun: true }
    );

    expect(result.ok).toBe(false);
    expect(result.dryRunUnverified).toBe(true);
  });

  it('fails hard on a missing target before any recorded action', async () => {
    const result = await runPageCode(
      'await page.clickText("Missing"); return { done: true, result: null };',
      { dryRun: true }
    );

    expect(result.ok).toBe(false);
    expect(result.dryRunUnverified).toBeFalsy();
  });
});

describe('function-expression scripts', () => {
  it('runs a full async arrow function script', async () => {
    document.body.innerHTML = '<p>expression works</p>';

    const result = await runPageCode(
      'async ({ page, state, input }) => { return { done: true, result: page.hasText("expression works") }; }'
    );

    expect(result.ok).toBe(true);
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only shape
    expect((result.value as { result: boolean }).result).toBe(true);
  });

  it('runs a full function declaration expression script', async () => {
    const result = await runPageCode(
      'async function run({ page, state, input }) { return { done: true, result: input.topic }; }',
      { input: { topic: 'rust' } }
    );

    expect(result.ok).toBe(true);
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only shape
    expect((result.value as { result: string }).result).toBe('rust');
  });

  it('still runs a bare body script', async () => {
    const result = await runPageCode('return { done: true, result: input.topic };', {
      input: { topic: 'go' },
    });

    expect(result.ok).toBe(true);
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only shape
    expect((result.value as { result: string }).result).toBe('go');
  });
});

describe('navigation and sleep guards', () => {
  it('page.navigate throws an instructive error', async () => {
    const result = await runPageCode(
      'await page.navigate("https://x.test"); return { done: true, result: null };'
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('return { navigate:');
  });

  it('waitFor with a number sleeps instead of querying', async () => {
    const start = Date.now();
    const result = await runPageCode(
      'await page.waitFor(150); return { done: true, result: null };'
    );

    expect(result.ok).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(140);
  });

  it('page.sleep caps the delay', async () => {
    const result = await runPageCode('await page.sleep(50); return { done: true, result: "ok" };');

    expect(result.ok).toBe(true);
  });
});
