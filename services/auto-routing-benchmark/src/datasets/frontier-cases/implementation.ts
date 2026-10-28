import type { DeciderCase } from '../decider-cases';

const SYSTEM_PROMPT =
  'You are a precise coding assistant. Solve the supplied fixture under its stated rules. Reply with only the requested JSON object, without fences or explanations.';

export const IMPLEMENTATION_FRONTIER_CASES: readonly DeciderCase[] = [
  {
    id: 'frontier-implementation-feature-development-reservation-optimizer',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Implement the planner spanning catalog.ts (jobs), slots.ts (compatibility), and plan.ts (optimizer). Jobs are [id,start,end,profit]: [a,0,3,8],[b,1,4,10],[c,3,5,6],[d,4,7,12],[e,5,7,7],[f,7,9,5],[g,0,9,25],[h,2,3,4]. Times are half-open. A chosen job may start when the previous job ends. Select a compatible subset maximizing profit; ties prefer fewer jobs then the lexicographically smaller id sequence in execution order. Return the implementation\'s acceptance fixture: keys profit, jobs.\n\nReply with exactly one JSON object containing exactly these keys in this order: "profit", "jobs". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: { profit: 27, jobs: ['b', 'd', 'f'] },
    },
  },
  {
    id: 'frontier-implementation-feature-development-policy-precedence',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Implement policy evaluation across defaults.ts, org.ts, route.ts, and emergency.ts. Rule order: emergency deny overrides everything; explicit route allow/deny overrides org; org overrides default; null means no rule, not deny. Separately a legalHold forbids write even when route allows. A read may be allowed while write is denied. Default allows read but denies write. Org A denies both; org B allows both. Route x allows both, y denies read and inherits write, z inherits both. Requests [id,org,route,emergency,legalHold,operation]: [p,A,x,false,false,read],[q,A,x,false,true,write],[r,B,y,false,false,read],[s,B,y,false,false,write],[t,B,x,true,false,read],[u,A,z,false,false,read],[v,B,z,false,true,read],[w,B,z,false,true,write]. Emit keys allowed, denied, where arrays preserve request order.\n\nReply with exactly one JSON object containing exactly these keys in this order: "allowed", "denied". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: { allowed: ['p', 's', 'v'], denied: ['q', 'r', 't', 'u', 'w'] },
    },
  },
  {
    id: 'frontier-implementation-feature-development-revision-materializer',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Implement a revision materializer spanning ingest.ts, reducer.ts, and snapshot.ts. Each event [key,revision,kind,value] supersedes only events with smaller revision for that key; equal revisions are resolved by delete beating set, then lexicographically larger set value. Arrival order is not revision order. A delete retains a tombstone; it is excluded from rows but included in revisions. Events: [a,4,set,oak],[b,2,set,bee],[a,2,set,ash],[a,4,set,pine],[b,5,delete,null],[b,4,set,birch],[c,1,delete,null],[c,1,set,cedar],[a,4,delete,null],[a,6,set,elm],[b,5,set,willow],[d,3,set,dogwood]. Return keys rows, revisions, each an array sorted by key; rows entries [key,value], revision entries [key,revision].\n\nReply with exactly one JSON object containing exactly these keys in this order: "rows", "revisions". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        rows: [
          ['a', 'elm'],
          ['d', 'dogwood'],
        ],
        revisions: [
          ['a', 6],
          ['b', 5],
          ['c', 1],
          ['d', 3],
        ],
      },
    },
  },
  {
    id: 'frontier-implementation-feature-development-min-cost-assignment',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Implement the worker assignment feature in workers.ts + constraints.ts + assign.ts. Assign each of jobs J0,J1,J2,J3 to a distinct worker among A,B,C,D,E. Costs in job order: A=[4,1,9,8], B=[2,6,3,9], C=[7,4,2,5], D=[3,8,6,1], E=[5,2,4,3]. Constraints: J0 cannot use B; if J1 uses A then J2 cannot use C; E must receive either J1 or J3; C and D cannot both be assigned. Minimize total cost then lexicographic worker sequence in job order. Return keys cost, workers.\n\nReply with exactly one JSON object containing exactly these keys in this order: "cost", "workers". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: { cost: 10, workers: ['A', 'E', 'B', 'D'] },
    },
  },
  {
    id: 'frontier-implementation-feature-development-dependency-version-solver',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Implement resolve.ts from catalog.ts and locks.ts. Choose one version 1,2,3 of EACH package A,B,C,D,E,F,G,H. Root requires A>=2 and B>=2. Dependencies by chosen version (unlisted versions have NONE): A2 needs C in {1,2} and D>=2; A3 needs C3 and D>=2; B2 needs E>=2; B3 needs E1 and F3; C1 needs F1; C2 needs F>=2; C3 needs F2; D2 needs G1; D3 needs G2; E1 needs H2; E2 needs H1; E3 needs H3; F1 needs G2; F2 needs G1; F3 needs G>=2; G1 needs H1; G2 needs H>=2; G3 needs H3. Soft locks in package order [A3,B3,C3,D3,E1,F3,G3,H2]. First satisfy every dependency; then minimize changed locks; then maximize sum of selected version numbers; then lexicographically smallest version string. Return keys versions (strings in package order), changed (package names in package order).\n\nReply with exactly one JSON object containing exactly these keys in this order: "versions", "changed". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        versions: ['A2', 'B3', 'C2', 'D3', 'E1', 'F3', 'G2', 'H2'],
        changed: ['A', 'C', 'G'],
      },
    },
  },
  {
    id: 'frontier-implementation-feature-development-atomic-import-batches',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Implement import batching in graph.ts and loader.ts. Imports (source requires target): A->B,B->C,C->A,C->D,D->E,E->D,F->C,F->G,G->H,H->G,I->F,I->E. An SCC must load atomically. Load waves contain every SCC whose external dependencies loaded in earlier waves, never the same wave. Sort members of each SCC alphabetically, SCCs by their first member, and preserve wave order. Return keys components (all SCC member arrays sorted by first member), waves (arrays of SCC labels formed by concatenating member names).\n\nReply with exactly one JSON object containing exactly these keys in this order: "components", "waves". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        components: [['A', 'B', 'C'], ['D', 'E'], ['F'], ['G', 'H'], ['I']],
        waves: [['DE', 'GH'], ['ABC'], ['F'], ['I']],
      },
    },
  },
  {
    id: 'frontier-implementation-feature-development-keyed-shortest-path',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Implement shortestPath.ts over grid.ts. Grid rows are ['S..a#...', '.##.#.b.', '...A..#.', '##B###.#', '...#...E', '.#...#..']. Coordinates [row,col] are zero-based; move orthogonally at cost1; # blocks, lowercase a/b collect reusable keys, uppercase A/B doors require matching key BEFORE entering. S/E are traversable. Determine minimum steps from S to E and count of distinct minimum-step coordinate paths; different key state alone is not a new path. Return keys steps, paths. Count BFS path multiplicities over (position,keyset), including multiple endpoint keysets if tied.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"steps\", \"paths\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: { steps: 23, paths: 1 },
    },
  },
  {
    id: 'frontier-implementation-feature-development-invoice-bankers-rounding',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Implement billing.ts and allocate.ts without binary floating point. Invoice lines have exact rational cents [numerator,denominator]: [1005,2],[1005,2],[-999,2],[101,4],[103,4],[1,2]. Round each line to nearest integer cent, ties to even, with symmetric handling of negatives. Separately round the exact sum once. Return keys lines (rounded integer cents), sumOfRounded, roundedSum. Do not substitute truncation or round-half-up.\n\nReply with exactly one JSON object containing exactly these keys in this order: "lines", "sumOfRounded", "roundedSum". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: { lines: [502, 502, -500, 25, 26, 0], sumOfRounded: 555, roundedSum: 557 },
    },
  },
  {
    id: 'frontier-implementation-feature-development-compaction-protected-readers',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Implement compact.ts for mvcc.ts. Versions per key, newest first: A=[12,11,9,8,7,6,3,1], B=[11,10,8,7,4,1], C=[10,9,6,5,2,1], D=[13,12,5,1]. Active snapshot timestamps are [4,8,10]. Keep the newest version of each key plus the newest version <= each active snapshot if one exists. A delete at A9 and C6 is a version like any other; do NOT drop tombstones while readers are active. Return keys kept, removed, each arrays of [key,version] ordered key ascending then version descending.\n\nReply with exactly one JSON object containing exactly these keys in this order: "kept", "removed". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        kept: [
          ['A', 12],
          ['A', 9],
          ['A', 8],
          ['A', 3],
          ['B', 11],
          ['B', 10],
          ['B', 8],
          ['B', 4],
          ['C', 10],
          ['C', 6],
          ['C', 2],
          ['D', 13],
          ['D', 5],
          ['D', 1],
        ],
        removed: [
          ['A', 11],
          ['A', 7],
          ['A', 6],
          ['A', 1],
          ['B', 7],
          ['B', 1],
          ['C', 9],
          ['C', 5],
          ['C', 1],
          ['D', 12],
        ],
      },
    },
  },
  {
    id: 'frontier-implementation-feature-development-route-specificity',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Implement router.ts from routes.ts. Segments: literal matches itself, :x matches one nonempty segment, * matches zero or more trailing segments and is only last. A match score is [literalCount,-wildcardCount,segmentCount]; maximize lexicographically, then smaller route id. Routes [id,pattern]: [a,/api/:tenant/items/:id],[b,/api/acme/items/*],[c,/api/:tenant/*],[d,/api/acme/items/:id],[e,/api/acme/items],[f,/api/*],[g,/api/:tenant/items/*]. Requests: /api/acme/items/7, /api/other/items/7, /api/acme/items, /api/acme/items/7/log, /api/acme, /api. Return keys selected (route ids in request order), scores (winning score arrays).\n\nReply with exactly one JSON object containing exactly these keys in this order: "selected", "scores". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        selected: ['d', 'a', 'e', 'b', 'c', 'f'],
        scores: [
          [3, 0, 4],
          [2, 0, 4],
          [3, 0, 3],
          [3, -1, 4],
          [1, -1, 3],
          [1, -1, 2],
        ],
      },
    },
  },
  {
    id: 'frontier-implementation-feature-development-observed-remove-set',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Implement an observed-remove set across replica.ts and merge.ts. An add attaches a globally unique tag to a value. Remove records only the tags it has observed for that value. Merge unions adds and removed tags; live values have at least one unremoved tag. Initially X and Y each see adds apple:a1 and pear:p1. X removes apple, then adds pear:p2 and plum:s1. Concurrently Y adds apple:a2, removes pear (seeing only p1), then adds plum:s2. Before merging, X removes plum (seeing s1 only). Merge once. Return keys live (sorted values), liveTags (sorted tags), tombstones (sorted removed tags).\n\nReply with exactly one JSON object containing exactly these keys in this order: "live", "liveTags", "tombstones". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        live: ['apple', 'pear', 'plum'],
        liveTags: ['a2', 'p2', 's2'],
        tombstones: ['a1', 'p1', 's1'],
      },
    },
  },
  {
    id: 'frontier-implementation-feature-development-preemptive-scheduler',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Implement the scheduler in ready.ts and dispatch.ts. Jobs [id,arrival,duration,priority]: [a,0,7,3],[b,2,4,1],[c,3,2,1],[d,5,1,0],[e,6,3,2]. At each integer time, include arrivals, choose lowest priority then smallest remaining duration then id lexicographic; run one unit, preempt freely. Completion occurs at end of unit. Return keys timeline (id per unit from t=0 until finished), completions (pairs [id,time], sorted id).\n\nReply with exactly one JSON object containing exactly these keys in this order: "timeline", "completions". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        timeline: [
          'a',
          'a',
          'b',
          'c',
          'c',
          'd',
          'b',
          'b',
          'b',
          'e',
          'e',
          'e',
          'a',
          'a',
          'a',
          'a',
          'a',
        ],
        completions: [
          ['a', 17],
          ['b', 9],
          ['c', 5],
          ['d', 6],
          ['e', 12],
        ],
      },
    },
  },
  {
    id: 'frontier-implementation-feature-development-stable-matching-feature',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Implement applicant-proposing deferred acceptance across preferences.ts and match.ts. Applicants A,B,C,D propose in alphabetical order among free applicants each round; rejected applicants continue next round. Applicant preferences: A=[X,Y,Z,W], B=[X,Z,Y,W], C=[Y,X,W,Z], D=[Y,Z,X,W]. Each institution holds one applicant. Institution preferences: X=[C,B,A,D], Y=[A,D,C,B], Z=[B,C,D,A], W=[D,A,B,C]. Return keys matches (pairs [applicant,institution] sorted applicant), proposals (total proposals). Held applicants can be displaced; never restart their list.\n\nReply with exactly one JSON object containing exactly these keys in this order: "matches", "proposals". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        matches: [
          ['A', 'Y'],
          ['B', 'Z'],
          ['C', 'X'],
          ['D', 'W'],
        ],
        proposals: 10,
      },
    },
  },
  {
    id: 'frontier-implementation-feature-development-parenthesization-counts',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Implement expression.ts + histogram.ts. For the expression 2*3-4*5+6, preserve operand/operator order and enumerate ALL full binary parenthesizations (14 trees); multiplication has no precedence inside an explicitly selected tree. Count distinct trees yielding each integer result. Return keys histogram (pairs [result,count], sorted result ascending), minimum, maximum. Do not deduplicate equal-valued subtrees before multiplying counts.\n\nReply with exactly one JSON object containing exactly these keys in this order: "histogram", "minimum", "maximum". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        histogram: [
          [-82, 1],
          [-46, 1],
          [-38, 1],
          [-28, 1],
          [-22, 3],
          [-20, 1],
          [-8, 1],
          [-4, 2],
          [2, 1],
          [16, 1],
          [22, 1],
        ],
        minimum: -82,
        maximum: 22,
      },
    },
  },
  {
    id: 'frontier-implementation-feature-development-constrained-release-selection',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Implement release selection across packages.ts, budget.ts, and choose.ts. Features [id,cost,value]: A,4,8; B,3,7; C,5,12; D,2,4; E,4,11; F,1,2; G,3,9. Budget 12. Constraints C requires A; E requires B and D; G conflicts with A; F requires exactly one of C and G (if F is selected, exactly one must be selected). Select maximum value, then smallest cost, then lexicographically smallest sorted id array. Return keys selected, cost, value.\n\nReply with exactly one JSON object containing exactly these keys in this order: "selected", "cost", "value". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: { selected: ['B', 'D', 'E', 'G'], cost: 12, value: 31 },
    },
  },
  {
    id: 'frontier-implementation-code-generation-dfa-minimization-table',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Generate a minimized DFA transition fixture for automaton.ts and lexer.ts. Alphabet [0,1], start A, accepting [D,F]. Transitions [state,on0,on1]: [A,B,C],[B,D,E],[C,D,E],[D,F,A],[E,F,A],[F,F,F]. Remove unreachable states, then merge states accepting identical languages. Name a merged class by concatenating original state names alphabetically; sort classes by that label. Return keys start, accepting (sorted labels), transitions (rows [label,on0Label,on1Label]).\n\nReply with exactly one JSON object containing exactly these keys in this order: "start", "accepting", "transitions". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        start: 'A',
        accepting: ['D', 'F'],
        transitions: [
          ['A', 'BC', 'BC'],
          ['BC', 'D', 'E'],
          ['D', 'F', 'A'],
          ['E', 'F', 'A'],
          ['F', 'F', 'F'],
        ],
      },
    },
  },
  {
    id: 'frontier-implementation-code-generation-all-valid-build-orders',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Generate build-order fixtures for graph.ts and emit.ts. Nodes A,B,C,D,E,F. Precedence edges A->D,B->D,B->E,C->E,D->F,E->F. Emit every topological order in lexicographic order as concatenated six-letter strings. Also emit the lexicographically median order using zero-based index floor(count/2). Return keys count, orders, median. No nodes may be omitted or repeated.\n\nReply with exactly one JSON object containing exactly these keys in this order: "count", "orders", "median". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        count: 16,
        orders: [
          'ABCDEF',
          'ABCEDF',
          'ABDCEF',
          'ACBDEF',
          'ACBEDF',
          'BACDEF',
          'BACEDF',
          'BADCEF',
          'BCADEF',
          'BCAEDF',
          'BCEADF',
          'CABDEF',
          'CABEDF',
          'CBADEF',
          'CBAEDF',
          'CBEADF',
        ],
        median: 'BCADEF',
      },
    },
  },
  {
    id: 'frontier-implementation-code-generation-exact-cover-fixture',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Generate the canonical exact-cover fixture for cover.ts. Universe [1,2,3,4,5,6,7]. Named rows: A=[1,4,7],B=[1,4],C=[4,5,7],D=[3,5,6],E=[2,3,6,7],F=[2,7],G=[1,2,3],H=[4,5,6,7],I=[1,6],J=[2,3,4,5,7]. A solution covers each element exactly once. List all solutions with row ids sorted within each, then lexicographically sort solutions by concatenated ids. Return keys solutions, minimumRows.\n\nReply with exactly one JSON object containing exactly these keys in this order: "solutions", "minimumRows". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        solutions: [
          ['B', 'D', 'F'],
          ['G', 'H'],
          ['I', 'J'],
        ],
        minimumRows: 2,
      },
    },
  },
  {
    id: 'frontier-implementation-code-generation-conditional-distribution-matrix',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Generate type-level expectation fixtures for types.ts under these explicit semantics (no compiler execution is requested). A union is a set of atomic names. A naked T in T extends string ? [T] : never distributes across union members; [T] extends [string] does not distribute and succeeds only if EVERY member is string-like. never has zero members, so a distributive conditional over never is never; the wrapped never test succeeds. string-like atoms are x,y; numeric atom is 7. Define D<T>=T extends string ? [T] : never and W<T>=[T] extends [string] ? [T] : never. Evaluate T=x|y, x|7, never. Represent never as [], each tuple as an array of its union\'s sorted atomic strings, and a union of tuples as an array sorted by JSON spelling. Return keys distributed, wrapped, each three results in query order.\n\nReply with exactly one JSON object containing exactly these keys in this order: "distributed", "wrapped". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: { distributed: [[['x'], ['y']], [['x']], []], wrapped: [[['x', 'y']], [], [[]]] },
    },
  },
  {
    id: 'frontier-implementation-code-generation-mapped-optional-key-classification',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Generate a compile-time key-classification fixture spanning model.ts and mapped.ts. Explicit rules: an optional property adds undefined to its READ type. RequiredKeys picks properties whose optional flag is false, not properties whose type excludes undefined. NonUndefinedKeys picks keys whose read type has no undefined. NonNullableRequired removes optional flags and removes null/undefined members from each declared value type. Model properties [key,optional,declaredMembers]: a,false,[number,undefined]; b,true,[string]; c,false,[null,string]; d,true,[boolean,null]; e,false,[never] where never denotes an empty union. Sort keys and union members lexicographically. Return keys required, nonUndefined, normalized; normalized is rows [key,members].\n\nReply with exactly one JSON object containing exactly these keys in this order: "required", "nonUndefined", "normalized". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        required: ['a', 'c', 'e'],
        nonUndefined: ['c', 'e'],
        normalized: [
          ['a', ['number']],
          ['b', ['string']],
          ['c', ['string']],
          ['d', ['boolean']],
          ['e', []],
        ],
      },
    },
  },
  {
    id: 'frontier-implementation-code-generation-overload-inference-fixture',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Generate a types.ts fixture using only these explicit TypeScript-style rules: Parameters and ReturnType inspect the LAST declared overload signature, not the first matching call; a direct call uses the first compatible overload; an intersection of function signatures preserves their listed order. Signatures in order: (x:'a')->'A'; (x:'b',n:number)->'B'; (x:string,n?:number)->'S'. For direct calls ['a'],['b',2],['z'],['a',2], arity must fit and literals must match; string accepts every listed string. The final signature's tuple spelling is exactly [string,number?]. Return keys parameters (array of strings), returnType (string), calls (return-type strings in call order).\n\nReply with exactly one JSON object containing exactly these keys in this order: \"parameters\", \"returnType\", \"calls\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: { parameters: ['string', 'number?'], returnType: 'S', calls: ['A', 'B', 'S', 'S'] },
    },
  },
  {
    id: 'frontier-implementation-code-generation-union-intersection-compatibility',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Generate a type compatibility table for types.ts. Explicit rules: objects have required fields; field unions are sets; intersection merges all fields and intersects value sets for fields present on both sides; an empty field set makes the whole object uninhabitable. A={kind:[a,b],x:[1,2]}, B={kind:[b,c],x:[2,3],y:[yes]}, C={kind:[c],z:[ok]}. Compute A&B, A&C, B&C, A&B&C. Render an uninhabitable result as null; otherwise render sorted rows [field,sortedMemberStrings]. Numbers 1,2,3 are represented as strings. Return keys intersections, inhabitable (boolean per result).\n\nReply with exactly one JSON object containing exactly these keys in this order: "intersections", "inhabitable". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        intersections: [
          [
            ['kind', ['b']],
            ['x', ['2']],
            ['y', ['yes']],
          ],
          null,
          [
            ['kind', ['c']],
            ['x', ['2', '3']],
            ['y', ['yes']],
            ['z', ['ok']],
          ],
          null,
        ],
        inhabitable: [true, false, true, false],
      },
    },
  },
  {
    id: 'frontier-implementation-code-generation-recursive-tuple-union',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Generate tuple-transform expectations for tuple.ts and parser.ts. Explicit rules: Paths<T> recursively branches each tuple element\'s union, concatenating one member at each position; an empty union at ANY position yields no paths; an empty tuple yields one empty path. Then DropAdjacentDuplicates removes consecutive equal members in each path but not separated duplicates; deduplicate transformed tuples and sort by JSON spelling. Inputs: [[a,b],[a,c],[b,c]], [[a],[],[b]], [], [[x,y],[x,y],[x]]. Return keys expandedCounts (before transformation), normalized (array of tuple-list results in input order). All members are strings.\n\nReply with exactly one JSON object containing exactly these keys in this order: "expandedCounts", "normalized". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        expandedCounts: [8, 0, 1, 4],
        normalized: [
          [
            ['a', 'b'],
            ['a', 'c', 'b'],
            ['a', 'c'],
            ['b', 'a', 'b'],
            ['b', 'a', 'c'],
            ['b', 'c', 'b'],
            ['b', 'c'],
          ],
          [],
          [[]],
          [['x', 'y', 'x'], ['x'], ['y', 'x']],
        ],
      },
    },
  },
  {
    id: 'frontier-implementation-code-generation-stack-bytecode-emission',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Generate stack bytecode for compiler.ts from ast.ts. AST is sub(mul(add(var(a),const(3)),var(b)),div(var(c),const(2))). Emit postorder instructions: var(x)->[load,x], const(n)->[push,n], binary op->both children left then right then [op]. Constant-fold only subtrees with two constant children; division is exact rational arithmetic (none here). Execute with a=4,b=5,c=6. Return keys instructions (instruction arrays), result, maxStack (maximum stack depth AFTER any instruction).\n\nReply with exactly one JSON object containing exactly these keys in this order: "instructions", "result", "maxStack". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        instructions: [
          ['load', 'a'],
          ['push', 3],
          ['add'],
          ['load', 'b'],
          ['mul'],
          ['load', 'c'],
          ['push', 2],
          ['div'],
          ['sub'],
        ],
        result: 32,
        maxStack: 3,
      },
    },
  },
  {
    id: 'frontier-implementation-code-generation-nfa-subset-table',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Generate a DFA fixture by subset construction for nfa.ts. NFA states 0..4, start 0, accepting 4. Epsilon edges 0->1,0->3,2->1. Labeled edges: 1-a->2,2-b->4,3-b->3,3-a->4,4-b->4. Alphabet [a,b]. Start subset is epsilon closure of {0}. Discover DFA subsets breadth-first, visiting a before b, including the empty dead subset. Label each subset by concatenated sorted state digits; label empty as \'-\'. Return keys start, accepting (labels in discovery order), transitions (rows [label,aLabel,bLabel] in discovery order).\n\nReply with exactly one JSON object containing exactly these keys in this order: "start", "accepting", "transitions". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        start: '013',
        accepting: ['124', '4'],
        transitions: [
          ['013', '124', '3'],
          ['124', '12', '4'],
          ['3', '4', '3'],
          ['12', '12', '4'],
          ['4', '-', '4'],
          ['-', '-', '-'],
        ],
      },
    },
  },
  {
    id: 'frontier-implementation-code-generation-canonical-commutative-ast',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Generate canonical serialized IR for normalize.ts. IR input is ['add',['mul',['var','b'],['const',2]],['add',['const',3],['var','a'],['const',-3]],['mul',['const',0],['var','z']],['mul',['const',1],['var','b']]]. add/mul are variadic. Normalize children recursively; flatten same operators; combine all constants; mul with zero becomes ['const',0]; omit add-zero and mul-one when other children exist; collapse unary add/mul; sort remaining children by their compact JSON text using ASCII lexicographic order. Return keys ir, variables (sorted distinct variable names in normalized IR).\n\nReply with exactly one JSON object containing exactly these keys in this order: \"ir\", \"variables\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {
        ir: ['add', ['mul', ['const', 2], ['var', 'b']], ['var', 'a'], ['var', 'b']],
        variables: ['a', 'b'],
      },
    },
  },
  {
    id: 'frontier-implementation-code-generation-lcs-patch-generation',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Generate a deterministic minimal insert/delete patch for diff.ts. Old tokens [A,B,A,C,B,D,A], new [B,A,B,C,A,D,B]. No replace operation. Find a longest common subsequence; among equal-length LCS token sequences choose lexicographically smallest. Embeddings of that selected LCS use earliest possible indices independently in each input. Return keys lcs (tokens), oldKeep (zero-based indices), newKeep (zero-based indices), edits (old.length+new.length-2*lcs.length).\n\nReply with exactly one JSON object containing exactly these keys in this order: "lcs", "oldKeep", "newKeep", "edits". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: { lcs: ['A', 'B', 'A', 'B'], oldKeep: [0, 1, 2, 4], newKeep: [1, 2, 4, 6], edits: 6 },
    },
  },
  {
    id: 'frontier-implementation-code-generation-join-plan-fixture',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Generate SQL acceptance fixtures from accounts.ts, events.ts, query.ts. Accounts [id,tenant,active]: [a,X,true],[b,X,false],[c,Y,true],[d,X,true]. Events [account,seq,amount,void]: [a,1,5,false],[a,2,9,true],[a,3,-2,false],[b,1,100,false],[c,1,7,false],[d,1,4,true],[d,2,6,false],[d,2,6,false]. Query: active X accounts; deduplicate events by (account,seq) BEFORE aggregate; exclude void; left join accounts so missing totals become 0. Keep totals >=0; order total descending then id ascending. Return keys rows (pairs [id,total]), grandTotal.\n\nReply with exactly one JSON object containing exactly these keys in this order: "rows", "grandTotal". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        rows: [
          ['d', 6],
          ['a', 3],
        ],
        grandTotal: 9,
      },
    },
  },
  {
    id: 'frontier-implementation-code-generation-minimum-hitting-set',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Generate the smallest integration-test selection fixture for coverage.ts. Required bug paths are sets of tests, at least one selected test must hit each: [A,B,D],[B,C],[C,D,E],[A,E,F],[D,F],[B,E],[A,C,F]. Test costs A=3,B=4,C=2,D=5,E=3,F=2. Minimize total cost, then selected count, then sorted id string. Return keys tests (sorted ids), cost, hits (for each path in listed order, its sorted selected test ids).\n\nReply with exactly one JSON object containing exactly these keys in this order: "tests", "cost", "hits". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        tests: ['B', 'C', 'F'],
        cost: 8,
        hits: [['B'], ['B', 'C'], ['C'], ['F'], ['F'], ['B'], ['C', 'F']],
      },
    },
  },
  {
    id: 'frontier-implementation-code-generation-checksum-carry-fixture',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Generate protocol.ts checksum fixtures. For each byte array, group big-endian 16-bit words, pad an odd last byte with low byte zero, sum with end-around carry until <=65535, then one\'s-complement (xor 65535). Inputs [255,255,0,1], [255,255,255,255,255], [1,2,3,4,5], [128,0,128,0,0,1], []. Return keys words (word arrays in input order), checksums (four lowercase hex digits per input), verified (boolean: folded sum INCLUDING the checksum equals 65535). Empty input\'s checksum is ffff.\n\nReply with exactly one JSON object containing exactly these keys in this order: "words", "checksums", "verified". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        words: [[65535, 1], [65535, 65535, 65280], [258, 772, 1280], [32768, 32768, 1], []],
        checksums: ['fffe', '00ff', 'f6f9', 'fffd', 'ffff'],
        verified: [true, true, true, true, true],
      },
    },
  },
  {
    id: 'frontier-implementation-test-creation-binary64-cancellation-oracle',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Create a regression oracle spanning sum.ts and test.ts. JavaScript Number is IEEE-754 binary64, round-to-nearest ties-to-even after each arithmetic operation; no extended precision or reassociation. Inputs: [1e16,1,-1e16], [9007199254740992,1,1], [0.1,0.2,-0.3], [Number.MIN_VALUE,Number.MIN_VALUE,-Number.MIN_VALUE]. Compare left fold starting at +0 against right-associated x0+(x1+x2). Return keys left, right, equal (Object.is comparisons per row). JSON numbers use ordinary JSON.stringify spelling.\n\nReply with exactly one JSON object containing exactly these keys in this order: "left", "right", "equal". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        left: [0, 9007199254740992, 5.551115123125783e-17, 5e-324],
        right: [0, 9007199254740994, 2.7755575615628914e-17, 5e-324],
        equal: [true, false, false, true],
      },
    },
  },
  {
    id: 'frontier-implementation-test-creation-euclidean-division-table',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Create edge-test fixtures for integer.ts. Euclidean division for integer a and nonzero integer b returns q,r satisfying a=b*q+r and 0<=r<abs(b), unlike truncation toward zero. Queries [-17,5],[-17,-5],[17,-5],[17,5],[-1,7],[-1,-7],[0,-3],[9007199254740993,7]. All computation is exact integers; output q and r as decimal strings to preserve large values. Return keys quotients, remainders in query order.\n\nReply with exactly one JSON object containing exactly these keys in this order: "quotients", "remainders". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        quotients: ['-4', '4', '-3', '3', '-1', '1', '0', '1286742750677284'],
        remainders: ['3', '3', '2', '2', '6', '6', '0', '5'],
      },
    },
  },
  {
    id: 'frontier-implementation-test-creation-decimal-double-rounding',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Create acceptance tests for decimal.ts and money.ts. Input decimal strings 1.2451,1.2449,1.2550,-1.2451,-1.2551,9.9951. Round exactly to nearest at the requested number of fractional digits; ties to even; retain trailing zeros and normalize zero sign positive. Compare direct rounding to 2 digits against rounding to 3 then 2 digits. Return keys direct, staged, mismatches (zero-based input indices). Do not parse into binary floating point.\n\nReply with exactly one JSON object containing exactly these keys in this order: "direct", "staged", "mismatches". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        direct: ['1.25', '1.24', '1.26', '-1.25', '-1.26', '10.00'],
        staged: ['1.24', '1.24', '1.26', '-1.24', '-1.26', '10.00'],
        mismatches: [0, 3],
      },
    },
  },
  {
    id: 'frontier-implementation-test-creation-next-float-bit-oracle',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Create binary64 boundary tests for next.ts. nextUp(x) is the least representable Number strictly greater than x; nextDown analogous. Inputs are +0,-0,1,-1,Number.MIN_VALUE,Number.MAX_VALUE. Return keys upBits, downBits as arrays of exactly 16 lowercase hexadecimal digits encoding each result\'s IEEE-754 64-bit pattern in big-endian order. Both zero signs step upward to the smallest positive subnormal and downward to the smallest negative subnormal. Include infinities by bit pattern, not JSON infinity.\n\nReply with exactly one JSON object containing exactly these keys in this order: "upBits", "downBits". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        upBits: [
          '0000000000000001',
          '0000000000000001',
          '3ff0000000000001',
          'bfefffffffffffff',
          '0000000000000002',
          '7ff0000000000000',
        ],
        downBits: [
          '8000000000000001',
          '8000000000000001',
          '3fefffffffffffff',
          'bff0000000000001',
          '0000000000000000',
          '7feffffffffffffe',
        ],
      },
    },
  },
  {
    id: 'frontier-implementation-test-creation-saturating-multiply-oracle',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Create fixed-point tests for fixed.ts and clamp.ts. Signed Q8.8 inputs are integer raw values in [-32768,32767]. Multiply exact raw integers, divide by 256, round nearest ties to even, THEN saturate to that raw interval. Inputs [32767,257],[-32768,257],[129,128],[131,128],[-129,128],[-131,128],[32767,-32768],[1,128]. Return keys raw (integer outputs), saturated (booleans whether clamp changed the rounded result). A pre-multiply clamp or truncation is incorrect.\n\nReply with exactly one JSON object containing exactly these keys in this order: "raw", "saturated". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        raw: [32767, -32768, 64, 66, -64, -66, -32768, 0],
        saturated: [true, true, false, false, false, false, true, false],
      },
    },
  },
  {
    id: 'frontier-implementation-test-creation-half-open-coverage-oracle',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Create interval sweep tests across normalize.ts and coverage.ts. Intervals [start,end,weight]: [0,4,2],[2,6,3],[4,7,-1],[6,8,5],[1,3,-2],[7,7,99],[8,10,1]. All half-open; empty intervals contribute nothing. Emit maximal nonempty spans of constant total weight on [0,10), including zero-weight spans, merging adjacent equal-weight spans. Return keys segments (triples [start,end,total]), integral (sum duration*total), maximum.\n\nReply with exactly one JSON object containing exactly these keys in this order: "segments", "integral", "maximum". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        segments: [
          [0, 1, 2],
          [1, 2, 0],
          [2, 3, 3],
          [3, 4, 5],
          [4, 6, 2],
          [6, 7, 4],
          [7, 8, 5],
          [8, 10, 1],
        ],
        integral: 25,
        maximum: 5,
      },
    },
  },
  {
    id: 'frontier-implementation-test-creation-sql-three-valued-oracle',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Create predicate tests for sql.ts. Values a=[null,0,1,2,null,3], b=[1,null,1,2,null,2]. SQL equality and greater-than return UNKNOWN if either operand is null. Predicate is NOT(a=b) OR (a>1 AND b IS NULL). SQL NOT UNKNOWN=UNKNOWN, FALSE AND UNKNOWN=FALSE, TRUE OR UNKNOWN=TRUE; otherwise use three-valued logic. WHERE keeps only TRUE. Return keys truth (strings T,F,U per row), kept (zero-based kept indices). Do not use JavaScript null equality.\n\nReply with exactly one JSON object containing exactly these keys in this order: "truth", "kept". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: { truth: ['U', 'U', 'F', 'F', 'U', 'T'], kept: [5] },
    },
  },
  {
    id: 'frontier-implementation-test-creation-ambiguous-clock-fold',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Create timezone resolver tests for local.ts with an explicitly supplied transition table, not host timezone rules. Zone offset is +120 minutes before UTC minute 180, +60 minutes for UTC [180,300), and +120 minutes thereafter. Local minute = UTC minute + offset. Resolve local minutes [239,240,299,300,359,360,419,420]. Return all valid UTC-minute candidates sorted ascending. Ambiguous policy chooses earliest candidate; gap policy chooses null (never shifts). Return keys candidates, selected.\n\nReply with exactly one JSON object containing exactly these keys in this order: "candidates", "selected". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        candidates: [[119], [120, 180], [179, 239], [240], [299], [], [], [300]],
        selected: [119, 120, 179, 240, 299, null, null, 300],
      },
    },
  },
  {
    id: 'frontier-implementation-test-creation-unicode-index-contract',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Create index-boundary tests for text.ts and splice.ts. String is A\ud83d\ude00e\u0301\ud834\udd1eZ (A, grinning-face U+1F600, e, combining acute U+0301, musical G-clef U+1D11E, Z). Public indices count Unicode scalar values, not UTF-16 units and not graphemes. Slice ranges [1,4],[2,3],[3,5],[4,6],[0,6] are half-open scalar indices. Return keys scalarSlices, utf16Slices (JavaScript slice using the same numeric indices), lengths (UTF-16 length then scalar count). Unpaired surrogate results in utf16Slices must be escaped with ordinary JSON serialization.\n\nReply with exactly one JSON object containing exactly these keys in this order: "scalarSlices", "utf16Slices", "lengths". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        scalarSlices: [
          '\ud83d\ude00e\u0301',
          'e',
          '\u0301\ud834\udd1e',
          '\ud834\udd1eZ',
          'A\ud83d\ude00e\u0301\ud834\udd1eZ',
        ],
        utf16Slices: [
          '\ud83d\ude00e',
          '\ude00',
          'e\u0301',
          '\u0301\ud834',
          'A\ud83d\ude00e\u0301\ud834',
        ],
        lengths: [8, 6],
      },
    },
  },
  {
    id: 'frontier-implementation-test-creation-zigzag-varint-boundaries',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Create codec.ts tests for signed 64-bit ZigZag then unsigned base-128 varint. ZigZag(n) is 2*n for n>=0, otherwise -2*n-1. Emit little-endian 7-bit groups with high bit 1 on all but final byte; zero emits [0]. Inputs decimal strings -1,0,1,-64,64,-65,8192,-9223372036854775808,9223372036854775807. Return keys bytes (byte arrays), lengths. All intermediate arithmetic is exact BigInt, never 32-bit JS bitwise.\n\nReply with exactly one JSON object containing exactly these keys in this order: "bytes", "lengths". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        bytes: [
          [1],
          [0],
          [2],
          [127],
          [128, 1],
          [129, 1],
          [128, 128, 1],
          [255, 255, 255, 255, 255, 255, 255, 255, 255, 1],
          [254, 255, 255, 255, 255, 255, 255, 255, 255, 1],
        ],
        lengths: [1, 1, 1, 1, 2, 2, 3, 10, 10],
      },
    },
  },
  {
    id: 'frontier-implementation-test-creation-rolling-hash-modular-product',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Create arithmetic oracle tests for hash.ts. For bytes [255,1,128,0,254,3], use h0=4294967290, hi+1=(hi*16777619+byte) mod 4294967291, all EXACT integer arithmetic. Also model the broken Number version performing multiply/add in binary64 before remainder; no bitwise truncation. Return keys exact (decimal-string states after each byte), floating (decimal-string states from the broken version), firstMismatch (zero-based index).\n\nReply with exactly one JSON object containing exactly these keys in this order: "exact", "floating", "firstMismatch". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        exact: ['4278189927', '3640268534', '2347699934', '705697553', '1227268734', '2805960646'],
        floating: [
          '4278189930',
          '3690601392',
          '4278550489',
          '1403217389',
          '2564532389',
          '1237764797',
        ],
        firstMismatch: 0,
      },
    },
  },
  {
    id: 'frontier-implementation-test-creation-linearizable-register-histories',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Create concurrent integration oracles for register.ts. Initial value 0. Each operation has invocation/response times; strict real-time order requires A before B only if A.response<B.invoke. Histories: H0: write(1) [0,5], write(2) [2,7], read()->1 [6,8]; H1: write(1) [0,2], write(2) [3,5], read()->1 [6,8]; H2: write(1) [0,4], read()->0 [1,2], read()->1 [3,5]; H3: write(1) [0,2], read()->0 [2,3]. Equal endpoints overlap by this contract. Enumerate each legal sequential permutation preserving strict real-time and observed read values. Return keys linearizable (booleans), witnessCounts (number of valid permutations). Operations are distinct even when values match.\n\nReply with exactly one JSON object containing exactly these keys in this order: "linearizable", "witnessCounts". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: { linearizable: [true, false, true, true], witnessCounts: [2, 0, 1, 1] },
    },
  },
  {
    id: 'frontier-implementation-test-creation-promise-cancellation-integration',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Create an integration expectation for queue.ts and cancellation.ts using ordinary JavaScript FIFO microtasks. Code: const log=[]; let cancelled=false; const job=Promise.resolve().then(()=>{log.push('start');return Promise.resolve().then(()=>{log.push(cancelled?'skip':'commit')})}).finally(()=>log.push('finish')); queueMicrotask(()=>{log.push('cancel');cancelled=true}); job.then(()=>log.push('observer')); await job; log.push('awaited'); await Promise.resolve(); Return keys log, committed (boolean whether commit appears). The entire code runs inside one async function; no other tasks exist. finally's promise adoption and observer registration matter.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"log\", \"committed\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {
        log: ['start', 'cancel', 'skip', 'finish', 'observer', 'awaited'],
        committed: false,
      },
    },
  },
  {
    id: 'frontier-implementation-test-creation-minimal-monotonicity-counterexample',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Create a property-based regression fixture for search.ts. Intended predicate monotonicity: once x>=threshold is true, it stays true for increasing x. Broken implementation computes (x & 255)>=threshold using JavaScript 32-bit bitwise on integer x. Enumerate thresholds 1..255, x pairs 0<=a<b<=520 with predicate(a)=true and predicate(b)=false. Choose the counterexample minimizing (b-a), then b, then threshold, then a. Return keys threshold, a, b, observed (two booleans), intended (two booleans for the unmasked comparison). This is shrinking by the supplied ordering, not just any failing pair.\n\nReply with exactly one JSON object containing exactly these keys in this order: "threshold", "a", "b", "observed", "intended". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: { threshold: 1, a: 255, b: 256, observed: [true, false], intended: [true, true] },
    },
  },
  {
    id: 'frontier-implementation-test-creation-largest-remainder-allocation',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Create allocation tests for split.ts and ledger.ts. Allocate each signed integer total to weights [5,3,2]. Work on abs(total), floor exact quotas, give remaining units to descending fractional remainder then smaller recipient index, then restore sign. Queries [1,2,3,5,7,-5,-7,0]. Never independently round quotas and never rank negative remainders. Return keys allocations (integer triples), sums (sum of each allocation), tiedQueries (query indices where two recipients have equal NONZERO fractional remainders before awards).\n\nReply with exactly one JSON object containing exactly these keys in this order: "allocations", "sums", "tiedQueries". Preserve every specified array order. No extra keys or commentary.',
    check: {
      kind: 'json_equal',
      value: {
        allocations: [
          [1, 0, 0],
          [1, 1, 0],
          [1, 1, 1],
          [3, 1, 1],
          [4, 2, 1],
          [-3, -1, -1],
          [-4, -2, -1],
          [0, 0, 0],
        ],
        sums: [1, 2, 3, 5, 7, -5, -7, 0],
        tiedQueries: [3, 5],
      },
    },
  },
];
