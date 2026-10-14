import type { DeciderCase } from '../decider-cases';

const SYSTEM_PROMPT =
  'You are a precise coding assistant. Solve the supplied fixture under its stated rules. Reply with only the requested JSON object, without fences or explanations.';

export const DEBUGGING_FRONTIER_CASES: readonly DeciderCase[] = [
  {
    id: 'frontier-debugging-bug-fixing-aba-tagged-cas',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Fix stack.ts plus reclaim.ts. Head initially (A,0), links A->B->C. T1 reads head A and next B, then pauses. T2 pops A, pops B, pushes A with its next changed to C; every successful head change increments an unbounded tag. T1 resumes. Current CAS checks pointer only and tries to replace head with saved B. Choices: P=compare pointer only; T=compare pointer AND saved tag; N=compare pointer and require current tag>=saved tag. Required: no removed node may re-enter via stale CAS. Select the unique valid patch and report resulting head and whether T1 CAS succeeds under the patched exact schedule. Return keys patch (P/T/N), head (node string), tag (integer), t1Succeeded. T1 never retries.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"patch\", \"head\", \"tag\", \"t1Succeeded\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"patch":"T","head":"A","tag":3,"t1Succeeded":false},
    },
  },
  {
    id: 'frontier-debugging-bug-fixing-singleflight-generation-cleanup',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Fix inflight.ts + invalidation.ts. load(k) caches a distinct promise token; invalidate(k) deletes the entry but doesn't cancel the underlying request. Each request's finally currently deletes k unconditionally. Schedule: load K creates p1; invalidate K; load K creates p2; p1 settles; load K again; p2 settles; load K again. New tokens p3,p4,... assigned only when no cached token exists. Choices: A=finally deletes only if map.get(k)===that request's token; B=never delete on success; C=delete before resolving but unconditionally. Contract: coalesce current-generation pending work and remove it after settling. Return keys patch, returned (four observations: first load token, second load token, load after p1, load after p2), requests (count). Settling does not return a token.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"patch\", \"returned\", \"requests\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"patch":"A","returned":["p1","p2","p2","p3"],"requests":3},
    },
  },
  {
    id: 'frontier-debugging-bug-fixing-tarjan-active-edge',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Fix graph.ts Tarjan SCC implementation. DFS visits nodes A,B,C,D,E,F alphabetically and each adjacency list alphabetically. Edges A->B,B->A,C->B,C->D,D->C,D->E,E->F,F->E. Bug: for every already visited neighbor, low[v]=min(low[v],index[w]), even after w has left the stack. Choices: S=apply that rule only when w is on the active stack; V=apply only when w is visited; L=apply min(low[v],low[w]) even off-stack. Tree-child recursion continues to propagate child low normally. Return keys patch, components (sorted members, then components sorted first member), roots (SCC root nodes in emission order under the patched DFS).\n\nReply with exactly one JSON object containing exactly these keys in this order: \"patch\", \"components\", \"roots\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"patch":"S","components":[["A","B"],["C","D"],["E","F"]],"roots":["A","E","C"]},
    },
  },
  {
    id: 'frontier-debugging-bug-fixing-affine-lazy-composition',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Fix lazy.ts and segment.ts. A pending tag (m,a) maps each value x to m*x+a. Existing pending tag O=(om,oa), newly applied tag N=(nm,na). Choices for combined tag: A=(om*nm,oa*nm+na); B=(om*nm,oa+na); C=(om*nm,om*na+oa). Contract applies old first, then new. Start values [1,2,3,4,5,6]. Updates half-open ranges: [0,6) with (2,1), [1,5) with (3,-2), [2,6) with (0,7), [0,3) with (-1,4). Return keys patch, values, sums (sum [0,6), [1,4), [3,6)). Tags act on all values even when m=0.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"patch\", \"values\", \"sums\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"patch":"A","values":[1,-9,-3,7,7,7],"sums":[10,-5,21]},
    },
  },
  {
    id: 'frontier-debugging-bug-fixing-dijkstra-stop-condition',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Fix queue.ts and shortest.ts. Directed weighted edges S->A:10,S->B:1,B->A:1,A->T:1,B->T:100,S->T:50. Algorithm pops smallest tentative cost (ties node id), relaxes outgoing edges, and permits stale entries. Bug returns when T is FIRST ENQUEUED. Choices: E=return when enqueued; P=return when a nonstale T entry is popped; M=return when any neighbor of T is popped. Return keys patch, distance, path (choose lexicographically smaller full node sequence on equal costs), popped (nonstale nodes up to termination). Costs are nonnegative.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"patch\", \"distance\", \"path\", \"popped\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"patch":"P","distance":3,"path":["S","B","A","T"],"popped":["S","B","A","T"]},
    },
  },
  {
    id: 'frontier-debugging-bug-fixing-large-index-midpoint',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Fix search.ts. lowerBound finds first integer i in [0,n) satisfying i>=target; use half-open lo=0,hi=n and usual if(mid<target)lo=mid+1;else hi=mid. n=4294967301, target=4294967297. Current mid=(lo+hi)>>>1 incorrectly coerces to 32 bits. Choices: A=lo+Math.floor((hi-lo)/2); B=(lo+hi)>>1; C=Math.floor(lo+hi)/2. Index domain is integer and <Number.MAX_SAFE_INTEGER. Return keys patch, index, iterations, lastMid (mid of final iteration). No array allocation or host compiler is needed.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"patch\", \"index\", \"iterations\", \"lastMid\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"patch":"A","index":4294967297,"iterations":32,"lastMid":4294967296},
    },
  },
  {
    id: 'frontier-debugging-bug-fixing-decimal-id-ordering',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Fix ids.ts and pagination.ts. Nonnegative decimal id strings may exceed safe integer. Canonicalize by stripping leading zeros but preserve one zero; numeric ascending order compares canonical length then lexical digits; equal numeric ids keep original input order. Choices: N=Number(a)-Number(b); L=raw string lexical; C=canonical length then lexical, stable ties. Input [9007199254740993,0010,9,9007199254740992,000,10,18446744073709551616,18446744073709551615] (all strings). Return keys patch, ordered (original spellings), page (indices 3 through 6 inclusive of ordered).\n\nReply with exactly one JSON object containing exactly these keys in this order: \"patch\", \"ordered\", \"page\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"patch":"C","ordered":["000","9","0010","10","9007199254740992","9007199254740993","18446744073709551615","18446744073709551616"],"page":["10","9007199254740992","9007199254740993","18446744073709551615"]},
    },
  },
  {
    id: 'frontier-debugging-bug-fixing-idempotent-ledger-atomicity',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Fix claim.ts + ledger.ts. A credit request key K adds 7 to initial balance 10 once. Unique claims and ledger effects must commit atomically. Schedule: T1 sees no K; T2 sees no K; T1 adds credit; T2 adds credit; T1 inserts K; T2 insertion conflicts. Current credit writes commit independently before claiming. Choices: C=claim and credit in SAME transaction, rollback entire loser; R=retry loser credit; D=deduplicate only response. Under patch C, run T1's transaction through commit first, then T2 conflicts; a later T3 retry finds K. Return keys patch, balance, committedCredits, responses (T1,T2,T3 strings: applied or duplicate). Isolation/unique index guarantees are explicitly atomic.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"patch\", \"balance\", \"committedCredits\", \"responses\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"patch":"C","balance":17,"committedCredits":1,"responses":["applied","duplicate","duplicate"]},
    },
  },
  {
    id: 'frontier-debugging-bug-fixing-kmp-border-fallback',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Fix prefix.ts and matcher.ts for KMP. On mismatch with matched prefix length j>0, choices A=j=pi[j-1], B=j-- then consume the mismatching text character, C=j=0 then consume. Only A is intended to reconsider the SAME character until compatible or j=0. Pattern 'ababaca', text 'ababababacababaca'. After reporting a match set j=pi[j-1] to permit overlaps. Return keys patch, prefix (pi array for pattern), matches (zero-based start indices).\n\nReply with exactly one JSON object containing exactly these keys in this order: \"patch\", \"prefix\", \"matches\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"patch":"A","prefix":[0,0,1,2,3,0,1],"matches":[4,10]},
    },
  },
  {
    id: 'frontier-debugging-bug-fixing-persistent-path-copy',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Fix tree.ts + history.ts. A persistent binary search tree initially root 4, left 2(children 1,3), right 6(children 5,7), every node distinct. Insert 0 to create v1 from v0, then insert 8 to create v2 from v1. Choices M=mutate existing child pointers; D=deep-copy every existing node on each insert; P=copy only nodes along insertion path and allocate the new leaf. Required preserve all snapshots AND allocate minimum nodes. Return keys patch, allocations (new nodes per insertion), sharedV0V1 (shared existing node values sorted), sharedV1V2 (same), inorderV0, inorderV2.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"patch\", \"allocations\", \"sharedV0V1\", \"sharedV1V2\", \"inorderV0\", \"inorderV2\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"patch":"P","allocations":[4,4],"sharedV0V1":[3,5,6,7],"sharedV1V2":[0,1,2,3,5],"inorderV0":[1,2,3,4,5,6,7],"inorderV2":[0,1,2,3,4,5,6,7,8]},
    },
  },
  {
    id: 'frontier-debugging-bug-fixing-never-detection-type-patch',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Fix types.ts + dispatcher.ts without invoking a compiler. Explicit semantics: naked T conditionals distribute; never is an empty union, so a naked conditional applied to never yields never regardless of branch. Wrapping in [T] suppresses distribution. The dispatcher must return 'empty' for never, 'all-string' if every member is string-like, and 'mixed' otherwise. Choices A: T extends never ? 'empty' : T extends string ? 'all-string' : 'mixed'; B: [T] extends [never] ? 'empty' : [T] extends [string] ? 'all-string' : 'mixed'; C: [T] extends [string] ? 'all-string' : 'mixed'. Queries never, 'x'|'y', 'x'|42, 42. Return keys patch, results (one string per query).\n\nReply with exactly one JSON object containing exactly these keys in this order: \"patch\", \"results\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"patch":"B","results":["empty","all-string","mixed","mixed"]},
    },
  },
  {
    id: 'frontier-debugging-bug-fixing-resource-owner-handoff',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Fix resources.ts + timeout.ts. Lease owns descriptor D until either a successful handoff atomically changes state owned->transferred, or timeout atomically changes owned->closed and closes once. Consumer closes a transferred descriptor exactly once after use. Schedule: acquire D; prepare handoff; timeout fires; handoff commit runs; consumer attempts use only if handoff succeeded; normal finally runs. Choices U=unconditional handoff and unconditional finally close; S=CAS state transitions and finally closes only if it wins owned->closed; F=ignore timeout until consumer finishes. Contract timeout must close promptly, never allow use-after-close, close exactly once. Return keys patch, handoffSucceeded, useCount, closes, state.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"patch\", \"handoffSucceeded\", \"useCount\", \"closes\", \"state\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"patch":"S","handoffSucceeded":false,"useCount":0,"closes":1,"state":"closed"},
    },
  },
  {
    id: 'frontier-debugging-bug-fixing-ring-buffer-release-publication',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Fix producer.ts and consumer.ts for a one-slot SPSC ring under explicitly weak memory. Slot payload begins old, flag=0. Producer writes payload=new then publishes flag=1. Without release/acquire, consumer seeing flag=1 may still read old. Choices R=release flag store and acquire flag load before payload read; A=atomic relaxed flag only; F=acquire store and release load (invalid ordering). With R, happens-before forces new when flag=1. Across permitted observations, consumer returns null if flag=0, else payload. Return keys patch, permitted (unique outputs sorted ASCII with null first), forbidden (outputs possible without R but excluded with R). No actual hardware execution is requested; use the supplied memory model.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"patch\", \"permitted\", \"forbidden\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"patch":"R","permitted":[null,"new"],"forbidden":["old"]},
    },
  },
  {
    id: 'frontier-debugging-bug-fixing-merge-watermark-equality',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Fix merge.ts + watermark.ts. Two sorted streams emit (time,id), and a stream watermark W guarantees no future record with time<W, but DOES permit time=W. A buffered record at time t can be emitted only if every stream's watermark is strictly >t (or stream ended). Choices G=all W>=t; S=all W>t; O=any W>t. At checkpoints: C0 buffer [(5,a),(5,c),(6,d)], watermarks [5,7]; C1 add (5,b), watermarks [6,7]; C2 watermarks [7,7]; C3 both ended. Emission order globally (time,id). Return keys patch, emittedByCheckpoint (arrays of ids newly emitted at each checkpoint), finalOrder. All buffer entries belong to the merged queue.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"patch\", \"emittedByCheckpoint\", \"finalOrder\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"patch":"S","emittedByCheckpoint":[[],["a","b","c"],["d"],[]],"finalOrder":["a","b","c","d"]},
    },
  },
  {
    id: 'frontier-debugging-bug-fixing-rollback-dsu-compression',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Fix rollback.ts DSU. Parent roots begin 0..5, union by size, tie smaller root; each successful union logs ONLY attached root's old parent and winner's old size. Snapshot is log length. Current find path-compresses but those changes are NOT logged. Choices N=disable compression in find; C=keep unlogged compression; R=clear log at snapshot. Required rollback restores connectivity exactly with this log format. Sequence union(0,1), union(2,3), snapshot S, union(1,2), union(4,5), find(3), rollback(S). Return keys patch, parents (six integers), sizes (six stored size integers, including attached roots' unchanged stored sizes), connected (pairs tests [0,1],[0,3],[2,3],[4,5]).\n\nReply with exactly one JSON object containing exactly these keys in this order: \"patch\", \"parents\", \"sizes\", \"connected\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"patch":"N","parents":[0,0,2,2,4,5],"sizes":[2,1,2,1,1,1],"connected":[true,false,true,false]},
    },
  },
  {
    id: 'frontier-debugging-test-repair-weighted-edit-distance',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Repair ONLY the golden test in align.test.ts; production align.ts follows the authoritative contract. Transform source 'CAABC' to target 'ACBAC'. Costs: insert=2, delete=2, substitute=3, exact match=0; adjacent transposition of two DIFFERENT source characters costs 1 using optimal-string-alignment recurrence (no substring edited twice). The stale test expected ordinary Levenshtein. Return keys distance, matrix (entire DP table, source prefix rows including empty and target prefix columns including empty). D[i,j] takes min of insert/delete/substitute plus D[i-2,j-2]+1 when adjacent swap condition holds.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"distance\", \"matrix\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"distance":2,"matrix":[[0,2,4,6,8,10],[2,3,2,4,6,8],[4,2,1,3,4,6],[6,4,3,4,3,5],[8,6,5,3,2,4],[10,8,6,5,4,2]]},
    },
  },
  {
    id: 'frontier-debugging-test-repair-convex-hull-collinear-policy',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Repair hull.test.ts, not hull.ts. Authoritative geometry contract: return convex hull counterclockwise, starting at lexicographically smallest (x,y); discard duplicate points and ALL collinear points inside hull edges; no repeated start at end. Input [(0,0),(1,0),(2,0),(3,0),(3,1),(3,3),(2,3),(0,3),(0,2),(1,1),(2,2),(0,0),(1,3)]. Stale test kept edge-collinear points. Return keys hull (coordinate arrays), doubledArea (integer shoelace magnitude), excluded (distinct excluded points sorted x then y).\n\nReply with exactly one JSON object containing exactly these keys in this order: \"hull\", \"doubledArea\", \"excluded\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"hull":[[0,0],[3,0],[3,3],[0,3]],"doubledArea":18,"excluded":[[0,2],[1,0],[1,1],[1,3],[2,0],[2,2],[2,3],[3,1]]},
    },
  },
  {
    id: 'frontier-debugging-test-repair-maximum-flow-cut-oracle',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Repair flow.test.ts's expected cut after network.ts added parallel routes. Directed capacities S->A5,S->B5,A->C3,A->D2,B->C2,B->D3,C->T5,D->T5,C->D1. Contract maximum flow; return ALL minimum-cut source sides, each containing S but not T. Sort nodes inside each side alphabetically; sort sides by concatenated names. Return keys flow, sourceSides, cutEdges (edges crossing FIRST sorted source side, triples [from,to,capacity] sorted from then to). A cut need not consist only of source or sink edges; reverse residual edges are not original capacity edges.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"flow\", \"sourceSides\", \"cutEdges\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"flow":10,"sourceSides":[["A","B","C","D","S"],["A","B","D","S"],["A","B","S"],["A","S"],["B","S"],["S"]],"cutEdges":[["C","T",5],["D","T",5]]},
    },
  },
  {
    id: 'frontier-debugging-test-repair-snapshot-isolation-write-skew',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Repair isolation.test.ts; the database fixture promises SNAPSHOT isolation, not serializable. Rows doctor A and B initially onCall=true with row version 0. T1 and T2 both snapshot version 0. T1 sees B=true and sets A=false; T2 sees A=true and sets B=false. T1 commits then T2 commits. Commit checks conflicts ONLY on written rows: row changed since snapshot -> abort; read-only rows do not conflict. A second run instead has both transactions write A=false. Return keys skewCommitted (T1/T2 booleans), skewFinal (A/B booleans), sameRowCommitted (T1/T2 booleans), sameRowFinal (A/B booleans).\n\nReply with exactly one JSON object containing exactly these keys in this order: \"skewCommitted\", \"skewFinal\", \"sameRowCommitted\", \"sameRowFinal\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"skewCommitted":[true,true],"skewFinal":[false,false],"sameRowCommitted":[true,false],"sameRowFinal":[false,true]},
    },
  },
  {
    id: 'frontier-debugging-test-repair-retry-budget-fake-clock',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Repair retry.test.ts's schedule to match retry.ts + budget.ts. Attempts start at t=0; each lasts 7ms, fails except attempt 5 which succeeds. Before attempt n+1 wait min(5*2^(n-1),20)ms after failure n. A next attempt is allowed only if its START time is strictly < deadline 84; in-flight attempt may finish after deadline. No jitter. Also test deadline 60 separately. Return keys starts (arrays for deadlines 84 then 60), finishes (arrays), outcomes (success or exhausted), attempts (counts). A timer at deadline does not cancel in-flight work.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"starts\", \"finishes\", \"outcomes\", \"attempts\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"starts":[[0,12,29,56,83],[0,12,29,56]],"finishes":[[7,19,36,63,90],[7,19,36,63]],"outcomes":["success","exhausted"],"attempts":[5,4]},
    },
  },
  {
    id: 'frontier-debugging-test-repair-window-peers-frame-repair',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Repair window.test.ts to honor SQL RANGE rather than ROWS. Ordered rows (id,score,amount): (a,1,2),(b,1,5),(c,2,3),(d,4,7),(e,4,-1),(f,5,4). Window sum uses RANGE BETWEEN 1 PRECEDING AND CURRENT ROW: include ALL rows with score in [currentScore-1,currentScore], including future peer rows. Rank is 1 plus number of rows with smaller score; dense_rank is 1 plus number of distinct smaller scores. Return keys sums, ranks, denseRanks in id order. Stale test wrongly used previous physical row.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"sums\", \"ranks\", \"denseRanks\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"sums":[7,7,10,6,6,10],"ranks":[1,1,3,4,4,6],"denseRanks":[1,1,2,3,3,4]},
    },
  },
  {
    id: 'frontier-debugging-test-repair-hamt-sign-bit-rank',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Repair bitmap.test.ts, not the HAMT. Bitmap indexes 0..31; bit i is unsigned 32-bit 2^i. Rank of index i is number of set bits with index<i. Existing bitmap has indices [0,5,16,30,31]. Query indices [0,1,5,16,29,30,31]. For absent indices, rank is insertion position. Return keys bitmapHex (8 lowercase hex digits), ranks, present (booleans). The stale test interpreted sign-bit bitmap as a negative number and treated bit31 as absent.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"bitmapHex\", \"ranks\", \"present\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"bitmapHex":"c0010021","ranks":[0,1,1,2,3,3,4],"present":[true,false,true,true,false,true,true]},
    },
  },
  {
    id: 'frontier-debugging-test-repair-spread-getter-materialization',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Repair snapshot.test.ts for snapshot.ts's shallow spread. Code: const log=[]; let backing=2; const nested={n:1}; const source=Object.create({inherited:9}); Object.defineProperty(source,'2',{enumerable:true,get(){log.push('2');backing++;return backing}}); Object.defineProperty(source,'a',{enumerable:true,get(){log.push('a');Object.defineProperty(source,'b',{enumerable:false});source.d=99;return backing*3}}); Object.defineProperty(source,'b',{value:7,enumerable:true,configurable:true}); Object.defineProperty(source,'c',{enumerable:true,get(){log.push('c');return nested}}); const copy={...source}; backing=10; nested.n=4; Object.freeze(copy); Return keys log, keys (Object.keys(copy)), values ([copy['2'],copy.a,copy.c.n]), sourceKeys (Object.keys(source)), inherited (copy.inherited??null), frozenNested (Object.isFrozen(copy.c)). Copy enumeration snapshots own keys first but rechecks each property's enumerability before getter; newly added d is not in that snapshot. Frozen copy does not deep-freeze nested.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"log\", \"keys\", \"values\", \"sourceKeys\", \"inherited\", \"frozenNested\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"log":["2","a","c"],"keys":["2","a","c"],"values":[3,9,4],"sourceKeys":["2","a","c","d"],"inherited":null,"frozenNested":false},
    },
  },
  {
    id: 'frontier-debugging-test-repair-async-generator-finalization',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Repair iterator.test.ts to honor async generator cleanup in source.ts and consumer.ts. Code inside one async function: const log=[]; async function* source(){try{yield 1;log.push('resume1');yield 2;log.push('resume2')}finally{log.push('finally:start');await Promise.resolve();log.push('finally:end')}} for await(const x of source()){log.push('value:'+x);if(x===1)break} log.push('after'); Return keys log, yielded (numeric values observed). The stale expectation omitted cleanup and incorrectly resumed past yield after break. No timers or external tasks.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"log\", \"yielded\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"log":["value:1","finally:start","finally:end","after"],"yielded":[1]},
    },
  },
  {
    id: 'frontier-debugging-test-repair-serializable-history-count',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Repair scheduler.test.ts. Production schedule enumerator counts linear extensions, not factorial permutations. Distinct events A,B,C,D,E,G have constraints A<C, B<C, B<D, C<E, D<E, D<G. Count every ordering meeting all constraints, using alphabetical choices. Return keys count, first (lexicographically first six-letter order), last (lexicographically last), prefixes (all distinct first-three-character prefixes sorted). The stale expected count assumed E always precedes G; no such edge exists.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"count\", \"first\", \"last\", \"prefixes\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"count":14,"first":"ABCDEG","last":"BDGACE","prefixes":["ABC","ABD","BAC","BAD","BDA","BDG"]},
    },
  },
  {
    id: 'frontier-debugging-test-repair-readonly-variance-contract',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Repair types.test.ts using an explicit safe subtype calculus (NO compiler). Dog<:Animal, Cat<:Animal, Dog/Cat unrelated; exact equality is reflexive. R(T) is a readonly array, covariant. M(T) is a mutable array, invariant. F(P,R) is a function: F(P1,R1)<:F(P2,R2) iff P2<:P1 AND R1<:R2. Apply these rules recursively, never erase nesting. Check source->target pairs: [R(Dog),R(Animal)]; [M(Dog),M(Animal)]; [F(Animal,Dog),F(Dog,Animal)]; [F(R(Animal),R(Dog)),F(R(Dog),R(Animal))]; [F(F(Dog,Animal),Dog),F(F(Animal,Dog),Animal)]; [F(F(Animal,Dog),Animal),F(F(Dog,Animal),Dog)]; [R(F(Animal,Dog)),R(F(Cat,Animal))]; [F(M(Animal),Dog),F(M(Dog),Animal)]; [F(F(R(Dog),Animal),R(Dog)),F(F(R(Animal),Dog),R(Animal))]; [M(F(Animal,Dog)),M(F(Dog,Animal))]. Return keys assignable (ten booleans), rejected (zero-based false indices). Production's calculus is authoritative even where real TypeScript has unsound allowances.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"assignable\", \"rejected\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"assignable":[true,false,true,true,true,false,true,false,true,false],"rejected":[1,5,7,9]},
    },
  },
  {
    id: 'frontier-debugging-test-repair-content-defined-chunk-reset',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Repair chunks.test.ts to match chunker.ts + hash.ts. Bytes [1,4,2,7,0,3,6,5,2,1,0,4,7,3,2]. Within each chunk start hash=0; for each byte h=(h*3+byte)%16. Cut AFTER a byte when chunk length>=3 and h%4==0, or length==6. RESET hash after every cut; emit any leftover tail. Return keys chunks (byte arrays), endOffsets (exclusive global byte offsets), hashes (terminal h for each emitted chunk). The stale test forgot reset and used cumulative length.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"chunks\", \"endOffsets\", \"hashes\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"chunks":[[1,4,2,7],[0,3,6,5,2],[1,0,4,7,3,2]],"endOffsets":[4,9,15],"hashes":[12,8,9]},
    },
  },
  {
    id: 'frontier-debugging-test-repair-circular-live-bindings',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Repair modules.test.ts under this explicit ES-module-like live-binding model, no compiler. counter.ts initializes count=1; inc increments cell. reader.ts captures snapshot=count and namespace getter reading current cell. main runs inc twice and records first=[snapshot,namespace.count]. A gate promise is initially pending. reader.readAndInc(id) logs 'start:'+id+':'+namespace.count, captures that count, awaits gate, calls inc, logs 'resume:'+id+':'+namespace.count, returns captured count. main starts p=readAndInc('p'), q=readAndInc('q'), calls inc once, queues a FIFO microtask that logs 'external' then calls inc, releases gate, awaits Promise.all([p,q]), records final namespace.count. Return keys first, captured (p/q return values), final, snapshot, log. Releasing a gate queues reactions but does not execute them inline; namespace is live, captured values are not.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"first\", \"captured\", \"final\", \"snapshot\", \"log\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"first":[1,3],"captured":[3,3],"final":7,"snapshot":1,"log":["start:p:3","start:q:3","external","resume:p:6","resume:q:7"]},
    },
  },
  {
    id: 'frontier-debugging-test-repair-priority-spec-repaired-golden',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Repair permission.test.ts; production permission.ts uses the published override order. For each request: hard security deny first; then an explicit user deny; then legal-role allow; then an explicit user allow; then group allow; otherwise deny. Legal-role allow MUST NOT override either earlier deny. Inputs [id,hard,user,legal,group] where user is allow/deny/inherit: [a,false,deny,true,true],[b,false,inherit,true,false],[c,true,allow,true,true],[d,false,allow,false,false],[e,false,inherit,false,true],[f,false,inherit,false,false],[g,false,deny,false,true],[h,false,allow,true,false]. Return keys allowed (ids in input order), reasons (one token per request: security,user-deny,legal,user-allow,group,default). The stale fixture gave legal precedence over user deny.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"allowed\", \"reasons\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"allowed":["b","d","e","h"],"reasons":["user-deny","legal","security","user-allow","group","default","user-deny","legal"]},
    },
  },
  {
    id: 'frontier-debugging-test-repair-modular-sequence-half-range',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Repair sequence.test.ts using wire.ts's exact RFC-style comparison contract supplied here. For unsigned 8-bit sequence x and y let d=(x-y) mod 256 in [0,255]. x is newer iff 0<d<128; equal iff d=0; exactly d=128 is ambiguous; otherwise older. Pairs [0,255],[255,0],[128,0],[0,128],[5,250],[250,5],[17,17],[130,3],[3,130]. Return keys differences, relations (newer/older/equal/ambiguous). The stale fixture used ordinary integer comparison and treated half-range as newer.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"differences\", \"relations\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"differences":[1,255,128,128,11,245,0,127,129],"relations":["newer","older","ambiguous","ambiguous","newer","older","equal","newer","older"]},
    },
  },
  {
    id: 'frontier-debugging-root-cause-analysis-epoch-protection-order',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Diagnose arena.ts + reader.ts + collector.ts. Object slot 4 initially generation0 value oak. Reader loads pointer (slot4,generation0), pauses BEFORE announcing its active epoch. Writer removes object, advances global epoch 0->1; collector sees no announced readers and reclaims slot4; allocator reuses slot4 for generation1 value pine. Reader announces epoch1 and dereferences its saved slot WITHOUT generation check. Select cause from late_epoch_announcement, atomic_counter_overflow, allocator_leak, immutable_snapshot. Return keys cause, observed (reader string), safeExpected (string it should have read), generations (saved and current integers). No intervening operations exist; dereference reads current slot contents.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"cause\", \"observed\", \"safeExpected\", \"generations\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"cause":"late_epoch_announcement","observed":"pine","safeExpected":"oak","generations":[0,1]},
    },
  },
  {
    id: 'frontier-debugging-root-cause-analysis-store-buffering-outcome',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Diagnose flags.ts + rendezvous.ts using explicitly supplied weak-memory semantics. Shared x=y=0. Thread A does relaxed store x=1 then relaxed load y into rA; B does relaxed store y=1 then relaxed load x into rB. Each thread may buffer its store until after its load; buffered writes eventually commit. Enumerate possible pairs [rA,rB]. Under a sequentially consistent execution, respect each thread's store-before-load and enumerate possible pairs again. Select cause explaining the extra weak outcome: store_buffering, torn_integer, lost_increment, stale_argument. Return keys cause, relaxed (unique sorted pairs), sequential (unique sorted pairs), extra (relaxed pairs absent from sequential).\n\nReply with exactly one JSON object containing exactly these keys in this order: \"cause\", \"relaxed\", \"sequential\", \"extra\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"cause":"store_buffering","relaxed":[[0,0],[0,1],[1,0],[1,1]],"sequential":[[0,1],[1,0],[1,1]],"extra":[[0,0]]},
    },
  },
  {
    id: 'frontier-debugging-root-cause-analysis-lock-cycle-transitive',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Diagnose checkout.ts, inventory.ts, and refund.ts using the exact lock snapshot. Exclusive nonreentrant locks owned: account by T1, stock by T2, invoice by T3, audit by T4. Waits: T1->stock, T2->invoice, T3->account, T4->stock, T5->audit. Each thread retains owned locks while waiting. Select cause from cyclic_lock_order, starvation_without_cycle, optimistic_conflict, missing_unlock_after_completion. Return keys cause, cycle (lexicographically smallest cycle rotation as thread ids, no repeated start), blocked (all transitively blocked threads sorted), victim (single thread whose abort breaks cycle using minimum rollback cost; costs T1=8,T2=3,T3=5,T4=1,T5=0). Aborting only off-cycle threads does not fix deadlock.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"cause\", \"cycle\", \"blocked\", \"victim\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"cause":"cyclic_lock_order","cycle":["T1","T2","T3"],"blocked":["T1","T2","T3","T4","T5"],"victim":"T2"},
    },
  },
  {
    id: 'frontier-debugging-root-cause-analysis-arraybuffer-view-alias',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Diagnose packet.ts + pool.ts + audit.ts. Pool owns bytes [1,2,3,4,5,6,7,8]. parser stores two records: view=bytes.subarray(2,6), snapshot=bytes.slice(2,6). Pool then does bytes.copyWithin(1,4,8) (overlap obeys JS memmove semantics), then bytes.fill(9,5,7). Audit reads records only afterward. Select cause from retained_borrowed_view, endian_mismatch, numeric_overflow, async_exception. Return keys cause, buffer (full current bytes), view, snapshot. All are numeric arrays; no actual transferred/detached buffers.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"cause\", \"buffer\", \"view\", \"snapshot\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"cause":"retained_borrowed_view","buffer":[1,5,6,7,8,9,9,8],"view":[6,7,8,9],"snapshot":[3,4,5,6]},
    },
  },
  {
    id: 'frontier-debugging-root-cause-analysis-utf8-chunk-state-loss',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Diagnose transport.ts + decode.ts. Bytes encode A\ud83d\ude00B\u20acC, split into chunks [[65,240,159],[152,128,66,226],[130,172,67]]. Current implementation creates a NEW nonfatal UTF-8 TextDecoder for EACH chunk and decodes with stream=false. Correct implementation retains ONE decoder, decodes every chunk with stream=true, then flushes. Standard UTF-8 replacement algorithm emits U+FFFD for each malformed standalone continuation byte; an incomplete sequence at final flush emits one replacement. Select cause from discarded_decoder_state, invalid_source_encoding, unicode_normalization, little_endian_decode. Return keys cause, brokenParts, broken, correct. Do not collapse repeated replacement characters.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"cause\", \"brokenParts\", \"broken\", \"correct\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"cause":"discarded_decoder_state","brokenParts":["A\ufffd","\ufffd\ufffdB\ufffd","\ufffd\ufffdC"],"broken":"A\ufffd\ufffd\ufffdB\ufffd\ufffd\ufffdC","correct":"A\ud83d\ude00B\u20acC"},
    },
  },
  {
    id: 'frontier-debugging-root-cause-analysis-duplicate-edge-indegree',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Diagnose graph.ts + topo.ts. Edge multiset [A->B,A->B,A->C,B->D,C->D,C->D,D->E]. Graph builder increments indegree for EVERY input edge but stores outgoing neighbors in a Set. Kahn starts all zero-indegree nodes, always processes alphabetically; for each unique outgoing neighbor decrements once. Select cause from multiplicity_mismatch, actual_directed_cycle, lexical_queue_order, disconnected_graph. Return keys cause, emitted (node ids), residual (pairs [id,remainingIndegree] sorted id, positive only), trueCycle (boolean under the directed edge relation). Nodes are A..E. Current algorithm reports cycle if fewer than five emitted.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"cause\", \"emitted\", \"residual\", \"trueCycle\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"cause":"multiplicity_mismatch","emitted":["A","C"],"residual":[["B",1],["D",2],["E",1]],"trueCycle":false},
    },
  },
  {
    id: 'frontier-debugging-root-cause-analysis-signed-zero-key-collapse',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Diagnose memo.ts + reciprocal.ts. Function f(x)=1/x requires distinguishing +0 from -0; cache is a JavaScript Map keyed directly by Number and caches results. Call sequence [+0,-0,2,-0,+0,-2]. Cache uses has before get, so falsy-result handling is not relevant. Serialize infinity as strings 'Infinity'/'-Infinity'; finite results are JSON numbers. Select cause from same_value_zero_key_equality, floating_underflow, cache_ttl_expiration, object_identity. Return keys cause, observed, intended (uncached results), misses (cache misses count). Map treats -0 and +0 as the same key.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"cause\", \"observed\", \"intended\", \"misses\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"cause":"same_value_zero_key_equality","observed":["Infinity","Infinity",0.5,"Infinity","Infinity",-0.5],"intended":["Infinity","-Infinity",0.5,"-Infinity","Infinity",-0.5],"misses":3},
    },
  },
  {
    id: 'frontier-debugging-root-cause-analysis-comparator-cycle-rounded-ratios',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Diagnose order.ts + weights.ts. A comparator defines x<y iff ((y.phase-x.phase+12)%12) lies in [1,5], equality only for equal phase; otherwise x>y. Records A.phase=0,B.phase=4,C.phase=8,D.phase=1. Sorting contract requires a strict total order. Select cause from nontransitive_comparator, unstable_sort_for_equal_keys, phase_overflow, duplicate_records. Return keys cause, lessEdges (pairs [id,id] satisfying comparator<0, sorted pair), cycles (all directed three-node cycles, rotate to smallest id, deduplicate, lexicographically sorted). Do not depend on a host sort algorithm's output for invalid comparators.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"cause\", \"lessEdges\", \"cycles\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"cause":"nontransitive_comparator","lessEdges":[["A","B"],["A","D"],["B","C"],["C","A"],["C","D"],["D","B"]],"cycles":[["A","B","C"],["B","C","D"]]},
    },
  },
  {
    id: 'frontier-debugging-root-cause-analysis-ack-correlation-generation',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Diagnose sender.ts + ack.ts. Request ids are reused after reconnect: generation0 sends id7 payload oak; disconnect; generation1 sends id7 payload pine and id8 payload elm. Pending map is keyed ONLY by id, overwritten on each send. Late ACK for (generation0,id7) arrives, followed by ACK(generation1,id8), then ACK(generation1,id7). ACK resolves and deletes whichever current pending entry has that id. Select cause from missing_generation_in_correlation_key, server_payload_mutation, duplicate_id_within_generation, timeout_clock_drift. Return keys cause, resolved (payloads in resolution order), ignored (ACK pairs ignored, in arrival order), remaining (payloads sorted).\n\nReply with exactly one JSON object containing exactly these keys in this order: \"cause\", \"resolved\", \"ignored\", \"remaining\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"cause":"missing_generation_in_correlation_key","resolved":["pine","elm"],"ignored":[[1,7]],"remaining":[]},
    },
  },
  {
    id: 'frontier-debugging-root-cause-analysis-retry-seed-thundering-herd',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Diagnose retry.ts + worker.ts. Three workers start together and each initializes its OWN PRNG with the SAME seed 1. PRNG next: seed=(seed*5+1)%16; jitter=seed%5. Every request fails instantly; after failure n (n=1,2,3) each waits 10*2^(n-1)+jitter before next attempt. No shared PRNG and no service-time variance. Select cause from identical_per_worker_prng_seed, exponential_backoff_missing, monotonic_clock_regression, sequential_dispatch. Return keys cause, attempts (start-time arrays for four attempts of each worker), collisionTimes (times at which all three attempt, sorted), distinctJitters (sorted distinct jitters used).\n\nReply with exactly one JSON object containing exactly these keys in this order: \"cause\", \"attempts\", \"collisionTimes\", \"distinctJitters\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"cause":"identical_per_worker_prng_seed","attempts":[[0,11,31,73],[0,11,31,73],[0,11,31,73]],"collisionTimes":[0,11,31,73],"distinctJitters":[0,1,2]},
    },
  },
  {
    id: 'frontier-debugging-root-cause-analysis-conditional-any-contamination',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Diagnose types.ts + route.ts with supplied type semantics, NOT a compiler. any in a naked conditional 'T extends string ? S : N' yields S|N; never yields no members; ordinary unions distribute. unknown fails extends string; literals x,y pass; number fails. A union containing any normalizes to any before conditional evaluation. Cases: x|number; x|any; never; unknown; x|y. Desired classifier has one result only for homogeneous unions; current distributed conditional returns a union of labels. Select cause from distributive_any_contamination, readonly_array_covariance, optional_property_erasure, overload_order. Return keys cause, results (arrays of sorted strings S/N for each case), ambiguous (indices with >1 label). Sort labels ASCII N before S.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"cause\", \"results\", \"ambiguous\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"cause":"distributive_any_contamination","results":[["N","S"],["N","S"],[],["N"],["S"]],"ambiguous":[0,1]},
    },
  },
  {
    id: 'frontier-debugging-root-cause-analysis-priority-inversion-lock-owner',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Diagnose mutex.ts + scheduler.ts. Lower number is higher priority. Low L priority3 starts at t0, locks M, needs 4 CPU units to unlock. High H priority0 arrives t1 and blocks on M, then needs 1 unit after acquiring. Medium N priority1 arrives t2 and needs 6 units without M. One CPU, preempt at each integer boundary, no priority inheritance; pick highest-priority runnable task. Select cause from priority_inversion, deadlock_cycle, lock_leak, lost_wakeup. Return keys cause, timeline (running id per unit), unlockAt (end time of L's fourth unit), highCompletedAt, inheritedHighCompletedAt (same schedule but blocked H donates priority0 to L until unlock). No context-switch cost.\n\nReply with exactly one JSON object containing exactly these keys in this order: \"cause\", \"timeline\", \"unlockAt\", \"highCompletedAt\", \"inheritedHighCompletedAt\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"cause":"priority_inversion","timeline":["L","L","N","N","N","N","N","N","L","L","H"],"unlockAt":10,"highCompletedAt":11,"inheritedHighCompletedAt":5},
    },
  },
  {
    id: 'frontier-debugging-root-cause-analysis-promise-executor-tdz',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Diagnose lock.ts + cache.ts using exact JavaScript. Code inside an async function: const log=[]; let cache; const p=new Promise(resolve=>{log.push('executor');resolve(1);cache=p}); p.then(()=>log.push('fulfilled'),()=>log.push('rejected')); await Promise.resolve(); let status; try{await p;status='fulfilled'}catch(e){status=e.name} return observation. Because p is a const in its temporal dead zone during the executor, cache=p throws AFTER resolve(1). Select cause explaining why the side effect fails without rejecting p: resolution_already_locked_before_executor_throw, swallowed_await_rejection, asynchronous_executor, cache_eviction. Return keys cause, log, status, cache (null when undefined).\n\nReply with exactly one JSON object containing exactly these keys in this order: \"cause\", \"log\", \"status\", \"cache\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"cause":"resolution_already_locked_before_executor_throw","log":["executor","fulfilled"],"status":"fulfilled","cache":null},
    },
  },
  {
    id: 'frontier-debugging-root-cause-analysis-signed-radix-bucket',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Diagnose radix.ts + counts.ts. For signed 32-bit integer ascending sort, an LSD radix pass for bits24..31 currently computes bucket=(x>>>24)&255 with no sign adjustment. Assume lower three bytes already stably sorted; for this fixture all lower bytes are zero. Values [-2147483648,-16777216,0,16777216,2147483392] where the last value does NOT have lower bytes zero (its lower bytes are ffff00), but is the only record with its top byte 127 and cannot tie any listed top bucket. Select cause from unsigned_top_byte_order, unstable_lower_pass, precision_loss_above_2pow53, integer_endian_swap. Return keys cause, buckets (input order), observed (stable ascending bucket pass), intended (signed numeric ascending), correctedBuckets (xor each top bucket with 128).\n\nReply with exactly one JSON object containing exactly these keys in this order: \"cause\", \"buckets\", \"observed\", \"intended\", \"correctedBuckets\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"cause":"unsigned_top_byte_order","buckets":[128,255,0,1,127],"observed":[0,16777216,2147483392,-2147483648,-16777216],"intended":[-2147483648,-16777216,0,16777216,2147483392],"correctedBuckets":[0,127,128,129,255]},
    },
  },
  {
    id: 'frontier-debugging-root-cause-analysis-outbox-watermark-cross-partition',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    tier: 'frontier',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      "Diagnose consumer.ts + offsets.ts. Two partitions have monotonically increasing offsets independently. Bug tracks ONE global maximum offset and skips every incoming event with offset<=globalMax, regardless of partition. Input [partition,offset,amount]: [P,3,5],[Q,1,7],[P,5,2],[Q,4,11],[Q,6,13],[P,6,17],[P,7,19],[Q,7,23]. Initial watermark=-1 and total0. A correct consumer tracks maximum PER partition; within each partition given events are unique and increasing. Select cause from cross_partition_watermark_alias, duplicated_source_event, arithmetic_overflow, out_of_order_within_partition. Return keys cause, accepted (zero-based event indices), observedTotal, intendedTotal, finalGlobal, perPartition (pairs sorted partition).\n\nReply with exactly one JSON object containing exactly these keys in this order: \"cause\", \"accepted\", \"observedTotal\", \"intendedTotal\", \"finalGlobal\", \"perPartition\". Preserve every specified array order. No extra keys or commentary.",
    check: {
      kind: 'json_equal',
      value: {"cause":"cross_partition_watermark_alias","accepted":[0,2,4,6],"observedTotal":39,"intendedTotal":97,"finalGlobal":7,"perPartition":[["P",7],["Q",7]]},
    },
  },
];
