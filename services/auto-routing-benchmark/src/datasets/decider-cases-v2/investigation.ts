import type { DeciderCase } from '../decider-cases';

const CODE_SYS =
  'You are a precise coding assistant. Answer with only what is asked, no explanations.';
const SYS_SYS =
  'You are a precise systems engineer. Answer with only what is asked, no explanations.';

export const INVESTIGATION_V2_CASES: readonly DeciderCase[] = [
  {
    id: 'invest-code-v2-listener-snapshot',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the JSON, preserving the shown key order.

const listeners = new Map();
const log = [];
function on(name, fn) {
  const bucket = listeners.get(name) ?? [];
  bucket.push(fn);
  listeners.set(name, bucket);
  return () => {
    const i = bucket.indexOf(fn);
    if (i >= 0) bucket.splice(i, 1);
  };
}
function emit(name, value) {
  const snapshot = [...(listeners.get(name) ?? [])];
  for (const fn of snapshot) fn(value);
}
let removeB;
let installed = false;
on('tick', n => {
  log.push('a' + n);
  removeB();
  if (!installed) {
    installed = true;
    on('tick', m => log.push('c' + m));
    emit('tick', n + 10);
  }
});
removeB = on('tick', n => log.push('b' + n));
emit('tick', 1);
emit('tick', 2);
console.log(JSON.stringify(log));`,
    check: {
      kind: 'json_equal',
      value: [
        "a1",
        "a11",
        "c11",
        "b1",
        "a2",
        "c2"
      ],
    },
  },
  {
    id: 'invest-code-v2-promise-adoption',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the exact output line.

const log = [];
const resolved = Promise.resolve();
function mark(value) {
  log.push(value);
}
async function worker() {
  mark('w0');
  await resolved;
  mark('w1');
  await resolved;
  mark('w2');
}
const task = worker();
const chain = resolved.then(() => {
  mark('p1');
  return resolved.then(() => {
    mark('inner');
  });
}).then(() => {
  mark('p2');
});
queueMicrotask(() => {
  mark('q1');
  queueMicrotask(() => mark('q2'));
});
mark('sync');
Promise.all([task, chain]).then(() => {
  console.log(log.join(','));
});`,
    check: {
      kind: 'exact',
      value: "w0,sync,w1,p1,q1,w2,inner,q2,p2",
    },
  },
  {
    id: 'invest-code-v2-sparse-array-views',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the JSON, preserving the shown key order.

const source = [];
source.length = 5;
source[1] = 3;
source[4] = 7;
const mapped = source.map((value, index) => value + index);
const copied = [...source];
const sliced = source.slice();
const visits = [];
source.forEach((value, index) => {
  visits.push(index + ':' + value);
});
let reductions = 0;
const sum = source.reduce((total, value) => {
  reductions++;
  return total + value;
}, 0);
const result = {
  mapped: JSON.stringify(mapped),
  copiedHasZero: 0 in copied,
  slicedHasZero: 0 in sliced,
  keys: Object.keys(source),
  visits,
  sum,
  reductions
};
console.log(JSON.stringify(result));`,
    check: {
      kind: 'json_equal',
      value: {
        "mapped": "[null,4,null,null,11]",
        "copiedHasZero": true,
        "slicedHasZero": false,
        "keys": [
          "1",
          "4"
        ],
        "visits": [
          "1:3",
          "4:7"
        ],
        "sum": 10,
        "reductions": 2
      },
    },
  },
  {
    id: 'invest-code-v2-getter-materialization',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the JSON, preserving the shown key order.

let reads = 0;
const source = {};
Object.defineProperty(source, 'value', {
  enumerable: true,
  get() {
    reads++;
    return reads * 10;
  }
});
Object.defineProperty(source, 'hidden', {
  enumerable: false,
  value: 99
});
const spread = {...source};
const assigned = Object.assign({}, source);
const preserved = Object.defineProperties(
  {}, Object.getOwnPropertyDescriptors(source)
);
const a = spread.value;
const b = assigned.value;
const c = preserved.value;
const d = preserved.value;
const result = {
  values: [a, b, c, d],
  reads,
  spreadKeys: Object.keys(spread),
  preservedHidden: preserved.hidden
};
console.log(JSON.stringify(result));`,
    check: {
      kind: 'json_equal',
      value: {
        "values": [
          10,
          20,
          30,
          40
        ],
        "reads": 4,
        "spreadKeys": [
          "value"
        ],
        "preservedHidden": 99
      },
    },
  },
  {
    id: 'invest-code-v2-map-identity-order',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the JSON, preserving the shown key order.

const map = new Map();
const first = {id: 1};
const second = {id: 1};
map.set(first, 'A');
map.set(second, 'B');
map.set(NaN, 'N1');
map.set(Number('bad'), 'N2');
map.set(-0, 'minus');
map.set(0, 'zero');
map.delete(first);
map.set(first, 'A2');
const snapshot = [];
for (const [key, value] of map) {
  const label = key === first ? 'first'
    : key === second ? 'second'
    : Number.isNaN(key) ? 'nan'
    : 'zero';
  snapshot.push(label + ':' + value);
}
const result = {
  size: map.size,
  freshObject: map.has({id: 1}),
  nan: map.get(NaN),
  snapshot
};
console.log(JSON.stringify(result));`,
    check: {
      kind: 'json_equal',
      value: {
        "size": 4,
        "freshObject": false,
        "nan": "N2",
        "snapshot": [
          "second:B",
          "nan:N2",
          "zero:zero",
          "first:A2"
        ]
      },
    },
  },
  {
    id: 'invest-code-v2-generator-finally-return',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the JSON, preserving the shown key order.

const events = [];
function* inner() {
  try {
    events.push('start');
    yield 1;
    events.push('after');
    yield 2;
  } finally {
    events.push('finally');
    yield 9;
    events.push('cleanup');
  }
  return 7;
}
function* outer() {
  const result = yield* inner();
  events.push('outer:' + result);
  return 8;
}
const iterator = outer();
const one = iterator.next();
const two = iterator.return(4);
const three = iterator.next(6);
const four = iterator.next();
console.log(JSON.stringify({one, two, three, four, events}));`,
    check: {
      kind: 'json_equal',
      value: {
        "one": {
          "value": 1,
          "done": false
        },
        "two": {
          "value": 9,
          "done": false
        },
        "three": {
          "value": 8,
          "done": true
        },
        "four": {
          "done": true
        },
        "events": [
          "start",
          "finally",
          "cleanup",
          "outer:4"
        ]
      },
    },
  },
  {
    id: 'invest-code-v2-memoized-recursive-state',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the JSON, preserving the shown key order.

function makeCounter() {
  const cache = new Map();
  let misses = 0;
  function count(n) {
    if (cache.has(n)) return cache.get(n);
    misses++;
    const value = n < 2 ? n : count(n - 1) + count(n - 2);
    cache.set(n, value);
    return value;
  }
  return {
    count,
    reset() { cache.clear(); },
    stats() { return {misses, size: cache.size}; }
  };
}
const first = makeCounter();
const second = makeCounter();
const a = first.count(6);
const b = first.count(5);
first.reset();
const c = first.count(3);
const d = second.count(3);
const result = {
  values: [a, b, c, d],
  first: first.stats(),
  second: second.stats()
};
console.log(JSON.stringify(result));`,
    check: {
      kind: 'json_equal',
      value: {
        "values": [
          8,
          5,
          2,
          2
        ],
        "first": {
          "misses": 11,
          "size": 4
        },
        "second": {
          "misses": 4,
          "size": 4
        }
      },
    },
  },
  {
    id: 'invest-code-v2-inflight-cache-eviction',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the JSON, preserving the shown key order.

const pending = new Map();
const waits = [];
let calls = 0;
function load() {
  calls++;
  return new Promise(resolve => waits.push(resolve));
}
function get(key) {
  if (pending.has(key)) return pending.get(key);
  const promise = load().finally(() => {
    pending.delete(key);
  });
  pending.set(key, promise);
  return promise;
}
async function run() {
  const a = get('x');
  const b = get('x');
  const before = a === b;
  pending.delete('x');
  const c = get('x');
  waits[0]('old');
  await a;
  const after = pending.has('x');
  const d = get('x');
  waits[1]('new');
  waits[2]('third');
  const values = await Promise.all([b, c, d]);
  console.log(JSON.stringify({before, after, calls, values}));
}
run();`,
    check: {
      kind: 'json_equal',
      value: {
        "before": true,
        "after": false,
        "calls": 3,
        "values": [
          "old",
          "new",
          "third"
        ]
      },
    },
  },
  {
    id: 'invest-code-v2-sticky-parser-cursor',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the JSON, preserving the shown key order.

const token = /[a-z]+/y;
const input = 'ab cd ef';
const out = [];
function attempt(at) {
  token.lastIndex = at;
  const found = token.exec(input);
  out.push({
    at,
    word: found ? found[0] : null,
    next: token.lastIndex
  });
}
attempt(0);
attempt(2);
attempt(3);
attempt(5);
attempt(6);
const global = /[a-z]+/g;
global.lastIndex = 2;
const hit = global.exec(input);
const result = {
  out,
  globalWord: hit[0],
  globalIndex: hit.index,
  globalNext: global.lastIndex
};
console.log(JSON.stringify(result));`,
    check: {
      kind: 'json_equal',
      value: {
        "out": [
          {
            "at": 0,
            "word": "ab",
            "next": 2
          },
          {
            "at": 2,
            "word": null,
            "next": 0
          },
          {
            "at": 3,
            "word": "cd",
            "next": 5
          },
          {
            "at": 5,
            "word": null,
            "next": 0
          },
          {
            "at": 6,
            "word": "ef",
            "next": 8
          }
        ],
        "globalWord": "cd",
        "globalIndex": 3,
        "globalNext": 5
      },
    },
  },
  {
    id: 'invest-code-v2-override-merge-aliases',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the JSON, preserving the shown key order.

const defaults = {
  tags: ['base'],
  limits: {soft: 3, hard: 9}
};
function configure(input) {
  return {
    ...defaults,
    ...input,
    limits: {...defaults.limits, ...input.limits}
  };
}
const first = configure({limits: {soft: 5}});
const second = configure({tags: ['custom']});
first.tags.push('shared');
first.limits.hard = 12;
second.tags.push('private');
const third = configure({limits: {hard: undefined}});
const result = {
  defaults,
  first,
  second,
  thirdHasHard: Object.hasOwn(third.limits, 'hard'),
  thirdHard: third.limits.hard ?? 'missing'
};
console.log(JSON.stringify(result));`,
    check: {
      kind: 'json_equal',
      value: {
        "defaults": {
          "tags": [
            "base",
            "shared"
          ],
          "limits": {
            "soft": 3,
            "hard": 9
          }
        },
        "first": {
          "tags": [
            "base",
            "shared"
          ],
          "limits": {
            "soft": 5,
            "hard": 12
          }
        },
        "second": {
          "tags": [
            "custom",
            "private"
          ],
          "limits": {
            "soft": 3,
            "hard": 9
          }
        },
        "thirdHasHard": true,
        "thirdHard": "missing"
      },
    },
  },
  {
    id: 'invest-code-v2-integer-precision-boundary',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the JSON, preserving the shown key order.

const base = 9007199254740992n;
const exact = [base, base + 1n, base + 2n];
const approximate = exact.map(Number);
const differences = approximate.map((value, index) => {
  return BigInt(value) - exact[index];
});
const cache = new Map();
for (let i = 0; i < approximate.length; i++) {
  cache.set(approximate[i], i);
}
const serialized = exact.map(String);
const result = {
  exact: serialized,
  distinctNumbers: new Set(approximate).size,
  cacheValues: [...cache.values()],
  differences: differences.map(String),
  equalFirstTwo: approximate[0] === approximate[1],
  subtraction: approximate[2] - approximate[1]
};
console.log(JSON.stringify(result));`,
    check: {
      kind: 'json_equal',
      value: {
        "exact": [
          "9007199254740992",
          "9007199254740993",
          "9007199254740994"
        ],
        "distinctNumbers": 2,
        "cacheValues": [
          1,
          2
        ],
        "differences": [
          "0",
          "-1",
          "0"
        ],
        "equalFirstTwo": true,
        "subtraction": 2
      },
    },
  },
  {
    id: 'invest-code-v2-optional-chain-side-effects',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the JSON, preserving the shown key order.

let calls = 0;
function key() {
  calls++;
  return 'run';
}
function argument() {
  calls += 10;
  return calls;
}
const absent = null;
const empty = {};
const present = {
  factor: 2,
  run(value) { return this.factor * value; }
};
const a = absent?.[key()]?.(argument());
const b = empty?.[key()]?.(argument());
const c = present?.[key()]?.(argument());
let error;
try {
  (absent?.run)(argument());
} catch (caught) {
  error = caught.name;
}
console.log(JSON.stringify({
  a: a ?? 'none', b: b ?? 'none', c, calls, error
}));`,
    check: {
      kind: 'json_equal',
      value: {
        "a": "none",
        "b": "none",
        "c": 24,
        "calls": 22,
        "error": "TypeError"
      },
    },
  },
  {
    id: 'invest-code-v2-finally-completion-replacement',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the JSON, preserving the shown key order.

const events = [];
function work(mode) {
  try {
    events.push('try:' + mode);
    if (mode === 0) return 'ok';
    if (mode === 1) throw new Error('failure');
    return 'other';
  } catch (error) {
    events.push('catch:' + error.message);
    return 'handled';
  } finally {
    events.push('finally:' + mode);
    if (mode === 1) return 'override';
    if (mode === 2) throw new Error('cleanup');
  }
}
const results = [];
for (const mode of [0, 1, 2]) {
  try {
    results.push(work(mode));
  } catch (error) {
    results.push('error:' + error.message);
  }
}
console.log(JSON.stringify({results, events}));`,
    check: {
      kind: 'json_equal',
      value: {
        "results": [
          "ok",
          "override",
          "error:cleanup"
        ],
        "events": [
          "try:0",
          "finally:0",
          "try:1",
          "catch:failure",
          "finally:1",
          "try:2",
          "finally:2"
        ]
      },
    },
  },
  {
    id: 'invest-code-v2-stable-two-pass-sort',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the JSON, preserving the shown key order.

const records = [
  {id: 'a', group: 2, score: 3},
  {id: 'b', group: 1, score: 5},
  {id: 'c', group: 2, score: 5},
  {id: 'd', group: 1, score: 3},
  {id: 'e', group: 2, score: 5},
  {id: 'f', group: 1, score: 5}
];
const original = records.map(row => row.id);
const alias = records;
const sorted = records.sort((left, right) => {
  return right.score - left.score;
});
sorted.sort((left, right) => {
  return left.group - right.group;
});
const top = sorted.filter((row, index, all) => {
  return index === 0 || row.group !== all[index - 1].group;
});
const result = {
  original,
  order: sorted.map(row => row.id),
  aliasOrder: alias.map(row => row.id),
  sameArray: sorted === records,
  top: top.map(row => row.id)
};
console.log(JSON.stringify(result));`,
    check: {
      kind: 'json_equal',
      value: {
        "original": [
          "a",
          "b",
          "c",
          "d",
          "e",
          "f"
        ],
        "order": [
          "b",
          "f",
          "d",
          "c",
          "e",
          "a"
        ],
        "aliasOrder": [
          "b",
          "f",
          "d",
          "c",
          "e",
          "a"
        ],
        "sameArray": true,
        "top": [
          "b",
          "c"
        ]
      },
    },
  },
  {
    id: 'invest-code-v2-closure-binding-lifetimes',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the JSON, preserving the shown key order.

const functions = [];
for (var i = 0; i < 3; i++) {
  functions.push(() => 'v' + i);
}
for (let j = 0; j < 3; j++) {
  functions.push(() => 'l' + j);
}
for (var k = 0; k < 3; k++) {
  const captured = k;
  functions.push(() => 'c' + captured);
}
const shared = {value: 0};
for (let m = 0; m < 2; m++) {
  const reference = shared;
  functions.push(() => 'r' + reference.value);
  shared.value++;
}
i = 8;
k = 9;
shared.value = 4;
const first = functions.map(fn => fn());
shared.value = 5;
const second = functions.slice(-2).map(fn => fn());
console.log(JSON.stringify({first, second}));`,
    check: {
      kind: 'json_equal',
      value: {
        "first": [
          "v8",
          "v8",
          "v8",
          "l0",
          "l1",
          "l2",
          "c0",
          "c1",
          "c2",
          "r4",
          "r4"
        ],
        "second": [
          "r5",
          "r5"
        ]
      },
    },
  },
  {
    id: 'invest-code-v2-enumeration-property-classes',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the JSON, preserving the shown key order.

const symbol = Symbol('secret');
const proto = {inherited: 'p'};
const object = Object.create(proto);
object.z = 'z';
object['10'] = 'ten';
object['2'] = 'two';
object['01'] = 'one';
object.a = 'a';
Object.defineProperty(object, 'hidden', {
  enumerable: false,
  value: 'h'
});
object[symbol] = 's';
delete object.z;
object.z = 'new';
const own = Object.keys(object);
const traversed = [];
for (const key in object) traversed.push(key);
const copied = {...object};
const result = {
  own,
  traversed,
  copiedSecret: copied[symbol],
  copiedHidden: Object.hasOwn(copied, 'hidden'),
  copiedInherited: Object.hasOwn(copied, 'inherited')
};
console.log(JSON.stringify(result));`,
    check: {
      kind: 'json_equal',
      value: {
        "own": [
          "2",
          "10",
          "01",
          "a",
          "z"
        ],
        "traversed": [
          "2",
          "10",
          "01",
          "a",
          "z",
          "inherited"
        ],
        "copiedSecret": "s",
        "copiedHidden": false,
        "copiedInherited": false
      },
    },
  },
  {
    id: 'invest-code-v2-utf8-chunk-boundaries',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the JSON, preserving the shown key order.

const chunks = [
  Uint8Array.from([0x41, 0xe2]),
  Uint8Array.from([0x82]),
  Uint8Array.from([0xac, 0x42, 0xf0, 0x9f]),
  Uint8Array.from([0x98, 0x80])
];
const decoder = new TextDecoder('utf-8');
const streamed = [];
for (const chunk of chunks) {
  streamed.push(decoder.decode(chunk, {stream: true}));
}
streamed.push(decoder.decode());
const joined = streamed.join('');
const isolated = chunks.map(chunk => {
  return new TextDecoder('utf-8').decode(chunk);
});
let rejected = false;
try {
  new TextDecoder('utf-8', {fatal: true}).decode(chunks[0]);
} catch {
  rejected = true;
}
const result = {streamed, joined, isolated, rejected};
console.log(JSON.stringify(result));`,
    check: {
      kind: 'json_equal',
      value: {
        "streamed": [
          "A",
          "",
          "€B",
          "😀",
          ""
        ],
        "joined": "A€B😀",
        "isolated": [
          "A�",
          "�",
          "�B�",
          "��"
        ],
        "rejected": true
      },
    },
  },
  {
    id: 'invest-code-v2-dependency-dfs-visited',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Study this self-contained JavaScript subsystem. What does its final console.log print? Return only the JSON, preserving the shown key order.

const edges = new Map([
  ['app', ['api', 'ui']],
  ['api', ['store', 'shared']],
  ['ui', ['shared', 'api']],
  ['store', ['shared']],
  ['shared', ['api']],
  ['unused', ['shared']]
]);
const visited = new Set();
const active = new Set();
const order = [];
const cycles = [];
function visit(node) {
  if (active.has(node)) {
    cycles.push(node);
    return;
  }
  if (visited.has(node)) return;
  visited.add(node);
  active.add(node);
  for (const target of edges.get(node) ?? []) visit(target);
  active.delete(node);
  order.push(node);
}
visit('app');
console.log(JSON.stringify({order, cycles, visited: [...visited]}));`,
    check: {
      kind: 'json_equal',
      value: {
        "order": [
          "shared",
          "store",
          "api",
          "ui",
          "app"
        ],
        "cycles": [
          "api"
        ],
        "visited": [
          "app",
          "api",
          "store",
          "shared",
          "ui"
        ]
      },
    },
  },
  {
    id: 'invest-code-v2-cache-observation-explanation',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Investigate this cache, without changing it. Explain the final loads count, whether first === second, the final key, and the two distinct cache semantics responsible. Distinguish a missing entry from a cached undefined. Do not propose unrelated optimizations.

const cache = new Map();
let loads = 0;
function load(key) {
  loads++;
  if (key === 'empty') return undefined;
  return {key, loads};
}
function get(key) {
  const value = cache.get(key);
  if (value !== undefined) return value;
  const fresh = load(key);
  cache.set(key, fresh);
  return fresh;
}
get('empty');
get('empty');
const first = get('full');
first.key = 'changed';
const second = get('full');
console.log(JSON.stringify({loads, same: first === second, key: second.key}));`,
    check: {
      kind: 'judged',
      rubric: "The answer states loads=3, first===second is true, and second.key is changed. It explains that cache.get returns undefined for both absent and cached-undefined entries, so empty is loaded twice, while full is loaded once. It explains shared object identity and mutation, not a copy. It identifies Map.has as the missing-versus-present discriminator, without claiming it fixes aliasing.",
      reference: "loads is 3. The two empty lookups reload because cache.get cannot distinguish cached undefined from a miss; Map.has would distinguish them. full is loaded once. Both full lookups return the same object, so first===second is true and second.key is changed after mutation.",
    },
  },
  {
    id: 'invest-code-v2-queue-rejection-propagation',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt: `Investigate how this serial queue connects caller-visible promises to its internal scheduling state. Identify where the next job obtains its predecessor, where a predecessor rejection propagates without invoking the job body, and which promise objects a caller's separate catch can affect. Explain the observed job names, settled statuses and rejection messages as evidence for that data flow. Do not change the implementation or propose a fix.

let tail = Promise.resolve();
const events = [];
function enqueue(name, fail) {
  const result = tail.then(() => {
    events.push(name);
    if (fail) throw new Error(name);
    return name;
  });
  tail = result;
  return result;
}
async function run() {
  const first = enqueue('a', true);
  const second = enqueue('b', false);
  const settled = await Promise.allSettled([first, second]);
  console.log(JSON.stringify({
    events,
    statuses: settled.map(item => item.status),
    errors: settled.map(item => item.reason.message)
  }));
}
run();`,
    check: {
      kind: 'judged',
      rubric: "The answer identifies tail.then as the predecessor connection and tail=result as the scheduling-state update. It states only a runs, both promises reject, and both rejection messages are a, explaining that the next fulfillment-only handler is skipped on rejection. It distinguishes the original promise stored in tail from a new promise returned by a caller's catch; attaching that catch does not replace the internal tail. It explains the supplied implementation without prescribing changes.",
      reference: "enqueue connects each job to tail through tail.then, then stores its result as the next tail and returns that same result to the caller. Only a runs; both results reject with message a because b's fulfillment handler is attached to a rejected predecessor. A caller's catch creates another promise but does not replace the promise stored in tail or the predecessor already captured by b.",
    },
  },
  {
    id: 'invest-ext-v2-release-source-precedence',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only this complete, fictional source pack; no network or unstated product knowledge is needed.

[S1: archived guide, product 2.3]
Streaming is preview; runtime >=18.17. Stable release 2.3.7 has no streaming.
[S2: official release matrix, product 2.4/2.5]
2.4.0: stable; runtime >=20.1; streaming=yes.
2.4.1: stable; runtime >=20.1; streaming=yes.
2.5.0: stable; runtime >=20.4; streaming=yes.
2.5.1-beta.1: prerelease; runtime >=20.1; streaming=yes.
[S3: official erratum for S2]
Streaming in 2.4.0 corrupts empty frames. Fixed in 2.4.1. Other S2 entries unchanged.
[S4: community post]
Use 2.5.0 on all runtime 20 releases.
The erratum overrides its matrix; otherwise the matching official versioned source overrides community claims. Deployment uses runtime 20.2, needs stable streaming without the empty-frame defect, and wants the newest eligible release. Which release and which two authoritative sources establish eligibility? Return JSON keys release,sources; sources in numeric order.`,
    check: {
      kind: 'json_equal',
      value: {
        "release": "2.4.1",
        "sources": [
          "S2",
          "S3"
        ]
      },
    },
  },
  {
    id: 'invest-ext-v2-retry-delivery-evidence',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only this complete, fictional source pack; no network or unstated product knowledge is needed.

[R1: retry policy]
A request may be retried if method is idempotent OR server guarantees non-application OR a deduplication token is honored for that endpoint and the identical token is reused. A local timeout alone does not prove non-application.
[R2: endpoint table]
GET /read: idempotent. POST /charge: non-idempotent, tokens honored.
POST /notify: non-idempotent, token header ignored.
[R3: six observations]
a: GET /read timed out after send.
b: POST /charge timed out after send, retry reuses token t1.
c: POST /charge timed out after send, retry changes t1 to t2.
d: POST /notify timed out after send with token t1.
e: POST /notify received explicit NOT_APPLIED from server.
f: POST /charge had connection refused before any request bytes were sent; server guarantees non-application in this situation.
List the retry-eligible observation ids in alphabetic order, comma-separated with no spaces.`,
    check: {
      kind: 'exact',
      value: "a,b,e,f",
    },
  },
  {
    id: 'invest-ext-v2-quota-reserved-costs',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only this complete, fictional source pack; no network or unstated product knowledge is needed.

[Q1: server admission manual, version 2]
Admission outcomes and remaining credits are reported by the server's final ledger, not by client attempt counters. Local cache hits appear in the exported accepted list but consume no admission. Server retries retain the original operation id.
[Q2: archived client diagnostics, version 1]
Client attempt counters classified retries as additional requests. These counters are not an admission ledger and cannot establish remaining credits.
[Q3: support attachment index]
Trace tiny-A: minute-only limiter, client version 1.
Trace dual-B: minute-and-hour limiter, client version 2; local cache enabled.
Trace dual-C: same limiter, client version 2; local cache disabled.
The deployment being investigated uses dual buckets, client version 2 and local cache.
[Q4: server final ledger excerpts; ids are in recorded order]
tiny-A: accepted a,b; rejected a-retry1,a-retry2,c,d,e,f; remaining minute 2; hour not tracked.
dual-B: accepted a,b,d,e; rejected c,f; remaining minute 0; hour 5.
dual-C: accepted a,b,e; rejected c,d,f; remaining minute 0; hour 5.
[Q5: scope clarification]
Only Q4 is authoritative for server admissions. Retry attempts in Q2 are not separate operation ids in a Q4 export.
What does the matching authoritative ledger say about this deployment? Return JSON keys accepted,rejected,minute,hour; preserve the ledger's operation order. Extract reported balances; do not calculate costs.`,
    check: {
      kind: 'json_equal',
      value: {
        "accepted": [
          "a",
          "b",
          "d",
          "e"
        ],
        "rejected": [
          "c",
          "f"
        ],
        "minute": 0,
        "hour": 5
      },
    },
  },
  {
    id: 'invest-ext-v2-prerelease-range-exclusion',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only this complete, fictional source pack; no network or unstated product knowledge is needed.

[V1: published compatibility profiles]
caret034 is the stable 0.3 line from its 0.3.4 baseline; caret004 is the pinned microfix line. preview is the 0.3.5 preview track. Compatibility is defined by the release matrix, not by sorting version strings. Prerelease acceptance is profile-specific.
[V2: official release matrix, columns version | caret034 | caret004 | preview]
0.0.4 | accepted | accepted | rejected
0.0.5-beta.1 | rejected | rejected | rejected
0.3.4-beta.2 | rejected | rejected | rejected
0.3.4 | accepted | rejected | rejected
0.3.5-beta.1 | rejected | rejected | accepted
0.3.5 | accepted | rejected | accepted
0.4.0-beta.1 | rejected | rejected | rejected
0.4.0 | rejected | rejected | rejected
[V3: signed erratum for V2]
The caret034 cell for 0.0.4 is a transcription error: it is rejected. All other cells are unchanged.
[V4: archived preview announcement]
0.4.0-beta.1 was temporarily accepted in the experimental preview track before V2 was published. That announcement does not describe the current published profiles.
Which versions do the current published profiles accept after the erratum? Return JSON keys caret034,caret004,preview, with version lists in V2 row order. Report documented membership, not computed range expansion.`,
    check: {
      kind: 'json_equal',
      value: {
        "caret034": [
          "0.3.4",
          "0.3.5"
        ],
        "caret004": [
          "0.0.4"
        ],
        "preview": [
          "0.3.5-beta.1",
          "0.3.5"
        ]
      },
    },
  },
  {
    id: 'invest-ext-v2-cache-age-calculation',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only this complete, fictional source pack; no network or unstated product knowledge is needed.

[C1: cache diagnostic field guide]
The final_age stage reports currentAge, the boolean fresh, and secondsBeyondLimit. Earlier stages are intermediate measurements, not the freshness decision. In strict mode only the final_age stage is authoritative; heuristic mode may override it.
[C2: trace attachment, mode strict, response id r7]
stage received: currentAge=20; fresh=true; secondsBeyondLimit=0.
stage resident: currentAge=45; fresh=true; secondsBeyondLimit=0.
stage final_age: currentAge=69; fresh=false; secondsBeyondLimit=9.
[C3: trace attachment, mode heuristic, response id r7]
stage final_age: currentAge=69; fresh=true; secondsBeyondLimit=0.
[C4: source precedence notice]
The field guide supersedes the old troubleshooting suggestion to use the largest fresh=true intermediate stage. Attachment values already include all age corrections; no arithmetic is required.
The deployment uses strict mode and is investigating response r7. What does the authoritative freshness diagnostic report? Return JSON keys currentAge,fresh,secondsBeyondLimit, using the documented final decision rather than reconstructing an age.`,
    check: {
      kind: 'json_equal',
      value: {
        "currentAge": 69,
        "fresh": false,
        "secondsBeyondLimit": 9
      },
    },
  },
  {
    id: 'invest-ext-v2-utf8-prefix-budget',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only this complete, fictional source pack; no network or unstated product knowledge is needed.

[U1: transport release notes]
The public byte-prefix mode preserves code points, never skips a point, and does not normalize. The experimental glyph mode measures displayed glyphs. Normalized mode converts decomposed sequences to composed form before truncation. Only public byte-prefix mode is enabled in this deployment.
[U2: conformance vectors]
Vector a input is A, U+00E9, U+1F600, B, C.
Vector b input is A, U+0065, U+0301, U+1F600, B.
Vector c input is U+20AC, U+1F600, U+00E9, A.
[U3: published byte-prefix results at the supported eight-byte limit]
a output: Aé😀B
b output: Aé😀
c output: €😀
[U4: experimental results at an eight-glyph limit]
a output: Aé😀BC
b output: Aé😀B
c output: €😀éA
[U5: normalized-mode bulletin]
Vector b's displayed appearance can match U3 even though its code-point sequence differs: normalized mode uses U+00E9, whereas U3 uses U+0065 then U+0301. U5 does not alter byte-prefix mode.
Which prefix strings are documented for this deployment's enabled mode? Return JSON keys a,b,c. Preserve the U3 code-point sequences; do not compute byte counts or apply normalization.`,
    check: {
      kind: 'json_equal',
      value: {
        "a": "Aé😀B",
        "b": "Aé😀",
        "c": "€😀"
      },
    },
  },
  {
    id: 'invest-ext-v2-opaque-pagination-snapshot',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only this complete, fictional source pack; no network or unstated product knowledge is needed.

[P1: archived export documentation]
The snapshot id identifies one immutable export manifest. Continuation tokens refer to the same snapshot; a later untokened request starts a new snapshot. Manifest item lists are in retained export order, not alphabetic id order.
[P2: request evidence]
The investigation's initial request returned snapshot s1 and next token tA. A later independent request returned snapshot s2 and next token tC. Following tA and its continuation never changes the snapshot.
[P3: archived manifest for s1]
status: completed. retained ids by rank: 1=z, 2=b, 3=k, 4=a. page count: 3.
[P4: archived manifest for s2]
status: completed. retained ids by rank: 1=n, 2=a. page count: 2.
[P5: raw-page caveat]
Raw page boundaries may repeat ids. The archived manifest already records the retained export and is the authoritative source for exported order and page count.
What does the archived manifest say about the export started by the investigation's initial request? Return JSON keys snapshot,ids,pages, retaining documented rank order. Do not reconstruct or deduplicate raw pages.`,
    check: {
      kind: 'json_equal',
      value: {
        "snapshot": "s1",
        "ids": [
          "z",
          "b",
          "k",
          "a"
        ],
        "pages": 3
      },
    },
  },
  {
    id: 'invest-ext-v2-cancellation-contract-layers',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only this complete, fictional source pack; no network or unstated product knowledge is needed.

[A1: transport]
abort() prevents future network chunks. It does not undo a chunk already delivered and does not remove scheduled user callbacks.
[A2: wrapper v1]
Every received chunk schedules a callback; callbacks do not check abort state.
[A3: wrapper v2]
Every received chunk schedules a callback; when invoked, it suppresses delivery if abort state is true.
[A4: trace, same for either wrapper]
receive chunk 1; schedule callback 1; invoke callback 1; receive chunk 2; schedule callback 2; abort; attempt receive chunk 3 (blocked); invoke callback 2.
Return JSON keys v1Delivered,v2Delivered,networkReceived; arrays contain chunk numbers in order, and networkReceived is a count.`,
    check: {
      kind: 'json_equal',
      value: {
        "v1Delivered": [
          1,
          2
        ],
        "v2Delivered": [
          1
        ],
        "networkReceived": 2
      },
    },
  },
  {
    id: 'invest-ext-v2-merge-null-delete-semantics',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only this complete, fictional source pack; no network or unstated product knowledge is needed.

[M1: configuration compatibility note]
Draft patches treated null as a stored value and concatenated arrays. The released merge-patch profile instead treats null as deletion and replaces arrays. Only the released profile is supported by client 2.1.
[M2: profile registry]
baseline: retained read=5, write=8; tags a,b; enabled=true.
draft-c: retained read=5, write=null, burst=3; tags a,b,c; enabled=null; extra has gone=null and keep=0.
released-c: retained read=5, burst=3; tags c; no enabled key; extra has keep=0 and no gone key.
[M3: deployment bulletin]
Client 2.1 deployments requesting the c preset select released-c, not baseline or draft-c. The draft example remains in an archived design proposal but was never released.
[M4: registry serialization conventions]
Emit retained limits as numeric fields, tags as a string array, and extra as its listed object. Omitted registry fields are omitted JSON keys, not null. Top-level order is limits,tags,extra; limits order is read,burst; extra order is keep.
What configuration does the published registry document for a client 2.1 deployment using preset c? Return that documented JSON object in M4's order. Do not apply a patch or invent an implementation.`,
    check: {
      kind: 'json_equal',
      value: {
        "limits": {
          "read": 5,
          "burst": 3
        },
        "tags": [
          "c"
        ],
        "extra": {
          "keep": 0
        }
      },
    },
  },
  {
    id: 'invest-ext-v2-advisory-safe-backport',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only this complete, fictional source pack; no network or unstated product knowledge is needed.

[S1: advisory, authoritative]
Affected: >=3.1.0 <3.1.9 OR >=3.2.0 <3.2.4. Version 3.3.0 fixes the flaw but requires runtime >=22.0. Prereleases are not approved for deployment.
[S2: compatibility]
3.1.x and 3.2.x require runtime >=20.0. Application permits >=3.2.1 <3.3.0. Deployment runtime is 20.9.
[S3: available releases]
3.1.9, 3.2.1, 3.2.3, 3.2.4, 3.2.5-beta.1, 3.3.0.
[S4: blog]
All version 3 releases are unsafe; upgrade to 4.
Choose the newest available, non-prerelease, unaffected release satisfying BOTH application and runtime constraints. Reply only with the version.`,
    check: {
      kind: 'exact',
      value: "3.2.4",
    },
  },
  {
    id: 'invest-ext-v2-reader-writer-compatibility',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only this complete, fictional source pack; no network or unstated product knowledge is needed.

[K1: compatibility rules]
A reader rejects unknown fields if strict=true; otherwise it ignores them. A required field must be present. An optional missing field gets its declared default. Type mismatches always reject; numeric strings are not numbers.
[K2: readers]
old: strict=false, required id:string, optional count:number default 0.
new: strict=true, required id:string and count:number, optional tag:string default empty string.
[K3: writer outputs]
a={"id":"x"}
b={"id":"x","count":2,"extra":true}
c={"id":"x","count":"2"}
d={"id":"x","count":2,"tag":"ok"}
Return JSON keys old,new; each value is a list of accepted output ids in alphabetic order.`,
    check: {
      kind: 'json_equal',
      value: {
        "old": [
          "a",
          "b",
          "d"
        ],
        "new": [
          "d"
        ]
      },
    },
  },
  {
    id: 'invest-ext-v2-fixed-offset-retention',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only this complete, fictional source pack; no network or unstated product knowledge is needed.

[T1: schedule registry]
fixed-edge uses UTC+05:30 year-round. seasonal-edge uses a seasonally changing offset. Both use a strict cutoff: equality is retained, not deleted.
[T2: published run bulletin, local date 2025-03-03]
fixed-edge: runUtc 2025-03-02T19:00:00Z; cutoffUtc 2025-02-28T19:00:00Z.
seasonal-edge: runUtc 2025-03-02T18:00:00Z; cutoffUtc 2025-02-28T18:00:00Z.
[T3: fixed-edge audited record dispositions]
a: before cutoff; deleted.
b: exactly at cutoff; retained.
c: after cutoff; retained.
d: after cutoff; retained.
[T4: archived operator note]
An earlier note described cutoff equality as deleted. The schedule registry supersedes that note. T2's timestamps are the authoritative published UTC values and require no timezone conversion.
The deployment uses a fixed offset without daylight saving. What run, cutoff and deleted-id facts are documented for its March 3 local run? Return JSON keys runUtc,cutoffUtc,deleted; use the published ISO timestamps and alphabetic ids.`,
    check: {
      kind: 'json_equal',
      value: {
        "runUtc": "2025-03-02T19:00:00Z",
        "cutoffUtc": "2025-02-28T19:00:00Z",
        "deleted": [
          "a"
        ]
      },
    },
  },
  {
    id: 'invest-ext-v2-billing-rounding-boundaries',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only this complete, fictional source pack; no network or unstated product knowledge is needed.

[B1: published accounting terminology]
Original bytes are informational. The finalized file journal records charge units after compression and metadata accounting. Gross batch units are before discounts; billed batch units are after discounts. Neither estimated units nor archived estimates are invoice evidence.
[B2: batch attachment index]
compressed-with-metadata: journal j17.
compressed-without-metadata: journal j18.
uncompressed: archived estimate j09.
The customer enabled compression and metadata accounting.
[B3: finalized journal j17]
file a: units 1. file b: units 2. file c: units 0. file d: units 3.
batch gross units: 6. batch billed units: 5.
[B4: finalized journal j18]
file a: units 1. file b: units 1. file c: units 0. file d: units 2.
batch gross units: 4. batch billed units: 4.
[B5: archived estimate j09]
file a: estimated units 4. file b: estimated units 2. file c: estimated units 0. file d: estimated units 5.
Batch estimate: 11. This is not a finalized journal.
Which charge facts does the applicable finalized journal document? Return JSON keys units,preDiscount,billed; units has keys a,b,c,d. Extract reported units rather than calculating a bill.`,
    check: {
      kind: 'json_equal',
      value: {
        "units": {
          "a": 1,
          "b": 2,
          "c": 0,
          "d": 3
        },
        "preDiscount": 6,
        "billed": 5
      },
    },
  },
  {
    id: 'invest-ext-v2-flag-precedence-changelog',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only this complete, fictional source pack; no network or unstated product knowledge is needed.

[F1: CLI 1.x]
Repeated --target flags accumulate. TARGET environment supplies the default target. Config is ignored if TARGET exists.
[F2: CLI 2.0 changelog]
--target is now scalar; last flag wins. Resolution is CLI > environment > config > builtin. Empty environment values are treated as unset. Builtin target is local. An omitted config key is unset. This supersedes F1.
[F3: CLI 2.1 erratum]
No behavior change to target resolution. --append-target is a separate accumulating flag, never implied by --target.
[F4: invocations all on 2.1]
a: config target=dev, TARGET="", no CLI flags.
b: config target=dev, TARGET=stage, --target canary --target prod.
c: no config target, TARGET="", no CLI flags.
d: config target=dev, TARGET=stage, no CLI flags.
Return JSON keys a,b,c,d with each resolved scalar target.`,
    check: {
      kind: 'json_equal',
      value: {
        "a": "dev",
        "b": "prod",
        "c": "local",
        "d": "stage"
      },
    },
  },
  {
    id: 'invest-ext-v2-dedup-authority-not-recency',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only this complete, fictional source pack; no network or unstated product knowledge is needed.

[D1: published source scope]
Signed errata amend their named manual. A newer community note cannot amend an official manual. Withdrawn manuals are not current guidance; withdrawal does not silently reinstate community recommendations.
[D2: current official manual entries]
a manual revision 8: setting on.
b manual revision 3: setting small.
c manual revision 7: setting green.
[D3: signed errata]
a erratum revision 2, amending manual revision 8: setting off.
c erratum revision 1, amending manual revision 7: setting red.
c erratum revision 2, superseding c erratum revision 1: setting blue.
[D4: withdrawal notice]
b manual revision 5 had setting large. It was withdrawn; manual revision 3 remains current for b.
[D5: community posts]
a post revision 20 recommends on. b post revision 9 recommends medium. Neither post changes published guidance.
What settings do the current official documents, including their amendments and withdrawals, actually specify? Return JSON keys a,b,c. Investigate source scope and supersession, not a generic record-deduplication algorithm.`,
    check: {
      kind: 'json_equal',
      value: {
        "a": "off",
        "b": "small",
        "c": "blue"
      },
    },
  },
  {
    id: 'invest-ext-v2-durability-ack-levels',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only this complete, fictional source pack; no network or unstated product knowledge is needed.

[L1: write API]
ACK accepted means the leader put the write in volatile memory. ACK replicated means two replicas have it in volatile memory. ACK durable means at least two replicas have flushed it to disk. Only durable promises survival of simultaneous process restart. None of these ACKs guarantees that all read replicas can immediately see the write.
[L2: read API]
A read with minToken waits until that replica has applied the specified write token. A read without minToken may observe an older version. Reads never change write durability.
[L3: observations]
a: accepted ACK; plain read returns new value.
b: replicated ACK; minToken read returns new value.
c: durable ACK; plain read returns old value.
d: durable ACK; minToken read returns new value.
Which observations establish restart survival, and which establish that their particular read applied the token? For the latter, count only the explicit minToken guarantee, not incidental value equality. Return JSON keys survives,tokenApplied; alphabetic ids.`,
    check: {
      kind: 'json_equal',
      value: {
        "survives": [
          "c",
          "d"
        ],
        "tokenApplied": [
          "b",
          "d"
        ]
      },
    },
  },
  {
    id: 'invest-ext-v2-conflicting-limits-evidence',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only the supplied fictional source pack. Do not use the network.

[E1: official manual 1.8]
Payload maximum is 8 MiB. Applies only to version 1.x.
[E2: official manual 2.0]
Payload maximum is 16 MiB. Applies to version 2.x; edge mode not discussed.
[E3: signed erratum for 2.0]
In edge mode payload maximum remains 8 MiB. Standard mode retains E2's limit.
[E4: support reply]
We raised the limit to 32 MiB on our internal preview cluster; public availability date unspecified.
A customer runs public version 2.1 in edge mode and wants to send 12 MiB. Explain whether the provided evidence supports this, reconcile the apparent contradictions, and name what evidence would be needed before relying on 32 MiB.`,
    check: {
      kind: 'judged',
      rubric: "The answer rejects 12 MiB for public 2.1 edge mode because E3 imposes 8 MiB; explains E1 is scoped to 1.x, E2 is amended for edge by E3, and E4 covers only an internal preview. It does not claim 32 MiB is publicly available or invent dates. It asks for an authoritative public release/limit document explicitly covering 2.1 edge mode before relying on 32 MiB.",
      reference: "No: E3 limits edge mode to 8 MiB, so 12 MiB exceeds it. E1 covers 1.x, while E2 allows 16 MiB only outside the edge exception in E3. E4 concerns an internal preview, not this public deployment. A public version- and mode-specific release note or limit specification is required to support a 32 MiB assumption.",
    },
  },
  {
    id: 'invest-ext-v2-migration-documented-sequencing',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only the supplied fictional source pack. Do not use the network.

[G1: version 1.x client]
send(payload) resolves after local enqueue. stop() discards queued writes.
[G2: version 2.x client]
send(payload) resolves after server accepted ACK, which is not durable. flush({durable:true}) waits for durable ACKs for all writes already enqueued when flush starts. stop() still discards unsent writes.
[G3: migration bulletin]
Do not mix 1.x and 2.x clients in one process. Server accepts both formats independently. A 2.x client can connect only after credential format B is installed; format B also works with 1.x.
The investigation concerns the guarantees of these published APIs, not an upgrade plan. Which credential and process-compatibility restrictions does the bulletin state? What do the 1.x and 2.x acknowledgements establish, what writes does durable flush cover, and which missing 1.x guarantee prevents the documents from proving a lossless queued-write shutdown? Explain those documented boundaries without designing a migration or inventing APIs.`,
    check: {
      kind: 'judged',
      rubric: "The answer identifies credential B as required before 2.x connection and the prohibition on mixing clients in one process. It states 1.x send establishes only local enqueue and stop discards its queue; the provided 1.x APIs do not establish a durable drain. It states 2.x send proves accepted, not durable, and durable flush covers only writes already enqueued when flush starts. It distinguishes these factual guarantees and missing documentation without presenting an invented 1.x drain API or a migration design.",
      reference: "G3 requires credential B before 2.x connection and prohibits mixing 1.x and 2.x in one process; B remains compatible with 1.x. G1 send proves only local enqueue, while stop discards queued writes, so no documented 1.x durable-drain guarantee exists. G2 send proves server acceptance, not durability. Its durable flush covers the writes already enqueued at the instant it starts, not later submissions.",
    },
  },
  {
    id: 'invest-ext-v2-delivery-guarantee-scope',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only the supplied fictional source pack. Do not use the network.

[H1: queue docs]
Messages are redelivered if their ACK is not recorded. A handler can run more than once. Visibility timeout is 30 seconds.
[H2: dedup docs]
Producer token suppresses duplicate ENQUEUES for five minutes. It does not suppress redelivery of a previously enqueued message. Tokens are scoped to queue plus producer id.
[H3: handler trace]
Handler committed an external payment at t=4. Its ACK was lost. It ran again at t=35. Producer used the same token; both executions have the same message id.
[H4: payment API documentation]
The payment service, independently of the queue, honors a stable payment idempotency key across retries and returns the original committed result for that key. Queue tokens are not automatically forwarded as payment keys. Recording an ACK before the payment commits can lose the intended payment on a crash.
What do these documents say the producer token guarantees, and why does H3 not contradict that guarantee? Identify which documented layer owns repeated-payment suppression and which scope and timing boundaries apply. Report source-supported behavior; do not redesign the handler.`,
    check: {
      kind: 'judged',
      rubric: "The answer attributes H3's second execution to lost-ACK redelivery of the same message. It states H2 deduplicates enqueues only for five minutes in queue-plus-producer scope, not handler execution. It identifies H4's payment-service idempotency key as the documented repeated-payment suppression layer and notes queue tokens are not automatically payment keys. It states ACK-before-payment carries the documented crash-loss risk, without treating a queue token as an exactly-once payment guarantee.",
      reference: "H1 permits redelivery when the ACK is lost, so the same message can run twice without a duplicate enqueue. H2's token covers only enqueues for five minutes within a queue and producer id. H4 assigns repeated-payment suppression to the payment service's stable idempotency key, which is independent of the queue token. ACK before payment has the documented crash-loss risk.",
    },
  },
  {
    id: 'invest-ext-v2-benchmark-confounding-sources',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt: `Use only the supplied fictional source pack. Do not use the network.

[J1: report A]
Client v2 processed 100 requests sequentially on host X; p50 wall latency 40 ms. Cache disabled. Every response checked for exact correctness; 96 passed.
[J2: report B]
Client v3 processed 1000 requests at concurrency 50 on host Y; p50 wall latency 25 ms. Cache warmed. Only HTTP status checked; all were 200.
[J3: release note]
v3 changes pooling and enables caching by default. No claim about answer correctness.
A proposal claims v3 is 37.5% faster and more correct, citing J1-J3. Investigate what evidence those sources actually provide. Distinguish their observed latency and status facts from version-level causal or correctness claims, identify the source-to-source comparability gaps, and say whether any supplied source establishes a controlled comparison. Do not compute a speedup, design an experiment or recommend a rollout.`,
    check: {
      kind: 'judged',
      rubric: "The answer reports A's 40 ms and B's 25 ms observed p50 but does not attribute the difference causally to version. It identifies different hosts, concurrency, cache state, sample sizes and correctness criteria as comparability gaps. It states all HTTP 200 responses in B do not prove exact-answer correctness or justify comparing its status rate to A's 96 exact passes. It identifies J3 as a pooling/cache change note without a correctness claim and concludes no supplied source establishes a controlled version comparison. It does not prescribe an experiment or rollout.",
      reference: "J1 reports 40 ms p50 and 96 exact passes; J2 reports 25 ms p50 and all HTTP statuses 200, not exact-answer checks. Host, concurrency, cache state, sample size and correctness criteria differ, so these reports do not isolate a causal version effect or comparable correctness rate. J3 documents pooling and default caching changes but makes no correctness claim. No supplied source establishes a controlled comparison.",
    },
  },
  {
    id: 'invest-repo-v2-reverse-import-closure',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt: `This is the complete synthetic repository evidence for the question. There is no network and no hidden repository state.

Files and imports (all paths are repository-root relative):
src/app.ts: runtime imports src/api.ts, src/ui.ts
src/api.ts: runtime imports src/cache.ts; type-only imports src/schema.ts
src/ui.ts: runtime imports src/view.ts
src/view.ts: runtime imports src/cache.ts
src/cache.ts: runtime imports src/hash.ts
src/hash.ts: no imports
src/schema.ts: runtime imports src/hash.ts
src/unused.ts: runtime imports src/cache.ts
Rules: an affected module is the changed module or any module that transitively runtime-imports it. Type-only edges do not count. Include modules outside app's reachable graph. Change: src/hash.ts.
Return the affected paths as a JSON array sorted lexicographically.`,
    check: {
      kind: 'json_equal',
      value: [
        "src/api.ts",
        "src/app.ts",
        "src/cache.ts",
        "src/hash.ts",
        "src/schema.ts",
        "src/ui.ts",
        "src/unused.ts",
        "src/view.ts"
      ],
    },
  },
  {
    id: 'invest-repo-v2-conditional-export-order',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt: `This is the complete synthetic repository evidence for the question. There is no network and no hidden repository state.

packages/widget/package.json:
{"exports":{".":{"types":"./dist/index.d.ts","node":{"import":"./dist/node.mjs","require":"./dist/node.cjs"},"browser":"./dist/browser.mjs","default":"./dist/fallback.mjs"},"./debug":{"development":"./dist/debug.mjs","default":null}}}
Resolution rules: examine keys in insertion order. A condition key matches iff it is in the active set, except default always matches. For a matched object recurse; null blocks resolution. No implicit active conditions. Extension does not affect this algorithm.
Requests:
a: widget, active conditions [node,import,browser]
b: widget, active conditions [browser,import]
c: widget, active conditions [types,node,require]
d: widget/debug, active conditions [node,import]
e: widget/debug, active conditions [development,node,import]
Return JSON keys a,b,c,d,e. Values are manifest-relative target paths; use the string BLOCKED for null.`,
    check: {
      kind: 'json_equal',
      value: {
        "a": "./dist/node.mjs",
        "b": "./dist/browser.mjs",
        "c": "./dist/index.d.ts",
        "d": "BLOCKED",
        "e": "./dist/debug.mjs"
      },
    },
  },
  {
    id: 'invest-repo-v2-alias-child-replacement',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt: `This is the complete synthetic repository evidence for the question. There is no network and no hidden repository state.

tsconfig.base.json at root:
{"compilerOptions":{"baseUrl":".","paths":{"@core/*":["packages/core/src/*"],"@util/*":["packages/util/src/*"]}}}
apps/site/tsconfig.json:
{"extends":"../../tsconfig.base.json","compilerOptions":{"baseUrl":".","paths":{"@core/*":["src/core/*"]}}}
apps/site/src/core/a.ts
packages/core/src/a.ts
packages/util/src/b.ts
Rules for this exercise: child paths replaces the whole parent paths object, never merges; child baseUrl is relative to the child's directory. Expand a single * literally. Resolve only an exact .ts path after appending .ts. There is no package fallback.
From the site project resolve @core/a and @util/b. Return JSON keys core,util with root-relative paths or the string UNRESOLVED.`,
    check: {
      kind: 'json_equal',
      value: {
        "core": "apps/site/src/core/a.ts",
        "util": "UNRESOLVED"
      },
    },
  },
  {
    id: 'invest-repo-v2-workspace-membership-negation',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt: `This is the complete synthetic repository evidence for the question. There is no network and no hidden repository state.

Workspace patterns in order:
packages/*
services/**
!services/**/fixtures/**
!packages/internal
Every directory listed below has a package.json:
packages/api
packages/api/examples/demo
packages/internal
services/router
services/router/fixtures/tiny
services/router/fixtures/tiny/helper
services/jobs/worker
apps/site
Rules: * consumes exactly one path segment; ** consumes zero or more complete segments. A positive pattern adds matching directories; a negative pattern removes matching directories. Only directories with package.json are candidates. services/** includes services itself if present.
Return the workspace member paths as a JSON array sorted lexicographically.`,
    check: {
      kind: 'json_equal',
      value: [
        "packages/api",
        "services/jobs/worker",
        "services/router"
      ],
    },
  },
  {
    id: 'invest-repo-v2-last-owner-wins',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt: `This is the complete synthetic repository evidence for the question. There is no network and no hidden repository state.

Ownership patterns in order:
** @platform
/services/** @services
/services/router/** @routing
/services/router/generated/** @generator
/services/router/generated/schema.ts @schema @routing
Rules: a matching later rule replaces the entire earlier owner set. ** matches zero or more path segments; literal paths match exactly. Leading / anchors to repository root. All owners are literal strings.
Files:
services/router/src/run.ts
services/router/generated/client.ts
services/router/generated/schema.ts
apps/site/services/router/run.ts
Return JSON keys run,client,schema,nested with owner arrays in declaration order.`,
    check: {
      kind: 'json_equal',
      value: {
        "run": [
          "@routing"
        ],
        "client": [
          "@generator"
        ],
        "schema": [
          "@schema",
          "@routing"
        ],
        "nested": [
          "@platform"
        ]
      },
    },
  },
  {
    id: 'invest-repo-v2-test-inclusion-exclusion',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt: `This is the complete synthetic repository evidence for the question. There is no network and no hidden repository state.

Test include patterns:
src/**/*.test.ts
tests/**/*.spec.ts
Test exclude patterns:
**/fixtures/**
**/*.slow.test.ts
Files:
src/a.test.ts
src/lib/a.slow.test.ts
src/fixtures/parser.test.ts
tests/root.spec.ts
tests/fixtures/sample.spec.ts
src/lib/check.spec.ts
tests/deep/next.spec.ts
src/.cache/hidden.test.ts
Rules: select a file matching any include and no exclude. ** matches zero or more directories, including dot-prefixed directories. * does not cross /. Patterns match the whole path; there are no default exclusions.
Return selected paths as a JSON array sorted lexicographically.`,
    check: {
      kind: 'json_equal',
      value: [
        "src/.cache/hidden.test.ts",
        "src/a.test.ts",
        "tests/deep/next.spec.ts",
        "tests/root.spec.ts"
      ],
    },
  },
  {
    id: 'invest-repo-v2-lazy-import-startup-graph',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt: `This is the complete synthetic repository evidence for the question. There is no network and no hidden repository state.

Module graph:
src/main.ts: static imports src/api.ts, src/types.ts (type-only); registers but never calls a function containing dynamic import src/admin.ts.
src/api.ts: static imports src/store.ts; re-exports a runtime binding from src/metrics.ts.
src/store.ts: static imports src/shared.ts.
src/metrics.ts: static imports src/shared.ts.
src/admin.ts: static imports src/secret.ts.
src/types.ts: static imports src/validator.ts.
src/shared.ts, src/secret.ts, src/validator.ts: no imports.
Startup discovery follows static runtime imports and runtime re-exports only. It ignores type-only edges and uncalled dynamic imports. Include the entry module itself.
For entry src/main.ts return the startup module set as a JSON array sorted lexicographically.`,
    check: {
      kind: 'json_equal',
      value: [
        "src/api.ts",
        "src/main.ts",
        "src/metrics.ts",
        "src/shared.ts",
        "src/store.ts"
      ],
    },
  },
  {
    id: 'invest-repo-v2-transitive-test-impact',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt: `This is the complete synthetic repository evidence for the question. There is no network and no hidden repository state.

Dependencies (an arrow means the left file imports the right file):
a.test.ts -> app.ts
b.test.ts -> view.ts
c.test.ts -> unused.ts
d.test.ts -> parser.ts
app.ts -> parser.ts, view.ts
view.ts -> format.ts
parser.ts -> format.ts
format.ts -> parser.ts
unused.ts -> helper.ts
helper.ts -> no files
Changed file: format.ts.
A test is impacted iff its transitive dependency set contains the changed file. Visit cycles once; do not require direct imports. Do not select ordinary source files.
Return impacted test paths as a JSON array sorted lexicographically.`,
    check: {
      kind: 'json_equal',
      value: [
        "a.test.ts",
        "b.test.ts",
        "d.test.ts"
      ],
    },
  },
  {
    id: 'invest-repo-v2-importer-lockfile-provenance',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt: `This is the complete synthetic repository evidence for the question. There is no network and no hidden repository state.

package.json at root: {"devDependencies":{"codec":"^4.0.0"}}
packages/api/package.json: {"dependencies":{"codec":"^3.2.0"}}
Lockfile excerpt:
importers:
  .:
    devDependencies:
      codec: {specifier: ^4.0.0, version: 4.1.2}
  packages/api:
    dependencies:
      codec: {specifier: ^3.2.0, version: 3.3.1(peer@2.0.0)}
packages:
  codec@3.3.1: {checksum: old}
  codec@4.1.2: {checksum: new}
snapshots:
  codec@3.3.1(peer@2.0.0): {dependencies: {peer: 2.0.0}}
No overrides exist. For this exercise the importer version chooses the installed package version; parentheses encode peer context, not part of codec's version. Root dependency does not override the api importer.
What codec version is installed for packages/api? Reply only with the semantic version.`,
    check: {
      kind: 'exact',
      value: "3.3.1",
    },
  },
  {
    id: 'invest-repo-v2-migration-ledger-first-blocker',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt: `This is the complete synthetic repository evidence for the question. There is no network and no hidden repository state.

Migration files sorted by numeric prefix:
001_init.sql creates table users.
003_add_email.sql adds users.email.
004_index_email.sql creates an index on users.email.
006_add_status.sql adds users.status.
Applied ledger: [001_init.sql, 004_index_email.sql].
Runner policy: applied files are skipped. Before running anything, the ledger must be a PREFIX of the sorted migration list, with no gaps; violation aborts immediately and performs no SQL. Missing numeric filenames are legal; gaps in the applied prefix are not.
Return JSON keys valid,firstMissingBeforeApplied,wouldRun. firstMissingBeforeApplied is the first skipped required ledger predecessor, or null. wouldRun lists actual executions, not hypothetical pending files.`,
    check: {
      kind: 'json_equal',
      value: {
        "valid": false,
        "firstMissingBeforeApplied": "003_add_email.sql",
        "wouldRun": []
      },
    },
  },
  {
    id: 'invest-repo-v2-relative-resolution-shadow',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt: `This is the complete synthetic repository evidence for the question. There is no network and no hidden repository state.

Complete file tree:
src/main.ts
src/lib.ts
src/lib/index.ts
src/lib/parser.ts
src/lib/parser/index.ts
src/lib/parser.js
src/lib/parser.tsx
src/config/index.ts
src/config.json
Rule for an extensionless relative specifier: normalize against the importing file's directory, then try PATH.ts, PATH.js, PATH/index.ts in that exact order. Do not try .tsx, .json or any package main field. Explicit extensions require exact existing path.
Requests:
a: src/main.ts imports ./lib
b: src/lib/index.ts imports ./parser
c: src/main.ts imports ./config
d: src/lib/index.ts imports ./parser.tsx
e: src/main.ts imports ./config.json
Return JSON keys a,b,c,d,e with root-relative resolved paths.`,
    check: {
      kind: 'json_equal',
      value: {
        "a": "src/lib.ts",
        "b": "src/lib/parser.ts",
        "c": "src/config/index.ts",
        "d": "src/lib/parser.tsx",
        "e": "src/config.json"
      },
    },
  },
  {
    id: 'invest-repo-v2-symlink-walk-canonical-visits',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt: `This is the complete synthetic repository evidence for the question. There is no network and no hidden repository state.

Directory evidence:
root entries in visit order: a, alias, b.
a is a directory with one file a/x.ts and symlink a/back -> root.
alias is a symlink -> a.
b is a directory with file b/y.ts and symlink b/other -> a.
Walker rules: follow directory symlinks; mark each real directory path visited BEFORE descending. Never revisit a real directory. Root is marked visited at start. Traverse each directory's entries in the shown order (a: x.ts,back; b: y.ts,other). Output file paths using the traversal spelling, not canonical spelling. File symlinks do not exist here.
Return the emitted paths as a JSON array in traversal order.`,
    check: {
      kind: 'json_equal',
      value: [
        "a/x.ts",
        "b/y.ts"
      ],
    },
  },
  {
    id: 'invest-repo-v2-handwritten-symbol-origin',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt: `This is the complete synthetic repository evidence for the question. There is no network and no hidden repository state.

Search results for resolveToken:
src/index.ts: export {resolveToken as token} from './auth';
src/auth.ts: export {resolveToken} from './security/token';
src/security/token.ts: handwritten function declaration resolveToken.
src/security/generated.ts: generated function declaration resolveToken; not exported by auth.
tests/token.test.ts: local helper resolveToken, imports token from '../src/index'.
dist/auth.js: build output copied from src/security/token.ts.
README.txt: prose mentioning resolveToken.
The question is specifically the handwritten implementation reached by importing token from src/index.ts, not every text match. Each relative re-export resolves exactly to the indicated .ts file.
Reply only with the repository-relative implementation path.`,
    check: {
      kind: 'exact',
      value: "src/security/token.ts",
    },
  },
  {
    id: 'invest-repo-v2-config-cascade-array-replacement',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt: `This is the complete synthetic repository evidence for the question. There is no network and no hidden repository state.

Configuration evidence:
root config: {"targets":["api","web"],"limits":{"read":4,"write":9},"trace":false}
package config: {"targets":["worker"],"limits":{"read":7}}
environment patch: {"limits":{"write":0},"trace":true}
CLI patch: {"targets":[],"trace":false}
Resolution order is root, package, environment, CLI. Object keys recursively merge. Arrays and all scalars replace; empty arrays, zero and false are valid explicit values, not omissions. Omitted keys remain.
Return final JSON with keys targets,limits,trace; within limits use read,write.`,
    check: {
      kind: 'json_equal',
      value: {
        "targets": [],
        "limits": {
          "read": 7,
          "write": 0
        },
        "trace": false
      },
    },
  },
  {
    id: 'invest-repo-v2-type-only-barrel-boundary',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt: `This is the complete synthetic repository evidence for the question. There is no network and no hidden repository state.

File exports:
src/index.ts: export type {Record} from './record'; export {parse as decode} from './parser'; export * from './helpers'.
src/record.ts: exports type Record; exports runtime function makeRecord.
src/parser.ts: exports runtime functions parse and internalScan.
src/helpers.ts: exports runtime function normalize; exports type Options; has unexported runtime constant cache.
Rules: named export forwards only the named binding; export type forwards no runtime binding; export * forwards every exported binding except default, preserving type-only status. No other exports exist. Relative targets resolve to the shown .ts files.
List the runtime export names visible through src/index.ts, sorted alphabetically and comma-separated with no spaces.`,
    check: {
      kind: 'exact',
      value: "decode,normalize",
    },
  },
  {
    id: 'invest-repo-v2-patch-old-new-line-coordinates',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt: `This is the complete synthetic repository evidence for the question. There is no network and no hidden repository state.

A patch to file src/settings.ts contains these two non-overlapping hunks, in original-file coordinates:
Hunk A replaces old lines 4 through 6 inclusive with five new lines.
Hunk B deletes old lines 12 through 13 inclusive.
Original file has 20 lines. Original lines 8 and 16 are unchanged. Replacement content is not reused original content.
Map surviving original lines into the new file. Do not apply hunk B's old coordinates to the already shifted intermediate file.
Return JSON keys newLineOf8,newLineOf16,totalLines.`,
    check: {
      kind: 'json_equal',
      value: {
        "newLineOf8": 10,
        "newLineOf16": 16,
        "totalLines": 20
      },
    },
  },
  {
    id: 'invest-repo-v2-search-does-not-prove-dead-code',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: SYS_SYS,
    userPrompt: `Investigate only this complete synthetic repository evidence; no network is needed.

File tree: src/main.ts, src/plugins/report.ts, src/loader.ts, config/plugins.json, tests/report.test.ts.
Literal search for "makeReport" finds only its exported declaration in src/plugins/report.ts and its test import.
src/main.ts imports src/loader.ts.
src/loader.ts reads config/plugins.json and dynamically imports each configured module, then invokes the configured export name.
config/plugins.json contains {"module":"./plugins/report.ts","export":"make"}.
src/plugins/report.ts re-exports makeReport under the alias make.
Paths in plugins.json resolve relative to src, so this configured module is src/plugins/report.ts.
A cleanup proposal says makeReport is test-only and can be deleted because no production literal import names it. Explain the repository-supported conclusion, trace the production route, and identify why the original search was insufficient.`,
    check: {
      kind: 'judged',
      rubric: "The answer rejects the test-only/deletion conclusion and traces main -> loader -> config module report.ts -> export alias make -> makeReport. It explains literal searches miss configured dynamic import and alias references. It distinguishes the evidenced configured reachability from proof that every deployment invokes it, and does not invent deployment configuration or claim all dynamic exports are used.",
      reference: "makeReport has a configured production route: main imports loader, loader reads plugins.json, that config selects report.ts and export make, and make aliases makeReport. A literal search for makeReport misses the dynamic import and alias. This evidence contradicts test-only reachability, though actual deployment invocation would require runtime/config evidence.",
    },
  },
  {
    id: 'invest-repo-v2-build-artifact-provenance',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: SYS_SYS,
    userPrompt: `Investigate only this complete synthetic repository evidence; no network is needed.

src/math.ts declares revision="new".
dist/math.js declares revision="old".
package.json exports "." -> ./dist/math.js and script build -> node tools/build.mjs.
tools/build.mjs generates dist/math.js from src/math.ts.
apps/demo imports the package by its package name, not a source path.
The source and distribution declarations are from the same checkout; the build has not run since the source changed. No cache or resolver overrides exist in this evidence.
Trace the repository's source-to-artifact-to-consumer path. Which declaration is authoritative for generation, which file is selected by the demo's package-name import, and which documented script owns that artifact? Explain whether manually changing the generated declaration changes the generator's source of truth. Do not diagnose a failure or prescribe a repair.`,
    check: {
      kind: 'judged',
      rubric: "The answer traces src/math.ts through tools/build.mjs to dist/math.js, then package exports to apps/demo. It identifies src/math.ts as the generator's source of truth, dist/math.js as the consumed package export, and the build script running node tools/build.mjs as the artifact producer. It explains that manual distribution edits do not change source authority and are overwritten by subsequent generation. It does not invent a source-path resolver override or prescribe a bug fix.",
      reference: "src/math.ts is the generation source. The documented build script invokes node tools/build.mjs to produce dist/math.js. package.json exports that distribution file, so apps/demo's package-name import consumes its declaration rather than the source declaration. A manual distribution edit changes the current artifact only, not the generation source, and a later build overwrites it.",
    },
  },
  {
    id: 'invest-repo-v2-cache-key-input-omission',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: SYS_SYS,
    userPrompt: `Investigate only this complete synthetic repository evidence; no network is needed.

Repository task graph:
packages/schema/spec.json -> packages/schema/tools/generate.mjs -> packages/schema/generated/types.ts
packages/api/src/client.ts imports packages/schema/generated/types.ts (resolved repository-root path).
Build task api:build dependsOn schema:generate.
Cache key for schema:generate hashes only tools/generate.mjs, not spec.json.
Cache key for api:build hashes src/** and the dependency task's cache key, not generated files.
The investigation is a map of task inputs and cache provenance. No output artifact corruption is observed.
Which files are semantic inputs to schema generation, which are represented in schema:generate's recorded cache key, and how does api:build represent its dependency? Trace whether a spec-only edit is visible to either recorded key, distinguishing execution ordering from input tracking. Describe the existing repository mechanism only; do not propose cache changes or diagnose a failed build.`,
    check: {
      kind: 'judged',
      rubric: "The answer identifies spec.json and tools/generate.mjs as semantic generation inputs but only tools/generate.mjs as hashed by schema:generate. It identifies api:build's source hash plus dependency task key rather than a direct generated-file hash. It traces that a spec-only edit changes neither recorded key because spec.json is absent from the first key and the dependency key remains unchanged. It distinguishes dependsOn ordering from cache-input representation without proposing changes.",
      reference: "schema generation consumes both spec.json and tools/generate.mjs, but its recorded key hashes only the generator script. api:build hashes its own src files and schema:generate's task key, not generated/types.ts directly. A spec-only edit is absent from the schema key and therefore from the unchanged dependency key used by api. dependsOn expresses execution ordering, not an additional file-input hash.",
    },
  },
  {
    id: 'invest-repo-v2-dependency-boundary-evidence',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: SYS_SYS,
    userPrompt: `Investigate only this complete synthetic repository evidence; no network is needed.

Workspace packages: ui, domain, storage.
Declared runtime imports:
ui/screen.ts -> domain/usecase.ts
domain/usecase.ts -> storage/sql.ts
storage/sql.ts -> ui/toast.ts
ui/toast.ts -> no imports
Package rule: ui may depend on domain; domain may depend on storage; storage must not depend on ui or domain. Package dependencies count any runtime import across package boundaries, regardless of whether the individual module graph cycles.
A reviewer says there is no cycle because toast does not import screen, so no architecture issue exists.
Explain the exact module-versus-package distinction, the violating edge, and one minimal boundary-preserving replacement that keeps failure reporting visible.`,
    check: {
      kind: 'judged',
      rubric: "The answer notes the shown module graph is acyclic but the package graph has ui -> domain -> storage -> ui. It identifies storage/sql.ts -> ui/toast.ts as the forbidden dependency under the stated rule. It proposes storage returning/throwing a structured failure that domain/UI handle, or injecting a neutral reporting callback/port without a storage import of UI, preserving visible failure reporting. It does not propose deleting reporting or deny the package cycle.",
      reference: "The module chain ends at toast, so those specific modules form no cycle. Collapsing by package gives ui -> domain -> storage -> ui, and storage/sql.ts importing ui/toast.ts violates the declared boundary. Remove that import and return/throw a structured failure for upper layers to present, or accept a neutral reporting port supplied from above; keep the UI notification without making storage depend on UI.",
    },
  },
];
