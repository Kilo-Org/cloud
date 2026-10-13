import type { DeciderCase } from '../decider-cases';

const CODE_SYS =
  'You are a precise coding assistant. Answer with only what is asked, no explanations.';
const SYS_SYS =
  'You are a precise systems engineer. Answer with only what is asked, no explanations.';

export const REFACTORING_V2_CASES: readonly DeciderCase[] = [
  {
    id: "refactor-migrate-v2-substr-normalization",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: CODE_SYS,
    userPrompt: `Migrate legacy substr(start, length) to slice without changing behavior. The adapter below is the proposed replacement for integer arguments. Record its regression fixture: what exact line does this print? Return only that line.

\`\`\`javascript
function migratedSubstr(text, start, length) {
  const size = text.length;
  const offset = start < 0
    ? Math.max(size + start, 0)
    : Math.min(start, size);
  const count = length === undefined
    ? size - offset
    : Math.max(length, 0);
  return text.slice(offset, offset + count);
}
const text = 'abcdefgh';
const inputs = [[-3, 2], [-20, 3], [2, -1], [7, 5], [9], [-2]];
const outputs = inputs.map(args => migratedSubstr(text, ...args));
console.log(JSON.stringify(outputs));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: ["fg", "abc", "", "h", "", "gh"],
    },
  },
  {
    id: "refactor-migrate-v2-callback-settlement",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: CODE_SYS,
    userPrompt: `A callback API can call back twice or throw after calling back. Migrate it to a promise while preserving first-settlement semantics. The migration below is used. What exact JSON line should the regression test expect? Answer only that line.

\`\`\`javascript
const trace = [];
function legacy(kind, callback) {
  trace.push('start:' + kind);
  if (kind === 'twice') {
    callback(null, 4);
    callback(new Error('late'));
  } else if (kind === 'throw') {
    callback(null, 7);
    throw new Error('after');
  } else {
    callback(new Error('first'));
    callback(null, 9);
  }
}
function migrated(kind) {
  return new Promise((resolve, reject) => {
    legacy(kind, (error, value) => {
      trace.push(error ? 'error:' + error.message : 'value:' + value);
      if (error) reject(error);
      else resolve(value);
    });
  });
}
(async () => {
  const results = await Promise.all(['twice', 'throw', 'fail'].map(kind =>
    migrated(kind).then(value => 'ok:' + value, error => 'bad:' + error.message)
  ));
  console.log(JSON.stringify([results, trace]));
})();
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [["ok:4", "ok:7", "bad:first"], ["start:twice", "value:4", "error:late", "start:throw", "value:7", "start:fail", "error:first", "value:9"]],
    },
  },
  {
    id: "refactor-migrate-v2-object-map-key-contract",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: CODE_SYS,
    userPrompt: `Migrate makeCounter's public API from an object with increment/remove/entries methods to a tuple [increment, remove, entries], updating every caller in the harness. Preserve String(key) collisions, deletion/reinsertion behavior, and Object.keys-compatible ordering rather than native Map order. Perform the migration, then report only the JSON output of the migrated whole program for the supplied inputs; do not output code.

\`\`\`javascript
function makeCounter() {
  const values = new Map();
  return {
    increment(key) {
      const normalized = String(key);
      values.set(normalized, (values.get(normalized) ?? 0) + 1);
    },
    remove(key) {
      values.delete(String(key));
    },
    entries() {
      const indexed = [];
      const ordinary = [];
      for (const [key, value] of values) {
        const number = Number(key);
        const isIndex = Number.isInteger(number)
          && number >= 0
          && number < 4294967295
          && String(number) === key;
        (isIndex ? indexed : ordinary).push([key, value]);
      }
      indexed.sort((left, right) => Number(left[0]) - Number(right[0]));
      return [...indexed, ...ordinary];
    },
  };
}
const counter = makeCounter();
for (const key of ['b', 10, '2', '01', 2, 'a', '4294967295']) {
  counter.increment(key);
}
counter.remove('b');
counter.increment('b');
console.log(JSON.stringify(counter.entries()));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [["2", 2], ["10", 1], ["01", 1], ["a", 1], ["4294967295", 1], ["b", 1]],
    },
  },
  {
    id: "refactor-migrate-v2-shared-loop-capture",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: CODE_SYS,
    userPrompt: `Migrate migrateCallbacks from exposing a callbacks array to exposing read(index) and set(value) methods, updating every caller. Preserve the shared mutable loop cell, including observations after set(-2); do not turn it into per-iteration captures. Leave the isolated-loop control unchanged. Perform the migration, then report only the JSON output of the migrated whole program; do not output code.

\`\`\`javascript
function migrateCallbacks() {
  let index;
  const callbacks = [];
  for (index = 0; index < 4; index++) {
    callbacks.push(() => index);
  }
  return {
    callbacks,
    set(value) { index = value; },
  };
}
const state = migrateCallbacks();
const before = state.callbacks.map(read => read());
state.set(-2);
const after = state.callbacks.map(read => read());
const isolated = [];
for (let index = 0; index < 4; index++) isolated.push(() => index);
console.log(JSON.stringify([before, after, isolated.map(read => read())]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [[4, 4, 4, 4], [-2, -2, -2, -2], [0, 1, 2, 3]],
    },
  },
  {
    id: "refactor-migrate-v2-defaulting-falsy-contract",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: CODE_SYS,
    userPrompt: `Migrate migrated(value) to migrated({ value, fallback }), where fallback is an injected lazy function, and update every call site. Preserve the old truthy-default contract: every falsy input invokes fallback exactly once, while truthy inputs never invoke it. Do not silently substitute nullish-only defaulting. Perform the migration, then report only the JSON output of the migrated whole program for these inputs; do not output code.

\`\`\`javascript
let calls = 0;
function fallback() {
  calls++;
  return 'default:' + calls;
}
function migrated(value) {
  return value ? value : fallback();
}
const inputs = [undefined, null, false, 0, '', NaN, '0', [], {}];
const outputs = inputs.map(value => migrated(value));
console.log(JSON.stringify([outputs, calls]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [["default:1", "default:2", "default:3", "default:4", "default:5", "default:6", "0", [], {}], 6],
    },
  },
  {
    id: "refactor-migrate-v2-date-wire-compatibility",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: CODE_SYS,
    userPrompt: `Migrate normalize(value), which returns a JSON-compatible value, to serialize(value), which returns the serialized JSON text directly, and update the final call site so it does not encode the result twice. Preserve Date strings, omitted undefined object properties, null array slots, nonfinite numbers, and negative-zero behavior. Perform the migration, then report only the JSON output line of the migrated program for the supplied value; do not output code.

\`\`\`javascript
function normalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map(item => item === undefined ? null : normalize(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, normalize(item)]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return Object.is(value, -0) ? 0 : value;
}
const value = {
  at: new Date('2001-02-03T04:05:06.000Z'),
  missing: undefined,
  items: [undefined, NaN, -0, { gone: undefined, present: null }],
};
console.log(JSON.stringify(normalize(value)));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: {"at": "2001-02-03T04:05:06.000Z", "items": [null, null, 0, {"present": null}]},
    },
  },
  {
    id: "refactor-migrate-v2-decimal-money-cutover",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: CODE_SYS,
    userPrompt: `Migrate cents(text) to a new API parseMoney(text) returning { amount: bigint }, and update the array processing and total calculation to consume the amount field. Preserve exact integer arithmetic and half-away-from-zero rounding, including the oversized amount. Remove the old cents API. Perform the migration, then report only the JSON output of the migrated whole program; do not output code.

\`\`\`javascript
function cents(text) {
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  const padded = fraction.padEnd(3, '0');
  let value = BigInt(whole) * 100n + BigInt(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) value += 1n;
  return negative ? -value : value;
}
const amounts = ['1.005', '-1.005', '0.0049', '2.675', '90071992547409.995'];
const migrated = amounts.map(text => cents(text));
const sum = migrated.reduce((total, value) => total + value, 0n);
console.log(JSON.stringify([migrated.map(String), String(sum)]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [["101", "-101", "0", "268", "9007199254741000"], "9007199254741268"],
    },
  },
  {
    id: "refactor-migrate-v2-destructure-getter-order",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: CODE_SYS,
    userPrompt: `Migrate before(config) to readRetries(config, fallback), updating its callers to pass 3 as fallback. Preserve the old function's individual getter evaluations and exception boundaries rather than caching one destructured read. Keep proposed(config) unchanged as a comparison control. Remove the old before API. Perform the migration, then report only the JSON output of the migrated whole program; do not output code.

\`\`\`javascript
function createConfig() {
  let reads = 0;
  return {
    get retries() { reads++; return reads === 1 ? undefined : reads; },
    count() { return reads; },
  };
}
function before(config) {
  return config.retries === undefined ? 3 : config.retries;
}
function proposed(config) {
  const { retries = 3 } = config;
  return retries;
}
const oldConfig = createConfig();
const newConfig = createConfig();
const results = [before(oldConfig), before(oldConfig), oldConfig.count(),
  proposed(newConfig), proposed(newConfig), newConfig.count()];
console.log(JSON.stringify(results));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [3, 3, 3, 3, 2, 2],
    },
  },
  {
    id: "refactor-migrate-v2-listener-snapshot",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: CODE_SYS,
    userPrompt: `Migrate createEmitter's on/off API to subscribe(listener), which returns an unsubscribe function, and update every listener registration/removal in the harness. Preserve snapshot-at-emit-start behavior: a listener removed during emit still runs in that emit, and newly added listeners wait until the next emit. Repeated subscription of the same listener must retain Set deduplication. Perform the migration, then report only the JSON output of the migrated whole program; do not output code.

\`\`\`javascript
function createEmitter() {
  const listeners = new Set();
  return {
    on(listener) { listeners.add(listener); },
    off(listener) { listeners.delete(listener); },
    emit(value) {
      for (const listener of [...listeners]) listener(value);
    },
  };
}
const emitter = createEmitter();
const trace = [];
const third = value => trace.push('c:' + value);
const second = value => trace.push('b:' + value);
const first = value => {
  trace.push('a:' + value);
  emitter.off(second);
  emitter.on(third);
};
emitter.on(first);
emitter.on(second);
emitter.emit(1);
emitter.emit(2);
console.log(JSON.stringify(trace));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: ["a:1", "b:1", "a:2", "c:2"],
    },
  },
  {
    id: "refactor-migrate-v2-sparse-array-loop",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: CODE_SYS,
    userPrompt: `A sparse-array map is migrated to an indexed loop without densifying holes. The code explicitly preserves the original length and membership checks. What exact signature must remain unchanged? Answer only the output line.

\`\`\`javascript
function migratedMap(input, transform) {
  const result = new Array(input.length);
  const size = input.length;
  for (let index = 0; index < size; index++) {
    if (index in input) result[index] = transform(input[index], index);
  }
  return result;
}
const input = new Array(6);
input[1] = 4;
input[3] = undefined;
input[5] = 0;
const calls = [];
const result = migratedMap(input, (value, index) => {
  calls.push(index);
  if (index === 1) input[2] = 8;
  return value === undefined ? 'u' : value + index;
});
console.log(JSON.stringify([result, Object.keys(result), calls]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [[null, 5, 10, "u", null, 5], ["1", "2", "3", "5"], [1, 2, 3, 5]],
    },
  },
  {
    id: "refactor-migrate-v2-live-export-adapter",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: CODE_SYS,
    userPrompt: `Migrate a stateful CommonJS-style module to a facade while preserving live reads, not a copied destructured value. This self-contained simulation shows the distinction. What exact output line should the compatibility test pin? Answer only the line.

\`\`\`javascript
function createModule() {
  let count = 0;
  return {
    get count() { return count; },
    increment() { count++; },
  };
}
const original = createModule();
const { count: snapshot } = original;
const facade = {
  get count() { return original.count; },
  increment() { original.increment(); },
};
const observations = [snapshot, facade.count];
facade.increment();
observations.push(snapshot, facade.count);
original.increment();
observations.push(snapshot, facade.count);
console.log(JSON.stringify(observations));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [0, 0, 0, 1, 0, 2],
    },
  },
  {
    id: "refactor-migrate-v2-negative-index-adapter",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: CODE_SYS,
    userPrompt: `Replace a legacy index API with this integer-index adapter. Negative indices count from the end, out-of-range results are undefined, and null entries remain null. What exact JSON regression line does the migrated implementation print? Answer only that line.

\`\`\`javascript
function migratedAt(values, index) {
  const normalized = index < 0 ? values.length + index : index;
  if (normalized < 0 || normalized >= values.length) return undefined;
  return values[normalized];
}
const values = ['first', null, 'last'];
const indices = [-4, -3, -2, -1, 0, 2, 3];
const signature = indices.map(index => {
  const value = migratedAt(values, index);
  return value === undefined ? 'missing' : value;
});
console.log(JSON.stringify(signature));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: ["missing", "first", null, "last", "first", "last", "missing"],
    },
  },
  {
    id: "refactor-migrate-v2-replacement-dollar-literals",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: CODE_SYS,
    userPrompt: `Migrate a global regex replace from a replacement string to a callback so the user-supplied replacement is literal. Pin both old and migrated behavior to document the intentional change. What exact line does this print? Answer only the JSON line.

\`\`\`javascript
const source = 'a1b2';
const replacement = "$&-$\`-$'-$$";
const oldValue = source.replace(/\\d/g, replacement);
const migrated = source.replace(/\\d/g, () => replacement);
console.log(JSON.stringify([oldValue, migrated]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: ["a1-a-b2-$b2-a1b--$", "a$&-$`-$'-$$b$&-$`-$'-$$"],
    },
  },
  {
    id: "refactor-migrate-v2-finally-return-contract",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: CODE_SYS,
    userPrompt: `During a promise-to-async migration, preserve finally semantics: a returned value from finally does not replace a fulfillment, but an exception does. This is the existing contract harness. What exact output line must the migration preserve? Answer only that line.

\`\`\`javascript
const trace = [];
async function migrated(value, shouldThrow) {
  try {
    const result = await Promise.resolve(value);
    trace.push('body:' + result);
    return result * 2;
  } finally {
    trace.push('finally:' + value);
    if (shouldThrow) throw new Error('cleanup');
  }
}
(async () => {
  const first = await migrated(3, false);
  const second = await migrated(4, true).catch(error => error.message);
  const legacy = await Promise.resolve(5).finally(() => 99);
  console.log(JSON.stringify([first, second, legacy, trace]));
})();
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [6, "cleanup", 5, ["body:3", "finally:3", "body:4", "finally:4"]],
    },
  },
  {
    id: "refactor-migrate-v2-csv-state-machine",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: CODE_SYS,
    userPrompt: `Migrate naive comma splitting to this scanner under a contract that supports quoted commas and doubled quotes, while preserving empty columns. Inputs are well-formed single CSV records. What exact output line is the new compatibility fixture? Answer only that line.

\`\`\`javascript
function parseCsv(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}
const records = ['a,"b,c",,"d""e",', '"",x', ',,'];
console.log(JSON.stringify(records.map(parseCsv)));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [["a", "b,c", "", "d\"e", ""], ["", "x"], ["", "", ""]],
    },
  },
  {
    id: "refactor-migrate-v2-query-duplicate-values",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: CODE_SYS,
    userPrompt: `Migrate adapt's input API from [key, value] tuples to { key, value } records and update the supplied input construction. Preserve scalar last-write wins, accumulation for [] keys, the reset when a scalar overwrites an array, null-prototype safety, and output key order. Perform the migration, then report only the JSON output of the migrated whole program; do not output code.

\`\`\`javascript
function adapt(pairs) {
  const result = Object.create(null);
  for (const [key, value] of pairs) {
    if (key.endsWith('[]')) {
      const base = key.slice(0, -2);
      if (!Array.isArray(result[base])) result[base] = [];
      result[base].push(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
const pairs = [
  ['page', '1'], ['tag[]', 'red'], ['page', '2'],
  ['tag[]', 'blue'], ['empty', ''], ['tag', 'override'],
  ['tag[]', 'green'], ['__proto__', 'safe'],
];
console.log(JSON.stringify(adapt(pairs)));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: {"page": "2", "tag": ["green"], "empty": "", "__proto__": "safe"},
    },
  },
  {
    id: "refactor-migrate-v2-mixed-version-column-cutover",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: SYS_SYS,
    userPrompt: `Two independently deployed services share a table. Old service versions read/write nickname; new versions must use display_name. Writes continue throughout deployment. Values may legitimately be null. Give a behavior-preserving expand/contract migration plan, including how to avoid a backfill overwriting a concurrent new write and when nickname can be removed. No SQL syntax is required.`,
    check: {
      kind: "judged",
      rubric: "Pass only if the answer includes all of: add display_name without initially dropping nickname; provide a compatibility/dual-write phase covering old writers as well as new writers (e.g. a DB trigger while old writers exist); explicitly distinguish legitimate null from not-yet-migrated state using a migration marker or equivalent mechanism; backfill atomically only rows still marked unmigrated, with concurrent writes setting the marker under the same transactional protection; delay new-column-only reads until backfill and writer compatibility are verified; remove nickname only after all old readers/writers and the rollback window are gone. Do not claim dual-writing only in the new service handles unchanged old writers.",
      reference: "Add nullable display_name and an explicit migrated marker. Install transactional compatibility logic covering legacy writes: copy nickname to display_name and mark migrated; new writes update both and mark migrated. Backfill in batches with an atomic conditional update of rows still unmigrated, so a newer write wins and legitimate null is never mistaken for pending work. Verify reconciliation before switching reads. Stop legacy access only after all old versions are retired; keep compatibility through the rollback window, then remove it and nickname.",
    },
  },
  {
    id: "refactor-migrate-v2-callback-timing-contract",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: SYS_SYS,
    userPrompt: `A legacy function calls its callback synchronously on a cache hit and asynchronously on a miss. Callers sometimes mutate state immediately after invoking it and the callback inspects that state. You must migrate to an API returning a Promise without silently claiming behavior is preserved. Explain the unavoidable timing difference, a concrete regression test, and a safe cutover of callers. The final API must not keep a callback overload.`,
    check: {
      kind: "judged",
      rubric: "Pass only if the answer says promise .then/await continuations run after the current stack even if resolved synchronously; identifies that synchronous cache-hit callback observability cannot be preserved by ordinary promise continuation; proposes a test recording before/callback-or-continuation/after order for both hit and miss; audits/migrates timing-dependent callers rather than pretending a Promise.resolve wrapper preserves timing; removes the callback overload at final cutover and documents the intentional timing change.",
      reference: "A resolved promise still schedules continuations as microtasks, so a synchronous hit callback before the caller's next statement becomes a continuation after it. Test a trace around invocation and immediate state mutation on hits and misses. Convert each dependent caller to explicit await sequencing or relocate the mutation, lock in the new timing contract, and remove the old callback entry point once all callers migrate.",
    },
  },
  {
    id: "refactor-migrate-v2-ordered-worker-migration",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: SYS_SYS,
    userPrompt: `A sequential job processor appends results in input order and stops before starting any later job after the first failure. Someone proposes Promise.all over every job to reduce latency. Jobs mutate shared state and cannot be cancelled after starting. Recommend a behavior-preserving migration to async/await and explain why parallelism is or is not admissible. Include how to test the failure boundary.`,
    check: {
      kind: "judged",
      rubric: "Pass only if it keeps jobs awaited one at a time in input order, states Promise.all eagerly starts later jobs and rejection does not cancel their effects, preserves stopping before later jobs begin after a failure, and proposes an instrumented trace test with a middle failure asserting later jobs were never invoked and earlier results/effects remain. Do not recommend concurrency as equivalent under these stated constraints.",
      reference: "Use an async loop and await each job before invoking the next; collect results in order and propagate the first failure. Promise.all starts all jobs and cannot undo later mutations after rejection. Test start/end/effect events for a success run and a failure in the middle, checking no later start event appears.",
    },
  },
  {
    id: "refactor-migrate-v2-precision-preserving-wire",
    taskType: 'refactoring',
    subtaskType: "migration",
    systemPrompt: SYS_SYS,
    userPrompt: `A service currently sends monetary amounts as decimal strings, including values above Number.MAX_SAFE_INTEGER in cents. Its internal representation is migrating to BigInt cents. Clients cannot change their wire format. Describe a behavior-preserving boundary conversion and tests. Inputs permit at most two fractional decimal digits; there is no rounding step. Negative zero should serialize as "0.00".`,
    check: {
      kind: "judged",
      rubric: "Pass only if it parses the decimal string with string operations into signed BigInt cents without a Number intermediate; serializes cents back to a decimal string with exactly two digits, correctly handling sign and zero; notes BigInt cannot be JSON.stringify-ed directly and keeps wire amounts as strings; tests oversized values, negatives, single fractional digit, no fraction, and normalized negative zero; does not impose rounding or change the client wire type.",
      reference: "Validate the decimal grammar, split sign/whole/fraction, right-pad the fraction to two digits and combine using BigInt arithmetic. Serialize the absolute cents quotient/remainder with two fractional digits and a minus only when nonzero. Put the resulting string into JSON, never the BigInt. Round-trip huge values and negatives and test 2 -> \"2.00\", 2.5 -> \"2.50\", and -0 -> \"0.00\".",
    },
  },
  {
    id: "refactor-cleanup-v2-pipeline-effect-order",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor the filter/map pipeline into explicit loops without calling filter or map. Preserve all observable effects: every keep call must finish before any project call, and mutations to shared rows must remain visible at the same times. Perform the cleanup, then report only the JSON output of the refactored whole program for the supplied rows; do not output code.

\`\`\`javascript
const trace = [];
const rows = [
  { id: 'a', active: true, value: 2 },
  { id: 'b', active: false, value: 4 },
  { id: 'c', active: true, value: 6 },
];
function keep(row) {
  trace.push('keep:' + row.id);
  if (row.id === 'a') rows[2].value = 9;
  return row.active;
}
function project(row) {
  trace.push('map:' + row.id);
  if (row.id === 'a') rows[2].value += 1;
  return row.id + '=' + row.value;
}
const result = rows.filter(keep).map(project);
console.log(JSON.stringify([result, trace]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [["a=2", "c=10"], ["keep:a", "keep:b", "keep:c", "map:a", "map:c"]],
    },
  },
  {
    id: "refactor-cleanup-v2-reduce-hole-mutation",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor the reduce call into an explicit indexed loop. Preserve entry-time traversal length, skipped missing indices, observation of later mutations, and callback effect order; do not use reduce in the refactored version. Perform the cleanup, then report only the JSON output of the refactored whole program; do not output code.

\`\`\`javascript
const values = [2, , 5, 7];
const visited = [];
const sum = values.reduce((total, value, index, source) => {
  visited.push(index + ':' + value);
  if (index === 0) {
    source[1] = 3;
    delete source[2];
    source.push(11);
  }
  return total + value;
}, 0);
console.log(JSON.stringify([sum, visited, values]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [12, ["0:2", "1:3", "3:7"], [2, 3, null, 7, 11]],
    },
  },
  {
    id: "refactor-cleanup-v2-stable-sort-ties",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: CODE_SYS,
    userPrompt: `A cleanup extracts comparison logic and must retain tie ordering and avoid mutating the caller's array. What exact line is the regression expectation for this implementation? Answer only the JSON line.

\`\`\`javascript
function order(items) {
  return [...items].sort((left, right) => {
    const leftGroup = left.group ?? 9;
    const rightGroup = right.group ?? 9;
    if (leftGroup !== rightGroup) return leftGroup - rightGroup;
    return right.score - left.score;
  });
}
const input = [
  { id: 'a', group: 2, score: 4 },
  { id: 'b', group: 1, score: 5 },
  { id: 'c', group: 1, score: 5 },
  { id: 'd', group: null, score: 8 },
  { id: 'e', group: 1, score: 7 },
];
const sorted = order(input);
console.log(JSON.stringify([sorted.map(row => row.id), input.map(row => row.id)]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [["e", "b", "c", "a", "d"], ["a", "b", "c", "d", "e"]],
    },
  },
  {
    id: "refactor-cleanup-v2-guard-clause-finally",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: CODE_SYS,
    userPrompt: `Simplify nested conditionals into guard clauses without changing cleanup and return behavior. Before editing, give the exact output line from the baseline below. Answer only that line.

\`\`\`javascript
const trace = [];
function run(mode) {
  try {
    if (mode === 'skip') {
      trace.push('skip');
      return 1;
    } else {
      if (mode === 'fail') throw new Error('body');
      trace.push('work');
      return 2;
    }
  } catch (error) {
    trace.push(error.message);
    return 3;
  } finally {
    trace.push('cleanup:' + mode);
    if (mode === 'override') return 4;
  }
}
const outputs = ['skip', 'fail', 'ok', 'override'].map(run);
console.log(JSON.stringify([outputs, trace]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [[1, 3, 2, 4], ["skip", "cleanup:skip", "body", "cleanup:fail", "work", "cleanup:ok", "work", "cleanup:override"]],
    },
  },
  {
    id: "refactor-cleanup-v2-short-circuit-getter",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor the three result expressions into a named evaluateFallbacks(source) helper returning their three values. Preserve lazy short-circuit evaluation and each distinct getter read; do not cache source.value. Keep read-count reporting in the harness. Perform the cleanup, then report only the JSON output of the refactored whole program; do not output code.

\`\`\`javascript
let reads = 0;
const source = {
  get value() {
    reads++;
    return [0, 5, 0, 7, null, 9][reads - 1];
  },
};
const first = source.value || source.value;
const second = source.value && source.value;
const third = source.value ?? source.value;
console.log(JSON.stringify([first, second, third, reads]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [5, 0, 7, 4],
    },
  },
  {
    id: "refactor-cleanup-v2-extracted-method-receiver",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: CODE_SYS,
    userPrompt: `Extract the add method's calculation into a standalone addTo(receiver, value) helper and update the invocation sites to pass the intended receiver explicitly, including undefined for the deliberately unbound call. Preserve receiver mutation and the 'unbound' result; do not replace the unbound call with a bound one. Perform the refactor, then report only the JSON output of the refactored whole strict-mode program; do not output code.

\`\`\`javascript
'use strict';
function createAccumulator(seed) {
  return {
    total: seed,
    add(value) {
      if (this === undefined) return 'unbound';
      this.total += value;
      return this.total;
    },
  };
}
const accumulator = createAccumulator(10);
const other = createAccumulator(100);
const helper = accumulator.add;
const outputs = [accumulator.add(2), helper(3), helper.call(other, 4),
  helper.call(accumulator, -5)];
console.log(JSON.stringify([outputs, accumulator.total, other.total]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [[12, "unbound", 104, 7], 7, 104],
    },
  },
  {
    id: "refactor-cleanup-v2-traversal-shared-nodes",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor recursive visit into an explicit-stack depth-first traversal, keeping its public result shape. Preserve child order, path-local cycle detection, and repeated visits to shared nodes on distinct paths; do not use a global visited set to suppress them. Perform the cleanup, then report only the JSON output of the refactored whole program from root; do not output code.

\`\`\`javascript
const nodes = {
  root: ['left', 'right'],
  left: ['leaf', 'root'],
  right: ['leaf'],
  leaf: [],
};
function visit(name, path = []) {
  if (path.includes(name)) return ['cycle:' + name];
  const next = [...path, name];
  const result = [next.join('/')];
  for (const child of nodes[name]) {
    result.push(...visit(child, next));
  }
  return result;
}
console.log(JSON.stringify(visit('root')));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: ["root", "root/left", "root/left/leaf", "cycle:root", "root/right", "root/right/leaf"],
    },
  },
  {
    id: "refactor-cleanup-v2-signed-zero-and-nan",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor classify's if chain into an ordered array of predicate/label rules, while keeping the existing string fallback. Preserve Object.is semantics for negative zero and NaN; do not replace those tests with ===. Leave the separate equality-control vector unchanged. Perform the cleanup, then report only the JSON output of the refactored whole program; do not output code.

\`\`\`javascript
function classify(value) {
  if (Object.is(value, -0)) return 'negative-zero';
  if (Object.is(value, NaN)) return 'not-a-number';
  if (value === 0) return 'zero';
  return String(value);
}
const values = [-0, 0, NaN, Number('bad'), '0', false];
const labels = values.map(classify);
const equality = [Object.is(NaN, NaN), NaN === NaN,
  Object.is(-0, 0), -0 === 0];
console.log(JSON.stringify([labels, equality]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [["negative-zero", "zero", "not-a-number", "not-a-number", "0", "false"], [true, false, false, true]],
    },
  },
  {
    id: "refactor-cleanup-v2-assignment-default-order",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor both destructuring assignments into explicit individual assignments with any necessary temporary values. Preserve left-to-right default evaluation, the state observed by mark, and the second assignment's use of the newly assigned a. Do not use destructuring in the refactored assignments. Perform the cleanup, then report only the JSON output of the refactored whole program; do not output code.

\`\`\`javascript
let a = 1;
let b = 2;
const trace = [];
function mark(name, value) {
  trace.push(name + ':' + a + ':' + b);
  return value;
}
[a = mark('a', b + 1), b = mark('b', a + 1)] = [undefined, undefined];
const first = [a, b];
[a, b = mark('second', a * 2)] = [5, undefined];
console.log(JSON.stringify([first, [a, b], trace]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [[3, 4], [5, 10], ["a:1:2", "b:3:2", "second:5:4"]],
    },
  },
  {
    id: "refactor-cleanup-v2-switch-fallthrough-state",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: CODE_SYS,
    userPrompt: `Combine duplicated switch cases without changing intentional fallthrough, state mutation, or default execution. What exact line must the cleanup preserve? Answer only the JSON line.

\`\`\`javascript
function apply(state, command) {
  switch (command) {
    case 'start':
      state.push('open');
    case 'tick':
      state.push('tick');
      break;
    case 'stop':
      state.push('close');
    default:
      state.push('audit');
  }
}
const state = [];
for (const command of ['start', 'tick', 'stop', 'unknown']) {
  apply(state, command);
}
console.log(JSON.stringify(state));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: ["open", "tick", "tick", "close", "audit", "audit"],
    },
  },
  {
    id: "refactor-cleanup-v2-regex-lifetime",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor oldMatch and proposedMatch behind a matcher factory with explicit fresh-per-call and shared-state lifetime modes. Update the harness to construct and call those two modes. Preserve both existing behaviors, including the shared global RegExp's lastIndex transitions; this is a structural refactor, not a request to fix the shared mode. Perform the cleanup, then report only the JSON output of the refactored whole program; do not output code.

\`\`\`javascript
const pattern = /a/g;
function oldMatch(text) {
  return /a/g.test(text);
}
function proposedMatch(text) {
  return pattern.test(text);
}
const texts = ['a', 'a', 'ba', 'ba', ''];
const oldResults = texts.map(oldMatch);
const newResults = [];
const positions = [];
for (const text of texts) {
  newResults.push(proposedMatch(text));
  positions.push(pattern.lastIndex);
}
console.log(JSON.stringify([oldResults, newResults, positions]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [[true, true, true, true, false], [true, false, true, false, false], [1, 0, 2, 0, 0]],
    },
  },
  {
    id: "refactor-cleanup-v2-dedupe-equality-contract",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: CODE_SYS,
    userPrompt: `Extract the two duplicate-removal algorithms into a unique(values, strategy) helper with 'indexOf' and 'set' strategies and update both call sites. Preserve each strategy's existing NaN, negative-zero, type, and ordering behavior rather than forcing them to agree. Keep label unchanged. Perform the cleanup, then report only the JSON output of the refactored whole program; do not output code.

\`\`\`javascript
const values = [NaN, 1, NaN, -0, 0, 1, '1'];
const oldUnique = values.filter((value, index, source) =>
  source.indexOf(value) === index
);
const proposed = [...new Set(values)];
function label(value) {
  if (Number.isNaN(value)) return 'NaN';
  if (Object.is(value, -0)) return '-0';
  return typeof value + ':' + value;
}
console.log(JSON.stringify([oldUnique.map(label), proposed.map(label)]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [["number:1", "-0", "string:1"], ["NaN", "number:1", "number:0", "string:1"]],
    },
  },
  {
    id: "refactor-cleanup-v2-spread-read-order",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor result construction to remove object spread, using explicit staged property copies and assignments instead. Preserve initial key insertion order, overwrite semantics, getter evaluation order, and the timing of the final revision read. Perform the cleanup, then report only the JSON output of the refactored whole program; do not output code.

\`\`\`javascript
const trace = [];
let revision = 1;
const source = {
  get a() { trace.push('a:' + revision); return revision++; },
  get b() { trace.push('b:' + revision); return revision++; },
};
const result = { before: 0, ...source, a: 9, ...source, after: revision };
console.log(JSON.stringify([result, Object.keys(result), trace]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [{"before": 0, "a": 3, "b": 4, "after": 5}, ["before", "a", "b", "after"], ["a:1", "b:2", "a:3", "b:4"]],
    },
  },
  {
    id: "refactor-cleanup-v2-floating-sum-association",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor sequential, chunked, and rightAssociated into one sum(values, mode) helper, using explicit 'left', 'two-chunks', and 'right' modes, and update the harness. Preserve each mode's exact addition association and IEEE-754 result; do not assume algebraic associativity or combine the modes into one reduction. Perform the cleanup, then report only the JSON output of the refactored whole program; do not output code.

\`\`\`javascript
const values = [1e16, 1, -1e16, 2];
function sequential(xs) {
  return xs.reduce((total, value) => total + value, 0);
}
function chunked(xs) {
  const left = sequential(xs.slice(0, 2));
  const right = sequential(xs.slice(2));
  return left + right;
}
function rightAssociated(xs) {
  return xs.reduceRight((total, value) => value + total, 0);
}
console.log(JSON.stringify([sequential(values), chunked(values), rightAssociated(values)]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [2, 2, 4],
    },
  },
  {
    id: "refactor-cleanup-v2-generator-early-close",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor the first for-of consumer into a manual iterator consumer with explicit try/finally cleanup, without changing its early-exit behavior. Ensure the first iterator closes before constructing the second iterator, and leave the deliberately manual second consumer's trace ordering intact. Perform the cleanup, then report only the JSON output of the refactored whole program; do not output code.

\`\`\`javascript
const trace = [];
function* records(name) {
  try {
    trace.push(name + ':start');
    yield 1;
    trace.push(name + ':middle');
    yield 2;
  } finally {
    trace.push(name + ':close');
  }
}
for (const value of records('loop')) {
  trace.push('value:' + value);
  break;
}
const manual = records('manual');
trace.push('manual-value:' + manual.next().value);
trace.push('before-return');
manual.return();
console.log(JSON.stringify(trace));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: ["loop:start", "value:1", "loop:close", "manual:start", "manual-value:1", "before-return", "manual:close"],
    },
  },
  {
    id: "refactor-cleanup-v2-memoization-key-collisions",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor memoize into createMemoizedPair(fn, keyForPair), extracting its existing colon-joined key policy into the injected keyForPair function and updating the harness. This must be behavior-preserving, including the current key collisions and number of combine calls; do not fix the key policy during this cleanup. Perform the refactor, then report only the JSON output of the refactored whole program; do not output code.

\`\`\`javascript
let calls = 0;
function combine(left, right) {
  calls++;
  return JSON.stringify([left, right]);
}
function memoize(fn) {
  const cache = new Map();
  return (left, right) => {
    const key = left + ':' + right;
    if (!cache.has(key)) cache.set(key, fn(left, right));
    return cache.get(key);
  };
}
const cached = memoize(combine);
const first = cached('a:b', 'c');
const second = cached('a', 'b:c');
const third = cached('a:b', 'c');
console.log(JSON.stringify([first, second, third, calls]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: ["[\"a:b\",\"c\"]", "[\"a:b\",\"c\"]", "[\"a:b\",\"c\"]", 1],
    },
  },
  {
    id: "refactor-cleanup-v2-pure-helper-boundary",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: SYS_SYS,
    userPrompt: `Two handlers duplicate six lines of discount arithmetic, but one runs inside a transaction and emits an audit event before committing; the other is a read-only preview. A teammate wants to extract a helper that opens its own transaction, calculates the discount, sends the event, and returns the preview too. Recommend a narrower cleanup that preserves both handlers' behavior and describe regression coverage.`,
    check: {
      kind: "judged",
      rubric: "Pass only if the answer extracts only the shared pure discount calculation; leaves transaction ownership and event emission with the effectful handler; keeps preview free of writes/events; avoids a helper-owned nested/independent transaction that changes atomicity; includes arithmetic parity tests plus assertions about event count/order and preview having no effects. Do not propose one side-effectful helper for both handlers.",
      reference: "Extract a pure calculateDiscount(input) used by both handlers. Keep persistence, transaction scope and audit emission in the committing handler; preview calls only the calculator. Test edge arithmetic on both paths, record effects to ensure preview emits nothing, and verify committing effects retain their order and rollback behavior.",
    },
  },
  {
    id: "refactor-cleanup-v2-cleanup-error-boundary",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: SYS_SYS,
    userPrompt: `A nested handler validates input, writes a row, then formats a response. Validation errors are translated to 400, storage failures to 503, but formatting bugs propagate as internal errors. A proposed cleanup puts all three calls in one catch returning 400. Explain a behavior-preserving guard-clause cleanup and the minimum useful regression tests. Do not write full code.`,
    check: {
      kind: "judged",
      rubric: "Pass only if it rejects the broad catch because it reclassifies storage and programming errors; uses early validation return with a validation-specific catch or tagged result; retains a separate storage boundary mapping storage failures to 503; keeps formatting outside both translated boundaries so programming errors propagate; tests validation prevents storage, storage failure gives 503 without formatting, success formats, and formatter failure is not a 400/503.",
      reference: "Make validation an early-return boundary handling only recognized validation failures. Keep the write in its storage-error boundary. After success, format outside those catches. Tests cover validation failure with no write, storage failure with no format, the success path, and a thrown formatter error propagating unchanged.",
    },
  },
  {
    id: "refactor-cleanup-v2-single-use-abstraction",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: SYS_SYS,
    userPrompt: `A 40-line function builds a report in three clear phases. Each phase is used once, and all share a small local accumulator. A proposed cleanup introduces ReportBuilder, PhaseStrategy, a registry, and a factory solely for this function; there are no planned alternate phases. Give a concrete simpler cleanup, when you would extract a helper, and how you would protect output behavior.`,
    check: {
      kind: "judged",
      rubric: "Pass only if the answer avoids the strategy/registry/factory/class family under the given single-use constraints; keeps straightforward sequential local control flow with descriptive names and limited focused extraction; says extraction is justified by a coherent independently understandable or reused operation rather than line count alone; preserves accumulator lifetime and phase ordering; recommends representative output/effect-order regression tests instead of claiming fewer lines prove correctness.",
      reference: "Keep one sequential function with named intermediates for the three phases. Extract only a cohesive computation if its name makes the parent clearer or it is genuinely reused; pass explicit values rather than hiding the accumulator in a framework. Lock down ordering and representative full report outputs, including empty and boundary inputs, before changing structure.",
    },
  },
  {
    id: "refactor-cleanup-v2-evaluation-once-safety",
    taskType: 'refactoring',
    subtaskType: "code_cleanup",
    systemPrompt: SYS_SYS,
    userPrompt: `A code cleanup replaces repeated config.timeout getter reads with one local const. The getter may perform I/O, return a new value on each read, or throw. Give the conditions under which this rewrite is behavior-preserving and a practical approach when those conditions are not established. Include what tests would reveal a difference.`,
    check: {
      kind: "judged",
      rubric: "Pass only if the answer requires stable returned value and no observable effects/errors/timing changes from removing reads, or an explicit changed contract; warns that reducing getter evaluations is not automatically a harmless optimization; recommends retaining the old reads until purity/stability is established or separating an explicit snapshot API and migrating callers; tests counted reads, varying returns, and a later-read exception at the original read locations. Do not assert one-read caching is always safer.",
      reference: "A single read is equivalent only if repeated reads are stable and observationally pure, including their throwing behavior. Without that guarantee keep the original evaluation sites. If snapshot semantics are desired, make that an explicit contract and migrate callers. Test a counting getter, changing values and a getter that throws only on the second read to expose altered effects and control flow.",
    },
  },
  {
    id: "refactor-arch-v2-composition-root-lifetimes",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: CODE_SYS,
    userPrompt: `A service-locator refactor moves dependencies to explicit construction. The repository must be shared, while each request gets its own counter. Pin the composition-root behavior by giving the exact output line from this harness. Answer only that line.

\`\`\`javascript
function createRepository() {
  const rows = new Map();
  let writes = 0;
  return {
    save(key, value) {
      writes++;
      rows.set(key, value);
      return writes;
    },
    snapshot() { return [...rows]; },
  };
}
function createRequest(repository, label) {
  let calls = 0;
  const save = value => {
    calls++;
    return repository.save(label + ':' + calls, value);
  };
  return { save, count: () => calls };
}
const repository = createRepository();
const requestA = createRequest(repository, 'A');
const requestB = createRequest(repository, 'B');
const results = [requestA.save('first'), requestB.save('second'),
  requestA.save('third'), requestB.save('fourth')];
console.log(JSON.stringify([results, requestA.count(), requestB.count(),
  repository.snapshot()]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [[1, 2, 3, 4], 2, 2, [["A:1", "first"], ["B:1", "second"], ["A:2", "third"], ["B:2", "fourth"]]],
    },
  },
  {
    id: "refactor-arch-v2-decorator-unwind-order",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor cross-cutting concerns into explicit decorators without changing nesting, error translation, or finalization order. What exact line should this architecture regression harness print? Answer only the JSON line.

\`\`\`javascript
const trace = [];
function around(name, inner) {
  return async input => {
    trace.push(name + ':enter');
    try {
      const value = await inner(input);
      trace.push(name + ':ok');
      return value;
    } catch (error) {
      trace.push(name + ':error');
      throw error;
    } finally {
      trace.push(name + ':exit');
    }
  };
}
async function core(input) {
  trace.push('core:' + input);
  if (input < 0) throw new Error('negative');
  return input * 2;
}
const service = around('audit', around('transaction', core));
(async () => {
  const first = await service(3);
  const second = await service(-1).catch(error => error.message);
  console.log(JSON.stringify([first, second, trace]));
})();
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [6, "negative", ["audit:enter", "transaction:enter", "core:3", "transaction:ok", "transaction:exit", "audit:ok", "audit:exit", "audit:enter", "transaction:enter", "core:-1", "transaction:error", "transaction:exit", "audit:error", "audit:exit"]],
    },
  },
  {
    id: "refactor-arch-v2-retry-layer-ownership",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor retry composition out of the harness into a pure composeOperation(adapter, retryLayers, trace) boundary, where retryLayers specifies the ordered wrapper names. Update both the double-owned and single-owned scenarios to use it. Preserve two total attempts per layer, wrapper nesting, the outside catch, and every trace event. Perform the architecture refactor, then report only the JSON output of the refactored whole program; do not output code.

\`\`\`javascript
function createAdapter(trace) {
  let calls = 0;
  return async () => {
    calls++;
    trace.push('call:' + calls);
    throw new Error('unavailable');
  };
}
function retry(inner, name, trace) {
  return async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      trace.push(name + ':' + attempt);
      try {
        return await inner();
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  };
}
(async () => {
  const doubled = [];
  const single = [];
  const nested = retry(retry(createAdapter(doubled), 'adapter', doubled),
    'service', doubled);
  await nested().catch(error => doubled.push(error.message));
  await retry(createAdapter(single), 'service', single)()
    .catch(error => single.push(error.message));
  console.log(JSON.stringify([doubled, single]));
})();
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [["service:1", "adapter:1", "call:1", "adapter:2", "call:2", "service:2", "adapter:1", "call:3", "adapter:2", "call:4", "unavailable"], ["service:1", "call:1", "service:2", "call:2", "unavailable"]],
    },
  },
  {
    id: "refactor-arch-v2-transactional-outbox-order",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor this transactional outbox implementation into separate persistence, transaction-coordinator, and notification-dispatcher boundaries with explicit dependency injection. Keep create as the application operation. Preserve atomic staging, rollback of both rows and events, commit trace order, and FIFO notification dispatch after transactions finish. Perform the architecture refactor, then report only the JSON output of the refactored whole program; do not output code.

\`\`\`javascript
const rows = [];
const outbox = [];
const trace = [];
function transact(action) {
  const stagedRows = [];
  const stagedEvents = [];
  const transaction = {
    insert(row) { stagedRows.push(row); },
    publish(event) { stagedEvents.push(event); },
  };
  try {
    action(transaction);
    rows.push(...stagedRows);
    outbox.push(...stagedEvents);
    trace.push('commit');
  } catch (error) {
    trace.push('rollback:' + error.message);
  }
}
function create(id, fail) {
  transact(transaction => {
    transaction.insert(id);
    transaction.publish('created:' + id);
    if (fail) throw new Error(id);
  });
}
create('a', false);
create('b', true);
create('c', false);
while (outbox.length) trace.push('send:' + outbox.shift());
console.log(JSON.stringify([rows, outbox, trace]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [["a", "c"], [], ["commit", "rollback:b", "commit", "send:created:a", "send:created:c"]],
    },
  },
  {
    id: "refactor-arch-v2-tenant-cache-isolation",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: CODE_SYS,
    userPrompt: `Move cache ownership from a global string-key helper to a tenant-partitioned adapter. Preserve identity reuse within a tenant while preventing delimiter collisions and cross-tenant leakage. What exact output line proves the new boundary behavior? Answer only the line.

\`\`\`javascript
function createCache() {
  const tenants = new Map();
  let loads = 0;
  return {
    read(tenant, key) {
      if (!tenants.has(tenant)) tenants.set(tenant, new Map());
      const cache = tenants.get(tenant);
      if (!cache.has(key)) {
        loads++;
        cache.set(key, { id: loads, tenant, key });
      }
      return cache.get(key);
    },
    invalidate(tenant, key) {
      tenants.get(tenant)?.delete(key);
    },
    count() { return loads; },
  };
}
const cache = createCache();
const a = cache.read('a:b', 'c');
const b = cache.read('a', 'b:c');
const again = cache.read('a:b', 'c');
cache.invalidate('a', 'b:c');
const fresh = cache.read('a', 'b:c');
console.log(JSON.stringify([[a.id, b.id, again.id, fresh.id],
  a === again, b === fresh, cache.count()]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [[1, 2, 1, 3], true, false, 3],
    },
  },
  {
    id: "refactor-arch-v2-adapter-error-translation",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor the provider boundary so Timeout-to-domain-result translation lives in a reusable provider adapter, while the application harness depends only on the adapter's read operation. Move provider construction to a composition root. Preserve successful values, retryable timeout results, propagation of TypeError, and input processing order. Perform the architecture refactor, then report only the JSON output of the refactored whole program; do not output code.

\`\`\`javascript
class Timeout extends Error {}
function adapt(provider) {
  return async key => {
    try {
      const value = await provider(key);
      return { kind: 'ok', value };
    } catch (error) {
      if (error instanceof Timeout) return { kind: 'retryable' };
      throw error;
    }
  };
}
const read = adapt(async key => {
  if (key === 'slow') throw new Timeout('late');
  if (key === 'bug') throw new TypeError('broken');
  return key.toUpperCase();
});
(async () => {
  const result = [];
  for (const key of ['good', 'slow', 'bug', 'next']) {
    try { result.push(await read(key)); }
    catch (error) { result.push(error.name + ':' + error.message); }
  }
  console.log(JSON.stringify(result));
})();
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [{"kind": "ok", "value": "GOOD"}, {"kind": "retryable"}, "TypeError:broken", {"kind": "ok", "value": "NEXT"}],
    },
  },
  {
    id: "refactor-arch-v2-strongly-connected-boundaries",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor the dependency audit into a pure dependency-boundary analyzer accepting an imports graph, separating graph traversal from the report formatting/composition root. Preserve strongly connected groups, name sorting within groups, and group sorting by first name. Apply the extracted analyzer to the supplied graph, then report only the JSON output of the refactored whole program; do not output code.

\`\`\`javascript
const imports = {
  api: ['service', 'contracts'],
  service: ['repository', 'policy'],
  repository: ['service', 'driver'],
  policy: ['contracts'],
  contracts: ['policy'],
  driver: ['codec'],
  codec: ['driver'],
  cli: ['api'],
};
function reaches(from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return imports[from].some(next => reaches(next, target, seen));
}
const names = Object.keys(imports).sort();
const remaining = new Set(names);
const groups = [];
for (const name of names) {
  if (!remaining.has(name)) continue;
  const group = names.filter(other =>
    reaches(name, other) && reaches(other, name)
  );
  for (const member of group) remaining.delete(member);
  groups.push(group);
}
console.log(JSON.stringify(groups));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [["api"], ["cli"], ["codec", "driver"], ["contracts", "policy"], ["repository", "service"]],
    },
  },
  {
    id: "refactor-arch-v2-layer-after-contract-extraction",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor the layer checker into a reusable pure layer-audit module accepting a graph, with memoization scoped to one audit rather than shared across unrelated graphs. Keep graph construction and JSON formatting in the outer composition root. Preserve layer = 1 + maximum import layer, leaves at 1, and sorted name/report ordering. Perform the architecture refactor, then report only the JSON output of the refactored whole program for this graph; do not output code.

\`\`\`javascript
const graph = {
  web: ['handlers', 'presenter'],
  cli: ['service'],
  handlers: ['service', 'contracts'],
  presenter: ['contracts', 'format'],
  service: ['policy', 'ports'],
  policy: ['contracts'],
  ports: ['contracts'],
  adapter: ['ports', 'driver'],
  driver: ['codec'],
  codec: [],
  format: [],
  contracts: [],
};
const cache = new Map();
function layer(name) {
  if (cache.has(name)) return cache.get(name);
  const result = 1 + Math.max(0, ...graph[name].map(layer));
  cache.set(name, result);
  return result;
}
const names = Object.keys(graph).sort();
console.log(JSON.stringify(names.map(name => [name, layer(name)])));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [["adapter", 3], ["cli", 4], ["codec", 1], ["contracts", 1], ["driver", 2], ["format", 1], ["handlers", 4], ["policy", 2], ["ports", 2], ["presenter", 2], ["service", 3], ["web", 5]],
    },
  },
  {
    id: "refactor-arch-v2-minimal-cycle-edge-cut",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor import-cycle remediation into a pure planAcyclicImports(edges) boundary returning { minimum, choices }, separating cycle detection, cut enumeration, and outer JSON reporting. Preserve enumeration of all minimum-cardinality edge cuts, not module deletions, and preserve sorting of choices. Perform the architecture refactor, then report only the JSON output of the refactored whole program for the supplied graph; do not output code.

\`\`\`javascript
const edges = ['A>B', 'B>C', 'C>A', 'C>D', 'D>B', 'D>E', 'E>F', 'F>D', 'G>A'];
function acyclic(remaining) {
  const graph = Object.fromEntries('ABCDEFG'.split('').map(name => [name, []]));
  for (const edge of remaining) {
    const [from, to] = edge.split('>');
    graph[from].push(to);
  }
  const active = new Set();
  const done = new Set();
  function visit(name) {
    if (active.has(name)) return false;
    if (done.has(name)) return true;
    active.add(name);
    for (const next of graph[name]) if (!visit(next)) return false;
    active.delete(name);
    done.add(name);
    return true;
  }
  return Object.keys(graph).every(visit);
}
let minimum = Infinity;
let choices = [];
for (let mask = 0; mask < 2 ** edges.length; mask++) {
  const removed = edges.filter((_, index) => mask & (1 << index));
  if (removed.length > minimum) continue;
  const remaining = edges.filter((_, index) => !(mask & (1 << index)));
  if (!acyclic(remaining)) continue;
  if (removed.length < minimum) { minimum = removed.length; choices = []; }
  choices.push(removed);
}
choices.sort((left, right) => left.join(',').localeCompare(right.join(',')));
console.log(JSON.stringify({ minimum, choices }));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: {"minimum": 2, "choices": [["B>C", "D>E"], ["B>C", "E>F"], ["B>C", "F>D"]]},
    },
  },
  {
    id: "refactor-arch-v2-type-runtime-blast-radius",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor the contract-change dependency audit into a pure affectedModules(dependencies, changedModules, includeTypes) boundary, removing its hard-coded changed module while keeping traversal separate from the report composition root. Update both callers to pass ['types']. Preserve runtime-only versus all-dependency propagation, inclusion of the changed module, and sorting. Perform the architecture refactor, then report only the JSON output of the refactored whole program; do not output code.

\`\`\`javascript
const dependencies = [
  ['api', 'service', 'runtime'],
  ['api', 'types', 'type'],
  ['service', 'ports', 'runtime'],
  ['ports', 'types', 'type'],
  ['adapter', 'ports', 'runtime'],
  ['adapter', 'types', 'runtime'],
  ['cli', 'service', 'runtime'],
  ['worker', 'adapter', 'runtime'],
  ['tests', 'worker', 'type'],
];
function affected(includeTypes) {
  const names = new Set(['types']);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, to, kind] of dependencies) {
      if (!includeTypes && kind === 'type') continue;
      if (names.has(to) && !names.has(from)) {
        names.add(from);
        changed = true;
      }
    }
  }
  return [...names].sort();
}
console.log(JSON.stringify([affected(false), affected(true)]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [["adapter", "types", "worker"], ["adapter", "api", "cli", "ports", "service", "tests", "types", "worker"]],
    },
  },
  {
    id: "refactor-arch-v2-unit-of-work-rollback",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: CODE_SYS,
    userPrompt: `Move balance changes into a unit-of-work boundary. Staged changes must roll back together, and failed transfers must not emit events. What exact line does this architecture contract harness print? Answer only the JSON line.

\`\`\`javascript
const balances = new Map([['a', 10], ['b', 2], ['c', 0]]);
const events = [];
function transfer(from, to, amount) {
  const staged = new Map(balances);
  try {
    if (staged.get(from) < amount) throw new Error('funds');
    staged.set(from, staged.get(from) - amount);
    if (!staged.has(to)) throw new Error('destination');
    staged.set(to, staged.get(to) + amount);
    balances.clear();
    for (const entry of staged) balances.set(...entry);
    events.push(from + '>' + to + ':' + amount);
    return 'ok';
  } catch (error) {
    return error.message;
  }
}
const results = [transfer('a', 'b', 4), transfer('b', 'missing', 3),
  transfer('c', 'a', 1), transfer('b', 'c', 5)];
console.log(JSON.stringify([results, [...balances], events]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [["ok", "destination", "funds", "ok"], [["a", 6], ["b", 1], ["c", 5]], ["a>b:4", "b>c:5"]],
    },
  },
  {
    id: "refactor-arch-v2-route-policy-precedence",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor route matching into a compiled policy boundary: compileRoutes(routes) should return a match(path) operation, precomputing route-pattern segments once instead of during each request. Keep routes and example requests at the outer composition root. Preserve wildcard matching, static-versus-parameter scores, declaration-order tie breaks, and fallback behavior. Perform the architecture refactor, then report only the JSON output of the refactored whole program; do not output code.

\`\`\`javascript
const routes = [
  { pattern: '/users/*', name: 'wild' },
  { pattern: '/users/:id', name: 'detail' },
  { pattern: '/users/new', name: 'new' },
  { pattern: '/users/:id/posts', name: 'posts' },
  { pattern: '/users/:name', name: 'alias' },
];
function match(path) {
  const parts = path.split('/').filter(Boolean);
  const candidates = [];
  for (let order = 0; order < routes.length; order++) {
    const route = routes[order];
    const pattern = route.pattern.split('/').filter(Boolean);
    const wildcard = pattern.at(-1) === '*';
    if (!wildcard && pattern.length !== parts.length) continue;
    if (wildcard && parts.length < pattern.length - 1) continue;
    let score = 0;
    let valid = true;
    for (let index = 0; index < pattern.length; index++) {
      const segment = pattern[index];
      if (segment === '*') break;
      if (!segment.startsWith(':') && segment !== parts[index]) valid = false;
      score += segment.startsWith(':') ? 1 : 3;
    }
    if (valid) candidates.push({ score, order, name: route.name });
  }
  candidates.sort((left, right) => right.score - left.score || left.order - right.order);
  return candidates[0]?.name ?? 'missing';
}
console.log(JSON.stringify(['/users/new', '/users/42', '/users/42/posts',
  '/users/42/other', '/users', '/other'].map(match)));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: ["new", "detail", "posts", "wild", "wild", "missing"],
    },
  },
  {
    id: "refactor-arch-v2-pure-reducer-rehydration",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor event replay into a pure replay(events, initialState) boundary returning the final state and historical snapshots, leaving event construction and reporting at the outer boundary. Preserve reducer immutability, snapshot identity separation, existing insertion order, and remove/re-add behavior. Perform the architecture refactor, then report only the JSON output of the refactored whole program, including its existing history and identity signature; do not output code.

\`\`\`javascript
function reduce(state, event) {
  const next = new Map(state);
  if (event.kind === 'add') {
    next.set(event.id, (next.get(event.id) ?? 0) + event.amount);
  } else if (event.kind === 'remove') {
    next.delete(event.id);
  }
  return next;
}
const events = [
  { kind: 'add', id: 'a', amount: 2 },
  { kind: 'add', id: 'b', amount: 4 },
  { kind: 'add', id: 'a', amount: 3 },
  { kind: 'remove', id: 'a' },
  { kind: 'add', id: 'a', amount: 1 },
];
let state = new Map();
const history = [state];
for (const event of events) {
  state = reduce(state, event);
  history.push(state);
}
console.log(JSON.stringify([history.map(snapshot => [...snapshot]),
  history[1] === history[2]]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [[[], [["a", 2]], [["a", 2], ["b", 4]], [["a", 5], ["b", 4]], [["b", 4]], [["b", 4], ["a", 1]]], false],
    },
  },
  {
    id: "refactor-arch-v2-graph-clone-alias-preservation",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor graph cloning into a cloneGraph(value) boundary whose internal recursive helper owns one fresh seen map per public call; callers must no longer pass or share the seen map. Preserve cycles, shared aliases within a clone, and separation from the original graph for plain objects and arrays. Perform the architecture refactor, then report only the JSON output of the refactored whole program after the supplied mutation; do not output code.

\`\`\`javascript
function clone(value, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const result = Array.isArray(value) ? [] : {};
  seen.set(value, result);
  for (const key of Object.keys(value)) result[key] = clone(value[key], seen);
  return result;
}
const shared = { count: 1 };
const original = { left: shared, right: shared, list: [shared] };
original.self = original;
shared.owner = original;
const copied = clone(original);
copied.left.count = 9;
console.log(JSON.stringify([
  copied !== original,
  copied.left === copied.right,
  copied.left === copied.list[0],
  copied.self === copied,
  copied.left.owner === copied,
  original.left.count,
  copied.right.count,
]));
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [true, true, true, true, true, 1, 9],
    },
  },
  {
    id: "refactor-arch-v2-resource-scope-unwind",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor resource ownership into an explicit scope. Resources must close in reverse acquisition order even when one close fails, and the original body error must be reported separately from cleanup errors. What exact line does the new boundary print? Answer only that line.

\`\`\`javascript
const trace = [];
async function withScope(body) {
  const resources = [];
  let bodyError = null;
  const cleanupErrors = [];
  const scope = {
    acquire(name, fails) {
      trace.push('open:' + name);
      resources.push(async () => {
        trace.push('close:' + name);
        if (fails) throw new Error(name);
      });
    },
  };
  try {
    await body(scope);
  } catch (error) {
    bodyError = error.message;
  } finally {
    for (const close of resources.reverse()) {
      try { await close(); }
      catch (error) { cleanupErrors.push(error.message); }
    }
  }
  return { bodyError, cleanupErrors };
}
(async () => {
  const result = await withScope(async scope => {
    scope.acquire('db', false);
    scope.acquire('file', true);
    scope.acquire('lock', false);
    throw new Error('work');
  });
  console.log(JSON.stringify([result, trace]));
})();
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [{"bodyError": "work", "cleanupErrors": ["file"]}, ["open:db", "open:file", "open:lock", "close:lock", "close:file", "close:db"]],
    },
  },
  {
    id: "refactor-arch-v2-request-scope-single-flight",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: CODE_SYS,
    userPrompt: `Refactor createScope into an injected request dependency boundary createScope(loader), removing its direct dependency on the outer load function. Construct each scope at the composition root with the same loader, but keep pending-promise storage private to each request. Preserve single-flight identity within a scope, separation across scopes, load count, and supplied resolution order. Perform the architecture refactor, then report only the JSON output of the refactored whole program; do not output code.

\`\`\`javascript
let loads = 0;
const resolvers = [];
function load(key) {
  loads++;
  const sequence = loads;
  return new Promise(resolve => resolvers.push(() => resolve(key + ':' + sequence)));
}
function createScope() {
  const pending = new Map();
  return key => {
    if (!pending.has(key)) pending.set(key, load(key));
    return pending.get(key);
  };
}
(async () => {
  const firstScope = createScope();
  const secondScope = createScope();
  const first = firstScope('x');
  const again = firstScope('x');
  const other = secondScope('x');
  const secondKey = firstScope('y');
  const identity = [first === again, first === other];
  for (const resolve of resolvers.reverse()) resolve();
  const values = await Promise.all([first, again, other, secondKey]);
  console.log(JSON.stringify([identity, loads, values]));
})();
\`\`\`

Preserve object keys in exactly the order printed by this program; JSON whitespace is immaterial.`,
    check: {
      kind: "json_equal",
      value: [[true, false], 3, ["x:1", "x:1", "x:2", "y:3"]],
    },
  },
  {
    id: "refactor-arch-v2-dependency-inversion-cutover",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: SYS_SYS,
    userPrompt: `Current imports form this cycle: domain/order imports infrastructure/sqlOrderStore; sqlOrderStore imports domain/order to construct orders. HTTP handlers import both. Refactor to dependency inversion without moving database dependencies into a shared "interfaces" package. Describe final dependencies, construction ownership, and tests that preserve behavior. No compatibility re-export is allowed at the end.`,
    check: {
      kind: "judged",
      rubric: "Pass only if it places a storage port in domain or a dependency-free contracts module; domain business logic depends on the port and not SQL; the SQL adapter implements the port and may depend inward on domain types without creating the reverse dependency; composition root constructs/injects the adapter into the service/handlers; migrates direct SQL-dependent callers and removes obsolete imports/re-exports; includes behavior tests with a fake port and adapter integration checks preserving transaction/error semantics. Do not put SQL implementation dependencies in the port module.",
      reference: "Define OrderStore at the inward boundary and make order operations accept it. sqlOrderStore implements that contract; it can import domain types, while domain no longer imports SQL. The outer composition root creates the SQL store and injects it into handlers/services. Update every old caller and remove obsolete exports. Test the pure use case through a fake and separately verify adapter persistence, errors and atomicity.",
    },
  },
  {
    id: "refactor-arch-v2-shared-validation-package",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: SYS_SYS,
    userPrompt: `Browser, CLI, and server duplicate request validation. The server validator module currently imports the DB client at module load and checks permissions using current user state. Design a shared validation boundary that removes duplication without shipping server code or changing permission behavior. Explain import structure, what remains server-only, and how to check the cutover.`,
    check: {
      kind: "judged",
      rubric: "Pass only if it extracts pure structural/value validation and shared types into a dependency-free/browser-safe module; keeps permission and DB-dependent checks on the server using current trusted state; avoids a barrel/re-export that imports or initializes the server DB in browser/CLI entry points; migrates the three structural-validation callers without claiming client validation is authoritative; tests equal structural acceptance/error shapes and verifies server authorization still executes with current user state. Do not share mutable current-user state.",
      reference: "Share only pure request shape/value validation and types in a safe entry point. Server performs that validation plus fresh authorization and DB checks; CLI/browser use the same pure part for feedback, never security authority. Do not import the server validator through a shared barrel. Replace duplicated callers and test structural parity, browser-safe dependency graphs and server permission behavior.",
    },
  },
  {
    id: "refactor-arch-v2-atomic-boundary-extraction",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: SYS_SYS,
    userPrompt: `Refactor a monolithic purchase handler into order, stock, notification, and application-coordinator modules. The current handler atomically writes an order and decrements stock in one DB transaction, then sends email after commit. Preserve that behavior; do not give the persistence modules independent transactions. Return concrete pseudocode for the refactored module APIs and coordinator showing shared transaction injection, commit/rollback, post-commit notification, and one failure-test outline. Explain any outbox variant you choose, but do not merely recommend an architecture without specifying the refactored boundaries.`,
    check: {
      kind: "judged",
      rubric: "Pass only if it provides concrete module/API and coordinator pseudocode, not just advice; retains one unit-of-work/transaction around both order and stock writes; passes the same transaction-scoped repositories/context into modules rather than opening independent transactions; shows rollback on failure and commit on success; sends email only after successful commit or uses a transactional outbox with post-commit dispatch; includes a failure test where stock failure rolls back the order and suppresses email, plus a success sequencing assertion; does not claim direct email inside the DB transaction is rollbackable.",
      reference: "order.create(tx, input) calls tx.orders.insert(input); stock.reserve(tx, item, count) calls tx.stock.decrementIfAvailable(item, count) and throws if unavailable; notification.send(order) sends the email. Coordinator purchase(input): order = await unitOfWork.transaction(async tx => { order = await orderModule.create(tx, input); await stock.reserve(tx, input.item, input.count); return order; }); await notification.send(order); return order. The unit of work commits after its callback succeeds and rolls back/rethrows on any callback failure. Failure test: inject a reserve failure after order insertion, assert no order or stock change persists and send was never called. Success test: assert commit occurs before send.",
    },
  },
  {
    id: "refactor-arch-v2-scoped-state-composition",
    taskType: 'refactoring',
    subtaskType: "architecture_improvement",
    systemPrompt: SYS_SYS,
    userPrompt: `A refactor extracts authorization and localization services from a request handler. They currently read mutable module-level currentUser and locale, which concurrent requests overwrite. DB connections are safely pooled and immutable locale dictionaries are expensive to build. Give an ownership/composition design that removes the race without rebuilding every dependency per request. Describe a deterministic concurrency test.`,
    check: {
      kind: "judged",
      rubric: "Pass only if it makes user/locale explicit immutable request-context data or request-scoped dependencies rather than globals; shares a safe DB pool and immutable dictionaries across requests; constructs request-bound service closures/objects at the outer request boundary; avoids storing request context on shared singleton instances; tests two interleaved requests with different users/locales using controlled barriers/deferred promises and asserts each gets its own permissions/localized values. Do not recommend thread-local storage without addressing the explicit lifetime contract.",
      reference: "Keep the pool and immutable dictionaries in the process composition root. At request entry capture an immutable user/locale context and inject it into request service closures; shared services never receive mutable current-user fields. In a test pause request A after context capture, start B with different values, resume A, and verify both authorization and localization stay request-specific.",
    },
  },
];
