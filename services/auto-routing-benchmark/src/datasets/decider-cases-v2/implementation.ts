import type { DeciderCase } from '../decider-cases';

const CODE_SYS =
  'You are a precise coding assistant. Answer with only what is asked, no explanations.';

function mutationTestPrompt(source: string): string {
  return `Create the smallest test suite from the numbered candidate inputs below that distinguishes reference from EVERY mutant. Each function is called independently on a fresh copy of its input. A test kills a mutant when JSON.stringify of its return value differs from JSON.stringify of reference's return value; an undefined return is distinct from every JSON value. Minimize the number of tests, then break ties by the lexicographically smallest ascending array of zero-based candidate indexes (compare indexes numerically). Reply only with a JSON object with keys "indexes", "expected" in that order. "expected" contains reference's return values for the selected inputs, in index order. Do not output test code.\n\n${source}`;
}

export const IMPLEMENTATION_V2_CASES: readonly DeciderCase[] = [
  {
    id: 'impl-feat-v2-idempotent-ledger',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement an in-memory ledger with idempotent event IDs and reversals. Start with balance zero. Ignore an event entirely if its id has already been seen. Otherwise mark its id seen, even if a reversal does nothing. A normal event adds n and records that amount under its id. A reversal subtracts the recorded amount of its target, then deletes that target's recorded amount; it does nothing if that target is not currently recorded. Process this input in order:
[{"id":"a","n":12},{"id":"b","n":-5},{"id":"early","reverse":"late"},{"id":"a","n":99},{"id":"c","n":7},{"id":"r1","reverse":"b"},{"id":"b","n":20},{"id":"r2","reverse":"b"},{"id":"late","n":9},{"id":"early","reverse":"late"},{"id":"r3","reverse":"r1"},{"id":"r4","reverse":"a"},{"id":"a","n":100},{"id":"d","n":-4},{"id":"r5","reverse":"late"},{"id":"e","n":0},{"id":"r6","reverse":"d"}]
Run the feature on this fixture. Return only the final balance as a JSON number.`,
    check: { kind: 'exact', value: '7' },
  },
  {
    id: 'impl-feat-v2-half-open-coalescing',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement interval normalization. Intervals are half-open [start,end). Discard empty intervals, sort by start then end, and merge transitively overlapping intervals, but DO NOT merge intervals that merely touch. Output intervals in increasing start order. Run it on [[8,10],[1,3],[3,5],[2,4],[10,11],[7,9],[-4,-1],[-2,0],[0,1],[12,12],[15,19],[17,21],[21,22],[14,16],[1,2]]. Return only the JSON array of normalized intervals.`,
    check: { kind: 'json_equal', value: [[-4, 0], [0, 1], [1, 5], [7, 10], [10, 11], [14, 21], [21, 22]] },
  },
  {
    id: 'impl-feat-v2-versioned-tombstones',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement a versioned key/value reducer. A row replaces the stored row for its key when its version is greater OR equal; equal versions therefore use the last row in input order. x:null is a tombstone that participates in version comparisons and must not appear in the output. Zero is a live value. Input rows use [key,version,x]:
[["a",2,7],["b",1,8],["a",1,9],["b",3,null],["a",2,11],["c",0,0]]
Return only a JSON array of [key,x] for live keys, sorted lexicographically by key.`,
    check: { kind: 'json_equal', value: [['a', 11], ['c', 0]] },
  },
  {
    id: 'impl-feat-v2-expiry-boundary',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement a cache whose set operation at time t expires at t+5. get returns the stored value only when t is STRICTLY less than expiry, otherwise null. Gets do not renew expiry. A new set replaces the entry, including expiry. Process operations [time,operation,key,value?]:
[[0,"set","a",1],[2,"set","b",2],[3,"get","a"],[5,"get","a"],[5,"get","b"],[6,"set","a",3],[7,"get","b"],[10,"get","a"],[11,"get","a"]]
Return only the JSON array of get results, in operation order.`,
    check: { kind: 'json_equal', value: [1, null, 2, null, 3, null] },
  },
  {
    id: 'impl-feat-v2-ready-queue-priority',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement a deterministic dependency scheduler. A task is ready when all dependencies have completed. Run exactly one task per step and recalculate readiness after every step. Among ready unfinished tasks choose the lexicographically GREATEST task ID, not the smallest and not a whole layer at once. Dependencies:
{"a":[],"b":[],"c":["a"],"d":["a","b"],"e":["c","d"],"f":["b"]}
Return only the JSON array of execution IDs.`,
    check: { kind: 'json_equal', value: ['b', 'f', 'a', 'd', 'c', 'e'] },
  },
  {
    id: 'impl-feat-v2-overwrite-queue',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement a FIFO queue with capacity three. put on a full queue discards the oldest item before appending the new one. take removes and returns the oldest, or null when empty. Apply:
[["put","a"],["put","b"],["put","c"],["take"],["put","d"],["put","e"],["put","f"],["take"],["take"]]
Return only a JSON object with keys "removed", "pending" in that order; removed holds all take results, pending is oldest-first.`,
    check: { kind: 'json_equal', value: { removed: ['a', 'd', 'e'], pending: ['f'] } },
  },
  {
    id: 'impl-feat-v2-escaped-delimiters',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: String.raw`Implement a delimiter parser. An unescaped comma ends a field. A backslash consumes the next character as literal data, whether that character is a comma or another backslash. Preserve empty fields. The input string, written as a JSON string literal, is:
"a\\,b,c\\\\,d\\,e,,f"
Decode the JSON string first, then parse its contents. Return only the JSON array of fields.`,
    check: { kind: 'json_equal', value: ['a,b', 'c\\', 'd,e', '', 'f'] },
  },
  {
    id: 'impl-feat-v2-largest-remainders',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement largest-remainder allocation. Allocate 23 indivisible units among weights [0,7,11,3,9,5,7]. Begin with floor(total*weight/sumWeights) for each index, then give the remaining units to the largest fractional remainders, one unit per index; ties favor the smaller index. Use exact integer arithmetic for comparisons. Return only the allocation JSON array in original weight order.`,
    check: { kind: 'json_equal', value: [0, 4, 6, 1, 5, 3, 4] },
  },
  {
    id: 'impl-feat-v2-event-time-sessions',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement event-time sessionization. Sort all timestamps numerically before processing. Consecutive sorted events belong to the same session when their gap is at most five; the threshold is measured from the immediately preceding event, not session start. Count every event. Input: [12,0,5,16,9,30,35,34]. Return only a JSON array of [firstTimestamp,lastTimestamp,eventCount], ordered by session start.`,
    check: { kind: 'json_equal', value: [[0, 16, 5], [30, 35, 3]] },
  },
  {
    id: 'impl-feat-v2-detached-ring-snapshots',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement a resizable ring buffer and immutable snapshots. Initial capacity is three. append adds the value, dropping the oldest if necessary. At capacity zero append is ignored. resize changes capacity immediately, retaining only the newest values that fit; growing capacity does not restore dropped values. snapshot saves the current values oldest-to-newest, detached from future changes. Process:
[["append",1],["append",2],["snapshot"],["append",3],["append",4],["resize",2],["snapshot"],["append",5],["resize",0],["append",6],["snapshot"],["resize",4],["append",7],["append",8],["append",9],["append",10],["append",11],["snapshot"]]
Return only the JSON array of all saved snapshots in capture order.`,
    check: { kind: 'json_equal', value: [[1, 2], [3, 4], [], [8, 9, 10, 11]] },
  },
  {
    id: 'impl-feat-v2-pruned-tree-leaves',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement a tree selector. A disabled node prunes its entire subtree. A leaf means a node with no children in the ORIGINAL tree, not a node whose children were all pruned. Visit children left-to-right and collect slash-joined root-to-leaf IDs for enabled leaves reachable through enabled ancestors. Input:
{"id":"r","enabled":true,"children":[{"id":"a","enabled":false,"children":[{"id":"x","enabled":true}]},{"id":"b","enabled":true,"children":[{"id":"y","enabled":true},{"id":"z","enabled":false}]},{"id":"c","enabled":true},{"id":"d","enabled":true,"children":[{"id":"p","enabled":false},{"id":"q","enabled":false}]},{"id":"e","enabled":true,"children":[{"id":"f","enabled":true,"children":[{"id":"g","enabled":false,"children":[{"id":"h","enabled":true}]},{"id":"i","enabled":true}]}]}]}
Return only the JSON array of paths.`,
    check: { kind: 'json_equal', value: ['r/b/y', 'r/c', 'r/e/f/i'] },
  },
  {
    id: 'impl-feat-v2-rolling-trimmed-mean',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement a rolling trimmed mean over complete windows of four values. For each window, remove exactly one smallest and exactly one largest value, then average the two remaining values. Do not mutate the input sequence; overlapping windows are based on original values. Sequence: [4,1,9,2,8,3,7]. Return only the JSON array of means in window order.`,
    check: { kind: 'json_equal', value: [3, 5, 5.5, 5] },
  },
  {
    id: 'impl-feat-v2-query-multimap',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement a query-string multimap parser with form decoding: split on ampersands, split each part at its first equals sign, treat a missing equals sign as an empty value, convert plus to space BEFORE decoding percent escapes, and percent-decode exactly once. Keep all repeated values in input order. Input:
a=1&a=2&x=a+b&x=a%2Bb&empty=&flag&bad=%252F
Return only the JSON array of [key,valuesArray], with keys sorted lexicographically.`,
    check: {
      kind: 'json_equal',
      value: [['a', ['1', '2']], ['bad', ['%2F']], ['empty', ['']], ['flag', ['']], ['x', ['a b', 'a+b']]],
    },
  },
  {
    id: 'impl-feat-v2-recursive-merge-patch',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement merge patch with these rules: a non-object patch (including an array) replaces its target entirely; an object patch recursively merges into an object target, or into an empty object if the target is not an object; a null property value deletes that property. Arrays are not objects for these rules. Base:
{"a":{"x":1,"y":2},"b":[1,2],"c":3}
Patch:
{"a":{"x":null,"z":0},"b":[9],"c":{"k":false}}
Return only the resulting JSON object. Use top-level keys a,b,c in that order, keys y,z in a, and key k in c.`,
    check: { kind: 'json_equal', value: { a: { y: 2, z: 0 }, b: [9], c: { k: false } } },
  },
  {
    id: 'impl-feat-v2-accepted-event-dedupe',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement per-key deduplication with a four-unit window. Accept a key's first event. Later accept it only when time minus the time of its LAST ACCEPTED event is at least four. Rejected events do not advance that timestamp. Process these [time,key] pairs in their given order:
[[0,"a"],[2,"a"],[3,"b"],[4,"a"],[5,"a"],[7,"b"],[8,"a"],[9,"b"]]
Return only the JSON array of accepted pairs.`,
    check: { kind: 'json_equal', value: [[0, 'a'], [3, 'b'], [4, 'a'], [7, 'b'], [8, 'a']] },
  },
  {
    id: 'impl-feat-v2-shortest-path-ties',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement shortest path selection on this directed acyclic weighted graph, represented as node -> [destination,cost] edges:
{"a":[["b",2],["c",1]],"b":[["d",2],["e",4]],"c":[["b",1],["d",3]],"d":[["e",2]],"e":[]}
Find a path from a to e with minimum total cost. Break equal-cost ties by lexicographic order of the slash-joined full path, not by number of edges. Return only a JSON object with keys "cost", "path" in that order; path is an array of node IDs.`,
    check: { kind: 'json_equal', value: { cost: 6, path: ['a', 'b', 'd', 'e'] } },
  },
  {
    id: 'impl-feat-v2-virtual-retry-clock',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement retries on a virtual clock. There are four attempts, the first three fail and the fourth succeeds. Each attempt takes three time units. Attempt zero starts at time zero. After failure number k (zero-based), wait min(5*2^k,12) time units AFTER that attempt has finished. Do not wait after success. Return only a JSON object with keys "starts", "finished" in that order, recording all attempt start times and final completion time.`,
    check: { kind: 'json_equal', value: { starts: [0, 8, 21, 36], finished: 39 } },
  },
  {
    id: 'impl-feat-v2-decimal-half-even',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement decimal-string rounding to two places using round-half-to-even and exact decimal arithmetic, not binary floating point. At an exact midpoint choose the result whose hundredths digit is even; beyond a midpoint round away from zero. Always emit two decimal places and normalize negative zero to "0.00". Inputs: ["1.005","1.015","-2.675","-0.005","9.999","3.1251"]. Return only the JSON array of rounded strings.`,
    check: { kind: 'json_equal', value: ['1.00', '1.02', '-2.68', '0.00', '10.00', '3.13'] },
  },
  {
    id: 'impl-feat-v2-range-subtraction',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: `Implement a range-set feature on integer points. Take the union of half-open ranges [[1,5],[4,8],[10,12]], then subtract the half-open range [3,6]. Overlapping input ranges must not duplicate points. Return only the JSON array of remaining integer points in increasing order.`,
    check: { kind: 'json_equal', value: [1, 2, 6, 7, 10, 11] },
  },
  {
    id: 'impl-feat-v2-quoted-csv',
    taskType: 'implementation',
    subtaskType: 'feature_development',
    systemPrompt: CODE_SYS,
    userPrompt: String.raw`Implement a CSV parser for this fixture. Commas and line breaks inside quoted fields are data. Two consecutive quotes inside a quoted field encode one literal quote. CRLF is a single record separator outside quoted fields. Decode this JSON string literal to obtain the input:
"name,note\r\nAda,\"a,b\"\r\nBob,\"He said \"\"ok\"\"\"\r\nEve,\"two\nlines\""
Return only the JSON array of rows, including the header, with each row an array of strings.`,
    check: {
      kind: 'json_equal',
      value: [['name', 'note'], ['Ada', 'a,b'], ['Bob', 'He said "ok"'], ['Eve', 'two\nlines']],
    },
  },
  {
    id: 'impl-gen-v2-utf8-netstrings',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate netstring fixtures for ["A","é","🙂","a:b,"]. A netstring is decimal UTF-8 BYTE length, colon, original text, comma. Count neither the prefix nor trailing comma in the length. Return only the JSON array of encoded strings in input order.`,
    check: { kind: 'json_equal', value: ['1:A,', '2:é,', '4:🙂,', '4:a:b,,'] },
  },
  {
    id: 'impl-gen-v2-unsigned-leb128',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate unsigned LEB128 byte fixtures for [0,127,128,255,16384,624485]. Emit least-significant seven-bit groups first, set bit 7 on every byte except the last, and encode zero as one zero byte. Return only a JSON array of arrays of decimal byte values, in input order.`,
    check: { kind: 'json_equal', value: [[0], [127], [128, 1], [255, 1], [128, 128, 1], [229, 142, 38]] },
  },
  {
    id: 'impl-gen-v2-delta-zigzag',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate a compressed integer fixture for [0,-1,1,-2,300,-300]. First delta-encode relative to the previous ORIGINAL value, starting with previous=0. Map each signed delta d to 2*d for d>=0, otherwise -2*d-1. Encode each mapped integer as unsigned LEB128: seven-bit groups least-significant first, continuation bit 128 except on the last byte. Return only a JSON array of byte arrays, one per input integer.`,
    check: { kind: 'json_equal', value: [[0], [1], [4], [5], [220, 4], [175, 9]] },
  },
  {
    id: 'impl-gen-v2-bounded-dyck-words',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate every balanced-parenthesis string with exactly four pairs and maximum nesting depth at most two. No prefix may have more closing than opening parentheses. Return only the JSON array of distinct strings in lexicographic order, with '(' ordered before ')'.`,
    check: {
      kind: 'json_equal',
      value: ['(()()())', '(()())()', '(())(())', '(())()()', '()(()())', '()(())()', '()()(())', '()()()()'],
    },
  },
  {
    id: 'impl-gen-v2-all-topological-orders',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate every valid topological ordering of tasks a,b,c,d where c requires a and d requires BOTH a and b; a and b have no prerequisites. Represent an ordering as its four concatenated letters. Return only a JSON array of all distinct valid strings, sorted lexicographically.`,
    check: { kind: 'json_equal', value: ['abcd', 'abdc', 'acbd', 'bacd', 'badc'] },
  },
  {
    id: 'impl-gen-v2-multiset-permutations',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate all DISTINCT permutations of the multiset ["a","a","b","c"] that do not contain adjacent a characters. Each permutation is a four-character string. Return only the JSON array sorted lexicographically.`,
    check: { kind: 'json_equal', value: ['abac', 'abca', 'acab', 'acba', 'baca', 'caba'] },
  },
  {
    id: 'impl-gen-v2-constrained-subsets',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate a selection fixture from items [id,cost,value]: [["a",2,3],["b",3,4],["c",4,5],["d",5,8]]. Each item may be chosen at most once. Include every nonempty subset whose total cost is at most seven AND total value is at least nine. Encode each subset as its IDs concatenated in increasing order. Return only the JSON array of subset strings sorted lexicographically.`,
    check: { kind: 'json_equal', value: ['ad', 'bc'] },
  },
  {
    id: 'impl-gen-v2-binary-cross-constraints',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate every six-character binary string with exactly three ones, with no substring "111", and with its first and last characters DIFFERENT. Preserve leading zeroes. Return only the JSON array in lexicographic order.`,
    check: {
      kind: 'json_equal',
      value: ['001011', '001101', '010011', '010101', '011001', '100110', '101010', '101100', '110010', '110100'],
    },
  },
  {
    id: 'impl-gen-v2-regex-literal-fixtures',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: String.raw`Generate literal-regex source fixtures for the strings represented by this JSON array:
["a.b","x+y","[z]","a\\b","^$","(a|b)?"]
For each string prefix EACH regex metacharacter in the set . * + ? ^ $ { } ( ) | [ ] and backslash with one backslash. Do not add anchors or regex delimiters. Return only the JSON array of regex SOURCE strings in input order, correctly JSON-escaped.`,
    check: { kind: 'json_equal', value: ['a\\.b', 'x\\+y', '\\[z\\]', 'a\\\\b', '\\^\\$', '\\(a\\|b\\)\\?'] },
  },
  {
    id: 'impl-gen-v2-rectangular-spiral',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate a clockwise spiral traversal fixture for [[1,2,3,4],[5,6,7,8],[9,10,11,12]]. Start at the upper-left, initially move right, and visit every cell exactly once while spiraling inward. Return only the JSON array of visited values.`,
    check: { kind: 'json_equal', value: [1, 2, 3, 4, 8, 12, 11, 10, 9, 5, 6, 7] },
  },
  {
    id: 'impl-gen-v2-canonical-prefix-codes',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate canonical binary prefix codes for symbol lengths [["A",2],["B",3],["C",3],["D",3],["E",4],["F",4]]. Sort by length then symbol. The first code is zero padded to its length. For each subsequent symbol increment the previous code numerically, then left-shift by the increase in length, and zero-pad to its new length. Return only the JSON array of [symbol,bitString] in canonical assignment order.`,
    check: {
      kind: 'json_equal',
      value: [['A', '00'], ['B', '010'], ['C', '011'], ['D', '100'], ['E', '1010'], ['F', '1011']],
    },
  },
  {
    id: 'impl-gen-v2-crc-eight',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate CRC-8 fixtures with polynomial 0x07, initial register zero, no reflection, and no final XOR. For each input byte XOR it into the register, then repeat eight times: if the old high bit was set, replace register by (register<<1)^0x07, otherwise by register<<1; mask to eight bits after EACH step. Inputs are [], [0], [1,2,3], [255,0,128], and ASCII bytes of "123456789". Return only the JSON array of final unsigned decimal registers in input order.`,
    check: { kind: 'json_equal', value: [0, 0, 72, 162, 244] },
  },
  {
    id: 'impl-gen-v2-kmp-prefix-table',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate the KMP prefix-function fixture for pattern "ababcababd". At index i store the length of the longest PROPER prefix of pattern[0..i] that is also a suffix of that same substring. The empty prefix has length zero. Return only the JSON array of ten prefix lengths in index order.`,
    check: { kind: 'json_equal', value: [0, 0, 1, 2, 0, 1, 2, 3, 4, 0] },
  },
  {
    id: 'impl-gen-v2-suffix-array-sentinel',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate the suffix array for "banana$", including the suffix starting at the sentinel $. Sort complete suffixes lexicographically using character ordering $ < a < b < n. Return only the JSON array of their zero-based starting offsets. Do not include an empty suffix.`,
    check: { kind: 'json_equal', value: [6, 5, 3, 1, 0, 4, 2] },
  },
  {
    id: 'impl-gen-v2-modular-automaton-language',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate all length-five binary strings accepted by this automaton: state starts at 0; reading bit b updates state to (2*state+b)%3; accept only if final state is 1 AND the last bit is 1. Leading zeroes count toward length. Return only the JSON array of accepted strings in lexicographic order.`,
    check: { kind: 'json_equal', value: ['00001', '00111', '01101', '10011', '11001', '11111'] },
  },
  {
    id: 'impl-gen-v2-sweep-line-boundaries',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate a sweep-line fixture for half-open intervals [[0,4],[2,6],[4,7],[6,8]]. Partition at EVERY distinct endpoint, including endpoints where the count does not change. For each elementary segment between consecutive endpoints emit [start,end,numberOfActiveIntervals]. Return only the JSON array sorted by start.`,
    check: { kind: 'json_equal', value: [[0, 2, 1], [2, 4, 2], [4, 6, 2], [6, 7, 2], [7, 8, 1]] },
  },
  {
    id: 'impl-gen-v2-midnight-anchored-schedule',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate a daily schedule fixture. Jobs run every 35 minutes, anchored at midnight 00:00, not at the start of the filter window. Include starts at or after 09:10 and strictly before 12:00 on the same day. Return only the JSON array of zero-padded 24-hour HH:MM strings in chronological order.`,
    check: { kind: 'json_equal', value: ['09:20', '09:55', '10:30', '11:05', '11:40'] },
  },
  {
    id: 'impl-gen-v2-signed-big-endian',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate signed 16-bit two's-complement big-endian byte fixtures for [-32768,-257,-1,0,255,32767]. Return only the JSON array of [highByte,lowByte] arrays using unsigned decimal byte values in input order.`,
    check: { kind: 'json_equal', value: [[128, 0], [254, 255], [255, 255], [0, 0], [0, 255], [127, 255]] },
  },
  {
    id: 'impl-gen-v2-json-pointer-patch-fixture',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate the expected fixture after sequentially applying these JSON Patch operations. JSON Pointer decodes ~1 as slash and ~0 as tilde. Array add INSERTS before the given zero-based index; replace does not insert. Base:
{"a/b":{"~x":[10,20]},"keep":true}
Operations:
[{"op":"add","path":"/a~1b/~0x/1","value":15},{"op":"replace","path":"/a~1b/~0x/0","value":7},{"op":"remove","path":"/keep"}]
Return only the resulting JSON object, with key "a/b", whose nested object has key "~x".`,
    check: { kind: 'json_equal', value: { 'a/b': { '~x': [7, 15, 20] } } },
  },
  {
    id: 'impl-gen-v2-edit-distance-row',
    taskType: 'implementation',
    subtaskType: 'code_generation',
    systemPrompt: CODE_SYS,
    userPrompt: `Generate a Levenshtein dynamic-programming fixture for source "kitten" and target "sitting". Insert, delete, and substitute each cost one; matching characters cost zero. dp[i][j] is the edit distance from the first i source characters to the first j target characters. Initialize dp[i][0]=i and dp[0][j]=j. Return only a JSON object with keys "distance", "lastRow" in that order: distance is dp[6][7], lastRow is dp[6][0..7].`,
    check: { kind: 'json_equal', value: { distance: 3, lastRow: [6, 6, 5, 4, 3, 3, 2, 3] } },
  },
  {
    id: 'impl-test-v2-lower-bound-mutants',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: mutationTestPrompt(`const inputs = [
  {xs: [], t: 0},
  {xs: [1,2,2,4], t: 2},
  {xs: [1,3], t: 2},
  {xs: [1,3], t: 5}
];
function reference({xs,t}) {
  const i = xs.findIndex(x => x >= t);
  return i < 0 ? xs.length : i;
}
const mutants = [
  ({xs,t}) => {
    const i = xs.findIndex(x => x > t);
    return i < 0 ? xs.length : i;
  },
  ({xs,t}) => xs.indexOf(t),
  ({xs,t}) => Math.min(reference({xs,t}), xs.length - 1)
];`),
    check: { kind: 'json_equal', value: { indexes: [0, 1], expected: [0, 1] } },
  },
  {
    id: 'impl-test-v2-pagination-mutants',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: mutationTestPrompt(`const inputs = [
  {xs: [0,1,2,3], p: 1, n: 2},
  {xs: [1,2,3,4], p: 2, n: 2},
  {xs: [1,2], p: 3, n: 2},
  {xs: [1], p: 1, n: 1}
];
const reference = ({xs,p,n}) => xs.slice((p-1)*n, p*n);
const mutants = [
  ({xs,p,n}) => xs.slice(p*n, (p+1)*n),
  ({xs,p,n}) => xs.slice((p-1)*n, p*n-1),
  x => reference(x).filter(Boolean)
];`),
    check: { kind: 'json_equal', value: { indexes: [0], expected: [[0, 1]] } },
  },
  {
    id: 'impl-test-v2-strict-integer-mutants',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: mutationTestPrompt(String.raw`const inputs = ["12", "12px", "", "2.0", "-03", " 7"];
const reference = s => /^[+-]?\d+$/.test(s) ? Number(s) : null;
const mutants = [
  s => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? null : n;
  },
  s => {
    const n = Number(s);
    return Number.isNaN(n) ? null : n;
  },
  s => /^\d+$/.test(s) ? Number(s) : null
];`),
    check: { kind: 'json_equal', value: { indexes: [3, 4], expected: [null, -3] } },
  },
  {
    id: 'impl-test-v2-median-mutants',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: mutationTestPrompt(`const inputs = [[1,2,10], [1,2,10,20], [2,3], [3,7,9]];
function reference(xs) {
  const a = [...xs].sort((a,b) => a-b);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m-1]+a[m])/2;
}
const mutants = [
  xs => {
    const a = [...xs].sort();
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m-1]+a[m])/2;
  },
  xs => Math.round(reference(xs)),
  xs => [...xs].sort((a,b) => a-b)[(xs.length-1) >> 1]
];`),
    check: { kind: 'json_equal', value: { indexes: [0, 2], expected: [2, 2.5] } },
  },
  {
    id: 'impl-test-v2-factorial-zero-mutants',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: mutationTestPrompt(`const inputs = [0,5,24,25,124,125];
function reference(n) {
  let total = 0;
  for (let d=5; d<=n; d*=5) total += Math.floor(n/d);
  return total;
}
const mutants = [
  n => Math.floor(n/5),
  n => Math.floor(n/5) + Math.floor(n/25),
  n => {
    let x = reference(n);
    if (n > 0 && n % 5 === 0) x--;
    return x;
  }
];`),
    check: { kind: 'json_equal', value: { indexes: [5], expected: [31] } },
  },
  {
    id: 'impl-test-v2-normalized-modulo-mutants',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: mutationTestPrompt(`const inputs = [[0,3],[1,3],[-1,3],[-3,3],[-4,3],[4,3]];
const reference = ([a,b]) => ((a%b)+b)%b;
const mutants = [
  ([a,b]) => a%b,
  ([a,b]) => Math.abs(a%b),
  ([a,b]) => a%b+b
];`),
    check: { kind: 'json_equal', value: { indexes: [0, 2], expected: [0, 2] } },
  },
  {
    id: 'impl-test-v2-stable-dedupe-mutants',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: mutationTestPrompt(`const inputs = [[1,2,1], [0,2,0,1], [], [3,2,1]];
const reference = xs => [...new Set(xs)];
const mutants = [
  xs => xs.filter((x,i) => xs.lastIndexOf(x) === i),
  xs => reference(xs).sort((a,b) => a-b),
  xs => reference(xs).filter(Boolean)
];`),
    check: { kind: 'json_equal', value: { indexes: [1], expected: [[0, 2, 1]] } },
  },
  {
    id: 'impl-test-v2-half-open-overlap-mutants',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: mutationTestPrompt(`const inputs = [[0,2,2,4], [0,4,1,2], [0,2,1,3], [0,0,0,1], [1,3,0,2]];
const reference = ([a,b,c,d]) => Math.max(a,c) < Math.min(b,d);
const mutants = [
  ([a,b,c,d]) => Math.max(a,c) <= Math.min(b,d),
  ([a,b,c,d]) => a <= c && d <= b,
  ([a,b,c,d]) => a < c && c < b
];`),
    check: { kind: 'json_equal', value: { indexes: [0, 4], expected: [false, true] } },
  },
  {
    id: 'impl-test-v2-unicode-unit-mutants',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: mutationTestPrompt(String.raw`const inputs = ["a", "é", "🙂", "e\u0301", "👩\u200d💻"];
const reference = s => [...s].length;
const mutants = [
  s => s.length,
  s => Buffer.byteLength(s, 'utf8'),
  s => [...s].filter(c => !/\p{Mark}/u.test(c)).length
];`),
    check: { kind: 'json_equal', value: { indexes: [2, 3], expected: [1, 2] } },
  },
  {
    id: 'impl-test-v2-nullish-default-mutants',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: mutationTestPrompt(`const inputs = [{}, {v:null}, {v:0}, {v:false}, {v:""}, {v:2}];
const reference = x => x.v ?? 7;
const mutants = [
  x => x.v || 7,
  x => x.v === null ? 7 : x.v,
  x => x.v === null ? 0 : x.v
];`),
    check: { kind: 'json_equal', value: { indexes: [0, 2], expected: [7, 0] } },
  },
  {
    id: 'impl-test-v2-clamp-mutants',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: mutationTestPrompt(`const inputs = [[-2,0,3],[2,0,3],[5,0,3],[0,0,3],[3,0,3]];
const reference = ([n,lo,hi]) => Math.min(hi, Math.max(lo,n));
const mutants = [
  ([n,lo,hi]) => Math.max(lo,n),
  ([n,lo,hi]) => Math.min(hi,n),
  ([n,lo,hi]) => n <= lo ? lo+1 : n >= hi ? hi-1 : n
];`),
    check: { kind: 'json_equal', value: { indexes: [0, 2], expected: [0, 3] } },
  },
  {
    id: 'impl-test-v2-weighted-rate-mutants',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: mutationTestPrompt(`const inputs = [
  [[1,2],[0,8]],
  [[1,3],[1,3]],
  [[1,1],[0,3]],
  [[0,2],[0,5]]
];
const reference = rows =>
  rows.reduce((s,[hits]) => s+hits,0) /
  rows.reduce((s,[,total]) => s+total,0);
const mutants = [
  rows => rows.reduce((s,[a,b]) => s+a/b,0) / rows.length,
  rows => Math.round(reference(rows)*10)/10,
  rows => rows.reduce((s,[a,b]) => s+Math.round(a/b),0) / rows.length
];`),
    check: { kind: 'json_equal', value: { indexes: [2], expected: [0.25] } },
  },
  {
    id: 'impl-test-v2-microtask-order-assertion',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: `Complete a regression test by supplying the expected JSON value for result below. No timers, I/O, or other tasks run. Return only a JSON object with keys "trace", "value" in that order.
async function run() {
  const trace = [];
  async function task() {
    trace.push("start");
    await Promise.resolve();
    trace.push("resume");
    return 4;
  }
  const p = task()
    .then(n => {
      trace.push("then:" + n);
      return n + 1;
    })
    .finally(() => {
      trace.push("finally");
    });
  queueMicrotask(() => trace.push("queued"));
  trace.push("sync");
  const value = await p;
  trace.push("end:" + value);
  return {trace, value};
}
const result = await run();
assert.deepEqual(result, EXPECTED);`,
    check: { kind: 'json_equal', value: { trace: ['start', 'sync', 'resume', 'queued', 'then:4', 'finally', 'end:5'], value: 5 } },
  },
  {
    id: 'impl-test-v2-sparse-map-mutation-assertion',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: `Complete a regression test for sparse arrays and mutation during map. EXPECTED is parsed from your JSON answer before the assertion; the JSON round-trip intentionally converts holes to null. Return only the JSON object with keys "seen", "mapped", "source" in that order.
const xs = [1,,3,4];
const seen = [];
const mapped = xs.map((n,i,a) => {
  seen.push([i,n]);
  if (i === 0) {
    a[1] = 2;
    a.push(5);
  }
  if (i === 1) delete a[2];
  return n * 10;
});
const actual = JSON.parse(JSON.stringify({seen,mapped,source:xs}));
assert.deepEqual(actual, EXPECTED);`,
    check: { kind: 'json_equal', value: { seen: [[0, 1], [1, 2], [3, 4]], mapped: [10, 20, null, 40], source: [1, 2, null, 4, 5] } },
  },
  {
    id: 'impl-test-v2-json-hook-order-assertion',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: `Supply the expected value for this regression assertion. Return only the JSON object with keys "calls", "text" in that order; text is a STRING containing serialized JSON, not a nested object.
const calls = [];
const obj = {
  a: 1,
  get b() {
    calls.push("get:b");
    return 2;
  },
  c: {
    toJSON() {
      calls.push("toJSON:c");
      return {x:3,y:4};
    }
  }
};
const text = JSON.stringify(obj, (key,value) => {
  calls.push("key:" + key);
  return key === "x" ? undefined :
    typeof value === "number" ? value * 10 : value;
});
assert.deepEqual({calls,text}, EXPECTED);`,
    check: { kind: 'json_equal', value: { calls: ['key:', 'key:a', 'get:b', 'key:b', 'toJSON:c', 'key:c', 'key:x', 'key:y'], text: '{"a":10,"b":20,"c":{"y":40}}' } },
  },
  {
    id: 'impl-test-v2-sticky-regex-assertion',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: `Supply the expected JSON array for this sticky-regex regression test. Each output pair contains matched text (or null on failure) and lastIndex AFTER exec. Return only the JSON array.
const re = /a+/gy;
const steps = [];
for (const [text,pos] of [
  ["aa_a",0],
  ["aa_a",2],
  ["aa_a",3],
  ["bbb",1],
  ["aa",0]
]) {
  re.lastIndex = pos;
  const m = re.exec(text);
  steps.push([m ? m[0] : null, re.lastIndex]);
}
assert.deepEqual(steps, EXPECTED);`,
    check: { kind: 'json_equal', value: [['aa', 2], [null, 0], ['a', 4], [null, 0], ['aa', 2]] },
  },
  {
    id: 'impl-test-v2-property-enumeration-assertion',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: `Complete the expected fixture for this object-enumeration regression test. Return only a JSON object with keys "own", "all", "hasHidden", "hasInherited" in that order.
const proto = {inherited:1};
const obj = Object.create(proto);
obj["10"] = "ten";
obj["2"] = "two";
obj.a = 3;
Object.defineProperty(obj, "hidden", {
  value:4,
  enumerable:false
});
obj.b = 5;
delete obj.a;
obj.a = 6;
const all = [];
for (const k in obj) all.push(k);
const actual = {
  own: Object.keys(obj),
  all,
  hasHidden: Object.hasOwn(obj,"hidden"),
  hasInherited: Object.hasOwn(obj,"inherited")
};
assert.deepEqual(actual, EXPECTED);`,
    check: { kind: 'json_equal', value: { own: ['2', '10', 'b', 'a'], all: ['2', '10', 'b', 'a', 'inherited'], hasHidden: true, hasInherited: false } },
  },
  {
    id: 'impl-test-v2-stable-secondary-sort-assertion',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: `Supply the expected JSON fixture for a regression test of stable sorting and first-per-key selection. Return only an object with keys "order", "selected" in that order.
const rows = [
  {k:"b",n:2,id:"p"},
  {k:"a",n:1,id:"q"},
  {k:"b",n:2,id:"r"},
  {k:"a",n:3,id:"s"},
  {k:"b",n:1,id:"t"}
];
rows.sort((a,b) =>
  a.k < b.k ? -1 : a.k > b.k ? 1 : b.n-a.n
);
const selected = rows
  .filter((x,i,a) => i === 0 || a[i-1].k !== x.k)
  .map(x => x.id);
const actual = {order:rows.map(x => x.id), selected};
assert.deepEqual(actual, EXPECTED);`,
    check: { kind: 'json_equal', value: { order: ['s', 'q', 'p', 'r', 't'], selected: ['s', 'p'] } },
  },
  {
    id: 'impl-test-v2-rejected-single-flight-assertion',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: `Complete the expected fixture for this rejected-promise cache regression test. It runs in isolation. Return only a JSON object with keys "sameFirst", "statuses", "sameSecond", "second", "calls" in that order.
let calls = 0;
const cache = new Map();
function get(key) {
  if (cache.has(key)) return cache.get(key);
  calls++;
  const p = Promise.resolve().then(() => {
    if (calls === 1) throw Error("fail");
    return key + ":" + calls;
  });
  cache.set(key,p);
  p.catch(() => {
    if (cache.get(key) === p) cache.delete(key);
  });
  return p;
}
const a = get("x");
const b = get("x");
const first = await Promise.allSettled([a,b]);
const c = get("x");
const d = get("x");
const second = await Promise.all([c,d]);
const actual = {
  sameFirst:a === b,
  statuses:first.map(x => x.status),
  sameSecond:c === d,
  second,
  calls
};
assert.deepEqual(actual, EXPECTED);`,
    check: { kind: 'json_equal', value: { sameFirst: true, statuses: ['rejected', 'rejected'], sameSecond: true, second: ['x:2', 'x:2'], calls: 2 } },
  },
  {
    id: 'impl-test-v2-generator-return-finally-assertion',
    taskType: 'implementation',
    subtaskType: 'test_creation',
    systemPrompt: CODE_SYS,
    userPrompt: `Complete this generator regression test's expected fixture. The JSON round-trip intentionally omits undefined-valued object properties. Return only a JSON object with keys "values", "trace" in that order; iterator-result objects use "value" before "done" when value exists.
const trace = [];
function* inner() {
  try {
    yield "a";
    yield "b";
  } finally {
    trace.push("inner-finally");
    yield "cleanup";
  }
}
function* outer() {
  try {
    yield "start";
    yield* inner();
    yield "end";
  } finally {
    trace.push("outer-finally");
  }
}
const g = outer();
const values = [
  g.next(),
  g.next(),
  g.return("stop"),
  g.next(),
  g.next()
];
const actual = JSON.parse(JSON.stringify({values,trace}));
assert.deepEqual(actual, EXPECTED);`,
    check: { kind: 'json_equal', value: { values: [{ value: 'start', done: false }, { value: 'a', done: false }, { value: 'cleanup', done: false }, { value: 'end', done: false }, { done: true }], trace: ['inner-finally', 'outer-finally'] } },
  },
];
