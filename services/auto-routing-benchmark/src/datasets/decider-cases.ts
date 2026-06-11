import type { ClassifierTaskType, DifficultyTier } from '@kilocode/auto-routing-contracts';
import type { DeciderCheck } from '../grading';

export type DeciderCase = {
  id: string;
  tier: DifficultyTier;
  taskType: ClassifierTaskType;
  systemPrompt: string;
  userPrompt: string;
  // Retained as metadata only. The decider now runs cases through the kilo CLI
  // (no chat-completions maxTokens knob), so this field is no longer consumed.
  maxTokens: number;
  check: DeciderCheck;
};

const CODE_SYS =
  'You are a precise coding assistant. Answer with only what is asked, no explanations.';
const SYS_SYS =
  'You are a precise systems engineer. Answer with only what is asked, no explanations.';

// Golden answers below were each worked through by hand. Every case has a
// single unambiguous, mechanically-checkable answer. Checks tolerate
// formatting noise (fences/case/whitespace) but never wrong values. For
// json_equal cases the prompt pins the exact key set in the same order as the
// expected value (the comparison is JSON.stringify-based and order-sensitive).
export const DECIDER_CASES: readonly DeciderCase[] = [
  // ---------------- LOW (mechanical lookups / trivial evaluation) ----------------
  {
    id: 'low-impl-array-pipeline',
    tier: 'low',
    taskType: 'implementation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this JavaScript print? Answer with the exact output line only.\n\nconst xs = [1, 2, 3, 4].filter(x => x % 2 === 0).map(x => x * 10);\nconsole.log(xs.join("-"));',
    maxTokens: 512,
    check: { kind: 'exact', value: '20-40' },
  },
  {
    id: 'low-impl-sort-numeric',
    tier: 'low',
    taskType: 'implementation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this JavaScript print? Answer with the exact output line only.\n\nconsole.log([5, 3, 8, 1].sort((a, b) => a - b).join(","));',
    maxTokens: 512,
    check: { kind: 'exact', value: '1,3,5,8' },
  },
  {
    id: 'low-impl-string-upper',
    tier: 'low',
    taskType: 'implementation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this JavaScript print? Answer with the exact output line only.\n\nconsole.log("hello".toUpperCase());',
    maxTokens: 512,
    check: { kind: 'exact', value: 'HELLO' },
  },
  {
    id: 'low-impl-ternary-parity',
    tier: 'low',
    taskType: 'implementation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this JavaScript print? Answer with the exact output line only.\n\nconst n = 7;\nconsole.log(n % 2 === 0 ? "even" : "odd");',
    maxTokens: 512,
    check: { kind: 'exact', value: 'odd' },
  },
  {
    id: 'low-debug-compound-assign',
    tier: 'low',
    taskType: 'debugging',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What is the final value printed? Answer with only the number.\n\nlet x = 10;\nx += 5;\nx *= 2;\nconsole.log(x);',
    maxTokens: 512,
    check: { kind: 'exact', value: '30' },
  },
  {
    id: 'low-debug-parseint-suffix',
    tier: 'low',
    taskType: 'debugging',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this JavaScript print? Answer with only the number.\n\nconsole.log(parseInt("42px", 10));',
    maxTokens: 512,
    check: { kind: 'exact', value: '42' },
  },
  {
    id: 'low-investigation-char-count',
    tier: 'low',
    taskType: 'investigation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'How many times does the letter "a" appear in the word "banana"? Answer with only the number.',
    maxTokens: 512,
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'low-investigation-object-keys',
    tier: 'low',
    taskType: 'investigation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'How many own enumerable keys does this object have? Answer with only the number.\n\nconst o = { a: 1, b: 2, c: 3 };',
    maxTokens: 512,
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'low-planning-http-created',
    tier: 'low',
    taskType: 'planning_design',
    systemPrompt:
      'You are a precise web API expert. Answer with only what is asked, no explanations.',
    userPrompt:
      'Which standard HTTP status code indicates that a new resource was successfully created? Answer with only the 3-digit number.',
    maxTokens: 512,
    check: { kind: 'exact', value: '201' },
  },
  {
    id: 'low-refactoring-reduce-sum',
    tier: 'low',
    taskType: 'refactoring',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A loop sums an array. What value does it produce? Answer with only the number.\n\nlet total = 0;\nfor (const n of [4, 4, 4]) total += n;\nconsole.log(total);',
    maxTokens: 512,
    check: { kind: 'exact', value: '12' },
  },

  // ---------------- MEDIUM (multi-step reasoning, off-by-one, spec application) -------------
  {
    id: 'medium-debug-off-by-one',
    tier: 'medium',
    taskType: 'debugging',
    systemPrompt: CODE_SYS,
    userPrompt:
      'This binary search has a bug. Reply with JSON {"line": <1-based line number of the buggy line>, "fix": "<the corrected line with leading whitespace removed>"}.\n\n1: function bsearch(a, t) {\n2:   let lo = 0, hi = a.length;\n3:   while (lo < hi) {\n4:     const mid = (lo + hi) >> 1;\n5:     if (a[mid] === t) return mid;\n6:     if (a[mid] < t) lo = mid;\n7:     else hi = mid;\n8:   }\n9:   return -1;\n10: }',
    maxTokens: 2048,
    check: { kind: 'json_equal', value: { line: 6, fix: 'if (a[mid] < t) lo = mid + 1;' } },
  },
  {
    id: 'medium-impl-reduce-trace',
    tier: 'medium',
    taskType: 'implementation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this print? Answer with only the number.\n\nconst r = [1, 2, 3, 4].reduce((acc, x) => acc + x * x, 0);\nconsole.log(r);',
    maxTokens: 2048,
    check: { kind: 'exact', value: '30' },
  },
  {
    id: 'medium-impl-closure-counter',
    tier: 'medium',
    taskType: 'implementation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What is the final printed value? Answer with only the number.\n\nfunction make() {\n  let c = 0;\n  return () => ++c;\n}\nconst f = make();\nf();\nf();\nconsole.log(f());',
    maxTokens: 2048,
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'medium-debug-async-order',
    tier: 'medium',
    taskType: 'debugging',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this program print, in order? Answer with the four uppercase letters joined by commas, e.g. "A,B,C,D".\n\nconsole.log("A");\nPromise.resolve().then(() => console.log("B"));\nsetTimeout(() => console.log("C"), 0);\nconsole.log("D");',
    maxTokens: 2048,
    check: { kind: 'regex', pattern: '^\\s*A\\s*,\\s*D\\s*,\\s*B\\s*,\\s*C\\s*$', flags: 'im' },
  },
  {
    id: 'medium-impl-map-set-dedup',
    tier: 'medium',
    taskType: 'implementation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What is the size of the resulting Set? Answer with only the number.\n\nconst s = new Set([1, 2, 2, 3, 3, 3, 4]);\nconsole.log(s.size);',
    maxTokens: 2048,
    check: { kind: 'exact', value: '4' },
  },
  {
    id: 'medium-investigation-regex-groups',
    tier: 'medium',
    taskType: 'investigation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Given the regex /(\\d{4})-(\\d{2})-(\\d{2})/ applied to "2026-06-11", what is capture group 2? Answer with only the value.',
    maxTokens: 2048,
    check: { kind: 'exact', value: '06' },
  },
  {
    id: 'medium-impl-recursion-fib',
    tier: 'medium',
    taskType: 'implementation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'This computes a Fibonacci-like sequence where f(0)=0, f(1)=1, f(n)=f(n-1)+f(n-2). What is f(7)? Answer with only the number.',
    maxTokens: 2048,
    check: { kind: 'exact', value: '13' },
  },
  {
    id: 'medium-debug-mutation-shared-ref',
    tier: 'medium',
    taskType: 'debugging',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this print? Answer with only the number.\n\nconst a = [1, 2, 3];\nconst b = a;\nb.push(4);\nconsole.log(a.length);',
    maxTokens: 2048,
    check: { kind: 'exact', value: '4' },
  },
  {
    id: 'medium-planning-rate-limit-window',
    tier: 'medium',
    taskType: 'planning_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A fixed-window rate limiter allows 100 requests per 60-second window. A client sends 80 requests in the first 30 seconds of a window, then 40 more requests in the next 20 seconds (same window). How many of the 40 later requests are rejected? Answer with only the number.',
    maxTokens: 2048,
    check: { kind: 'exact', value: '20' },
  },
  {
    id: 'medium-refactoring-equivalent-output',
    tier: 'medium',
    taskType: 'refactoring',
    systemPrompt: CODE_SYS,
    userPrompt:
      'After refactoring, both versions must produce the same output. What number does this print? Answer with only the number.\n\nconst nums = [10, 20, 30];\nconst doubled = nums.map(n => n * 2);\nconsole.log(doubled[1]);',
    maxTokens: 2048,
    check: { kind: 'exact', value: '40' },
  },

  // ---------------- HIGH (deep multi-constraint reasoning, subtle semantics) -------------
  {
    id: 'high-investigation-queue-trace',
    tier: 'high',
    taskType: 'investigation',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Three workers process a queue with at-least-once delivery. Worker A reads job 7 at t=0ms and crashes at t=50ms before ack. Visibility timeout is 30ms. Worker B receives job 7 at t=35ms, processes it in 40ms and acks. Worker C receives job 7 at t=80ms (redelivery triggered by the crash recovery scan at t=70ms) and processes it in 10ms, acking at t=90ms. The job inserts a row keyed by an idempotency key with ON CONFLICT DO NOTHING. How many rows exist at t=100ms, and which worker\'s insert won? Reply with JSON {"rows": <number>, "winner": "<A|B|C>"}.',
    maxTokens: 4096,
    check: { kind: 'json_equal', value: { rows: 1, winner: 'B' } },
  },
  {
    id: 'high-debug-closure-loop-var',
    tier: 'high',
    taskType: 'debugging',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this print? Answer with the three numbers joined by commas, e.g. "1,2,3".\n\nconst fns = [];\nfor (var i = 0; i < 3; i++) {\n  fns.push(() => i);\n}\nconsole.log(fns[0]() + "," + fns[1]() + "," + fns[2]());',
    maxTokens: 4096,
    check: { kind: 'regex', pattern: '^\\s*3\\s*,\\s*3\\s*,\\s*3\\s*$', flags: 'm' },
  },
  {
    id: 'high-debug-closure-let-var',
    tier: 'high',
    taskType: 'debugging',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this print? Answer with the three numbers joined by commas, e.g. "1,2,3".\n\nconst fns = [];\nfor (let i = 0; i < 3; i++) {\n  fns.push(() => i);\n}\nconsole.log(fns[0]() + "," + fns[1]() + "," + fns[2]());',
    maxTokens: 4096,
    check: { kind: 'regex', pattern: '^\\s*0\\s*,\\s*1\\s*,\\s*2\\s*$', flags: 'm' },
  },
  {
    id: 'high-impl-this-binding',
    tier: 'high',
    taskType: 'implementation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this print? Answer with only the number.\n\nconst obj = {\n  v: 10,\n  get() {\n    return [1, 2].map(function () {\n      return this?.v ?? 0;\n    }).reduce((a, b) => a + b, 0);\n  },\n};\nconsole.log(obj.get());',
    maxTokens: 4096,
    check: { kind: 'exact', value: '0' },
  },
  {
    id: 'high-investigation-deadlock-order',
    tier: 'high',
    taskType: 'investigation',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Two threads acquire locks. Thread 1: lock A, then lock B. Thread 2: lock B, then lock A. Both hold the first lock and then block forever waiting for the second. To eliminate the deadlock by enforcing a global lock acquisition order (alphabetical: A before B), which single thread number must have its two lock acquisitions reordered? Answer with only the thread number.',
    maxTokens: 4096,
    check: { kind: 'exact', value: '2' },
  },
  {
    id: 'high-debug-float-equality',
    tier: 'high',
    taskType: 'debugging',
    systemPrompt: CODE_SYS,
    userPrompt:
      'In IEEE-754 double precision (JavaScript Number), does the expression (0.1 + 0.2 === 0.3) evaluate to true or false? Answer with only the lowercase word true or false.',
    maxTokens: 4096,
    check: { kind: 'exact', value: 'false' },
  },
  {
    id: 'high-investigation-txn-isolation',
    tier: 'high',
    taskType: 'investigation',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A counter row holds value 5. Under READ COMMITTED isolation, two concurrent transactions T1 and T2 each run: SELECT v FROM c; then UPDATE c SET v = (the value they read) + 1. Both read before either writes, T1 commits first, then T2 commits (last-write-wins, no row lock taken on the SELECT). What is the final value of v? Answer with only the number.',
    maxTokens: 4096,
    check: { kind: 'exact', value: '6' },
  },
  {
    id: 'high-impl-generator-trace',
    tier: 'high',
    taskType: 'implementation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this print? Answer with the values joined by commas, e.g. "1,2,3".\n\nfunction* g() {\n  yield 1;\n  yield* [2, 3];\n  yield 4;\n}\nconsole.log([...g()].join(","));',
    maxTokens: 4096,
    check: { kind: 'regex', pattern: '^\\s*1\\s*,\\s*2\\s*,\\s*3\\s*,\\s*4\\s*$', flags: 'm' },
  },
  {
    id: 'high-planning-cache-invalidation',
    tier: 'high',
    taskType: 'planning_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A write-through cache with TTL 60s. At t=0s key K is written (value 1, cached). At t=30s the database row for K is updated to value 2 by a process that bypasses the cache (does not invalidate it). At t=45s a reader requests K. At t=70s another reader requests K. The cache returns its entry if present and unexpired, otherwise reads the DB and caches. What value does the t=45s reader get, and what value does the t=70s reader get? Reply with JSON {"first": <number>, "second": <number>}.',
    maxTokens: 4096,
    check: { kind: 'json_equal', value: { first: 1, second: 2 } },
  },
  {
    id: 'high-refactoring-short-circuit',
    tier: 'high',
    taskType: 'refactoring',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this print? Answer with only the number.\n\nlet calls = 0;\nfunction side() {\n  calls++;\n  return 0;\n}\nconst result = side() || side() || 7;\nconsole.log(calls);',
    maxTokens: 4096,
    check: { kind: 'exact', value: '2' },
  },
];
