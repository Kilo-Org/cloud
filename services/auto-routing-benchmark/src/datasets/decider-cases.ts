import type {
  ClassifierSubtaskType,
  ClassifierTaskType,
  DifficultyTier,
} from '@kilocode/auto-routing-contracts';
import type { DeciderCheck } from '../grading';

export type DeciderCase = {
  id: string; // stable slug, e.g. 'impl-gen-squares-array' (<taskType>-<subtype>-<topic>)
  tier: DifficultyTier;
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
// carries exactly one difficulty tier: low = mechanical lookups / trivial
// evaluation, medium = multi-step reasoning / off-by-one traps / spec
// application, high = deep tracing / multi-constraint puzzles / subtle
// semantics. agentic_execution cases are self-contained tasks performed with
// file/terminal tools inside the benchmark container (node:22-slim, no repo,
// no network) and every command involved is deterministic there.
export const DECIDER_CASES: readonly DeciderCase[] = [
  // ---------------------------------------------------------------------------
  // implementation / feature_development
  // ---------------------------------------------------------------------------
  {
    id: 'impl-feat-ternary-parity',
    tier: 'low',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this JavaScript print? Answer with the exact output line only.\n\nconst n = 7;\nconsole.log(n % 2 === 0 ? "even" : "odd");',
    check: { kind: 'exact', value: 'odd' },
  },
  {
    id: 'impl-feat-array-pipeline',
    tier: 'low',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this JavaScript print? Answer with the exact output line only.\n\nconst xs = [1, 2, 3, 4].filter(x => x % 2 === 0).map(x => x * 10);\nconsole.log(xs.join("-"));',
    check: { kind: 'exact', value: '20-40' },
  },
  {
    id: 'impl-feat-closure-counter',
    tier: 'medium',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What is the final printed value? Answer with only the number.\n\nfunction make() {\n  let c = 0;\n  return () => ++c;\n}\nconst f = make();\nf();\nf();\nconsole.log(f());',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'impl-feat-recursion-fib',
    tier: 'medium',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt:
      'This computes a Fibonacci-like sequence where f(0)=0, f(1)=1, f(n)=f(n-1)+f(n-2). What is f(7)? Answer with only the number.',
    check: { kind: 'exact', value: '13' },
  },
  {
    id: 'impl-feat-this-binding',
    tier: 'high',
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
    tier: 'low',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Generate a minimal package manifest. Reply with only a JSON object with exactly the keys "name" and "version" in that order, where name is "demo-app" and version is "1.2.3".',
    check: { kind: 'json_equal', value: { name: 'demo-app', version: '1.2.3' } },
  },
  {
    id: 'impl-gen-squares-array',
    tier: 'low',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Generate a test fixture: a JSON array containing the squares of the integers 1 through 6, in increasing order. Reply with only the JSON array.',
    check: { kind: 'json_equal', value: [1, 4, 9, 16, 25, 36] },
  },
  {
    id: 'impl-gen-no-consecutive-ones',
    tier: 'medium',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Generate a test fixture: a JSON array of all binary strings of length 3 that contain no two consecutive 1s, in lexicographic order, each string as a JSON string. Reply with only the JSON array.',
    check: { kind: 'json_equal', value: ['000', '001', '010', '100', '101'] },
  },
  {
    id: 'impl-gen-two-ones-strings',
    tier: 'high',
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
    tier: 'low',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'You are writing a unit test. What value makes this assertion pass? Answer with the exact string only.\n\nexpect([5, 3, 8, 1].sort((a, b) => a - b).join(",")).toBe(?)',
    check: { kind: 'exact', value: '1,3,5,8' },
  },
  {
    id: 'impl-test-upper-expectation',
    tier: 'low',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'You are writing a unit test. What value makes this assertion pass? Answer with the exact string only.\n\nexpect("hello".toUpperCase()).toBe(?)',
    check: { kind: 'exact', value: 'HELLO' },
  },
  {
    id: 'impl-test-mock-call-count',
    tier: 'medium',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt:
      'You are writing a unit test with a mock:\n\nconst fn = vi.fn(x => x * 2);\nconst wrapped = x => fn(x) + fn(x);\nwrapped(3);\nwrapped(4);\nexpect(fn).toHaveBeenCalledTimes(?)\n\nWhat number makes the assertion pass? Answer with only the number.',
    check: { kind: 'exact', value: '4' },
  },
  {
    id: 'impl-test-trailing-zeros',
    tier: 'high',
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
    tier: 'low',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this JavaScript print? Answer with only the number.\n\nconsole.log(parseInt("42px", 10));',
    check: { kind: 'exact', value: '42' },
  },
  {
    id: 'debug-fix-binary-search',
    tier: 'medium',
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
    tier: 'medium',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      'This pagination helper is buggy: pages([1, 2, 3, 4, 5, 6, 7], 3) should return [[1,2,3],[4,5,6],[7]] but loses elements. Reply with JSON {"line": <1-based line number of the buggy line>, "fix": "<the corrected line with leading whitespace removed, keeping single spaces around operators>"}.\n\n1: function pages(xs, size) {\n2:   const out = [];\n3:   for (let i = 0; i < xs.length; i += size) {\n4:     out.push(xs.slice(i, size));\n5:   }\n6:   return out;\n7: }',
    check: { kind: 'json_equal', value: { line: 4, fix: 'out.push(xs.slice(i, i + size));' } },
  },
  {
    id: 'debug-fix-regex-lastindex',
    tier: 'high',
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
    tier: 'low',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A unit test asserts that this program prints 25, and the test fails. The code is correct; the expectation is stale. What value should the updated test expect? Answer with only the number.\n\nlet x = 10;\nx += 5;\nx *= 2;\nconsole.log(x);',
    check: { kind: 'exact', value: '30' },
  },
  {
    id: 'debug-repair-date-format',
    tier: 'medium',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A snapshot test fails after a date-formatter fix. The formatter now emits dates as zero-padded YYYY-MM-DD. What exact string should the updated snapshot expect for June 1, 2026? Answer with only the date string.',
    check: { kind: 'exact', value: '2026-06-01' },
  },
  {
    id: 'debug-repair-entries-shape',
    tier: 'medium',
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
    tier: 'high',
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
    tier: 'medium',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this program print, in order? Answer with the four uppercase letters joined by commas, e.g. "A,B,C,D".\n\nconsole.log("A");\nPromise.resolve().then(() => console.log("B"));\nsetTimeout(() => console.log("C"), 0);\nconsole.log("D");',
    check: { kind: 'regex', pattern: '^\\s*A\\s*,\\s*D\\s*,\\s*B\\s*,\\s*C\\s*$', flags: 'im' },
  },
  {
    id: 'debug-rca-shared-ref',
    tier: 'medium',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this print? Answer with only the number.\n\nconst a = [1, 2, 3];\nconst b = a;\nb.push(4);\nconsole.log(a.length);',
    check: { kind: 'exact', value: '4' },
  },
  {
    id: 'debug-rca-closure-loop-var',
    tier: 'high',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      'What does this print? Answer with the three numbers joined by commas, e.g. "1,2,3".\n\nconst fns = [];\nfor (var i = 0; i < 3; i++) {\n  fns.push(() => i);\n}\nconsole.log(fns[0]() + "," + fns[1]() + "," + fns[2]());',
    check: { kind: 'regex', pattern: '^\\s*3\\s*,\\s*3\\s*,\\s*3\\s*$', flags: 'm' },
  },
  {
    id: 'debug-rca-float-equality',
    tier: 'high',
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
    tier: 'low',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A loop sums an array. What value does it produce? Answer with only the number.\n\nlet total = 0;\nfor (const n of [4, 4, 4]) total += n;\nconsole.log(total);',
    check: { kind: 'exact', value: '12' },
  },
  {
    id: 'refactor-cleanup-extract-helper',
    tier: 'low',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Two branches both compute s.trim().toLowerCase(), so you extract a helper norm(s) that does exactly that. What does norm("  HeLLo ") return? Answer with the exact string only.',
    check: { kind: 'exact', value: 'hello' },
  },
  {
    id: 'refactor-cleanup-map-equivalent',
    tier: 'medium',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: CODE_SYS,
    userPrompt:
      'After refactoring, both versions must produce the same output. What number does this print? Answer with only the number.\n\nconst nums = [10, 20, 30];\nconst doubled = nums.map(n => n * 2);\nconsole.log(doubled[1]);',
    check: { kind: 'exact', value: '40' },
  },
  {
    id: 'refactor-cleanup-short-circuit',
    tier: 'high',
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
    tier: 'low',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Files x.ts, y.ts, and z.ts each contain exactly one import of helper.ts. helper.ts moves to a new directory, changing its import path. How many import statements must be updated? Answer with only the number.',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'refactor-arch-layer-depth',
    tier: 'medium',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: CODE_SYS,
    userPrompt:
      "Modules and their imports: app imports auth and billing; auth imports core; billing imports core; core imports nothing. In a layered architecture where a module's layer is 1 + the maximum layer of its imports, and core is layer 1, what layer is app? Answer with only the number.",
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'refactor-arch-interface-edges',
    tier: 'medium',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A module graph has edges A->B, A->C, B->D, C->D. To improve the architecture you introduce an interface module I: the edges B->D and C->D are removed and replaced by B->I, C->I, and I->D. How many edges does the new graph have? Answer with only the number.',
    check: { kind: 'exact', value: '5' },
  },
  {
    id: 'refactor-arch-cycle-cut',
    tier: 'high',
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
    tier: 'low',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: CODE_SYS,
    userPrompt:
      'You are migrating code off the deprecated String.prototype.substr. The old call is "javascript".substr(4, 3). What string does the equivalent migrated call "javascript".slice(4, 7) return? Answer with the exact string only.',
    check: { kind: 'exact', value: 'scr' },
  },
  {
    id: 'refactor-migrate-promise-chain',
    tier: 'medium',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: CODE_SYS,
    userPrompt:
      'After migrating a callback API to promises, the code reads:\n\nPromise.resolve(2).then(x => x + 1).then(x => x * 10).then(x => console.log(x));\n\nWhat number does it print? Answer with only the number.',
    check: { kind: 'exact', value: '30' },
  },
  {
    id: 'refactor-migrate-strict-equality',
    tier: 'medium',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: CODE_SYS,
    userPrompt:
      'You are migrating a codebase from == to ===. How many of these four comparisons change their result after replacing == with ===?\n\n"1" == 1\nnull == undefined\n2 == 2\nNaN == NaN\n\nAnswer with only the number.',
    check: { kind: 'exact', value: '2' },
  },
  {
    id: 'refactor-migrate-var-to-let',
    tier: 'high',
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
    id: 'plan-arch-three-tier',
    tier: 'low',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'In a classic three-tier architecture with presentation, business, and data tiers, which tier should contain the SQL queries? Answer with only one word: presentation, business, or data.',
    check: { kind: 'exact', value: 'data' },
  },
  {
    id: 'plan-arch-call-chain',
    tier: 'medium',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A service design has these synchronous call edges: gateway calls auth and orders; orders calls inventory and billing; billing calls ledger. Counting edges, how long is the longest call chain starting at gateway? Answer with only the number.',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'plan-arch-dependency-rules',
    tier: 'medium',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A layered design enforces these rules: ui may import only app; app may import domain and infra; infra may import domain; domain imports nothing. How many of these five proposed imports violate the rules?\n\nui -> app\nui -> domain\napp -> domain\ninfra -> app\ndomain -> infra\n\nAnswer with only the number.',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'plan-arch-latency-budget',
    tier: 'high',
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
    tier: 'low',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A rollout plan has four steps in strict sequence: write code, code review, deploy to staging, deploy to production. Which step is third? Answer with only the exact step name.',
    check: { kind: 'exact', value: 'deploy to staging' },
  },
  {
    id: 'plan-steps-batch-count',
    tier: 'medium',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A data migration plan processes 1000 records in batches of up to 80 records, one batch per run. How many runs does the plan need to process all records? Answer with only the number.',
    check: { kind: 'exact', value: '13' },
  },
  {
    id: 'plan-steps-deploy-waves',
    tier: 'medium',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Services A, B, C, D deploy in waves: a service can only deploy after all its dependencies are deployed, and any number of services can share a wave. Dependencies: B needs A; C needs A; D needs B and C. Reply with JSON {"waves": <minimum number of waves>, "dWave": <1-based wave in which D deploys>}.',
    check: { kind: 'json_equal', value: { waves: 3, dWave: 3 } },
  },
  {
    id: 'plan-steps-critical-path',
    tier: 'high',
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
    tier: 'low',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A system replicates each write to 3 nodes and requires a majority quorum of acknowledgements before confirming the write. How many node acknowledgements are required? Answer with only the number.',
    check: { kind: 'exact', value: '2' },
  },
  {
    id: 'plan-system-rate-limit-window',
    tier: 'medium',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A fixed-window rate limiter allows 100 requests per 60-second window. A client sends 80 requests in the first 30 seconds of a window, then 40 more requests in the next 20 seconds (same window). How many of the 40 later requests are rejected? Answer with only the number.',
    check: { kind: 'exact', value: '20' },
  },
  {
    id: 'plan-system-replica-availability',
    tier: 'medium',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A service is available when at least one of its two independent replicas is up. Each replica is up 90% of the time, independently. What is the service availability as a percentage? Answer with only the number.',
    check: { kind: 'exact', value: '99' },
  },
  {
    id: 'plan-system-cache-staleness',
    tier: 'high',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'A write-through cache with TTL 60s. At t=0s key K is written (value 1, cached). At t=30s the database row for K is updated to value 2 by a process that bypasses the cache (does not invalidate it). At t=45s a reader requests K. At t=70s another reader requests K. The cache returns its entry if present and unexpired, otherwise reads the DB and caches. What value does the t=45s reader get, and what value does the t=70s reader get? Reply with JSON {"first": <number>, "second": <number>}.',
    check: { kind: 'json_equal', value: { first: 1, second: 2 } },
  },
  {
    id: 'plan-system-queue-trace',
    tier: 'high',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Three workers process a queue with at-least-once delivery. Worker A reads job 7 at t=0ms and crashes at t=50ms, before performing the insert and before ack. Visibility timeout is 30ms. Worker B receives job 7 at t=35ms, processes it in 40ms and acks. Worker C receives job 7 at t=80ms (redelivery triggered by the crash recovery scan at t=70ms) and processes it in 10ms, acking at t=90ms. The job inserts a row keyed by an idempotency key with ON CONFLICT DO NOTHING. How many rows exist at t=100ms, and which worker\'s insert won? Reply with JSON {"rows": <number>, "winner": "<A|B|C>"}.',
    check: { kind: 'json_equal', value: { rows: 1, winner: 'B' } },
  },
  {
    id: 'plan-system-deadlock-order',
    tier: 'high',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Two threads acquire locks. Thread 1: lock A, then lock B. Thread 2: lock B, then lock A. Both hold the first lock and then block forever waiting for the second. To eliminate the deadlock by enforcing a global lock acquisition order (alphabetical: A before B), which single thread number must have its two lock acquisitions reordered? Answer with only the thread number.',
    check: { kind: 'exact', value: '2' },
  },
  {
    id: 'plan-system-txn-isolation',
    tier: 'high',
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
    tier: 'low',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A repository listing shows these files:\n\nsrc/app.ts\nsrc/app.test.ts\nsrc/util.ts\nsrc/util.test.ts\nsrc/index.ts\nREADME.md\n\nHow many files end in .test.ts? Answer with only the number.',
    check: { kind: 'exact', value: '2' },
  },
  {
    id: 'invest-repo-glob-match',
    tier: 'medium',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Using a glob where ** matches zero or more directories, how many of these files match the pattern src/**/*.ts?\n\nsrc/a.ts\nsrc/lib/b.ts\nsrc/lib/deep/c.ts\ntest/d.ts\nsrc/e.tsx\n\nAnswer with only the number.',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'invest-repo-grep-case',
    tier: 'medium',
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    systemPrompt: CODE_SYS,
    userPrompt:
      'A file contains exactly these 5 lines:\n\nError: failed\nerror handled\nno problems\nERROR_CODE=7\nerrors: none\n\nHow many lines does a case-sensitive search for the string "error" match? Answer with only the number.',
    check: { kind: 'exact', value: '2' },
  },
  {
    id: 'invest-repo-gitignore',
    tier: 'high',
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
    tier: 'low',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt:
      'How many times does the letter "a" appear in the word "banana"? Answer with only the number.',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'invest-code-object-keys',
    tier: 'low',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt:
      'How many own enumerable keys does this object have? Answer with only the number.\n\nconst o = { a: 1, b: 2, c: 3 };',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'invest-code-regex-groups',
    tier: 'medium',
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Given the regex /(\\d{4})-(\\d{2})-(\\d{2})/ applied to "2026-06-11", what is capture group 2? Answer with only the value.',
    check: { kind: 'exact', value: '06' },
  },
  {
    id: 'invest-code-collatz-depth',
    tier: 'high',
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
    tier: 'low',
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
    tier: 'medium',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: SYS_SYS,
    userPrompt:
      'Per the UTF-8 encoding specification, how many bytes does the encoding of the euro sign (U+20AC) use? Answer with only the number.',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'invest-ext-semver-caret',
    tier: 'medium',
    taskType: 'investigation',
    subtaskType: 'external_research',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Per the npm semver range specification, consider the range ^1.4.2. Does it include version 1.5.0, and does it include version 2.0.0? Reply with JSON {"v150": <true|false>, "v200": <true|false>}.',
    check: { kind: 'json_equal', value: { v150: true, v200: false } },
  },
  {
    id: 'invest-ext-json-spec',
    tier: 'high',
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
    tier: 'low',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Using your file tools, create a file /tmp/bench-kv.json containing exactly this JSON: {"alpha": 4, "beta": 9}. Then read the file back and answer with only the value of the key "beta".',
    check: { kind: 'exact', value: '9' },
  },
  {
    id: 'agentic-tool-notes-count',
    tier: 'low',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create a directory /tmp/bench-notes containing exactly three files named one.txt, two.txt, and three.txt (any content). Then list the directory and answer with only the number of files it contains.',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'agentic-tool-log-grep',
    tier: 'medium',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create a file /tmp/bench-app.log containing exactly these 6 lines:\n\nINFO start\nERROR disk full\nINFO retry\nERROR timeout\nWARN slow\nERROR disk full\n\nThen search the file and answer with only the number of lines that contain the word ERROR.',
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'agentic-tool-csv-filter-sum',
    tier: 'high',
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
    tier: 'low',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Run this command in the terminal and answer with only the number it prints:\n\nnode -e "console.log(process.versions.node.split(\'.\')[0])"',
    check: { kind: 'exact', value: '22' },
  },
  {
    id: 'agentic-term-wc-lines',
    tier: 'low',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Using the terminal, write a file /tmp/bench-words.txt containing exactly these 5 lines:\n\nred\ngreen\nblue\ncyan\nplum\n\nThen run: wc -l < /tmp/bench-words.txt and answer with only the number it prints.',
    check: { kind: 'exact', value: '5' },
  },
  {
    id: 'agentic-term-sort-pipeline',
    tier: 'medium',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Run this pipeline in the terminal and answer with only the line it prints:\n\nprintf 'pear\\napple\\nbanana\\n' | sort | head -n 1",
    check: { kind: 'exact', value: 'apple' },
  },
  {
    id: 'agentic-term-sha256-prefix',
    tier: 'high',
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
    tier: 'medium',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create a file /tmp/bench-seq.txt containing the integers 1 through 10, one per line. Then use a terminal command to sum the lines and answer with only the sum.',
    check: { kind: 'exact', value: '55' },
  },
  {
    id: 'agentic-multi-node-script',
    tier: 'medium',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Write a file /tmp/bench-fib.js containing a Node.js script that computes f(12) for the sequence f(1) = 1, f(2) = 1, f(n) = f(n-1) + f(n-2), and prints the result. Run it with node and answer with only the number it prints.',
    check: { kind: 'exact', value: '144' },
  },
  {
    id: 'agentic-multi-find-count',
    tier: 'medium',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Create directories /tmp/bench-proj/src and /tmp/bench-proj/test. Create empty files /tmp/bench-proj/src/a.ts, /tmp/bench-proj/src/b.ts, and /tmp/bench-proj/test/a.test.ts. Then run:\n\nfind /tmp/bench-proj -name '*.ts' | wc -l\n\nand answer with only the number it prints.",
    check: { kind: 'exact', value: '3' },
  },
  {
    id: 'agentic-multi-json-transform',
    tier: 'high',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      'Create a file /tmp/bench-in.json containing exactly this JSON array: [3, 1, 4, 1, 5, 9, 2, 6, 5, 3]. Then write and run a Node.js script that reads the file, computes the sum of the distinct values in the array, and prints it. Answer with only the number.',
    check: { kind: 'exact', value: '30' },
  },
];
