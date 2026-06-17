import type { ClassifierSubtaskType, ClassifierTaskType } from '@kilocode/auto-routing-contracts';
import type { DeciderCheck } from '../grading';

export type DeciderCase = {
  id: string; // stable slug, e.g. 'impl-gen-squares-array' (<taskType>-<subtype>-<topic>)
  taskType: ClassifierTaskType;
  subtaskType: ClassifierSubtaskType;
  systemPrompt: string;
  userPrompt: string;
  check: DeciderCheck;
};

const CODE_SYS =
  'You are a precise coding assistant. Answer with only what is asked, no explanations.';
const SYS_SYS =
  'You are a precise systems engineer. Answer with only what is asked, no explanations.';
const AGENT_SYS =
  'You are a precise coding agent with file and terminal tools available. Complete the task exactly as specified, then answer with only what is asked, no explanations.';

// Golden answers below were each worked through by hand (and re-verified
// mechanically where a snippet could be executed). Every case has a single
// unambiguous, mechanically-checkable answer. Checks tolerate formatting
// noise (fences/case/whitespace) but never wrong values. For json_equal cases
// the prompt pins the exact key set in the same order as the expected value
// (the comparison is JSON.stringify-based and order-sensitive). Each case
// agentic_execution cases are self-contained tasks performed with file/terminal
// tools inside the benchmark container (node:22-slim, no repo, no network) and
// every command involved is deterministic there.
export const DECIDER_CASES: readonly DeciderCase[] = [
  // ---------------------------------------------------------------------------
  // implementation / feature_development
  // ---------------------------------------------------------------------------
  {
    id: 'impl-feat-ternary-parity',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this JavaScript print? Answer with the exact output line only.\n\nconst n = 7;\nconsole.log(n % 2 === 0 ? "even" : "odd");',
    check: { kind: 'exact', value: 'odd' },
  },
  {
    id: 'impl-feat-array-pipeline',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this JavaScript print? Answer with the exact output line only.\n\nconst xs = [1, 2, 3, 4].filter(x => x % 2 === 0).map(x => x * 10);\nconsole.log(xs.join("-"));',
    check: { kind: 'exact', value: '20-40' },
  },
  {
    id: 'impl-feat-closure-counter',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What is the final printed value? Answer with only the number.\n\nfunction make() {\n  let c = 0;\n  return () => ++c;\n}\nconst f = make();\nf();\nf();\nconsole.log(f());',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'impl-feat-recursion-fib',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt:
      'This computes a Fibonacci-like sequence where f(0)=0, f(1)=1, f(n)=f(n-1)+f(n-2). What is f(7)? Answer with only the number.',
    check: { kind: 'exact', value: '13' },
  },
  {
    id: 'impl-feat-this-binding',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this print? Answer with only the number.\n\nconst obj = {\n  v: 10,\n  get() {\n    return [1, 2].map(function () {\n      return this?.v ?? 0;\n    }).reduce((a, b) => a + b, 0);\n  },\n};\nconsole.log(obj.get());',
    check: { kind: 'exact', value: '0' },
  },

  // ---------------------------------------------------------------------------
  // implementation / code_generation
  // ---------------------------------------------------------------------------
  {
    id: 'impl-gen-package-manifest',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Generate a minimal package manifest. Reply with only a JSON object with exactly the keys "name" and "version" in that order, where name is "demo-app" and version is "1.2.3".',
    check: { kind: 'json_equal', value: { name: 'demo-app', version: '1.2.3' } },
  },
  {
    id: 'impl-gen-squares-array',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Generate a test fixture: a JSON array containing the squares of the integers 1 through 6, in increasing order. Reply with only the JSON array.',
    check: { kind: 'json_equal', value: [1, 4, 9, 16, 25, 36] },
  },
  {
    id: 'impl-gen-no-consecutive-ones',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Generate a test fixture: a JSON array of all binary strings of length 3 that contain no two consecutive 1s, in lexicographic order, each string as a JSON string. Reply with only the JSON array.',
    check: { kind: 'json_equal', value: ['000', '001', '010', '100', '101'] },
  },
  {
    id: 'impl-gen-two-ones-strings',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Generate a test fixture. Reply with only a JSON object with exactly the keys "count" and "strings" in that order, where strings is the JSON array of all binary strings of length 4 containing exactly two 1s, in lexicographic order, each as a JSON string, and count is the length of that array.',
    check: {
      kind: 'json_equal',
      value: { count: 6, strings: ['0011', '0101', '0110', '1001', '1010', '1100'] },
    },
  },

  // ---------------------------------------------------------------------------
  // implementation / test_creation
  // ---------------------------------------------------------------------------
  {
    id: 'impl-test-sort-expectation',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'You are writing a unit test. What value makes this assertion pass? Answer with the exact string only.\n\nexpect([5, 3, 8, 1].sort((a, b) => a - b).join(",")).toBe(?)',
    check: { kind: 'exact', value: '1,3,5,8' },
  },
  {
    id: 'impl-test-upper-expectation',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'You are writing a unit test. What value makes this assertion pass? Answer with the exact string only.\n\nexpect("hello".toUpperCase()).toBe(?)',
    check: { kind: 'exact', value: 'HELLO' },
  },
  {
    id: 'impl-test-mock-call-count',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'You are writing a unit test with a mock:\n\nconst fn = vi.fn(x => x * 2);\nconst wrapped = x => fn(x) + fn(x);\nwrapped(3);\nwrapped(4);\nexpect(fn).toHaveBeenCalledTimes(?)\n\nWhat number makes the assertion pass? Answer with only the number.',
    check: { kind: 'exact', value: '4' },
  },
  {
    id: 'impl-test-trailing-zeros',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'You are adding a test for a function trailingZeros(n) that returns the number of trailing zero digits of n! (n factorial). What expected value should the test assert for trailingZeros(25)? Answer with only the number.',
    check: { kind: 'exact', value: '6' },
  },

  // ---------------------------------------------------------------------------
  // debugging / bug_fixing
  // ---------------------------------------------------------------------------
  {
    id: 'debug-fix-parseint-suffix',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this JavaScript print? Answer with only the number.\n\nconsole.log(parseInt("42px", 10));',
    check: { kind: 'exact', value: '42' },
  },
  {
    id: 'debug-fix-binary-search',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      'This binary search has a bug. Reply with JSON {"line": <1-based line number of the buggy line>, "fix": "<the corrected line with leading whitespace removed, keeping single spaces around operators>"}.\n\n1: function bsearch(a, t) {\n2:   let lo = 0, hi = a.length;\n3:   while (lo < hi) {\n4:     const mid = (lo + hi) >> 1;\n5:     if (a[mid] === t) return mid;\n6:     if (a[mid] < t) lo = mid;\n7:     else hi = mid;\n8:   }\n9:   return -1;\n10: }',
    check: { kind: 'json_equal', value: { line: 6, fix: 'if (a[mid] < t) lo = mid + 1;' } },
  },
  {
    // 'pages' rather than 'pagination' so the id never collides with the
    // classifier dataset's debug-fix-pagination-slice in shared telemetry.
    id: 'debug-fix-pages-slice',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      'This pagination helper is buggy: pages([1, 2, 3, 4, 5, 6, 7], 3) should return [[1,2,3],[4,5,6],[7]] but loses elements. Reply with JSON {"line": <1-based line number of the buggy line>, "fix": "<the corrected line with leading whitespace removed, keeping single spaces around operators>"}.\n\n1: function pages(xs, size) {\n2:   const out = [];\n3:   for (let i = 0; i < xs.length; i += size) {\n4:     out.push(xs.slice(i, size));\n5:   }\n6:   return out;\n7: }',
    check: { kind: 'json_equal', value: { line: 4, fix: 'out.push(xs.slice(i, i + size));' } },
  },
  {
    id: 'debug-fix-regex-lastindex',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A validator misbehaves on its second call because of a stateful regex bug. What does this print? Answer with only the two words printed, separated by a single space.\n\nconst re = /a/g;\nconsole.log(re.test("abc"), re.test("abc"));',
    check: { kind: 'exact', value: 'true false' },
  },

  // ---------------------------------------------------------------------------
  // debugging / test_repair
  // ---------------------------------------------------------------------------
  {
    id: 'debug-repair-compound-assign',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A unit test asserts that this program prints 25, and the test fails. The code is correct; the expectation is stale. What value should the updated test expect? Answer with only the number.\n\nlet x = 10;\nx += 5;\nx *= 2;\nconsole.log(x);',
    check: { kind: 'exact', value: '30' },
  },
  {
    id: 'debug-repair-date-format',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A snapshot test fails after a date-formatter fix. The formatter now emits dates as zero-padded YYYY-MM-DD. What exact string should the updated snapshot expect for June 1, 2026? Answer with only the date string.',
    check: { kind: 'exact', value: '2026-06-01' },
  },
  {
    id: 'debug-repair-entries-shape',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A test broke because a refactor changed a function to return Object.entries(obj) instead of obj. For obj = {a: 1, b: 2} (keys in that insertion order), what is the new return value? Reply with only that value as JSON (an array of [key, value] pairs in insertion order).',
    check: {
      kind: 'json_equal',
      value: [
        ['a', 1],
        ['b', 2],
      ],
    },
  },
  {
    id: 'debug-repair-float-sum',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A failing test asserts expect(0.1 + 0.2).toBe(0.3). The repair pins the actual IEEE-754 value. What does console.log(0.1 + 0.2) print in JavaScript? Answer with the exact printed number only.',
    check: { kind: 'exact', value: '0.30000000000000004' },
  },

  // ---------------------------------------------------------------------------
  // debugging / root_cause_analysis
  // ---------------------------------------------------------------------------
  {
    id: 'debug-rca-async-order',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this program print, in order? Answer with the four uppercase letters joined by commas, e.g. "A,B,C,D".\n\nconsole.log("A");\nPromise.resolve().then(() => console.log("B"));\nsetTimeout(() => console.log("C"), 0);\nconsole.log("D");',
    check: { kind: 'regex', pattern: '^\\s*A\\s*,\\s*D\\s*,\\s*B\\s*,\\s*C\\s*$', flags: 'im' },
  },
  {
    id: 'debug-rca-shared-ref',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this print? Answer with only the number.\n\nconst a = [1, 2, 3];\nconst b = a;\nb.push(4);\nconsole.log(a.length);',
    check: { kind: 'exact', value: '4' },
  },
  {
    id: 'debug-rca-closure-loop-var',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this print? Answer with the three numbers joined by commas, e.g. "1,2,3".\n\nconst fns = [];\nfor (var i = 0; i < 3; i++) {\n  fns.push(() => i);\n}\nconsole.log(fns[0]() + "," + fns[1]() + "," + fns[2]());',
    check: { kind: 'regex', pattern: '^\\s*3\\s*,\\s*3\\s*,\\s*3\\s*$', flags: 'm' },
  },
  {
    id: 'debug-rca-float-equality',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      'In IEEE-754 double precision (JavaScript Number), does the expression (0.1 + 0.2 === 0.3) evaluate to true or false? Answer with only the lowercase word true or false.',
    check: { kind: 'exact', value: 'false' },
  },

  // ---------------------------------------------------------------------------
  // refactoring / code_cleanup
  // ---------------------------------------------------------------------------
  {
    id: 'refactor-cleanup-loop-to-reduce',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A loop sums an array. What value does it produce? Answer with only the number.\n\nlet total = 0;\nfor (const n of [4, 4, 4]) total += n;\nconsole.log(total);',
    check: { kind: 'exact', value: '12' },
  },
  {
    id: 'refactor-cleanup-extract-helper',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Two branches both compute s.trim().toLowerCase(), so you extract a helper norm(s) that does exactly that. What does norm("  HeLLo ") return? Answer with the exact string only.',
    check: { kind: 'exact', value: 'hello' },
  },
  {
    id: 'refactor-cleanup-map-equivalent',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: CODE_SYS,
    userPrompt:
      'After refactoring, both versions must produce the same output. What number does this print? Answer with only the number.\n\nconst nums = [10, 20, 30];\nconst doubled = nums.map(n => n * 2);\nconsole.log(doubled[1]);',
    check: { kind: 'exact', value: '40' },
  },
  {
    id: 'refactor-cleanup-short-circuit',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this print? Answer with only the number.\n\nlet calls = 0;\nfunction side() {\n  calls++;\n  return 0;\n}\nconst result = side() || side() || 7;\nconsole.log(calls);',
    check: { kind: 'exact', value: '2' },
  },

  // ---------------------------------------------------------------------------
  // refactoring / architecture_improvement
  // ---------------------------------------------------------------------------
  {
    id: 'refactor-arch-import-updates',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Files x.ts, y.ts, and z.ts each contain exactly one import of helper.ts. helper.ts moves to a new directory, changing its import path. How many import statements must be updated? Answer with only the number.',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'refactor-arch-layer-depth',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: CODE_SYS,
    userPrompt:
      "Modules and their imports: app imports auth and billing; auth imports core; billing imports core; core imports nothing. In a layered architecture where a module's layer is 1 + the maximum layer of its imports, and core is layer 1, what layer is app? Answer with only the number.",
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'refactor-arch-interface-edges',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A module graph has edges A->B, A->C, B->D, C->D. To improve the architecture you introduce an interface module I: the edges B->D and C->D are removed and replaced by B->I, C->I, and I->D. How many edges does the new graph have? Answer with only the number.',
    check: { kind: 'exact', value: '5' },
  },
  {
    id: 'refactor-arch-cycle-cut',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A module graph has directed import edges A->B, B->C, C->A, B->D, D->B, D->E. You must make the graph acyclic by deleting the minimum number of import edges. Reply with JSON {"deleted": <minimum number of edges to delete>, "remaining": <number of edges left after deleting them>}.',
    check: { kind: 'json_equal', value: { deleted: 2, remaining: 4 } },
  },

  // ---------------------------------------------------------------------------
  // refactoring / migration
  // ---------------------------------------------------------------------------
  {
    id: 'refactor-migrate-substr-slice',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: CODE_SYS,
    userPrompt:
      'You are migrating code off the deprecated String.prototype.substr. The old call is "javascript".substr(4, 3). What string does the equivalent migrated call "javascript".slice(4, 7) return? Answer with the exact string only.',
    check: { kind: 'exact', value: 'scr' },
  },
  {
    id: 'refactor-migrate-promise-chain',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: CODE_SYS,
    userPrompt:
      'After migrating a callback API to promises, the code reads:\n\nPromise.resolve(2).then(x => x + 1).then(x => x * 10).then(x => console.log(x));\n\nWhat number does it print? Answer with only the number.',
    check: { kind: 'exact', value: '30' },
  },
  {
    id: 'refactor-migrate-strict-equality',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: CODE_SYS,
    userPrompt:
      'You are migrating a codebase from == to ===. How many of these four comparisons change their result after replacing == with ===?\n\n"1" == 1\nnull == undefined\n2 == 2\nNaN == NaN\n\nAnswer with only the number.',
    check: { kind: 'exact', value: '2' },
  },
  {
    id: 'refactor-migrate-var-to-let',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A loop variable was migrated from var to let. What does the migrated code print? Answer with the three numbers joined by commas, e.g. "1,2,3".\n\nconst fns = [];\nfor (let i = 0; i < 3; i++) {\n  fns.push(() => i);\n}\nconsole.log(fns[0]() + "," + fns[1]() + "," + fns[2]());',
    check: { kind: 'regex', pattern: '^\\s*0\\s*,\\s*1\\s*,\\s*2\\s*$', flags: 'm' },
  },

  // ---------------------------------------------------------------------------
  // planning_design / architecture_design
  // ---------------------------------------------------------------------------
  {
    id: 'plan-arch-three-layer',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'In a classic three-layer architecture with presentation, business, and data layers, which layer should contain the SQL queries? Answer with only one word: presentation, business, or data.',
    check: { kind: 'exact', value: 'data' },
  },
  {
    id: 'plan-arch-call-chain',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A service design has these synchronous call edges: gateway calls auth and orders; orders calls inventory and billing; billing calls ledger. Counting edges, how long is the longest call chain starting at gateway? Answer with only the number.',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'plan-arch-dependency-rules',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A layered design enforces these rules: ui may import only app; app may import domain and infra; infra may import domain; domain imports nothing. How many of these five proposed imports violate the rules?\n\nui -> app\nui -> domain\napp -> domain\ninfra -> app\ndomain -> infra\n\nAnswer with only the number.',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'plan-arch-latency-budget',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A design must keep worst-case request latency within a 300 ms budget. The synchronous chain is gateway (10 ms) -> auth (40 ms) -> service (120 ms) -> db (90 ms), and in the worst case the db call is retried once (the db is called twice; all other components run once). Reply with JSON {"totalMs": <worst-case total latency in ms>, "withinBudget": <true|false>}.',
    check: { kind: 'json_equal', value: { totalMs: 350, withinBudget: false } },
  },

  // ---------------------------------------------------------------------------
  // planning_design / technical_planning
  // ---------------------------------------------------------------------------
  {
    id: 'plan-steps-rollout-order',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A rollout plan has four steps in strict sequence: write code, code review, deploy to staging, deploy to production. Which step is third? Answer with only the exact step name.',
    check: { kind: 'exact', value: 'deploy to staging' },
  },
  {
    id: 'plan-steps-batch-count',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A data migration plan processes 1000 records in batches of up to 80 records, one batch per run. How many runs does the plan need to process all records? Answer with only the number.',
    check: { kind: 'exact', value: '13' },
  },
  {
    id: 'plan-steps-deploy-waves',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Services A, B, C, D deploy in waves: a service can only deploy after all its dependencies are deployed, and any number of services can share a wave. Dependencies: B needs A; C needs A; D needs B and C. Reply with JSON {"waves": <minimum number of waves>, "dWave": <1-based wave in which D deploys>}.',
    check: { kind: 'json_equal', value: { waves: 3, dWave: 3 } },
  },
  {
    id: 'plan-steps-critical-path',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A plan has tasks with durations in days and dependencies: A (3 days) has no dependencies; B (2 days) starts after A; C (4 days) starts after A; D (1 day) starts after both B and C; E (2 days) starts after D. With unlimited parallelism, what is the minimum number of days to finish all tasks? Answer with only the number.',
    check: { kind: 'exact', value: '10' },
  },

  // ---------------------------------------------------------------------------
  // planning_design / system_design
  // ---------------------------------------------------------------------------
  {
    id: 'plan-system-write-quorum',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A system replicates each write to 3 nodes and requires a majority quorum of acknowledgements before confirming the write. How many node acknowledgements are required? Answer with only the number.',
    check: { kind: 'exact', value: '2' },
  },
  {
    id: 'plan-system-rate-limit-window',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A fixed-window rate limiter allows 100 requests per 60-second window. A client sends 80 requests in the first 30 seconds of a window, then 40 more requests in the next 20 seconds (same window). How many of the 40 later requests are rejected? Answer with only the number.',
    check: { kind: 'exact', value: '20' },
  },
  {
    id: 'plan-system-replica-availability',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A service is available when at least one of its two independent replicas is up. Each replica is up 90% of the time, independently. What is the service availability as a percentage? Answer with only the number.',
    check: { kind: 'exact', value: '99' },
  },
  {
    id: 'plan-system-cache-staleness',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A write-through cache with TTL 60s. At t=0s key K is written (value 1, cached). At t=30s the database row for K is updated to value 2 by a process that bypasses the cache (does not invalidate it). At t=45s a reader requests K. At t=70s another reader requests K. The cache returns its entry if present and unexpired, otherwise reads the DB and caches. What value does the t=45s reader get, and what value does the t=70s reader get? Reply with JSON {"first": <number>, "second": <number>}.',
    check: { kind: 'json_equal', value: { first: 1, second: 2 } },
  },
  {
    id: 'plan-system-queue-trace',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Three workers process a queue with at-least-once delivery. Worker A reads job 7 at t=0ms and crashes at t=50ms, before performing the insert and before ack. Visibility timeout is 30ms. Worker B receives job 7 at t=35ms, processes it in 40ms and acks. Worker C receives job 7 at t=80ms (redelivery triggered by the crash recovery scan at t=70ms) and processes it in 10ms, acking at t=90ms. The job inserts a row keyed by an idempotency key with ON CONFLICT DO NOTHING. How many rows exist at t=100ms, and which worker\'s insert won? Reply with JSON {"rows": <number>, "winner": "<A|B|C>"}.',
    check: { kind: 'json_equal', value: { rows: 1, winner: 'B' } },
  },
  {
    id: 'plan-system-deadlock-order',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Two threads acquire locks. Thread 1: lock A, then lock B. Thread 2: lock B, then lock A. Both hold the first lock and then block forever waiting for the second. To eliminate the deadlock by enforcing a global lock acquisition order (alphabetical: A before B), which single thread number must have its two lock acquisitions reordered? Answer with only the thread number.',
    check: { kind: 'exact', value: '2' },
  },
  {
    id: 'plan-system-txn-isolation',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A counter row holds value 5. Under READ COMMITTED isolation, two concurrent transactions T1 and T2 each run: SELECT v FROM c; then UPDATE c SET v = (the value they read) + 1. Both read before either writes, T1 commits first, then T2 commits (last-write-wins, no row lock taken on the SELECT). What is the final value of v? Answer with only the number.',
    check: { kind: 'exact', value: '6' },
  },

  // ---------------------------------------------------------------------------
  // investigation / repo_exploration
  // ---------------------------------------------------------------------------
  {
    id: 'invest-repo-test-file-count',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A repository listing shows these files:\n\nsrc/app.ts\nsrc/app.test.ts\nsrc/util.ts\nsrc/util.test.ts\nsrc/index.ts\nREADME.md\n\nHow many files end in .test.ts? Answer with only the number.',
    check: { kind: 'exact', value: '2' },
  },
  {
    id: 'invest-repo-glob-match',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Using a glob where ** matches zero or more directories, how many of these files match the pattern src/**/*.ts?\n\nsrc/a.ts\nsrc/lib/b.ts\nsrc/lib/deep/c.ts\ntest/d.ts\nsrc/e.tsx\n\nAnswer with only the number.',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'invest-repo-grep-case',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A file contains exactly these 5 lines:\n\nError: failed\nerror handled\nno problems\nERROR_CODE=7\nerrors: none\n\nHow many lines does a case-sensitive search for the string "error" match? Answer with only the number.',
    check: { kind: 'exact', value: '2' },
  },
  {
    id: 'invest-repo-gitignore',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A .gitignore contains exactly these rules in order:\n\n*.log\n!important.log\nlogs/\n\nUsing standard git semantics (a pattern without a slash matches at any depth, and a file cannot be re-included if a parent directory of it is excluded), how many of these files are ignored?\n\ndebug.log\nimportant.log\nlogs/important.log\nlogs/app.txt\nsrc/trace.log\n\nAnswer with only the number.',
    check: { kind: 'exact', value: '4' },
  },

  // ---------------------------------------------------------------------------
  // investigation / codebase_understanding
  // ---------------------------------------------------------------------------
  {
    id: 'invest-code-char-count',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt:
      'How many times does the letter "a" appear in the word "banana"? Answer with only the number.',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'invest-code-object-keys',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt:
      'How many own enumerable keys does this object have? Answer with only the number.\n\nconst o = { a: 1, b: 2, c: 3 };',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'invest-code-regex-groups',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Given the regex /(\\d{4})-(\\d{2})-(\\d{2})/ applied to "2026-06-11", what is capture group 2? Answer with only the value.',
    check: { kind: 'exact', value: '06' },
  },
  {
    id: 'invest-code-collatz-depth',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt:
      'You are reading unfamiliar code. What does f(6) return?\n\nfunction f(n) {\n  if (n <= 1) return n;\n  return n % 2 === 0 ? f(n / 2) + 1 : f(3 * n + 1);\n}\n\nAnswer with only the number.',
    check: { kind: 'exact', value: '7' },
  },

  // ---------------------------------------------------------------------------
  // investigation / external_research
  // ---------------------------------------------------------------------------
  {
    id: 'invest-ext-http-created',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt:
      'You are a precise web API expert. Answer with only what is asked, no explanations.',
    userPrompt:
      'Which standard HTTP status code indicates that a new resource was successfully created? Answer with only the 3-digit number.',
    check: { kind: 'exact', value: '201' },
  },
  {
    id: 'invest-ext-utf8-euro',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Per the UTF-8 encoding specification, how many bytes does the encoding of the euro sign (U+20AC) use? Answer with only the number.',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'invest-ext-semver-caret',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Per the npm semver range specification, consider the range ^1.4.2. Does it include version 1.5.0, and does it include version 2.0.0? Reply with JSON {"v150": <true|false>, "v200": <true|false>}.',
    check: { kind: 'json_equal', value: { v150: true, v200: false } },
  },
  {
    id: 'invest-ext-json-spec',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Per the JSON specification (RFC 8259), how many of these four documents are valid JSON?\n\n{"a": 01}\n{"a": 1,}\n{"a": .5}\n{"a": 1e2}\n\nAnswer with only the number.',
    check: { kind: 'exact', value: '1' },
  },

  // ---------------------------------------------------------------------------
  // agentic_execution / tool_usage
  // ---------------------------------------------------------------------------
  {
    id: 'agentic-tool-json-read',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Using your file tools, create a file /tmp/bench-kv.json containing exactly this JSON: {"alpha": 4, "beta": 9}. Then read the file back and answer with only the value of the key "beta".',
    check: { kind: 'exact', value: '9' },
  },
  {
    id: 'agentic-tool-notes-count',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create a directory /tmp/bench-notes containing exactly three files named one.txt, two.txt, and three.txt (any content). Then list the directory and answer with only the number of files it contains.',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'agentic-tool-log-grep',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create a file /tmp/bench-app.log containing exactly these 6 lines:\n\nINFO start\nERROR disk full\nINFO retry\nERROR timeout\nWARN slow\nERROR disk full\n\nThen search the file and answer with only the number of lines that contain the word ERROR.',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'agentic-tool-csv-filter-sum',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create a file /tmp/bench-data.csv containing exactly these 6 lines:\n\nid,qty\na,12\nb,7\ne,31\no,50\nk,9\n\nThen compute the sum of the qty column over only the rows whose id is a vowel (a, e, i, o, or u), and answer with only the number.',
    check: { kind: 'exact', value: '93' },
  },

  // ---------------------------------------------------------------------------
  // agentic_execution / terminal_operations
  // ---------------------------------------------------------------------------
  {
    id: 'agentic-term-node-major',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Run this command in the terminal and answer with only the number it prints:\n\nnode -e "console.log(process.versions.node.split(\'.\')[0])"',
    check: { kind: 'exact', value: '22' },
  },
  {
    id: 'agentic-term-wc-lines',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Using the terminal, write a file /tmp/bench-words.txt containing exactly these 5 lines:\n\nred\ngreen\nblue\ncyan\nplum\n\nThen run: wc -l < /tmp/bench-words.txt and answer with only the number it prints.',
    check: { kind: 'exact', value: '5' },
  },
  {
    id: 'agentic-term-sort-pipeline',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Run this pipeline in the terminal and answer with only the line it prints:\n\nprintf 'pear\\napple\\nbanana\\n' | sort | head -n 1",
    check: { kind: 'exact', value: 'apple' },
  },
  {
    id: 'agentic-term-sha256-prefix',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Run this command in the terminal and answer with only the 8 characters it prints:\n\nnode -e \"console.log(require('crypto').createHash('sha256').update('kilo-benchmark').digest('hex').slice(0, 8))\"",
    check: { kind: 'exact', value: 'fd99e6a4' },
  },

  // ---------------------------------------------------------------------------
  // agentic_execution / multi_step_execution
  // ---------------------------------------------------------------------------
  {
    id: 'agentic-multi-seq-sum',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create a file /tmp/bench-seq.txt containing the integers 1 through 10, one per line. Then use a terminal command to sum the lines and answer with only the sum.',
    check: { kind: 'exact', value: '55' },
  },
  {
    id: 'agentic-multi-node-script',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Write a file /tmp/bench-fib.js containing a Node.js script that computes f(12) for the sequence f(1) = 1, f(2) = 1, f(n) = f(n-1) + f(n-2), and prints the result. Run it with node and answer with only the number it prints.',
    check: { kind: 'exact', value: '144' },
  },
  {
    id: 'agentic-multi-find-count',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Create directories /tmp/bench-proj/src and /tmp/bench-proj/test. Create empty files /tmp/bench-proj/src/a.ts, /tmp/bench-proj/src/b.ts, and /tmp/bench-proj/test/a.test.ts. Then run:\n\nfind /tmp/bench-proj -name '*.ts' | wc -l\n\nand answer with only the number it prints.",
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'agentic-multi-json-transform',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create a file /tmp/bench-in.json containing exactly this JSON array: [3, 1, 4, 1, 5, 9, 2, 6, 5, 3]. Then write and run a Node.js script that reads the file, computes the sum of the distinct values in the array, and prints it. Answer with only the number.',
    check: { kind: 'exact', value: '30' },
  },
  // ---------------------------------------------------------------------------
  // Supplemental taxonomy-route coverage
  // ---------------------------------------------------------------------------
  {
    id: 'supp-impl-feat-clamp',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Implement mentally: clamp(14, 3, 9) returns min when low, max when high, otherwise value. Answer with only the returned number.',
    check: { kind: 'exact', value: '9' },
  },
  {
    id: 'supp-impl-feat-join-slugs',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What should slug(["Kilo", "Code", "Cloud"]) return if it lowercases words and joins them with hyphens? Answer only the return value.',
    check: { kind: 'exact', value: 'kilo-code-cloud' },
  },
  {
    id: 'supp-impl-code-nullish',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this print? Answer with only the output.\n\nconst x = null ?? "fallback";\nconsole.log(x);',
    check: { kind: 'exact', value: 'fallback' },
  },
  {
    id: 'supp-impl-code-set-size',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this JavaScript print? Answer only the number.\n\nconst s = new Set(["a", "b", "a", "c"]);\nconsole.log(s.size);',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'supp-impl-test-boundary-count',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A clamp(value, min, max) function needs tests for below min, at min, inside range, at max, and above max. How many cases is that? Answer only the number.',
    check: { kind: 'exact', value: '5' },
  },
  {
    id: 'supp-impl-test-error-case',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'For parsePort(input), which invalid input should a test include: "3000", "0", or "abc"? Answer only the invalid value.',
    check: { kind: 'exact', value: 'abc' },
  },
  {
    id: 'supp-debug-bug-off-by-one',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A loop uses i <= items.length and reads items[i]. What operator should replace <= to avoid reading past the end? Answer only the operator.',
    check: { kind: 'exact', value: '<' },
  },
  {
    id: 'supp-debug-bug-json-parse',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      'JSON.parse("{bad}") throws. Should the fix catch SyntaxError or TypeError? Answer only the error class.',
    check: { kind: 'exact', value: 'SyntaxError' },
  },
  {
    id: 'supp-debug-test-expected',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A function returns ["a", "b"]. The failing test expects ["b", "a"] but order is part of the contract. Which expected array is correct? Answer JSON only.',
    check: { kind: 'json_equal', value: ['a', 'b'] },
  },
  {
    id: 'supp-debug-test-timeout',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A test waits for text that appears after clicking Save, but it never clicks Save. What single action is missing? Answer only the verb.',
    check: { kind: 'exact', value: 'click' },
  },
  {
    id: 'supp-debug-root-cause-cache',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A value updates in the database but the page shows the old value until cache expiry. Which layer is the likely root cause: database, cache, or compiler? Answer one word.',
    check: { kind: 'exact', value: 'cache' },
  },
  {
    id: 'supp-debug-root-cause-env',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Local requests hit port 8810 but the worker config says the target service runs on 8814. What kind of mismatch is this? Answer one word.',
    check: { kind: 'exact', value: 'port' },
  },
  {
    id: 'supp-refactor-cleanup-dead-branch',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A condition checks if status === "done" inside a branch where status is already known to be "pending". What should happen to that inner branch? Answer one word.',
    check: { kind: 'exact', value: 'remove' },
  },
  {
    id: 'supp-refactor-cleanup-name',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Which name is clearer for a boolean: data, flag, or hasErrors? Answer only the best name.',
    check: { kind: 'exact', value: 'hasErrors' },
  },
  {
    id: 'supp-refactor-arch-shared-helper',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Three modules duplicate the same pure validation logic. Should the shared code be a pure helper, global mutable state, or copied again? Answer two words.',
    check: { kind: 'exact', value: 'pure helper' },
  },
  {
    id: 'supp-refactor-arch-boundary',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A UI component directly opens database connections. Which boundary should own the database call: UI, server, or CSS? Answer one word.',
    check: { kind: 'exact', value: 'server' },
  },
  {
    id: 'supp-refactor-migration-column',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A migration renames user_name to display_name without changing values. What SQL operation is this: INSERT, RENAME COLUMN, or DROP TABLE? Answer only the operation.',
    check: { kind: 'exact', value: 'RENAME COLUMN' },
  },
  {
    id: 'supp-refactor-migration-backfill',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: SYS_SYS,
    userPrompt:
      'After adding a non-null slug column to existing rows, what data operation fills slug for old rows? Answer one word.',
    check: { kind: 'exact', value: 'backfill' },
  },
  {
    id: 'supp-plan-arch-cache-layer',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'For read-heavy config that changes rarely, should the hot path read every request from origin storage or use a short cache? Answer two words.',
    check: { kind: 'exact', value: 'short cache' },
  },
  {
    id: 'supp-plan-arch-queue',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A long-running benchmark exceeds request time limits. Which primitive should carry the work asynchronously: queue, cookie, or CSS? Answer one word.',
    check: { kind: 'exact', value: 'queue' },
  },
  {
    id: 'supp-plan-technical-rollout',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Order these rollout steps: deploy code, run migration, monitor logs. Which step should be last? Answer two words.',
    check: { kind: 'exact', value: 'monitor logs' },
  },
  {
    id: 'supp-plan-technical-risk',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A plan changes a shared API contract. Should verification focus on one file only or all direct consumers? Answer three words.',
    check: { kind: 'exact', value: 'all direct consumers' },
  },
  {
    id: 'supp-plan-system-slo',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A service retries failed jobs and eventually sends hopeless jobs to a separate queue. What is that queue commonly called? Answer only the abbreviation.',
    check: { kind: 'exact', value: 'DLQ' },
  },
  {
    id: 'supp-plan-system-idempotency',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'If the same queue message may be delivered twice, should writes be idempotent or random? Answer one word.',
    check: { kind: 'exact', value: 'idempotent' },
  },
  {
    id: 'supp-invest-repo-rg',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Which command is the fastest common choice to search a repository for the string saveRoutingTable: rg, cat, or date? Answer one word.',
    check: { kind: 'exact', value: 'rg' },
  },
  {
    id: 'supp-invest-repo-package',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: SYS_SYS,
    userPrompt:
      'In a pnpm monorepo, which file usually names a package and its scripts: package.json or README.md? Answer only the file name.',
    check: { kind: 'exact', value: 'package.json' },
  },
  {
    id: 'supp-invest-code-flow',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A handler calls validateInput, then saveRow, then enqueueJob. Which function creates the async follow-up? Answer only the function name.',
    check: { kind: 'exact', value: 'enqueueJob' },
  },
  {
    id: 'supp-invest-code-owner',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: SYS_SYS,
    userPrompt:
      'If a type is imported from @kilocode/auto-routing-contracts, which package owns that type? Answer only the package name.',
    check: { kind: 'exact', value: '@kilocode/auto-routing-contracts' },
  },
  {
    id: 'supp-invest-research-source',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt:
      'For a question about current Cloudflare Workers limits, should you prefer official docs or an old blog post? Answer two words.',
    check: { kind: 'exact', value: 'official docs' },
  },
  {
    id: 'supp-invest-research-date',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt:
      'When comparing two search results for current pricing, which field matters most: publish date, font size, or title length? Answer two words.',
    check: { kind: 'exact', value: 'publish date' },
  },
  {
    id: 'supp-agent-tool-json-file',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create /tmp/bench-tool.json containing exactly {"a":2,"b":5}. Then read it and answer with only the sum of a and b.',
    check: { kind: 'exact', value: '7' },
  },
  {
    id: 'supp-agent-tool-grep-count',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create /tmp/bench-tool.txt with lines alpha, beta, alphabet, gamma. Count lines containing alpha and answer only the number.',
    check: { kind: 'exact', value: '2' },
  },
  {
    id: 'supp-agent-term-node-eval',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt: 'Run node -e "console.log(6*7)" in the terminal and answer with only the output.',
    check: { kind: 'exact', value: '42' },
  },
  {
    id: 'supp-agent-term-pwd-base',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Run pwd in the terminal. If it ends with /app, answer app; otherwise answer other. Answer one word.',
    check: { kind: 'regex', pattern: '^(app|other)$' },
  },
  {
    id: 'supp-agent-multi-script',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Write /tmp/bench-multi.js that prints ["k","i","l","o"].join(""). Run it with node and answer with only what it prints.',
    check: { kind: 'exact', value: 'kilo' },
  },
  {
    id: 'supp-agent-multi-files',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create /tmp/bench-a.txt containing 11 and /tmp/bench-b.txt containing 31. Read both files, add the numbers, and answer only the sum.',
    check: { kind: 'exact', value: '42' },
  },

  // ---------------------------------------------------------------------------
  // Additional taxonomy-route coverage to keep every pair at 10+ cases
  // ---------------------------------------------------------------------------
  {
    id: 'supp2-impl-feat-nullish-total',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this JavaScript print? Answer with only the number.\n\nconst input = { count: null };\nconst total = (input.count ?? 4) + 6;\nconsole.log(total);',
    check: { kind: 'exact', value: '10' },
  },
  {
    id: 'supp2-impl-feat-spread-merge',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this JavaScript print? Answer with the exact output line only.\n\nconst base = { a: 1, b: 2 };\nconst next = { ...base, b: 5, c: 8 };\nconsole.log(Object.keys(next).join(","));',
    check: { kind: 'exact', value: 'a,b,c' },
  },
  {
    id: 'supp2-impl-feat-set-size',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this JavaScript print? Answer with only the number.\n\nconst tags = new Set(["api", "web", "api", "cli"]);\nconsole.log(tags.size);',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'supp2-impl-gen-config-object',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Generate a config fixture. Reply with only a JSON object with exactly the keys "enabled" and "retries" in that order, where enabled is true and retries is 3.',
    check: { kind: 'json_equal', value: { enabled: true, retries: 3 } },
  },
  {
    id: 'supp2-impl-gen-primes-array',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Generate a test fixture: a JSON array containing the prime numbers less than 12, in increasing order. Reply with only the JSON array.',
    check: { kind: 'json_equal', value: [2, 3, 5, 7, 11] },
  },
  {
    id: 'supp2-impl-gen-user-slug',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Generate a slug for the title "Ship Fast, Stay Safe!". Reply with only the lowercase slug.',
    check: { kind: 'exact', value: 'ship-fast-stay-safe' },
  },
  {
    id: 'supp2-impl-gen-initials-object',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Generate a fixture. Reply with only a JSON object with exactly the keys "name" and "initials" in that order, where name is "Ada Lovelace" and initials is "AL".',
    check: { kind: 'json_equal', value: { name: 'Ada Lovelace', initials: 'AL' } },
  },
  {
    id: 'supp2-impl-test-array-length',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'You are writing a unit test. What number makes this assertion pass? Answer with only the number.\n\nexpect(["red", "blue", "green"].length).toBe(?)',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'supp2-impl-test-trim-expectation',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'You are writing a unit test. What exact string makes this assertion pass? Answer with only the string.\n\nexpect("  done\\n".trim()).toBe(?)',
    check: { kind: 'exact', value: 'done' },
  },
  {
    id: 'supp2-impl-test-map-output',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'You are writing a unit test. What JSON array should be expected?\n\n[2, 4, 6].map(n => n / 2)',
    check: { kind: 'json_equal', value: [1, 2, 3] },
  },
  {
    id: 'supp2-impl-test-url-search-param',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'You are writing a unit test. What value should this assertion expect? Answer with the exact string only.\n\nnew URL("https://example.test/path?mode=fast").searchParams.get("mode")',
    check: { kind: 'exact', value: 'fast' },
  },
  {
    id: 'supp2-debug-bug-loop-bound',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A loop should visit indexes 0, 1, and 2 of a 3-item array. Which comparison operator should the loop use with i and length: < or <=? Answer only the operator.',
    check: { kind: 'exact', value: '<' },
  },
  {
    id: 'supp2-debug-bug-negated-guard',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A guard should return early when user is missing. Complete the condition: if (___user) return "anonymous"; Answer with only the missing operator.',
    check: { kind: 'exact', value: '!' },
  },
  {
    id: 'supp2-debug-bug-assignment-condition',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A condition accidentally uses = instead of comparing status to "ready". Which operator should replace = for strict comparison? Answer only the operator.',
    check: { kind: 'exact', value: '===' },
  },
  {
    id: 'supp2-debug-bug-missing-await',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      'An async function returns Promise { <pending> } where the resolved value was expected. What keyword is missing before the promise call? Answer one word.',
    check: { kind: 'exact', value: 'await' },
  },
  {
    id: 'supp2-debug-test-boolean-expect',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A test expected isAdmin("owner") to be false, but the fixed function correctly returns true. What boolean should the test expect? Answer one word.',
    check: { kind: 'exact', value: 'true' },
  },
  {
    id: 'supp2-debug-test-error-message',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A validation test expected "bad input"; the implementation now intentionally throws "missing email". What exact message should the repaired test expect?',
    check: { kind: 'exact', value: 'missing email' },
  },
  {
    id: 'supp2-debug-test-json-shape',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A response fixture changed from {ok:true} to {status:"ok"}. Reply with only the new expected JSON object.',
    check: { kind: 'json_equal', value: { status: 'ok' } },
  },
  {
    id: 'supp2-debug-test-async-resolve',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A test should assert that fetchName() resolves to "Kilo". Which matcher should be used before toBe("Kilo"): resolves or rejects? Answer one word.',
    check: { kind: 'exact', value: 'resolves' },
  },
  {
    id: 'supp2-debug-rca-unset-secret',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A deploy works locally but production calls fail with "missing OPENROUTER_API_KEY". Which category is the root cause: secret, schema, or css? Answer one word.',
    check: { kind: 'exact', value: 'secret' },
  },
  {
    id: 'supp2-debug-rca-race-condition',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Two workers update the same counter concurrently and one increment disappears. What kind of bug is this? Answer two words.',
    check: { kind: 'exact', value: 'race condition' },
  },
  {
    id: 'supp2-debug-rca-cache-key',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Two users see each other cached results because the cache key omits userId. Which part is wrong: cache key, database type, or font? Answer two words.',
    check: { kind: 'exact', value: 'cache key' },
  },
  {
    id: 'supp2-debug-rca-timeout',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A request always fails after exactly 30 seconds while the downstream job completes at 45 seconds. What limit is most likely being hit? Answer one word.',
    check: { kind: 'exact', value: 'timeout' },
  },
  {
    id: 'supp2-refactor-cleanup-unused-import',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A file imports formatDate but never uses it. What should happen to that import? Answer one word.',
    check: { kind: 'exact', value: 'remove' },
  },
  {
    id: 'supp2-refactor-cleanup-nested-if',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Replacing nested if statements with early returns primarily reduces what? Answer one word.',
    check: { kind: 'exact', value: 'nesting' },
  },
  {
    id: 'supp2-refactor-cleanup-magic-number',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The number 86400000 appears repeatedly to mean milliseconds per day. What should it become: named constant, random value, or inline comment only? Answer two words.',
    check: { kind: 'exact', value: 'named constant' },
  },
  {
    id: 'supp2-refactor-cleanup-duplicate-branch',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Two switch cases have identical bodies. What refactor can combine them: fallthrough, mutation, or sleep? Answer one word.',
    check: { kind: 'exact', value: 'fallthrough' },
  },
  {
    id: 'supp2-refactor-arch-adapter',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: SYS_SYS,
    userPrompt:
      'To isolate provider-specific API calls behind a common interface, what pattern is commonly used? Answer one word.',
    check: { kind: 'exact', value: 'adapter' },
  },
  {
    id: 'supp2-refactor-arch-pure-core',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Moving business rules out of HTTP handlers into pure functions mainly improves what? Answer one word.',
    check: { kind: 'exact', value: 'testability' },
  },
  {
    id: 'supp2-refactor-arch-layering',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A router imports a React component to reuse validation logic. Should validation move to shared domain code or stay in the component? Answer three words.',
    check: { kind: 'exact', value: 'shared domain code' },
  },
  {
    id: 'supp2-refactor-arch-contract-package',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Two services duplicate the same Zod request schema. Where should that schema live: shared contracts package, CSS file, or log line? Answer three words.',
    check: { kind: 'exact', value: 'shared contracts package' },
  },
  {
    id: 'supp2-refactor-migration-add-index',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A frequent lookup filters by run_id and model. Which database object usually speeds that lookup? Answer one word.',
    check: { kind: 'exact', value: 'index' },
  },
  {
    id: 'supp2-refactor-migration-nullable-first',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: SYS_SYS,
    userPrompt:
      'For a large table, adding a new column before backfilling is usually safer if it starts nullable or non-null with no default? Answer one word.',
    check: { kind: 'exact', value: 'nullable' },
  },
  {
    id: 'supp2-refactor-migration-drop-column',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Removing an obsolete database column is which SQL operation: DROP COLUMN, SELECT, or COMMIT? Answer only the operation.',
    check: { kind: 'exact', value: 'DROP COLUMN' },
  },
  {
    id: 'supp2-refactor-migration-rename-table',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A migration changes table name old_events to events while preserving rows. What operation is this? Answer two words.',
    check: { kind: 'exact', value: 'rename table' },
  },
  {
    id: 'supp2-plan-arch-separate-writer',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'If one service should own writes to a shared routing table and others only read, what role does that service have? Answer two words.',
    check: { kind: 'exact', value: 'sole writer' },
  },
  {
    id: 'supp2-plan-arch-event-queue',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A user request should return quickly while heavy work continues later. Which architecture primitive usually decouples the work? Answer one word.',
    check: { kind: 'exact', value: 'queue' },
  },
  {
    id: 'supp2-plan-arch-cache-invalidation',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'After publishing a new config, should readers keep the old KV cache forever or invalidate it? Answer two words.',
    check: { kind: 'exact', value: 'invalidate it' },
  },
  {
    id: 'supp2-plan-arch-idempotent-writes',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'If a queue retries messages, should database writes be idempotent or time-randomized? Answer one word.',
    check: { kind: 'exact', value: 'idempotent' },
  },
  {
    id: 'supp2-plan-technical-order',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'For a schema-breaking rollout, which should be planned before deploy: migration or celebration? Answer one word.',
    check: { kind: 'exact', value: 'migration' },
  },
  {
    id: 'supp2-plan-technical-rollback',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A rollout plan should include how to return to the previous version. What is that called? Answer one word.',
    check: { kind: 'exact', value: 'rollback' },
  },
  {
    id: 'supp2-plan-technical-verification',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A plan touches a worker and a web consumer. Should verification include both surfaces or only the worker? Answer two words.',
    check: { kind: 'exact', value: 'both surfaces' },
  },
  {
    id: 'supp2-plan-technical-owner',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'When a launch depends on CI deploy finishing, what should the plan wait for before starting a new benchmark? Answer two words.',
    check: { kind: 'exact', value: 'deploy completion' },
  },
  {
    id: 'supp2-plan-system-backpressure',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Limiting how many jobs run at once to protect downstream capacity is called what? Answer one word.',
    check: { kind: 'exact', value: 'backpressure' },
  },
  {
    id: 'supp2-invest-repo-find-schema',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: SYS_SYS,
    userPrompt:
      'To find where benchmark_runs is defined in a repo, which command should you use first: rg, sleep, or curl? Answer one word.',
    check: { kind: 'exact', value: 'rg' },
  },
  {
    id: 'supp2-invest-repo-list-files',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Which command lists tracked and untracked file changes in a git worktree: git status or npm version? Answer two words.',
    check: { kind: 'exact', value: 'git status' },
  },
  {
    id: 'supp2-invest-repo-find-tests',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: SYS_SYS,
    userPrompt: 'Files ending in .test.ts usually contain what? Answer one word.',
    check: { kind: 'exact', value: 'tests' },
  },
  {
    id: 'supp2-invest-repo-read-config',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: SYS_SYS,
    userPrompt:
      'In a Cloudflare Worker service, which config file commonly defines bindings: wrangler.jsonc or tsconfig.tsbuildinfo? Answer only the file name.',
    check: { kind: 'exact', value: 'wrangler.jsonc' },
  },
  {
    id: 'supp2-invest-code-call-chain',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Given the call chain handleRequest -> classify -> computeDecision, which function chooses the model? Answer only the function name.',
    check: { kind: 'exact', value: 'computeDecision' },
  },
  {
    id: 'supp2-invest-code-schema-owner',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: SYS_SYS,
    userPrompt:
      'If RoutingTableSchema parses published artifacts, is it a runtime schema or CSS class? Answer two words.',
    check: { kind: 'exact', value: 'runtime schema' },
  },
  {
    id: 'supp2-invest-code-field-rename',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A database row field route_key maps to API field routeKey. What naming conversion is this: snake to camel, camel to snake, or uppercase? Answer three words.',
    check: { kind: 'exact', value: 'snake to camel' },
  },
  {
    id: 'supp2-invest-code-consumer',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A type change in @kilocode/auto-routing-contracts breaks services/auto-routing and apps/web. What are those packages called relative to the type? Answer one word.',
    check: { kind: 'exact', value: 'consumers' },
  },
  {
    id: 'supp2-invest-research-primary-source',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt:
      'For library API behavior, should you prefer official docs or a random forum answer? Answer two words.',
    check: { kind: 'exact', value: 'official docs' },
  },
  {
    id: 'supp2-invest-research-cross-check',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt:
      'If two current sources disagree, should you cross-check or guess? Answer one word.',
    check: { kind: 'exact', value: 'cross-check' },
  },
  {
    id: 'supp2-invest-research-version',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt:
      'When reading framework docs, which detail matters for compatibility: version or logo color? Answer one word.',
    check: { kind: 'exact', value: 'version' },
  },
  {
    id: 'supp2-invest-research-quote-limit',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt:
      'When using a source, should long copyrighted passages be quoted in full or summarized? Answer one word.',
    check: { kind: 'exact', value: 'summarized' },
  },
  {
    id: 'supp2-agent-tool-sort-file',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create /tmp/bench-sort.txt with lines delta, alpha, charlie. Sort the lines alphabetically and answer with the first line only.',
    check: { kind: 'exact', value: 'alpha' },
  },
  {
    id: 'supp2-agent-tool-json-length',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create /tmp/bench-items.json containing ["a","b","c","d"]. Read it and answer only the array length.',
    check: { kind: 'exact', value: '4' },
  },
  {
    id: 'supp2-agent-tool-word-count',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create /tmp/bench-words.txt containing exactly "one two three". Count the words and answer only the number.',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'supp2-agent-tool-file-exists',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create /tmp/bench-exists.txt containing ok. Then check that the file exists and answer only yes or no.',
    check: { kind: 'exact', value: 'yes' },
  },
  {
    id: 'supp2-agent-term-node-json',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Run node -e "console.log(JSON.stringify([1,2,3].reduce((a,b)=>a+b,0)))" in the terminal and answer with only the output.',
    check: { kind: 'exact', value: '6' },
  },
  {
    id: 'supp2-agent-term-printf',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt: 'Run printf kilo in the terminal and answer with only the output.',
    check: { kind: 'exact', value: 'kilo' },
  },
  {
    id: 'supp2-agent-term-sort',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Run a shell command that sorts the words "zeta alpha" alphabetically one per line. Answer with only the first sorted word.',
    check: { kind: 'exact', value: 'alpha' },
  },
  {
    id: 'supp2-agent-term-expr',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt: 'Run a terminal calculation for 9 + 8 + 7 and answer with only the result.',
    check: { kind: 'exact', value: '24' },
  },
  {
    id: 'supp2-agent-multi-generate-run',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Write /tmp/bench-sum.js that prints 14 + 28. Run it with node and answer with only what it prints.',
    check: { kind: 'exact', value: '42' },
  },
  {
    id: 'supp2-agent-multi-read-transform',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create /tmp/bench-name.txt containing kilo. Read it, uppercase it, and answer only the uppercase text.',
    check: { kind: 'exact', value: 'KILO' },
  },
  {
    id: 'supp2-agent-multi-two-files-join',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create /tmp/bench-left.txt containing auto and /tmp/bench-right.txt containing route. Read both and answer with the two words joined by a hyphen.',
    check: { kind: 'exact', value: 'auto-route' },
  },
  {
    id: 'supp2-agent-multi-json-sum',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create /tmp/bench-numbers.json containing [5,10,15]. Read it, sum the numbers, and answer only the sum.',
    check: { kind: 'exact', value: '30' },
  },
];
