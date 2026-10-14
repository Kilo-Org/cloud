import type { DeciderCase } from '../decider-cases';

const INVESTIGATION_SYSTEM_PROMPT =
  'You are a precise investigation assistant. Reason from the supplied repository, execution model, or versioned specification excerpts only. Return exactly the requested JSON, with no prose or markdown.';

export const INVESTIGATION_FRONTIER_CASES: readonly DeciderCase[] = [
  {
    id: "frontier-invest-conditional-export-resolution",
    taskType: 'investigation',
    subtaskType: "repo_exploration",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate the supplied repository snapshot; all files and runtime assumptions needed are below. Resolve behavior across file boundaries, not by file names alone. Return JSON with keys "development", "production" in that order; each value is [codecFile,dependencyFile].

package.json:
{"imports":{"#codec":{"worker":{"development":"./debug.js","default":"./fast.js"},"node":"./node.js","default":"./fallback.js"}}}
resolve.js: export function resolve(map, active) { if (typeof map === 'string') return map; for (const key of Object.keys(map)) { if (key === 'default' || active.includes(key)) { const result = resolve(map[key], active); if (result !== undefined) return result; } } }
loader.js: #codec is resolved by resolve(package.imports['#codec'], active). Only the selected module is loaded.
debug.js: export const dependency = '#trace';
fast.js: export const dependency = '#hash';
node.js: export const dependency = '#fs';
fallback.js: export const dependency = null;
trace-package.json: {"imports":{"#trace":{"production":"./sink.js","worker":"./ring.js","default":"./console.js"}}}
entry.js: Resolve #codec for active=['node','worker','development','production']; resolve the selected dependency with trace-package imports and the same active list. Repeat with active=['node','worker','production']. Object-key insertion order, not active-list order, is normative. #hash resolves to './hash.js'.`,
    check: {
      kind: 'json_equal',
      value: {
        "development": [
          "./debug.js",
          "./sink.js"
        ],
        "production": [
          "./fast.js",
          "./hash.js"
        ]
      },
    },
  },
  {
    id: "frontier-invest-config-diamond-tombstones",
    taskType: 'investigation',
    subtaskType: "repo_exploration",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate the supplied repository snapshot; all files and runtime assumptions needed are below. Resolve behavior across file boundaries, not by file names alone. Return JSON keys "db", "flags", "timeout" in that order; db keys "retry", "host", "tls" in that order, omitting deleted keys.

merge.js: merge(base,patch) copies base; a null patch deletes the key, two plain objects merge recursively, arrays replace, other values overwrite. resolve(name) folds parents left-to-right starting from {}, then merges the named own patch. Each parent is fully resolved independently; no global visited suppression.
configs.json:
{"base":{"parents":[],"own":{"db":{"host":"a","retry":3},"flags":["x"],"timeout":9}},"west":{"parents":["base"],"own":{"db":{"host":null,"port":4},"flags":["w"]}},"east":{"parents":["base"],"own":{"db":{"retry":null},"timeout":0}},"app":{"parents":["west","east"],"own":{"db":{"port":null,"tls":true},"flags":[]}}}
entry.js: resolve('app').`,
    check: {
      kind: 'json_equal',
      value: {
        "db": {
          "retry": 3,
          "host": "a",
          "tls": true
        },
        "flags": [],
        "timeout": 0
      },
    },
  },
  {
    id: "frontier-invest-commonjs-cycle-replaced-exports",
    taskType: 'investigation',
    subtaskType: "repo_exploration",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate the supplied repository snapshot; all files and runtime assumptions needed are below. Resolve behavior across file boundaries, not by file names alone. Return result with keys "a", "seen", "read", "same", "bRead" in that order.

runtime.js: require(id) inserts {exports:{}} into cache before executing that module. It returns cached .exports by identity; replacing module.exports does not update old references.
a.js: exports.phase='start'; const b=require('b'); module.exports={phase:'end', seen:b.seen, read:()=>b.read()};
b.js: const a=require('a'); exports.seen=a.phase; exports.read=()=>a.phase; a.phase='mutated';
entry.js: const a=require('a'); const b=require('b'); result={a:a.phase, seen:a.seen, read:a.read(), same:a===require('a'), bRead:b.read()}.`,
    check: {
      kind: 'json_equal',
      value: {
        "a": "end",
        "seen": "start",
        "read": "mutated",
        "same": true,
        "bRead": "mutated"
      },
    },
  },
  {
    id: "frontier-invest-workspace-build-edge-kinds",
    taskType: 'investigation',
    subtaskType: "repo_exploration",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate the supplied repository snapshot; all files and runtime assumptions needed are below. Resolve behavior across file boundaries, not by file names alone. Return JSON keys "reachable", "order"; reachable sorted lexicographically, order in execution order.

planner.ts: From root, traverse runtime and build edges recursively. dev edges are traversed only for the root, never transitively. An override rewrites a target before traversal. After reachability, schedule by build edges only (including rewritten ones); runtime edges do not constrain build order. Lexicographically smallest ready package is always selected.
workspace.json: app: runtime=[api], build=[ui], dev=[test]; api: runtime=[schema], build=[gen], dev=[lint]; ui: runtime=[old-theme], build=[gen], dev=[]; test: runtime=[harness], build=[], dev=[lint]; schema: runtime=[], build=[gen], dev=[]; gen, theme, harness, lint, old-theme: all lists empty.
overrides.json: old-theme -> theme.
entry.ts: plan('app').`,
    check: {
      kind: 'json_equal',
      value: {
        "reachable": [
          "api",
          "app",
          "gen",
          "harness",
          "schema",
          "test",
          "theme",
          "ui"
        ],
        "order": [
          "gen",
          "api",
          "harness",
          "schema",
          "test",
          "theme",
          "ui",
          "app"
        ]
      },
    },
  },
  {
    id: "frontier-invest-tree-shaking-effect-closure",
    taskType: 'investigation',
    subtaskType: "repo_exploration",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate the supplied repository snapshot; all files and runtime assumptions needed are below. Resolve behavior across file boundaries, not by file names alone. Return JSON keys "retained", "effects" in that order. Follow the stated bundler, not assumptions about a real bundler.

bundle.ts: Start with entry used. For each used module, include all imports whose binding is used; also include every import of a module marked effects=true. Repeat to fixed point. A module's imports are examined only once that module is included. Unused re-exports do not include their targets. Output retained modules sorted; evaluation uses dependency-first DFS, import declaration order, skipping already visiting/visited modules, and emits only effects=true modules when finishing DFS.
entry.ts: imports=[['facade',used],['metrics',unused]], effects=false.
facade.ts: imports=[['core',used],['compat',unused]], unused re-export='legacy', effects=false.
core.ts: imports=[['registry',used]], effects=false.
registry.ts: imports=[['core',used],['patch',unused]], effects=true.
metrics.ts: imports=[['transport',unused]], effects=true.
patch.ts: imports=[], effects=true.
compat.ts: imports=[['legacy',used]], effects=false.
legacy.ts: imports=[], effects=true.
transport.ts: imports=[], effects=false.`,
    check: {
      kind: 'json_equal',
      value: {
        "retained": [
          "core",
          "entry",
          "facade",
          "metrics",
          "patch",
          "registry"
        ],
        "effects": [
          "patch",
          "registry",
          "metrics"
        ]
      },
    },
  },
  {
    id: "frontier-invest-middleware-mounted-precedence",
    taskType: 'investigation',
    subtaskType: "repo_exploration",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate the supplied repository snapshot; all files and runtime assumptions needed are below. Resolve behavior across file boundaries, not by file names alone. Return JSON keys "matched", "unmatched"; each object keys "status", "log".

router.js: Build chains as global middleware, matching mount middleware, then route middleware, each in registration order. next() invokes the remainder once. A middleware may mutate context before and after next(); a route terminates unless it calls next. Query strings are removed before exact route matching.
global.js: G(ctx,next){ctx.log.push('G+'); next();ctx.log.push('G-')}; register G first.
mount.js: mount('/v1', M), where M logs 'M+', sets role='guest', calls next(), then logs 'M-'. Prefix match requires segment boundary.
auth.js: A logs 'A'; if ctx.token==='ok' sets role='admin' and calls next(); otherwise sets status=401 and terminates.
routes.js: register GET '/v1/item' [A,H]; H logs 'H:'+role; status=200; then registers GET '/v1/item' [J] where J logs 'J' and status=201. First matching route only.
entry.js: run GET '/v1/item?x=1',token='ok'; run GET '/v10/item',token='ok'. Unmatched request still runs globals then sets status=404.`,
    check: {
      kind: 'json_equal',
      value: {
        "matched": {
          "status": 200,
          "log": [
            "G+",
            "M+",
            "A",
            "H:admin",
            "M-",
            "G-"
          ]
        },
        "unmatched": {
          "status": 404,
          "log": [
            "G+",
            "G-"
          ]
        }
      },
    },
  },
  {
    id: "frontier-invest-migration-journal-reconciliation",
    taskType: 'investigation',
    subtaskType: "repo_exploration",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate the supplied repository snapshot; all files and runtime assumptions needed are below. Resolve behavior across file boundaries, not by file names alone. Return JSON keys "operations", "markers" in that order; markers sorted.

manifest.json: [{id:'a',after:[],hash:'1'},{id:'b',after:['a'],hash:'2'},{id:'c',after:['a'],hash:'3'},{id:'d',after:['b','c'],hash:'4'},{id:'e',after:['d'],hash:'5'}].
journal.json: [{id:'a',hash:'1',state:'applied'},{id:'b',hash:'2',state:'started'},{id:'c',hash:'3',state:'applied'}].
runner.ts: Applied means matching hash plus state=applied. started is not applied. Choose lexicographically smallest runnable unapplied migration. Recovery for a started migration invokes down then up; new migrations invoke up only. Record applied after up succeeds. Preflight fails only on an applied hash mismatch.
changes.ts: down('b') deletes marker B if present; up('b') creates marker B, up('d') adds D, up('e') removes C and adds E. Initial marker set is A,B,C. No other changes.`,
    check: {
      kind: 'json_equal',
      value: {
        "operations": [
          "down:b",
          "up:b",
          "up:d",
          "up:e"
        ],
        "markers": [
          "A",
          "B",
          "D",
          "E"
        ]
      },
    },
  },
  {
    id: "frontier-invest-retry-token-ownership",
    taskType: 'investigation',
    subtaskType: "repo_exploration",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate the supplied repository snapshot; all files and runtime assumptions needed are below. Resolve behavior across file boundaries, not by file names alone. Return JSON keys "generation", "value", "accepted", "rejected". accepted/rejected are operation labels in chronological order, labels formed operation+generation with no separator.

store.ts: slot={generation:0,value:null}; begin() increments generation and returns it. success(g,v) writes only when g===slot.generation. failure(g) clears only when g===slot.generation. cancel(g) increments generation and clears only when g===slot.generation.
client.ts: A=begin(); B=begin(); success(A,'old'); cancel(A); success(B,'new'); C=begin(); failure(B); D=begin(); success(C,'stale'); cancel(D); success(D,'late'); E=begin(); success(E,'fresh').
audit.ts: Every success/failure/cancel appends [operation,g,accepted] even if ignored. begin does not log.`,
    check: {
      kind: 'json_equal',
      value: {
        "generation": 6,
        "value": "fresh",
        "accepted": [
          "success2",
          "cancel4",
          "success6"
        ],
        "rejected": [
          "success1",
          "cancel1",
          "failure2",
          "success3",
          "success4"
        ]
      },
    },
  },
  {
    id: "frontier-invest-alias-extension-shadowing",
    taskType: 'investigation',
    subtaskType: "repo_exploration",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate the supplied repository snapshot; all files and runtime assumptions needed are below. Resolve behavior across file boundaries, not by file names alone. Return JSON keys "resolved", "missing"; resolved is an array in request order of found paths; missing contains unresolved original specifiers.

resolver.ts: For bare specifiers select the longest matching alias prefix (segment boundary), replace prefix once, and never alias again. Resolve a resulting extensionless path by candidates path+'.ts', path+'/index.ts', path+'.js' in that order. For a relative specifier normalize '.'/'..' against importer directory and do not use aliases. No package fallback.
aliases.json: {'@':'/src','@/lib':'/vendor/lib','@/lib/private':'/src/internal'}.
files.txt: /src/lib/run.ts, /vendor/lib/run/index.ts, /vendor/lib/run.js, /src/internal/key.ts, /src/lib/private/key.ts, /src/main.ts, /src/util/index.ts, /vendor/lib/util.ts.
entry.ts: from /src/main.ts resolve '@/lib/run', '@/lib/private/key', './lib/run', '@/util', '@/library/run'.`,
    check: {
      kind: 'json_equal',
      value: {
        "resolved": [
          "/vendor/lib/run/index.ts",
          "/src/internal/key.ts",
          "/src/lib/run.ts",
          "/src/util/index.ts"
        ],
        "missing": [
          "@/library/run"
        ]
      },
    },
  },
  {
    id: "frontier-invest-feature-policy-source-order",
    taskType: 'investigation',
    subtaskType: "repo_exploration",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate the supplied repository snapshot; all files and runtime assumptions needed are below. Resolve behavior across file boundaries, not by file names alone. Return JSON keys "enabled", "values"; values keys "audit", "beta", "export", "search".

policy.ts: Start with default=false. Apply organization, project, user assignments in that order; null means inherit, false is an explicit assignment. A locked organization assignment prevents every later assignment for that flag, including user. Finally a kill switch forces false regardless of lock. A dependency is evaluated after assignment; if any dependency is false its dependent is false. Dependencies form a DAG.
org.json: search={value:true,locked:true}, export={value:true,locked:false}, beta={value:false,locked:false}.
project.json: search=false, export=null, beta=true, audit=true.
user.json: search=false, export=true, beta=null, audit=false.
kill.json: ['export'].
deps.json: search=[], export=['search'], beta=['export'], audit=['search'].
entry.ts: evaluate every flag, then return enabled flags lexicographically sorted and all final values.`,
    check: {
      kind: 'json_equal',
      value: {
        "enabled": [
          "search"
        ],
        "values": {
          "audit": false,
          "beta": false,
          "export": false,
          "search": true
        }
      },
    },
  },
  {
    id: "frontier-invest-invalidation-captured-dependencies",
    taskType: 'investigation',
    subtaskType: "repo_exploration",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate the supplied repository snapshot; all files and runtime assumptions needed are below. Resolve behavior across file boundaries, not by file names alone. Return JSON keys "loads", "results", "cached"; results lists the four top-level get return values in order and cached lists final cache keys sorted.

cache.ts: get(key,loader) returns cached value when present. On a miss, dependencies are exactly keys read by nested get during that loader, even when those nested reads hit cache. invalidate(key) deletes that entry and recursively deletes current entries whose captured dependencies contain it. An entry deleted loses its dependency edges.
loaders.ts: A returns source.a; B returns get(A)*2; C returns get(B)+get(A); D returns get(C)+source.d. source initially {a:2,d:1}.
entry.ts: get(D); source.a=5; invalidate(B); get(C); get(D); source.d=9; invalidate(A); get(D).
audit.ts: log every loader execution using its key, in chronological order. Source changes alone never invalidate.`,
    check: {
      kind: 'json_equal',
      value: {
        "loads": [
          "D",
          "C",
          "B",
          "A",
          "C",
          "B",
          "D",
          "D",
          "C",
          "B",
          "A"
        ],
        "results": [
          7,
          6,
          7,
          24
        ],
        "cached": [
          "A",
          "B",
          "C",
          "D"
        ]
      },
    },
  },
  {
    id: "frontier-invest-plugin-waterfall-live-registration",
    taskType: 'investigation',
    subtaskType: "repo_exploration",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate the supplied repository snapshot; all files and runtime assumptions needed are below. Resolve behavior across file boundaries, not by file names alone. Return JSON keys "first", "second", "nested", "log".

hooks.ts: register(name,fn) appends. waterfall(seed) snapshots the callback array once, then applies each callback to the previous result. recursive waterfall calls take their own snapshot.
plugin-a.ts: register('a', x=>{ if (!installed) {installed=true; register('c',y=>y*3); nested=waterfall(2)}; return x+nested }); installed=false,nested=0.
plugin-b.ts: register('b',x=>x-1).
entry.ts: Load a then b. first=waterfall(5); second=waterfall(5). Each callback logs name+':'+input before its body. During the recursive call a sees installed=true and nested still 0 because nested assignment occurs after recursion returns.`,
    check: {
      kind: 'json_equal',
      value: {
        "first": 7,
        "second": 21,
        "nested": 3,
        "log": [
          "a:5",
          "a:2",
          "b:2",
          "c:1",
          "b:8",
          "a:5",
          "b:8",
          "c:7"
        ]
      },
    },
  },
  {
    id: "frontier-invest-outbox-crash-dedup-boundaries",
    taskType: 'investigation',
    subtaskType: "repo_exploration",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate the supplied repository snapshot; all files and runtime assumptions needed are below. Resolve behavior across file boundaries, not by file names alone. Return JSON keys "producerBalance", "consumerBalance", "events", "log"; events is event IDs in creation order.

db.ts: In a transaction, increment balance and append outbox event atomically. Request dedup is keyed by requestId, not payload; repeats return existing event without balance changes. Initial balance=0.
producer.ts: commit R1:+7 -> event E1; commit R2:+4 -> E2; repeat R1:+99 -> existing E1; commit R3:-2 -> E3.
consumer.ts: Delivering an event: if inbox has eventId, ignore; otherwise atomically add amount to consumerBalance and insert eventId into inbox. Marking producer outbox delivered is a separate operation. A crash after inbox commit before producer marking leaves event eligible for replay. Start consumerBalance=0.
dispatch.ts: deliver E1, crash before marking; deliver E2 and mark; replay E1 and mark; deliver E3 and mark; deliver E2 again. Log 'apply:E#' or 'ignore:E#' for every delivery.`,
    check: {
      kind: 'json_equal',
      value: {
        "producerBalance": 9,
        "consumerBalance": 9,
        "events": [
          "E1",
          "E2",
          "E3"
        ],
        "log": [
          "apply:E1",
          "apply:E2",
          "ignore:E1",
          "apply:E3",
          "ignore:E2"
        ]
      },
    },
  },
  {
    id: "frontier-invest-peer-resolution-nearest-scope",
    taskType: 'investigation',
    subtaskType: "repo_exploration",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate the supplied repository snapshot; all files and runtime assumptions needed are below. Resolve behavior across file boundaries, not by file names alone. Return JSON keys "root", "plugin"; each keys "view", "directReact", "peerReact", "peerSatisfied".

resolve.ts: A dependency is looked up from the requesting package directory upward at each ancestor/node_modules/name. A peer is resolved from the dependent package's parent directory upward, not from inside its own node_modules. No realpath/symlink effects. Versions are exact integers; peer range '^N' accepts versions N only in this simplified model.
filesystem.json:
/app/node_modules/react version=2
/app/node_modules/view version=5, peer react='^2'
/app/node_modules/view/node_modules/react version=3
/app/node_modules/plugin version=1
/app/node_modules/plugin/node_modules/view version=6, peer react='^3'
/app/node_modules/plugin/node_modules/react version=3
/app/node_modules/plugin/node_modules/view/node_modules/react version=4
entry.ts: /app requires view; plugin requires view. For each selected view, compare its direct require('react') with peer react resolution.`,
    check: {
      kind: 'json_equal',
      value: {
        "root": {
          "view": 5,
          "directReact": 3,
          "peerReact": 2,
          "peerSatisfied": true
        },
        "plugin": {
          "view": 6,
          "directReact": 4,
          "peerReact": 3,
          "peerSatisfied": true
        }
      },
    },
  },
  {
    id: "frontier-invest-route-decode-before-validation",
    taskType: 'investigation',
    subtaskType: "repo_exploration",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate the supplied repository snapshot; all files and runtime assumptions needed are below. Resolve behavior across file boundaries, not by file names alone. Return JSON keys "statuses", "accepted"; statuses in request order, accepted contains decoded filenames for only status=200.

mount.ts: Raw URL pathname is split on literal '/' before percent decoding each segment exactly once. Empty segments are kept. Query is discarded. Encoded '/' stays within the decoded segment, never re-split. Invalid percent encoding returns 400 before routing.
routes.ts: First segment must be 'api'; second must be 'files'; exactly one further segment required. Decoder result '.' or '..', or containing '/', is rejected 403. Empty filename gives 422. Otherwise route returns 200 and the filename. Shape mismatch gives 404.
entry.ts: Requests ['/api/files/a%2Fb','/api/files/%252e%252e','/api/files/%2e%2e','/api/files/','/api/files/x/y','/api/files/%ZZ','/api/files/a%3Fb?ignored=1'].`,
    check: {
      kind: 'json_equal',
      value: {
        "statuses": [
          403,
          200,
          403,
          422,
          404,
          400,
          200
        ],
        "accepted": [
          "%2e%2e",
          "a?b"
        ]
      },
    },
  },
  {
    id: "frontier-invest-thenable-assimilation-finally-order",
    taskType: 'investigation',
    subtaskType: "codebase_understanding",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate the ordering contract among a foreign thenable, an async continuation, a finally handler returning a promise, and explicitly queued jobs. Return only the final result as JSON with keys "log" in exactly that order. The following is one async function body; await its completion under modern ECMAScript semantics. No timers or external input exist.

const log=[];
const t={then(resolve){log.push('thenable');queueMicrotask(()=>log.push('inside'));resolve('v');resolve('ignored')}};
const p=Promise.resolve(t).then(v=>{log.push('value:'+v);return 'done'}).finally(()=>{log.push('finally');return Promise.resolve().then(()=>log.push('cleanup'))}).then(v=>log.push('after:'+v));
const q=(async()=>{log.push('async:start');await 0;log.push('async:resume');await t;log.push('async:end')})();
queueMicrotask(()=>{log.push('q1');queueMicrotask(()=>log.push('q2'))});
log.push('sync');
await Promise.all([p,q]);
return {log};

Serialize nested objects in property creation order. Iterator result objects use keys value,done in that order; omit properties whose values are undefined, as JSON.stringify does.`,
    check: {
      kind: 'json_equal',
      value: {
        "log": [
          "async:start",
          "sync",
          "thenable",
          "async:resume",
          "q1",
          "inside",
          "value:v",
          "thenable",
          "q2",
          "finally",
          "inside",
          "async:end",
          "cleanup",
          "after:done"
        ]
      },
    },
  },
  {
    id: "frontier-invest-iterator-abrupt-completion-precedence",
    taskType: 'investigation',
    subtaskType: "codebase_understanding",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate iterator closing across destructuring and a throwing loop body; distinguish an iterator return failure from the pre-existing completion. Return only the final result as JSON with keys "firstError", "secondError", "log" in exactly that order. The following is one async function body; await its completion under modern ECMAScript semantics. No timers or external input exist.

const log=[];
function iterable(tag){return {[Symbol.iterator](){let n=0;return {next(){log.push(tag+':next');return {value:++n,done:false}},return(){log.push(tag+':return');throw new Error(tag+':close')}}}}}
let firstError,secondError;
try{const [a,b]=iterable('bind');log.push('bound:'+a+','+b)}catch(e){firstError=e.message}
try{for(const n of iterable('loop')){log.push('body:'+n);throw new Error('body')}}catch(e){secondError=e.message}
return {firstError,secondError,log};

Serialize nested objects in property creation order. Iterator result objects use keys value,done in that order; omit properties whose values are undefined, as JSON.stringify does.`,
    check: {
      kind: 'json_equal',
      value: {
        "firstError": "bind:close",
        "secondError": "body",
        "log": [
          "bind:next",
          "bind:next",
          "bind:return",
          "loop:next",
          "body:1",
          "loop:return"
        ]
      },
    },
  },
  {
    id: "frontier-invest-proxy-spread-descriptor-race",
    taskType: 'investigation',
    subtaskType: "codebase_understanding",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate a proxy with an ownKeys snapshot whose getters mutate later property descriptors. Account for spread using enumerable descriptors and for JSON key-order rules. Return only the final result as JSON with keys "keys", "values", "log" in exactly that order. The following is one async function body; await its completion under modern ECMAScript semantics. No timers or external input exist.

const log=[];
const target={2:'two',a:1,b:2};
const proxy=new Proxy(target,{ownKeys(t){log.push('keys');return ['b','a','2','ghost']},getOwnPropertyDescriptor(t,k){log.push('desc:'+k);return Reflect.getOwnPropertyDescriptor(t,k)},get(t,k,r){log.push('get:'+k);if(k==='b'){delete t.a;Object.defineProperty(t,'ghost',{value:9,enumerable:true,configurable:true})}return Reflect.get(t,k,r)}});
const copy={...proxy,a:7};
return {keys:Object.keys(copy),values:Object.values(copy),log};

Serialize nested objects in property creation order. Iterator result objects use keys value,done in that order; omit properties whose values are undefined, as JSON.stringify does.`,
    check: {
      kind: 'json_equal',
      value: {
        "keys": [
          "2",
          "b",
          "ghost",
          "a"
        ],
        "values": [
          "two",
          2,
          9,
          7
        ],
        "log": [
          "keys",
          "desc:b",
          "get:b",
          "desc:a",
          "desc:2",
          "get:2",
          "desc:ghost",
          "get:ghost"
        ]
      },
    },
  },
  {
    id: "frontier-invest-dataview-overlapping-copy-and-wrap",
    taskType: 'investigation',
    subtaskType: "codebase_understanding",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate byte-level aliasing, overlapping TypedArray.set, signed reads, and DataView byte order. Do not assume host endianness: all multi-byte operations here specify it. Return only the final result as JSON with keys "before", "bytes", "signed", "after" in exactly that order. The following is one async function body; await its completion under modern ECMAScript semantics. No timers or external input exist.

const bytes=new Uint8Array([0xff,0x00,0x80,0x7f,0x11,0x22,0x33,0x44]);
const view=new DataView(bytes.buffer);
const before=[view.getInt16(0,false),view.getUint32(2,true)];
bytes.set(bytes.subarray(0,5),2);
view.setInt16(1,65537,false);
const signed=new Int8Array(bytes.buffer,2,4);
const after=[view.getInt16(1,false),view.getUint32(2,false)];
return {before,bytes:[...bytes],signed:[...signed],after};

Serialize nested objects in property creation order. Iterator result objects use keys value,done in that order; omit properties whose values are undefined, as JSON.stringify does.`,
    check: {
      kind: 'json_equal',
      value: {
        "before": [
          -256,
          571572096
        ],
        "bytes": [
          255,
          0,
          1,
          0,
          128,
          127,
          17,
          68
        ],
        "signed": [
          1,
          0,
          -128,
          127
        ],
        "after": [
          1,
          16810111
        ]
      },
    },
  },
  {
    id: "frontier-invest-map-reinsertion-live-generator",
    taskType: 'investigation',
    subtaskType: "codebase_understanding",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate a live Map iterator suspended inside a generator, with key deletion/reinsertion and generator-finally mutation. Remember that reinserted keys occupy new iteration positions. Return only the final result as JSON with keys "first", "second", "third", "closed", "entries", "log" in exactly that order. The following is one async function body; await its completion under modern ECMAScript semantics. No timers or external input exist.

const m=new Map([['a',1],['b',2],['c',3]]),log=[];
function* walk(){try{for(const [k,v] of m){log.push('visit:'+k);yield [k,v]}}finally{log.push('close');m.set('z',9)}}
const g=walk(),first=g.next().value;
m.delete('b');m.set('d',4);m.delete('a');m.set('a',5);
const second=g.next().value;
m.set('c',30);
const third=g.next().value;
const closed=g.return('stop');
return {first,second,third,closed,entries:[...m],log};

Serialize nested objects in property creation order. Iterator result objects use keys value,done in that order; omit properties whose values are undefined, as JSON.stringify does.`,
    check: {
      kind: 'json_equal',
      value: {
        "first": [
          "a",
          1
        ],
        "second": [
          "c",
          3
        ],
        "third": [
          "d",
          4
        ],
        "closed": {
          "value": "stop",
          "done": true
        },
        "entries": [
          [
            "c",
            30
          ],
          [
            "d",
            4
          ],
          [
            "a",
            5
          ],
          [
            "z",
            9
          ]
        ],
        "log": [
          "visit:a",
          "visit:c",
          "visit:d",
          "close"
        ]
      },
    },
  },
  {
    id: "frontier-invest-async-generator-return-yielded-finally",
    taskType: 'investigation',
    subtaskType: "codebase_understanding",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate async generator request queuing when a return request enters a finally block that itself yields. Later next requests can resume that finally block. Return only the final result as JSON with keys "replies", "log" in exactly that order. The following is one async function body; await its completion under modern ECMAScript semantics. No timers or external input exist.

const log=[];
async function* gen(){try{log.push('start');yield await Promise.resolve(1);log.push('body');yield 2}finally{log.push('finally:start');yield 9;log.push('finally:end')}}
const g=gen();
const a=g.next(),b=g.return(7),c=g.next(8),d=g.next();
const replies=await Promise.all([a,b,c,d]);
return {replies,log};

Serialize nested objects in property creation order. Iterator result objects use keys value,done in that order; omit properties whose values are undefined, as JSON.stringify does.`,
    check: {
      kind: 'json_equal',
      value: {
        "replies": [
          {
            "value": 1,
            "done": false
          },
          {
            "value": 9,
            "done": false
          },
          {
            "value": 7,
            "done": true
          },
          {
            "done": true
          }
        ],
        "log": [
          "start",
          "finally:start",
          "finally:end"
        ]
      },
    },
  },
  {
    id: "frontier-invest-structured-clone-alias-transfer",
    taskType: 'investigation',
    subtaskType: "codebase_understanding",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate graph identity preservation across structuredClone with a transferred buffer, including a shared Map key and a cycle. Encoding uses explicit little-endian reads. Return only the final result as JSON with keys "originalBytes", "detachedRead", "cycle", "keyIdentity", "originalKey", "cloneWord" in exactly that order. The following is one async function body; await its completion under modern ECMAScript semantics. No timers or external input exist.

const buffer=new ArrayBuffer(4),view=new DataView(buffer);view.setUint32(0,0x10203040,true);
const key={n:1},root={key,map:new Map(),view};root.self=root;root.map.set(key,view);
const clone=structuredClone(root,{transfer:[buffer]});
clone.key.n=2;clone.map.get(clone.key).setUint8(1,0xff);
let detachedRead;try{view.getUint8(0);detachedRead='ok'}catch(e){detachedRead=e.name}
return {originalBytes:buffer.byteLength,detachedRead,cycle:clone.self===clone,keyIdentity:[...clone.map.keys()][0]===clone.key,originalKey:key.n,cloneWord:clone.view.getUint32(0,true)};

Serialize nested objects in property creation order. Iterator result objects use keys value,done in that order; omit properties whose values are undefined, as JSON.stringify does.`,
    check: {
      kind: 'json_equal',
      value: {
        "originalBytes": 0,
        "detachedRead": "TypeError",
        "cycle": true,
        "keyIdentity": true,
        "originalKey": 1,
        "cloneWord": 270597952
      },
    },
  },
  {
    id: "frontier-invest-sticky-unicode-lastindex-backtracking",
    taskType: 'investigation',
    subtaskType: "codebase_understanding",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate sticky Unicode regex matching when lastIndex lies inside a surrogate pair, and contrast a global non-Unicode dot. Record indices in UTF-16 units. Return only the final result as JSON with keys "sticky", "plainCodeUnit", "plainIndex", "plainLastIndex" in exactly that order. The following is one async function body; await its completion under modern ECMAScript semantics. No timers or external input exist.

const s='A😀B😀C',sticky=/./uy,plain=/./g,log=[];
sticky.lastIndex=2;const a=sticky.exec(s);log.push([a?.[0]??null,a?.index??null,sticky.lastIndex]);
sticky.lastIndex=3;const b=sticky.exec(s);log.push([b?.[0]??null,b?.index??null,sticky.lastIndex]);
sticky.lastIndex=7;const c=sticky.exec(s);log.push([c?.[0]??null,c?.index??null,sticky.lastIndex]);
plain.lastIndex=1;const p=plain.exec(s);
return {sticky:log,plainCodeUnit:p[0].charCodeAt(0),plainIndex:p.index,plainLastIndex:plain.lastIndex};

Serialize nested objects in property creation order. Iterator result objects use keys value,done in that order; omit properties whose values are undefined, as JSON.stringify does.`,
    check: {
      kind: 'json_equal',
      value: {
        "sticky": [
          [
            "😀",
            1,
            3
          ],
          [
            "B",
            3,
            4
          ],
          [
            null,
            null,
            0
          ]
        ],
        "plainCodeUnit": 55357,
        "plainIndex": 1,
        "plainLastIndex": 2
      },
    },
  },
  {
    id: "frontier-invest-inherited-setter-versus-define-spread",
    taskType: 'investigation',
    subtaskType: "codebase_understanding",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate why Object.assign and object spread differ when the source has an enumerable __proto__ property and the target inherits a setter. No host prototype pollution exists outside this snippet. Return only the final result as JSON with keys "log", "assignedOwn", "assignedMarker", "assignedX", "spreadOwn", "spreadMarker", "spreadProtoMarker" in exactly that order. The following is one async function body; await its completion under modern ECMAScript semantics. No timers or external input exist.

const log=[],proto={set x(v){log.push('set:'+v)},marker:4};
const source=JSON.parse('{"x":3,"__proto__":{"marker":9},"y":5}');
const assigned=Object.create(proto);Object.assign(assigned,source);
const spread={...source};
return {log,assignedOwn:Object.keys(assigned),assignedMarker:assigned.marker,assignedX:assigned.x??null,spreadOwn:Object.keys(spread),spreadMarker:spread.marker??null,spreadProtoMarker:spread.__proto__.marker};

Serialize nested objects in property creation order. Iterator result objects use keys value,done in that order; omit properties whose values are undefined, as JSON.stringify does.`,
    check: {
      kind: 'json_equal',
      value: {
        "log": [
          "set:3"
        ],
        "assignedOwn": [
          "y"
        ],
        "assignedMarker": 9,
        "assignedX": null,
        "spreadOwn": [
          "x",
          "__proto__",
          "y"
        ],
        "spreadMarker": null,
        "spreadProtoMarker": 9
      },
    },
  },
  {
    id: "frontier-invest-integer-rounding-object-key-collisions",
    taskType: 'investigation',
    subtaskType: "codebase_understanding",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate exact integer conversion versus Number rounding, SameValueZero key identity, and signed 64-bit wrapping. Every BigInt is serialized as a decimal string. Return only the final result as JSON with keys "numberEqual", "bigintEqual", "size", "values", "signed", "unsigned" in exactly that order. The following is one async function body; await its completion under modern ECMAScript semantics. No timers or external input exist.

const a=9007199254740993n,b=9007199254740992n;
const map=new Map();map.set(Number(a),'a');map.set(Number(b),'b');map.set(-0,'negative');map.set(+0,'positive');map.set(NaN,'first');map.set(Number('x'),'second');
const x=(1n<<63n)+5n,y=-((1n<<64n)+3n);
return {numberEqual:Number(a)===Number(b),bigintEqual:a===b,size:map.size,values:[...map.values()],signed:[BigInt.asIntN(64,x).toString(),BigInt.asIntN(64,y).toString()],unsigned:[BigInt.asUintN(64,x).toString(),BigInt.asUintN(64,y).toString()]};

Serialize nested objects in property creation order. Iterator result objects use keys value,done in that order; omit properties whose values are undefined, as JSON.stringify does.`,
    check: {
      kind: 'json_equal',
      value: {
        "numberEqual": true,
        "bigintEqual": false,
        "size": 3,
        "values": [
          "b",
          "positive",
          "second"
        ],
        "signed": [
          "-9223372036854775803",
          "-3"
        ],
        "unsigned": [
          "9223372036854775813",
          "18446744073709551613"
        ]
      },
    },
  },
  {
    id: "frontier-invest-sc-cas-history-enumeration",
    taskType: 'investigation',
    subtaskType: "codebase_understanding",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate all legal executions of this shared-memory subsystem. Memory is sequentially consistent: enumerate all total orders respecting each thread's program order; each event is atomic. Initially x=0,y=0. Thread A: A1 stores x=1; A2 reads y into rA; A3 compareExchange(x,1,3) into cA (returns old x, changes x only if old x is 1). Thread B: B1 stores y=1; B2 reads x into rB; B3 exchange(x,2) into eB (returns old x). No other events exist. Return only JSON keys "histories", "outcomes" in that order. histories is the number of legal total orders. outcomes contains each distinct [rA,cA,rB,eB,finalX] tuple once, sorted numeric lexicographically.`,
    check: {
      kind: 'json_equal',
      value: {
        "histories": 20,
        "outcomes": [
          [
            0,
            1,
            1,
            3,
            2
          ],
          [
            0,
            1,
            3,
            3,
            2
          ],
          [
            0,
            2,
            1,
            1,
            2
          ],
          [
            1,
            1,
            0,
            0,
            3
          ],
          [
            1,
            1,
            0,
            3,
            2
          ],
          [
            1,
            1,
            1,
            3,
            2
          ],
          [
            1,
            1,
            3,
            3,
            2
          ],
          [
            1,
            2,
            0,
            1,
            2
          ],
          [
            1,
            2,
            1,
            1,
            2
          ]
        ]
      },
    },
  },
  {
    id: "frontier-invest-linearizable-cas-overlap",
    taskType: 'investigation',
    subtaskType: "codebase_understanding",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate whether an observed concurrent history can implement one atomic register, initially 0. Operation intervals are closed; op U must precede V if U.response < V.invocation. A linearization is a permutation respecting those real-time constraints, with one instantaneous operation per interval. Operations: A=write(1), interval [0,4]; B=compareExchange(0,2), interval [1,3], observed old=0; C=read(), interval [2,6], observed value=1; D=compareExchange(1,3), interval [5,7], observed old=1; E=read(), interval [6,8], observed value=3. A write has no returned value; compareExchange returns old value and updates only on expected-value equality. Return JSON keys "orders", "finalValues". orders are every valid linearization as concatenated IDs sorted lexicographically; finalValues are unique final register values sorted numerically. Include overlapping endpoint intervals without inventing precedence.`,
    check: {
      kind: 'json_equal',
      value: {
        "orders": [
          "BACDE"
        ],
        "finalValues": [
          3
        ]
      },
    },
  },
  {
    id: "frontier-invest-seqlock-visibility-counterexample",
    taskType: 'investigation',
    subtaskType: "codebase_understanding",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate a seqlock under this explicitly specified weak visibility model, not a hardware-specific model. Writer publishes seq=1, x=10, y=20, seq=2; initially all are 0. Reader executes s1=seq; a=x; b=y; s2=seq and accepts iff s1==s2 and even. Enumerate s1,s2 from {0,1,2}, requiring s1<=s2. Data reads independently choose 0 or their new value. No future exposure rule: if s2=0 then both data reads must be 0. Three variants: relaxed has no extra constraint; acquireFirst forces both data reads new when s1=2; acquireLast imposes no constraint on earlier data reads when s2=2 (it only constrains reads after itself, of which there are none). Accepted records are valid only if [s1,a,b] is [0,0,0] or [2,10,20]; all others are torn. Return JSON keys "relaxed", "acquireFirst", "acquireLast". Each object has keys "accepted", "torn" with distinct triples sorted numeric lexicographically. This is an investigation of whether a proposed final-acquire-only patch establishes the publication invariant.`,
    check: {
      kind: 'json_equal',
      value: {
        "relaxed": {
          "accepted": [
            [
              0,
              0,
              0
            ],
            [
              2,
              0,
              0
            ],
            [
              2,
              0,
              20
            ],
            [
              2,
              10,
              0
            ],
            [
              2,
              10,
              20
            ]
          ],
          "torn": [
            [
              2,
              0,
              0
            ],
            [
              2,
              0,
              20
            ],
            [
              2,
              10,
              0
            ]
          ]
        },
        "acquireFirst": {
          "accepted": [
            [
              0,
              0,
              0
            ],
            [
              2,
              10,
              20
            ]
          ],
          "torn": []
        },
        "acquireLast": {
          "accepted": [
            [
              0,
              0,
              0
            ],
            [
              2,
              0,
              0
            ],
            [
              2,
              0,
              20
            ],
            [
              2,
              10,
              0
            ],
            [
              2,
              10,
              20
            ]
          ],
          "torn": [
            [
              2,
              0,
              0
            ],
            [
              2,
              0,
              20
            ],
            [
              2,
              10,
              0
            ]
          ]
        }
      },
    },
  },
  {
    id: "frontier-invest-typescript-distribution-key-remapping",
    taskType: 'investigation',
    subtaskType: "codebase_understanding",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate this TypeScript 5.9 type-level API; do not emit source code. Rules: a conditional whose checked side is naked type parameter distributes over unions; a tuple-wrapped check does not. Mapped types below distribute over a union through Dist. Optional properties remain optional in Pick. A required property with type never still has a key. String union outputs must be lexicographically sorted.
type U={kind:'a'; id:string; optional?:number}|{kind:'b'; id:number; count:number}|{kind:'c'; id:string; count?:number};
type Dist<T> = T extends {id:string} ? {[K in keyof T as K extends 'kind' ? never : K]:T[K]} : never;
type Whole<T> = [T] extends [{id:string}] ? true : false;
type Common=keyof Dist<U>;
type AllKeys<T> = T extends unknown ? keyof T : never;
type RequiredKeys<T> = T extends unknown ? {[K in keyof T]-?: {} extends Pick<T,K> ? never : K}[keyof T] : never;
Return JSON keys "whole", "common", "all", "required". whole is Whole<U> as boolean; common is Common as an array; all is AllKeys<Dist<U>> as an array; required is RequiredKeys<Dist<U>> as an array. Exclude never constituents.`,
    check: {
      kind: 'json_equal',
      value: {
        "whole": false,
        "common": [
          "id"
        ],
        "all": [
          "count",
          "id",
          "optional"
        ],
        "required": [
          "id"
        ]
      },
    },
  },
  {
    id: "frontier-invest-typescript-overload-and-never-recursion",
    taskType: 'investigation',
    subtaskType: "codebase_understanding",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Investigate TypeScript 5.9 conditional inference. Rules: ReturnType and Parameters infer from the last overload signature only. Exclude distributes. T extends never distributes when T is a naked parameter, producing never for T=never; [T] extends [never] produces true. Recursive conditional distribution is performed separately for each union alternative. Numeric/string literal unions are reported as sorted strings.
declare function parse(x:'hex'): {kind:'hex';value:number};
declare function parse(x:'text'): {kind:'text';value:string};
declare function parse(x:'hex'|'text'): {kind:'mixed';value:string|number};
type Last=ReturnType<typeof parse>;
type P=Parameters<typeof parse>[0];
type Peel<T> = T extends readonly [infer H,...infer R] ? H|Peel<R> : never;
type Input=readonly ['a',1]|readonly ['b',2,3]|readonly [];
type A=Exclude<Peel<Input>,number>;
type Naked<T>=T extends never ? 'yes':'no';
type Boxed<T>=[T] extends [never] ? 'yes':'no';
Return JSON keys "lastKind", "lastValueTypes", "parameter", "peeledStrings", "nakedNever", "boxedNever". lastValueTypes is an alphabetically sorted array of primitive type names; parameter and peeledStrings sorted literal arrays. Represent a never result by [], other results by a singleton string array.`,
    check: {
      kind: 'json_equal',
      value: {
        "lastKind": "mixed",
        "lastValueTypes": [
          "number",
          "string"
        ],
        "parameter": [
          "hex",
          "text"
        ],
        "peeledStrings": [
          "a",
          "b"
        ],
        "nakedNever": [],
        "boxedNever": [
          "yes"
        ]
      },
    },
  },
  {
    id: "frontier-invest-selective-ack-version-precedence",
    taskType: 'investigation',
    subtaskType: "external_research",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Research synthesis from the supplied versioned excerpts only; no network is needed. These are fictional protocol specifications, and the quoted excerpts are the complete normative universe for this task. Authority order is signed erratum > negotiated version > older compatibility appendix. Quote StreamAck 2.1 §4: "ACK n cumulatively accepts every sequence <=n; bitmap bit i additionally accepts n+1+i. Resend all outstanding unaccepted sequences." Quote signed erratum E7 for 2.1: "Bitmap bit 0 denotes n+2, not n+1; bit i denotes n+2+i. Cumulative semantics unchanged." Quote StreamAck 1.0 appendix: "A bitmap disables cumulative acknowledgment." Connection negotiated 2.1.

Outstanding sequences are [8,9,10,11,12,13,14,15,16]. Receiver sends n=10 and bitmap string '10110', written bit0-first. Return JSON keys "accepted", "resend", "authority". Arrays ascending; authority is the controlling bitmap source identifier exactly 'E7'.`,
    check: {
      kind: 'json_equal',
      value: {
        "accepted": [
          8,
          9,
          10,
          12,
          14,
          15
        ],
        "resend": [
          11,
          13,
          16
        ],
        "authority": "E7"
      },
    },
  },
  {
    id: "frontier-invest-cache-stale-security-override",
    taskType: 'investigation',
    subtaskType: "external_research",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Research synthesis from the supplied versioned excerpts only; no network is needed. These are fictional protocol specifications, and the quoted excerpts are the complete normative universe for this task. Authority order: security bulletin > endpoint profile > base 3.0 > legacy note. Quote CacheBase 3.0: "Fresh until storedAt+maxAge; after expiry may serve within staleWhileRevalidate; age includes resident time and upstream Age." Quote PaymentsProfile 3.0-P: "For authorized responses, stale service requires must-revalidate absent; maxAge is the lesser of response max-age and profile cap 50." Quote security bulletin SB2: "Authorization scope changes invalidate entries immediately, even fresh; failed revalidation never renews freshness." Quote legacy 2.0 note: "Network errors restart freshness."

All entries were stored at local t=100 with upstream Age=10; now t=140. Entry A: maxAge=80,swr=30,mustRevalidate=false,scopeUnchanged=true. B: maxAge=45,swr=30,mustRevalidate=true,scopeUnchanged=true. C: maxAge=90,swr=30,mustRevalidate=false,scopeUnchanged=false. D: maxAge=20,swr=20,mustRevalidate=false,scopeUnchanged=true. Freshness is strict age<effectiveMaxAge, stale-window is strict age<effectiveMaxAge+swr. For each choose fresh, stale, or revalidate; scope invalidation is revalidate. Return keys "age", "decisions", "controllingSources"; decisions keys A,B,C,D; controllingSources ['3.0-P','SB2'] in that order.`,
    check: {
      kind: 'json_equal',
      value: {
        "age": 50,
        "decisions": {
          "A": "stale",
          "B": "revalidate",
          "C": "revalidate",
          "D": "revalidate"
        },
        "controllingSources": [
          "3.0-P",
          "SB2"
        ]
      },
    },
  },
  {
    id: "frontier-invest-redirect-credential-policy",
    taskType: 'investigation',
    subtaskType: "external_research",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Research synthesis from the supplied versioned excerpts only; no network is needed. These are fictional protocol specifications, and the quoted excerpts are the complete normative universe for this task. Authority order security profile 4-S > transport 4.0 > deprecated SDK note. Quote Transport 4.0 §8: "307/308 preserve method and body; 303 becomes GET with no body; 301/302 change POST to GET with no body. Other methods preserve." Quote Security 4-S §2: "On any cross-origin redirect strip Authorization permanently for the chain. Origin is tuple (scheme,lowercase host,effective port). Dropping a body also removes Content-Type. An explicit default port equals an omitted default port." Quote SDK 3.1 note: "Re-add original Authorization when returning to the first origin."

Initial request POST https://a.example:443/start with body='PAY', Authorization='token', Content-Type='application/json'. Follow redirects 307 to https://A.example/one; 302 to https://b.example/two; 308 to https://a.example/end. Return JSON keys "hops", "final". hops is an array for each redirected request; each object keys "method", "body", "authorization", "contentType"; absent fields use null. final is final URL exactly as supplied.`,
    check: {
      kind: 'json_equal',
      value: {
        "hops": [
          {
            "method": "POST",
            "body": "PAY",
            "authorization": "token",
            "contentType": "application/json"
          },
          {
            "method": "GET",
            "body": null,
            "authorization": null,
            "contentType": null
          },
          {
            "method": "GET",
            "body": null,
            "authorization": null,
            "contentType": null
          }
        ],
        "final": "https://a.example/end"
      },
    },
  },
  {
    id: "frontier-invest-signature-canonicalization-duplicate-header",
    taskType: 'investigation',
    subtaskType: "external_research",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Research synthesis from the supplied versioned excerpts only; no network is needed. These are fictional protocol specifications, and the quoted excerpts are the complete normative universe for this task. Authority order interoperability erratum I3 > Signature 2.4 > proxy guide 2.0. Quote Signature 2.4: "Select covered fields case-insensitively. Lowercase names, trim ASCII SP/HTAB at each value boundary, combine duplicates in wire order with comma-space. Sort field names lexicographically. Canonical lines are name:value." Quote I3: "For x-tags only, split every duplicate on comma, trim SP/HTAB, remove empty members, retain duplicates, then sort members by Unicode code point; join with comma without spaces." Quote proxy guide 2.0: "Collapse duplicate fields by keeping the last occurrence."

Covered names are ['X-Tags','Host','X-Id']; wire headers in order: ['x-tags',' b, a '],['Host',' EXAMPLE.test '],['X-Id',' 7	'],['X-Tags','a,, c'],['x-id','8 '],['uncovered','ignored']. Return keys "canonical", "lines". lines is the canonical line array; canonical joins those lines by LF with no trailing LF. Do not lowercase field values.`,
    check: {
      kind: 'json_equal',
      value: {
        "canonical": "host:EXAMPLE.test\nx-id:7, 8\nx-tags:a,a,b,c",
        "lines": [
          "host:EXAMPLE.test",
          "x-id:7, 8",
          "x-tags:a,a,b,c"
        ]
      },
    },
  },
  {
    id: "frontier-invest-schema-patch-null-array-precedence",
    taskType: 'investigation',
    subtaskType: "external_research",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Research synthesis from the supplied versioned excerpts only; no network is needed. These are fictional protocol specifications, and the quoted excerpts are the complete normative universe for this task. Authority order negotiated PatchProfile 5-P > MergeSpec 5.0 > migration advice 4.0. Quote MergeSpec 5.0: "Objects merge recursively; arrays replace; null removes a key." Quote PatchProfile 5-P: "At /settings/labels, null is a stored value, never deletion. At /members, arrays are keyed by id: update matching objects recursively, preserve original order, append new ids in patch order; an object with remove=true deletes that id and is never stored. Null at all other paths retains base semantics." Quote migration advice 4.0: "Concatenate every array."

Base: {settings:{labels:['old'],quota:9},members:[{id:'a',role:'reader',meta:{x:1,y:2}},{id:'b',role:'writer'}],extra:1}. Patch: {settings:{labels:null,quota:null},members:[{id:'b',remove:true},{id:'a',meta:{x:null,z:3}},{id:'c',role:'admin'}],extra:null}. Return JSON keys "settings", "members"; settings key labels; member a keys id,role,meta with meta keys y,z; member c keys id,role.`,
    check: {
      kind: 'json_equal',
      value: {
        "settings": {
          "labels": null
        },
        "members": [
          {
            "id": "a",
            "role": "reader",
            "meta": {
              "y": 2,
              "z": 3
            }
          },
          {
            "id": "c",
            "role": "admin"
          }
        ]
      },
    },
  },
  {
    id: "frontier-invest-capability-caveat-deny-precedence",
    taskType: 'investigation',
    subtaskType: "external_research",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Research synthesis from the supplied versioned excerpts only; no network is needed. These are fictional protocol specifications, and the quoted excerpts are the complete normative universe for this task. Authority order revocation registry R9 > delegated profile 6-D > ACL 6.0 > legacy operator memo. Quote ACL 6.0: "Union grants from direct and inherited roles; wildcard '*' matches any one resource segment. Explicit denies override grants." Quote 6-D: "Delegated capability grants are intersected with BOTH parent grants and their own resource caveats; they cannot bypass a parent deny. A grant allows an action only when every caveat is true. Expiry requires now<expires." Quote R9: "Revoked token ids grant nothing regardless of role." Quote old memo: "Delegation bypasses denies."

At now=50 parent grants read /team/* and write /team/doc; parent denies write /team/secret. Token T1 unrevoked has delegated read,write /team/*, caveats expires=51 and ip='10.0.0.1'. Token T2 revoked has read /team/*,expires=90,same ip. Requests (token,action,resource,ip): (T1,read,/team/doc,10.0.0.1), (T1,write,/team/other,10.0.0.1), (T1,write,/team/secret,10.0.0.1), (T1,read,/team/doc/child,10.0.0.1), (T1,write,/team/doc,10.0.0.2), (T2,read,/team/doc,10.0.0.1), (T1,write,/team/doc,10.0.0.1). Return JSON keys "allowed", "reasons". allowed is booleans in order; reasons uses first applicable rejection in priority revoked, caveat, parent-deny, no-parent-grant, no-token-grant; success reason 'allow'.`,
    check: {
      kind: 'json_equal',
      value: {
        "allowed": [
          true,
          false,
          false,
          false,
          false,
          false,
          true
        ],
        "reasons": [
          "allow",
          "no-parent-grant",
          "parent-deny",
          "no-parent-grant",
          "caveat",
          "revoked",
          "allow"
        ]
      },
    },
  },
  {
    id: "frontier-invest-lease-fencing-epoch-counter",
    taskType: 'investigation',
    subtaskType: "external_research",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Research synthesis from the supplied versioned excerpts only; no network is needed. These are fictional protocol specifications, and the quoted excerpts are the complete normative universe for this task. Authority order failover amendment F2 > LeaseStore 7.0 > client guide 6.0. Quote LeaseStore 7.0: "Each lease token is (epoch,counter). Resources remember the greatest accepted token. Tokens compare lexicographically. Write with token lower than remembered is rejected; equal token may write only when its owner matches the remembered owner." Quote F2: "New epoch resets counter to 0. Epoch dominates counter. A token's time expiry is checked at resource receipt, now<expires, and is independent of fencing order. Rejected writes never update remembered token or owner." Quote client guide 6.0: "Compare only counters; expiration at send time is enough."

Initial remembered token=(3,8),owner=A,value='initial'. Receipt history: [time=9,token=(3,9),owner=A,expires=10,value='a']; [10,(3,10),B,10,'expired']; [11,(4,0),B,30,'b']; [12,(3,99),A,40,'old']; [13,(4,0),A,30,'wrong-owner']; [14,(4,1),C,15,'c']; [15,(4,1),C,15,'late']; [16,(4,1),C,40,'renewed']. Return keys "accepted", "token", "owner", "value". accepted booleans in order; token array [epoch,counter].`,
    check: {
      kind: 'json_equal',
      value: {
        "accepted": [
          true,
          false,
          true,
          false,
          false,
          true,
          false,
          true
        ],
        "token": [
          4,
          1
        ],
        "owner": "C",
        "value": "renewed"
      },
    },
  },
  {
    id: "frontier-invest-unicode-identifier-collision-normalization",
    taskType: 'investigation',
    subtaskType: "external_research",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Research synthesis from the supplied versioned excerpts only; no network is needed. These are fictional protocol specifications, and the quoted excerpts are the complete normative universe for this task. Authority order registry erratum U4 > Identifier 3.2 > display advice 3.0. Quote Identifier 3.2: "Canonicalize using NFKC, then ASCII-only case folding A-Z to a-z. No locale-sensitive case folding. Canonical duplicates conflict; preserve first spelling." Quote U4: "Reject a canonical identifier containing '/' or backslash before duplicate detection. Percent escapes are literal text, never decoded." Quote display advice 3.0: "Use NFC, lowercase all Unicode letters, and percent-decode before storage."

Insert these identifiers in order: 'Ａ', 'A', 'a', 'K', 'K', 'İ', 'i', '／', '%2F', 'é', 'é', '①', '1'. Return keys "statuses", "stored". statuses uses inserted,duplicate,invalid. stored is first original spelling for each canonical id in insertion order, represented as [canonical,original] pairs; do not sort or percent-decode.`,
    check: {
      kind: 'json_equal',
      value: {
        "statuses": [
          "inserted",
          "duplicate",
          "duplicate",
          "inserted",
          "duplicate",
          "inserted",
          "inserted",
          "invalid",
          "inserted",
          "inserted",
          "duplicate",
          "inserted",
          "duplicate"
        ],
        "stored": [
          [
            "a",
            "Ａ"
          ],
          [
            "k",
            "K"
          ],
          [
            "İ",
            "İ"
          ],
          [
            "i",
            "i"
          ],
          [
            "%2f",
            "%2F"
          ],
          [
            "é",
            "é"
          ],
          [
            "1",
            "①"
          ]
        ]
      },
    },
  },
  {
    id: "frontier-invest-snapshot-pagination-cursor-order",
    taskType: 'investigation',
    subtaskType: "external_research",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Research synthesis from the supplied versioned excerpts only; no network is needed. These are fictional protocol specifications, and the quoted excerpts are the complete normative universe for this task. Authority order consistency profile C8 > Pagination 8.0 > UI guide 7.0. Quote Pagination 8.0: "Sort by (score descending,id ascending). Cursor is the last returned tuple; later pages are strictly after it in that order." Quote C8: "Cursor carries snapshot revision. All pages use visibility and scores from that revision, not current storage. Deleted-after-snapshot rows remain visible; inserted-after-snapshot rows do not." Quote UI guide 7.0: "A cursor stores only id and always uses current scores."

Revision 10 rows: a:score9,b:9,c:8,d:7,e:7,f:6. Page size=2. Page1 uses revision10. Before page2 revision11 deletes b, changes c to score10, inserts g:score8; before page3 revision12 deletes d and changes e to score12. Continue to exhaustion with same cursor chain. Return JSON keys "pages", "cursors", "revision". pages are arrays of ids; cursors [score,id] at each nonempty page end, including last; revision is snapshot revision.`,
    check: {
      kind: 'json_equal',
      value: {
        "pages": [
          [
            "a",
            "b"
          ],
          [
            "c",
            "d"
          ],
          [
            "e",
            "f"
          ]
        ],
        "cursors": [
          [
            9,
            "b"
          ],
          [
            7,
            "d"
          ],
          [
            6,
            "f"
          ]
        ],
        "revision": 10
      },
    },
  },
  {
    id: "frontier-invest-gcra-weighted-request-amendment",
    taskType: 'investigation',
    subtaskType: "external_research",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Research synthesis from the supplied versioned excerpts only; no network is needed. These are fictional protocol specifications, and the quoted excerpts are the complete normative universe for this task. Authority order weighted erratum W5 > Rate 5.0 > SDK retries 4.0. Quote Rate 5.0: "Theoretical arrival time TAT initially 0, interval I=4, tolerance L=8. Accept when now>=TAT-L; on acceptance TAT=max(now,TAT)+I; rejection leaves TAT unchanged." Quote W5: "For weight w, admission instead requires now>=TAT-L+(w-1)*I. Accepted TAT advances by w*I. Return retryAfter=max(0,TAT-L+(w-1)*I-now) computed BEFORE state update." Quote SDK 4.0: "Rejected calls still consume tokens; weight only affects logging."

Calls in receipt order [now,weight]: [0,1],[0,2],[1,1],[4,3],[5,1],[8,2],[12,1],[12,3],[20,2]. Return JSON keys "accepted", "retryAfter", "tat"; accepted and retryAfter per call, tat is final state. Equal boundary is accepted; no floating-point rounding is needed.`,
    check: {
      kind: 'json_equal',
      value: {
        "accepted": [
          true,
          true,
          false,
          false,
          true,
          false,
          true,
          false,
          true
        ],
        "retryAfter": [
          0,
          0,
          3,
          8,
          0,
          4,
          0,
          8,
          0
        ],
        "tat": 28
      },
    },
  },
  {
    id: "frontier-invest-mvcc-command-counter-own-writes",
    taskType: 'investigation',
    subtaskType: "external_research",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Research synthesis from the supplied versioned excerpts only; no network is needed. These are fictional protocol specifications, and the quoted excerpts are the complete normative universe for this task. Authority order transaction profile T4 > MVCC 4.0 > SQL adapter note 3.0. Quote MVCC 4.0: "A snapshot sees committed versions with commit sequence <=snapshot, choosing the newest such version per key; tombstones delete visibility." Quote T4: "A transaction overlays its own writes, including tombstones, regardless of command counter. Snapshot isolation fixes snapshot at begin; read-committed captures latest commit sequence at EACH read statement. Own writes override either snapshot." Quote SQL adapter 3.0: "Own writes are invisible until commit."

Committed history: seq1 A=10,B=20; seq2 A=11; seq3 B=21,C=30; seq4 A=tombstone,C=31. Two separate uncommitted transactions S(snapshot isolation) and R(read committed) begin just after seq2. Each writes B=99 locally. First read occurs after seq3. Each then locally deletes C. Second read occurs after seq4. A read returns [A,B,C], using null for absent. Return JSON keys "snapshot", "readCommitted"; each contains first then second read arrays. Neither transaction commits.`,
    check: {
      kind: 'json_equal',
      value: {
        "snapshot": [
          [
            11,
            99,
            null
          ],
          [
            11,
            99,
            null
          ]
        ],
        "readCommitted": [
          [
            11,
            99,
            30
          ],
          [
            null,
            99,
            null
          ]
        ]
      },
    },
  },
  {
    id: "frontier-invest-clock-uncertainty-expiry-validity",
    taskType: 'investigation',
    subtaskType: "external_research",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Research synthesis from the supplied versioned excerpts only; no network is needed. These are fictional protocol specifications, and the quoted excerpts are the complete normative universe for this task. Authority order conservative time profile CT2 > Token 2.0 > deployment memo 1.9. Quote Token 2.0: "Token valid when server time >=notBefore and <expires. Expiry equality is invalid." Quote CT2: "A client estimates server time as interval [local+offsetLow,local+offsetHigh]. definitely-valid requires EVERY point valid; definitely-invalid requires NO point valid; otherwise uncertain. Reject if expires<=notBefore regardless of interval." Quote deployment memo 1.9: "Use midpoint and accept expiry equality."

At local time100 offset interval [-3,+4], classify tokens A=[97,105], B=[98,104], C=[104,110], D=[90,97], E=[105,120], F=[99,99], G=[90,104], H=[104,105] where pair means [notBefore,expires]. Return JSON keys "serverInterval", "classifications"; classifications keys A through H. Labels exactly valid,invalid,uncertain.`,
    check: {
      kind: 'json_equal',
      value: {
        "serverInterval": [
          97,
          104
        ],
        "classifications": {
          "A": "valid",
          "B": "uncertain",
          "C": "uncertain",
          "D": "invalid",
          "E": "invalid",
          "F": "invalid",
          "G": "uncertain",
          "H": "uncertain"
        }
      },
    },
  },
  {
    id: "frontier-invest-stream-credit-reset-signed-deltas",
    taskType: 'investigation',
    subtaskType: "external_research",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Research synthesis from the supplied versioned excerpts only; no network is needed. These are fictional protocol specifications, and the quoted excerpts are the complete normative universe for this task. Authority order recovery amendment RC3 > Flow 3.0 > transport FAQ 2.8. Quote Flow 3.0: "Sender tracks connection credit C and per-stream credit S. DATA(n) sends only if n<=C and n<=S, then subtracts n from both. WINDOW delta adds to its corresponding credit." Quote RC3: "RESET discards a stream's queued unsent bytes but refunds NO already sent connection bytes. A replacement stream starts with profile credit 5; credits cannot transfer. Negative WINDOW deltas are legal and may make credit negative; never clamp." Quote FAQ 2.8: "Reset refunds all bytes and credit floors at zero."

Start C=10,S[a]=6. Events: DATA a 4; WINDOW a -5; DATA a 1; WINDOW connection 3; RESET a; OPEN b; DATA b 5; WINDOW connection -8; DATA b 1; WINDOW b 4; WINDOW connection 6; DATA b 3. Reject data on a reset stream or insufficient credit without changing any credits; failed sends are not queued. Return keys "dataAccepted", "connectionCredit", "streams"; streams keys a,b with a=null for reset and b numeric.`,
    check: {
      kind: 'json_equal',
      value: {
        "dataAccepted": [
          true,
          false,
          true,
          false,
          false
        ],
        "connectionCredit": 2,
        "streams": {
          "a": null,
          "b": 4
        }
      },
    },
  },
  {
    id: "frontier-invest-media-negotiation-specificity-before-quality",
    taskType: 'investigation',
    subtaskType: "external_research",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Research synthesis from the supplied versioned excerpts only; no network is needed. These are fictional protocol specifications, and the quoted excerpts are the complete normative universe for this task. Authority order conformance clarification NC1 > Media 1.5 > CDN note 1.0. Quote Media 1.5: "For each representation find matching ranges. Effective quality comes from MOST SPECIFIC matching range: exact type/subtype with matching parameters, exact without parameters, type/*, */*. Choose representation with highest effective q." Quote NC1: "A more specific q=0 is a veto even if a wildcard gives q=1. Equal specificity ranges choose the earliest header occurrence; representation ties choose server order. A parameterized range only matches when every parameter equals representation metadata; unmatched parameterized ranges are ignored." Quote CDN 1.0: "Use maximum q among every matching range."

Header ranges in order: */*;q=0.9, text/*;q=0.8, text/html;q=0, application/json;profile=compact;q=0.7, application/json;q=0.6, application/json;profile=compact;q=0.95, image/*;q=0.85. Server representation order: H=text/html, J=application/json with profile=compact, K=application/json with profile=full, P=image/png, X=application/xml. Return keys "qualities", "chosen", "vetoed"; qualities keys H,J,K,P,X; chosen is one ID, vetoed sorted IDs. Treat the two compact ranges as same specificity; header order wins.`,
    check: {
      kind: 'json_equal',
      value: {
        "qualities": {
          "H": 0,
          "J": 0.7,
          "K": 0.6,
          "P": 0.85,
          "X": 0.9
        },
        "chosen": "X",
        "vetoed": [
          "H"
        ]
      },
    },
  },
  {
    id: "frontier-invest-idempotency-inflight-expiry-hash",
    taskType: 'investigation',
    subtaskType: "external_research",
    tier: 'frontier',
    systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
    userPrompt: `Research synthesis from the supplied versioned excerpts only; no network is needed. These are fictional protocol specifications, and the quoted excerpts are the complete normative universe for this task. Authority order concurrency addendum CA6 > Idempotency 6.0 > retry recipe 5.0. Quote Idempotency 6.0: "Records keyed by (tenant,key); a completed record replays its response when canonical request hash matches, otherwise conflict. Expiry permits deleting completed records only when now>=expires." Quote CA6: "In-flight records never expire. A same-hash in-flight request joins, different-hash conflicts. Completion sets expires=completionTime+TTL, not startTime+TTL. Canonical hash uses object key sorting recursively; arrays preserve order. Tenant namespaces are independent." Quote retry recipe 5.0: "An expired started record may be stolen; payload order always changes hash."

TTL=5. Requests and completion events in order: at0 request tenant A,key K,body {x:1,y:[2,3]} -> starts job J1; at6 request A,K,{y:[2,3],x:1}; at7 request A,K,{x:1,y:[3,2]}; at8 request B,K,{x:1,y:[3,2]} -> starts J2; at9 complete J1 response='R1'; at10 request A,K,{x:1,y:[2,3]}; at14 request A,K,{x:1,y:[3,2]} -> starts J3; at15 complete J2 response='R2'; at16 request B,K,{y:[3,2],x:1}. Return keys "requestResults", "records". requestResults in request order uses start:J#,join:J#,conflict,replay:R#. records keys A,B; each keys job,state,expires where in-flight expires=null. Expiry boundary at14 is expired.`,
    check: {
      kind: 'json_equal',
      value: {
        "requestResults": [
          "start:J1",
          "join:J1",
          "conflict",
          "start:J2",
          "replay:R1",
          "start:J3",
          "replay:R2"
        ],
        "records": {
          "A": {
            "job": "J3",
            "state": "inflight",
            "expires": null
          },
          "B": {
            "job": "J2",
            "state": "complete",
            "expires": 20
          }
        }
      },
    },
  },
];
