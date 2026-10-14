import type { DeciderCase } from '../decider-cases';

const FRONTIER_SYSTEM =
  'You are a precise software engineer. Solve the supplied finite refactoring or design problem completely. Reply with only the requested JSON; no markdown, explanation, or extra keys. Respect the specified key and array order.';

export const REFACTORING_FRONTIER_CASES: readonly DeciderCase[] = [
  {
    id: 'frontier-refactoring-code-cleanup-getter-common-subexpression',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Review a behavior-preserving cleanup of this three-file fixture. model.js exposes two effectful getters; client.js relies on both the returned total and the audit log. Each proposal replaces the entire model adapter, not the client observation.

adapter.js (an ECMAScript module; all execution is strict):
export function run(x) {
const [base,step]=x; const log=[];let n=base;const o={get value(){log.push(n);const v=n;n+=step;return v;}};const total=o.value+o.value;return {total,log};
}

observer.js is unchanged and imports run from adapter.js:
export function observe(input) {
  try { return {value: run(JSON.parse(JSON.stringify(input)))}; }
  catch (error) { return {error: error.name}; }
}

client.js calls observe once for each input below, using a fresh adapter instance for every input. The observation is serialized immediately with JSON.stringify; only this JSON string is contractual. Objects with added non-enumerable/array non-index properties are not separately inspected. There are no other inputs or hidden requirements.
Ordered input domain:
[[0,1],[2,-1],[-2,3],[5,0],[-3,-3],[-3,-2],[-3,-1],[-3,0],[-3,1],[-3,2],[-3,3],[-2,-3],[-2,-2],[-2,-1],[-2,0],[-2,1],[-2,2],[-1,-3],[-1,-2],[-1,-1],[-1,0],[-1,1],[-1,2],[-1,3],[0,-3],[0,-2],[0,-1],[0,0],[0,2],[0,3],[1,-3],[1,-2],[1,-1],[1,0],[1,1],[1,2],[1,3],[2,-3],[2,-2],[2,0],[2,1],[2,2],[2,3],[3,-3],[3,-2],[3,-1],[3,0],[3,1],[3,2],[3,3]]

The following four proposals independently replace ONLY the body of run in adapter.js. Never combine proposals.
Proposal 1:
const [base,step]=x;const log=[];let n=base;const o={get value(){log.push(n);const v=n;n+=step;return v;}};const v=o.value;return {total:v+v,log};

Proposal 2:
const [base,step]=x;const log=[];let n=base;function read(){log.push(n);const v=n;n+=step;return v;}return {total:read()+read(),log};

Proposal 3:
const [base,step]=x;const log=[base,base+step];return {total:base*2+step,log};

Proposal 4:
const [base,step]=x;return {total:base*2+step,log:[base+step,base]};

Determine which proposals preserve every contractual observation across the ENTIRE domain, not merely a sample output. For every unsafe proposal, give the first counterexample in the listed domain (not the numerically smallest input). Return one JSON object with exactly keys "safe","witnesses" in that order. safe is the ascending array of safe proposal numbers. witnesses is ordered by proposal number; each witness has exactly keys "candidate","input","expected","actual" in that order. expected and actual are the observer objects, with "value" or "error" as appropriate, preserving every nested object key's creation order. Values missing from an array serialize as null. Do not include witnesses for safe proposals.`,
    check: {
      kind: 'json_equal',
      value: {
        safe: [2, 3],
        witnesses: [
          {
            candidate: 1,
            input: [0, 1],
            expected: {
              value: {
                total: 1,
                log: [0, 1],
              },
            },
            actual: {
              value: {
                total: 0,
                log: [0],
              },
            },
          },
          {
            candidate: 4,
            input: [0, 1],
            expected: {
              value: {
                total: 1,
                log: [0, 1],
              },
            },
            actual: {
              value: {
                total: 1,
                log: [1, 0],
              },
            },
          },
        ],
      },
    },
  },
  {
    id: 'frontier-refactoring-code-cleanup-receiver-capture',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Review a behavior-preserving cleanup of this three-file fixture. registry.js returns a method using its receiver; worker.js invokes the adapter after changing the registry. Observe the late lookup and method receiver separately.

adapter.js (an ECMAScript module; all execution is strict):
export function run(x) {
const [a,b]=x;const registry={bias:a,apply(v){return this.bias+v;}};const call=v=>registry.apply(v);registry.bias=b;return [call(4),call(-1)];
}

observer.js is unchanged and imports run from adapter.js:
export function observe(input) {
  try { return {value: run(JSON.parse(JSON.stringify(input)))}; }
  catch (error) { return {error: error.name}; }
}

client.js calls observe once for each input below, using a fresh adapter instance for every input. The observation is serialized immediately with JSON.stringify; only this JSON string is contractual. Objects with added non-enumerable/array non-index properties are not separately inspected. There are no other inputs or hidden requirements.
Ordered input domain:
[[1,2],[3,0],[-2,5],[0,-1],[-2,-2],[-2,0],[-2,1],[-2,3],[0,-2],[0,0],[0,1],[0,3],[1,-2],[1,0],[1,1],[1,3],[3,-2],[3,1],[3,3]]

The following four proposals independently replace ONLY the body of run in adapter.js. Never combine proposals.
Proposal 1:
const [a,b]=x;const registry={bias:a,apply(v){return this.bias+v;}};const method=registry.apply;const call=v=>method.call(registry,v);registry.bias=b;return [call(4),call(-1)];

Proposal 2:
const [a,b]=x;const registry={bias:a,apply(v){return this.bias+v;}};const method=registry.apply.bind({bias:a});registry.bias=b;return [method(4),method(-1)];

Proposal 3:
const [a,b]=x;const registry={bias:a,apply(v){return this.bias+v;}};const method=registry.apply;registry.bias=b;return [method(4),method(-1)];

Proposal 4:
const [a,b]=x;const registry={bias:a,apply(v){return this.bias+v;}};const call=registry.apply.bind(registry);registry.bias=b;return [call(4),call(-1)];

Determine which proposals preserve every contractual observation across the ENTIRE domain, not merely a sample output. For every unsafe proposal, give the first counterexample in the listed domain (not the numerically smallest input). Return one JSON object with exactly keys "safe","witnesses" in that order. safe is the ascending array of safe proposal numbers. witnesses is ordered by proposal number; each witness has exactly keys "candidate","input","expected","actual" in that order. expected and actual are the observer objects, with "value" or "error" as appropriate, preserving every nested object key's creation order. Values missing from an array serialize as null. Do not include witnesses for safe proposals.`,
    check: {
      kind: 'json_equal',
      value: {
        safe: [1, 4],
        witnesses: [
          {
            candidate: 2,
            input: [1, 2],
            expected: {
              value: [6, 1],
            },
            actual: {
              value: [5, 0],
            },
          },
          {
            candidate: 3,
            input: [1, 2],
            expected: {
              value: [6, 1],
            },
            actual: {
              error: 'TypeError',
            },
          },
        ],
      },
    },
  },
  {
    id: 'frontier-refactoring-code-cleanup-sparse-array-effect-order',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Review a behavior-preserving cleanup of this three-file fixture. loader.js creates a sparse input; view.js observes which callbacks ran and which output indices exist. A hole is not an explicit undefined.

adapter.js (an ECMAScript module; all execution is strict):
export function run(x) {
const [n,indices]=x;const a=Array(n);for(const i of indices)a[i]=i+1;const calls=[];const b=a.map((v,i)=>{calls.push(i);return v*2;});return {calls,keys:Object.keys(b),values:JSON.stringify(b)};
}

observer.js is unchanged and imports run from adapter.js:
export function observe(input) {
  try { return {value: run(JSON.parse(JSON.stringify(input)))}; }
  catch (error) { return {error: error.name}; }
}

client.js calls observe once for each input below, using a fresh adapter instance for every input. The observation is serialized immediately with JSON.stringify; only this JSON string is contractual. Objects with added non-enumerable/array non-index properties are not separately inspected. There are no other inputs or hidden requirements.
Ordered input domain:
[[4,[0,2]],[3,[1]],[5,[0,3,4]],[2,[]],[2,[0]],[2,[1]],[2,[0,1]],[3,[]],[3,[0]],[3,[0,1]],[3,[2]],[3,[0,2]],[3,[1,2]],[3,[0,1,2]],[4,[]],[4,[0]],[4,[1]],[4,[0,1]],[4,[2]],[4,[1,2]],[4,[0,1,2]],[4,[3]],[4,[0,3]],[4,[1,3]],[4,[0,1,3]],[4,[2,3]],[4,[0,2,3]],[4,[1,2,3]],[4,[0,1,2,3]],[5,[]],[5,[0]],[5,[1]],[5,[0,1]],[5,[2]],[5,[0,2]],[5,[1,2]],[5,[0,1,2]],[5,[3]],[5,[0,3]],[5,[1,3]],[5,[0,1,3]],[5,[2,3]],[5,[0,2,3]],[5,[1,2,3]],[5,[0,1,2,3]],[5,[4]],[5,[0,4]],[5,[1,4]],[5,[0,1,4]],[5,[2,4]],[5,[0,2,4]],[5,[1,2,4]],[5,[0,1,2,4]],[5,[3,4]],[5,[1,3,4]],[5,[0,1,3,4]],[5,[2,3,4]],[5,[0,2,3,4]],[5,[1,2,3,4]],[5,[0,1,2,3,4]],[6,[]],[6,[0]],[6,[1]],[6,[0,1]],[6,[2]],[6,[0,2]],[6,[1,2]],[6,[0,1,2]],[6,[3]],[6,[0,3]],[6,[1,3]],[6,[0,1,3]],[6,[2,3]],[6,[0,2,3]],[6,[1,2,3]],[6,[0,1,2,3]],[6,[4]],[6,[0,4]],[6,[1,4]],[6,[0,1,4]],[6,[2,4]],[6,[0,2,4]],[6,[1,2,4]],[6,[0,1,2,4]],[6,[3,4]],[6,[0,3,4]],[6,[1,3,4]],[6,[0,1,3,4]],[6,[2,3,4]],[6,[0,2,3,4]],[6,[1,2,3,4]],[6,[0,1,2,3,4]],[6,[5]],[6,[0,5]],[6,[1,5]],[6,[0,1,5]],[6,[2,5]],[6,[0,2,5]],[6,[1,2,5]],[6,[0,1,2,5]],[6,[3,5]],[6,[0,3,5]],[6,[1,3,5]],[6,[0,1,3,5]],[6,[2,3,5]],[6,[0,2,3,5]],[6,[1,2,3,5]],[6,[0,1,2,3,5]],[6,[4,5]],[6,[0,4,5]],[6,[1,4,5]],[6,[0,1,4,5]],[6,[2,4,5]],[6,[0,2,4,5]],[6,[1,2,4,5]],[6,[0,1,2,4,5]],[6,[3,4,5]],[6,[0,3,4,5]],[6,[1,3,4,5]],[6,[0,1,3,4,5]],[6,[2,3,4,5]],[6,[0,2,3,4,5]],[6,[1,2,3,4,5]],[6,[0,1,2,3,4,5]]]

The following four proposals independently replace ONLY the body of run in adapter.js. Never combine proposals.
Proposal 1:
const [n,indices]=x;const a=Array(n);for(const i of indices)a[i]=i+1;const calls=[];const b=[...a].map((v,i)=>{calls.push(i);return v*2;});return {calls,keys:Object.keys(b),values:JSON.stringify(b)};

Proposal 2:
const [n,indices]=x;const a=Array(n);for(const i of indices)a[i]=i+1;const calls=[];const b=Array(n);for(let i=0;i<n;i++)if(i in a){calls.push(i);b[i]=a[i]*2;}return {calls,keys:Object.keys(b),values:JSON.stringify(b)};

Proposal 3:
const [n,indices]=x;const calls=[...indices].sort((a,b)=>a-b);const b=Array(n);for(const i of calls)b[i]=(i+1)*2;return {calls,keys:Object.keys(b),values:JSON.stringify(b)};

Proposal 4:
const [n,indices]=x;const calls=indices;const b=indices.map(i=>(i+1)*2);return {calls,keys:Object.keys(b),values:JSON.stringify(b)};

Determine which proposals preserve every contractual observation across the ENTIRE domain, not merely a sample output. For every unsafe proposal, give the first counterexample in the listed domain (not the numerically smallest input). Return one JSON object with exactly keys "safe","witnesses" in that order. safe is the ascending array of safe proposal numbers. witnesses is ordered by proposal number; each witness has exactly keys "candidate","input","expected","actual" in that order. expected and actual are the observer objects, with "value" or "error" as appropriate, preserving every nested object key's creation order. Values missing from an array serialize as null. Do not include witnesses for safe proposals.`,
    check: {
      kind: 'json_equal',
      value: {
        safe: [2, 3],
        witnesses: [
          {
            candidate: 1,
            input: [4, [0, 2]],
            expected: {
              value: {
                calls: [0, 2],
                keys: ['0', '2'],
                values: '[2,null,6,null]',
              },
            },
            actual: {
              value: {
                calls: [0, 1, 2, 3],
                keys: ['0', '1', '2', '3'],
                values: '[2,null,6,null]',
              },
            },
          },
          {
            candidate: 4,
            input: [4, [0, 2]],
            expected: {
              value: {
                calls: [0, 2],
                keys: ['0', '2'],
                values: '[2,null,6,null]',
              },
            },
            actual: {
              value: {
                calls: [0, 2],
                keys: ['0', '1'],
                values: '[2,6]',
              },
            },
          },
        ],
      },
    },
  },
  {
    id: 'frontier-refactoring-code-cleanup-iterator-resource-close',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Review a behavior-preserving cleanup of this three-file fixture. source.js owns a resource inside a generator finally block. client.js stops at a threshold and records resource lifetime. Do not treat Array.from as a lazy traversal.

adapter.js (an ECMAScript module; all execution is strict):
export function run(x) {
const [limit,n]=x;const log=[];function* source(){try{for(let i=0;i<n;i++){log.push('read'+i);yield i;}}finally{log.push('close');}}const seen=[];for(const v of source()){seen.push(v);if(v>=limit)break;}return {seen,log};
}

observer.js is unchanged and imports run from adapter.js:
export function observe(input) {
  try { return {value: run(JSON.parse(JSON.stringify(input)))}; }
  catch (error) { return {error: error.name}; }
}

client.js calls observe once for each input below, using a fresh adapter instance for every input. The observation is serialized immediately with JSON.stringify; only this JSON string is contractual. Objects with added non-enumerable/array non-index properties are not separately inspected. There are no other inputs or hidden requirements.
Ordered input domain:
[[2,4],[0,3],[4,5],[7,3],[-1,0],[-1,1],[-1,2],[-1,3],[-1,4],[-1,5],[0,0],[0,1],[0,2],[0,4],[0,5],[1,0],[1,1],[1,2],[1,3],[1,4],[1,5],[2,0],[2,1],[2,2],[2,3],[2,5],[5,0],[5,1],[5,2],[5,3],[5,4],[5,5]]

The following four proposals independently replace ONLY the body of run in adapter.js. Never combine proposals.
Proposal 1:
const [limit,n]=x;const log=[];function* source(){try{for(let i=0;i<n;i++){log.push('read'+i);yield i;}}finally{log.push('close');}}const seen=[];for(const v of Array.from(source())){seen.push(v);if(v>=limit)break;}return {seen,log};

Proposal 2:
const [limit,n]=x;const log=[];function* source(){try{for(let i=0;i<n;i++){log.push('read'+i);yield i;}}finally{log.push('close');}}const seen=[];const it=source();try{while(true){const s=it.next();if(s.done)break;seen.push(s.value);if(s.value>=limit)break;}}finally{it.return();}return {seen,log};

Proposal 3:
const [limit,n]=x;const log=[];function* source(){try{for(let i=0;i<n;i++){log.push('read'+i);yield i;}}finally{log.push('close');}}const seen=[];const it=source();while(true){const s=it.next();if(s.done)break;seen.push(s.value);if(s.value>=limit)break;}return {seen,log};

Proposal 4:
const [limit,n]=x;const seen=[],log=[];for(let i=0;i<n;i++){log.push('read'+i);seen.push(i);if(i>=limit)break;}log.push('close');return {seen,log};

Determine which proposals preserve every contractual observation across the ENTIRE domain, not merely a sample output. For every unsafe proposal, give the first counterexample in the listed domain (not the numerically smallest input). Return one JSON object with exactly keys "safe","witnesses" in that order. safe is the ascending array of safe proposal numbers. witnesses is ordered by proposal number; each witness has exactly keys "candidate","input","expected","actual" in that order. expected and actual are the observer objects, with "value" or "error" as appropriate, preserving every nested object key's creation order. Values missing from an array serialize as null. Do not include witnesses for safe proposals.`,
    check: {
      kind: 'json_equal',
      value: {
        safe: [2, 4],
        witnesses: [
          {
            candidate: 1,
            input: [2, 4],
            expected: {
              value: {
                seen: [0, 1, 2],
                log: ['read0', 'read1', 'read2', 'close'],
              },
            },
            actual: {
              value: {
                seen: [0, 1, 2],
                log: ['read0', 'read1', 'read2', 'read3', 'close'],
              },
            },
          },
          {
            candidate: 3,
            input: [2, 4],
            expected: {
              value: {
                seen: [0, 1, 2],
                log: ['read0', 'read1', 'read2', 'close'],
              },
            },
            actual: {
              value: {
                seen: [0, 1, 2],
                log: ['read0', 'read1', 'read2'],
              },
            },
          },
        ],
      },
    },
  },
  {
    id: 'frontier-refactoring-code-cleanup-finally-completion-priority',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Review a behavior-preserving cleanup of this three-file fixture. transaction.js may throw or return and cleanup.js may override either completion. client.js catches only the final exception. Removing a finally return changes public behavior.

adapter.js (an ECMAScript module; all execution is strict):
export function run(x) {
const [fail,override]=x;const log=[];function f(){try{log.push('work');if(fail)throw Error('work');return 7;}finally{log.push('cleanup');if(override)return 9;}}try{return {result:f(),log};}catch(e){return {error:e.message,log};}
}

observer.js is unchanged and imports run from adapter.js:
export function observe(input) {
  try { return {value: run(JSON.parse(JSON.stringify(input)))}; }
  catch (error) { return {error: error.name}; }
}

client.js calls observe once for each input below, using a fresh adapter instance for every input. The observation is serialized immediately with JSON.stringify; only this JSON string is contractual. Objects with added non-enumerable/array non-index properties are not separately inspected. There are no other inputs or hidden requirements.
Ordered input domain:
[[false,false],[true,false],[false,true],[true,true]]

The following four proposals independently replace ONLY the body of run in adapter.js. Never combine proposals.
Proposal 1:
const [fail,override]=x;const log=['work','cleanup'];if(override)return {result:9,log};if(fail)return {error:'work',log};return {result:7,log};

Proposal 2:
const [fail,override]=x;const log=['work','cleanup'];if(fail)return {error:'work',log};return {result:override?9:7,log};

Proposal 3:
const [fail,override]=x;const log=[];function f(){try{log.push('work');if(fail)throw Error('work');return 7;}finally{log.push('cleanup');if(override)return 9;}}try{const result=f();return {result,log};}catch(e){return {error:e.message,log};}

Proposal 4:
const [fail,override]=x;const log=['work','cleanup'];return {result:override?9:7,log};

Determine which proposals preserve every contractual observation across the ENTIRE domain, not merely a sample output. For every unsafe proposal, give the first counterexample in the listed domain (not the numerically smallest input). Return one JSON object with exactly keys "safe","witnesses" in that order. safe is the ascending array of safe proposal numbers. witnesses is ordered by proposal number; each witness has exactly keys "candidate","input","expected","actual" in that order. expected and actual are the observer objects, with "value" or "error" as appropriate, preserving every nested object key's creation order. Values missing from an array serialize as null. Do not include witnesses for safe proposals.`,
    check: {
      kind: 'json_equal',
      value: {
        safe: [1, 3],
        witnesses: [
          {
            candidate: 2,
            input: [true, true],
            expected: {
              value: {
                result: 9,
                log: ['work', 'cleanup'],
              },
            },
            actual: {
              value: {
                error: 'work',
                log: ['work', 'cleanup'],
              },
            },
          },
          {
            candidate: 4,
            input: [true, false],
            expected: {
              value: {
                error: 'work',
                log: ['work', 'cleanup'],
              },
            },
            actual: {
              value: {
                result: 7,
                log: ['work', 'cleanup'],
              },
            },
          },
        ],
      },
    },
  },
  {
    id: 'frontier-refactoring-code-cleanup-typed-buffer-overlap',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Review a behavior-preserving cleanup of this three-file fixture. buffer.js lends a typed-array view; codec.js copies overlapping bytes and then mutates the lent view. Identity of the buffer and copy-vs-view are observable.

adapter.js (an ECMAScript module; all execution is strict):
export function run(x) {
const [start,end,value]=x;const a=Uint8Array.from([1,2,3,4,5]);const b=a.subarray(start,end);a.set(b,1);b[0]=value;return {a:[...a],b:[...b],shared:a.buffer===b.buffer};
}

observer.js is unchanged and imports run from adapter.js:
export function observe(input) {
  try { return {value: run(JSON.parse(JSON.stringify(input)))}; }
  catch (error) { return {error: error.name}; }
}

client.js calls observe once for each input below, using a fresh adapter instance for every input. The observation is serialized immediately with JSON.stringify; only this JSON string is contractual. Objects with added non-enumerable/array non-index properties are not separately inspected. There are no other inputs or hidden requirements.
Ordered input domain:
[[1,3,8],[0,2,9],[2,4,7],[1,4,6],[0,1,0],[0,1,9],[0,1,256],[0,2,0],[0,2,256],[0,3,0],[0,3,9],[0,3,256],[0,4,0],[0,4,9],[0,4,256],[1,2,0],[1,2,9],[1,2,256],[1,3,0],[1,3,9],[1,3,256],[1,4,0],[1,4,9],[1,4,256],[1,5,0],[1,5,9],[1,5,256],[2,3,0],[2,3,9],[2,3,256],[2,4,0],[2,4,9],[2,4,256],[2,5,0],[2,5,9],[2,5,256],[3,4,0],[3,4,9],[3,4,256],[3,5,0],[3,5,9],[3,5,256],[4,5,0],[4,5,9],[4,5,256]]

The following four proposals independently replace ONLY the body of run in adapter.js. Never combine proposals.
Proposal 1:
const [start,end,value]=x;const a=Uint8Array.from([1,2,3,4,5]);const b=a.slice(start,end);a.set(b,1);b[0]=value;return {a:[...a],b:[...b],shared:a.buffer===b.buffer};

Proposal 2:
const [start,end,value]=x;const a=Uint8Array.from([1,2,3,4,5]);const b=new Uint8Array(a.buffer,start,end-start);a.set(b,1);b[0]=value;return {a:[...a],b:[...b],shared:a.buffer===b.buffer};

Proposal 3:
const [start,end,value]=x;const a=Uint8Array.from([1,2,3,4,5]);const b=a.subarray(start,end);for(let i=0;i<b.length;i++)a[1+i]=b[i];b[0]=value;return {a:[...a],b:[...b],shared:a.buffer===b.buffer};

Proposal 4:
const [start,end,value]=x;const a=Uint8Array.from([1,2,3,4,5]);const b=a.subarray(start,end);const copy=[...b];copy.forEach((v,i)=>a[1+i]=v);b[0]=value;return {a:[...a],b:[...b],shared:a.buffer===b.buffer};

Determine which proposals preserve every contractual observation across the ENTIRE domain, not merely a sample output. For every unsafe proposal, give the first counterexample in the listed domain (not the numerically smallest input). Return one JSON object with exactly keys "safe","witnesses" in that order. safe is the ascending array of safe proposal numbers. witnesses is ordered by proposal number; each witness has exactly keys "candidate","input","expected","actual" in that order. expected and actual are the observer objects, with "value" or "error" as appropriate, preserving every nested object key's creation order. Values missing from an array serialize as null. Do not include witnesses for safe proposals.`,
    check: {
      kind: 'json_equal',
      value: {
        safe: [2, 4],
        witnesses: [
          {
            candidate: 1,
            input: [1, 3, 8],
            expected: {
              value: {
                a: [1, 8, 3, 4, 5],
                b: [8, 3],
                shared: true,
              },
            },
            actual: {
              value: {
                a: [1, 2, 3, 4, 5],
                b: [8, 3],
                shared: false,
              },
            },
          },
          {
            candidate: 3,
            input: [0, 2, 9],
            expected: {
              value: {
                a: [9, 1, 2, 4, 5],
                b: [9, 1],
                shared: true,
              },
            },
            actual: {
              value: {
                a: [9, 1, 1, 4, 5],
                b: [9, 1],
                shared: true,
              },
            },
          },
        ],
      },
    },
  },
  {
    id: 'frontier-refactoring-code-cleanup-negative-cache-preservation',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Review a behavior-preserving cleanup of this three-file fixture. repository.js permits zero, null, and missing records; cache.js promises one fetch per distinct key including negative results. client.js exposes fetch count.

adapter.js (an ECMAScript module; all execution is strict):
export function run(x) {
const data={a:0,b:null,c:3};const cache=new Map();let fetches=0;const values=x.map(k=>{if(!cache.has(k)){fetches++;cache.set(k,data[k]);}return cache.get(k)??'missing';});return {values,fetches};
}

observer.js is unchanged and imports run from adapter.js:
export function observe(input) {
  try { return {value: run(JSON.parse(JSON.stringify(input)))}; }
  catch (error) { return {error: error.name}; }
}

client.js calls observe once for each input below, using a fresh adapter instance for every input. The observation is serialized immediately with JSON.stringify; only this JSON string is contractual. Objects with added non-enumerable/array non-index properties are not separately inspected. There are no other inputs or hidden requirements.
Ordered input domain:
[["a","a","b","b","c","c"],["c","c","c"],["b","a","b","a"],["d","d","c","d"],["a","a","a","a"],["a","a","a","b"],["a","a","a","c"],["a","a","a","d"],["a","a","b","a"],["a","a","b","b"],["a","a","b","c"],["a","a","b","d"],["a","a","c","a"],["a","a","c","b"],["a","a","c","c"],["a","a","c","d"],["a","a","d","a"],["a","a","d","b"],["a","a","d","c"],["a","a","d","d"],["a","b","a","a"],["a","b","a","b"],["a","b","a","c"],["a","b","a","d"],["a","b","b","a"],["a","b","b","b"],["a","b","b","c"],["a","b","b","d"],["a","b","c","a"],["a","b","c","b"],["a","b","c","c"],["a","b","c","d"],["a","b","d","a"],["a","b","d","b"],["a","b","d","c"],["a","b","d","d"],["a","c","a","a"],["a","c","a","b"],["a","c","a","c"],["a","c","a","d"],["a","c","b","a"],["a","c","b","b"],["a","c","b","c"],["a","c","b","d"],["a","c","c","a"],["a","c","c","b"],["a","c","c","c"],["a","c","c","d"],["a","c","d","a"],["a","c","d","b"],["a","c","d","c"],["a","c","d","d"],["a","d","a","a"],["a","d","a","b"],["a","d","a","c"],["a","d","a","d"],["a","d","b","a"],["a","d","b","b"],["a","d","b","c"],["a","d","b","d"],["a","d","c","a"],["a","d","c","b"],["a","d","c","c"],["a","d","c","d"],["a","d","d","a"],["a","d","d","b"],["a","d","d","c"],["a","d","d","d"],["b","a","a","a"],["b","a","a","b"],["b","a","a","c"],["b","a","a","d"],["b","a","b","b"],["b","a","b","c"],["b","a","b","d"],["b","a","c","a"],["b","a","c","b"],["b","a","c","c"],["b","a","c","d"],["b","a","d","a"],["b","a","d","b"],["b","a","d","c"],["b","a","d","d"],["b","b","a","a"],["b","b","a","b"],["b","b","a","c"],["b","b","a","d"],["b","b","b","a"],["b","b","b","b"],["b","b","b","c"],["b","b","b","d"],["b","b","c","a"],["b","b","c","b"],["b","b","c","c"],["b","b","c","d"],["b","b","d","a"],["b","b","d","b"],["b","b","d","c"],["b","b","d","d"],["b","c","a","a"],["b","c","a","b"],["b","c","a","c"],["b","c","a","d"],["b","c","b","a"],["b","c","b","b"],["b","c","b","c"],["b","c","b","d"],["b","c","c","a"],["b","c","c","b"],["b","c","c","c"],["b","c","c","d"],["b","c","d","a"],["b","c","d","b"],["b","c","d","c"],["b","c","d","d"],["b","d","a","a"],["b","d","a","b"],["b","d","a","c"],["b","d","a","d"],["b","d","b","a"],["b","d","b","b"],["b","d","b","c"],["b","d","b","d"],["b","d","c","a"],["b","d","c","b"],["b","d","c","c"],["b","d","c","d"],["b","d","d","a"],["b","d","d","b"],["b","d","d","c"],["b","d","d","d"],["c","a","a","a"],["c","a","a","b"],["c","a","a","c"],["c","a","a","d"],["c","a","b","a"],["c","a","b","b"],["c","a","b","c"],["c","a","b","d"],["c","a","c","a"],["c","a","c","b"],["c","a","c","c"],["c","a","c","d"],["c","a","d","a"],["c","a","d","b"],["c","a","d","c"],["c","a","d","d"],["c","b","a","a"],["c","b","a","b"],["c","b","a","c"],["c","b","a","d"],["c","b","b","a"],["c","b","b","b"],["c","b","b","c"],["c","b","b","d"],["c","b","c","a"],["c","b","c","b"],["c","b","c","c"],["c","b","c","d"],["c","b","d","a"],["c","b","d","b"],["c","b","d","c"],["c","b","d","d"],["c","c","a","a"],["c","c","a","b"],["c","c","a","c"],["c","c","a","d"],["c","c","b","a"],["c","c","b","b"],["c","c","b","c"],["c","c","b","d"],["c","c","c","a"],["c","c","c","b"],["c","c","c","c"],["c","c","c","d"],["c","c","d","a"],["c","c","d","b"],["c","c","d","c"],["c","c","d","d"],["c","d","a","a"],["c","d","a","b"],["c","d","a","c"],["c","d","a","d"],["c","d","b","a"],["c","d","b","b"],["c","d","b","c"],["c","d","b","d"],["c","d","c","a"],["c","d","c","b"],["c","d","c","c"],["c","d","c","d"],["c","d","d","a"],["c","d","d","b"],["c","d","d","c"],["c","d","d","d"],["d","a","a","a"],["d","a","a","b"],["d","a","a","c"],["d","a","a","d"],["d","a","b","a"],["d","a","b","b"],["d","a","b","c"],["d","a","b","d"],["d","a","c","a"],["d","a","c","b"],["d","a","c","c"],["d","a","c","d"],["d","a","d","a"],["d","a","d","b"],["d","a","d","c"],["d","a","d","d"],["d","b","a","a"],["d","b","a","b"],["d","b","a","c"],["d","b","a","d"],["d","b","b","a"],["d","b","b","b"],["d","b","b","c"],["d","b","b","d"],["d","b","c","a"],["d","b","c","b"],["d","b","c","c"],["d","b","c","d"],["d","b","d","a"],["d","b","d","b"],["d","b","d","c"],["d","b","d","d"],["d","c","a","a"],["d","c","a","b"],["d","c","a","c"],["d","c","a","d"],["d","c","b","a"],["d","c","b","b"],["d","c","b","c"],["d","c","b","d"],["d","c","c","a"],["d","c","c","b"],["d","c","c","c"],["d","c","c","d"],["d","c","d","a"],["d","c","d","b"],["d","c","d","c"],["d","c","d","d"],["d","d","a","a"],["d","d","a","b"],["d","d","a","c"],["d","d","a","d"],["d","d","b","a"],["d","d","b","b"],["d","d","b","c"],["d","d","b","d"],["d","d","c","a"],["d","d","c","b"],["d","d","c","c"],["d","d","d","a"],["d","d","d","b"],["d","d","d","c"],["d","d","d","d"]]

The following four proposals independently replace ONLY the body of run in adapter.js. Never combine proposals.
Proposal 1:
const data={a:0,b:null,c:3};const cache=new Map();let fetches=0;const values=x.map(k=>{if(!cache.get(k)){fetches++;cache.set(k,data[k]);}return cache.get(k)??'missing';});return {values,fetches};

Proposal 2:
const data={a:0,b:null,c:3};const cache=new Map();let fetches=0;const values=x.map(k=>{if(cache.get(k)===undefined){fetches++;cache.set(k,data[k]);}return cache.get(k)??'missing';});return {values,fetches};

Proposal 3:
const data={a:0,b:null,c:3};const cache=new Map();let fetches=0;const values=x.map(k=>{if(!cache.has(k)){fetches++;cache.set(k,{value:data[k]});}return cache.get(k).value??'missing';});return {values,fetches};

Proposal 4:
const data={a:0,b:null,c:3};const cache=Object.create(null);let fetches=0;const values=x.map(k=>{if(!Object.hasOwn(cache,k)){fetches++;cache[k]=data[k];}return cache[k]??'missing';});return {values,fetches};

Determine which proposals preserve every contractual observation across the ENTIRE domain, not merely a sample output. For every unsafe proposal, give the first counterexample in the listed domain (not the numerically smallest input). Return one JSON object with exactly keys "safe","witnesses" in that order. safe is the ascending array of safe proposal numbers. witnesses is ordered by proposal number; each witness has exactly keys "candidate","input","expected","actual" in that order. expected and actual are the observer objects, with "value" or "error" as appropriate, preserving every nested object key's creation order. Values missing from an array serialize as null. Do not include witnesses for safe proposals.`,
    check: {
      kind: 'json_equal',
      value: {
        safe: [3, 4],
        witnesses: [
          {
            candidate: 1,
            input: ['a', 'a', 'b', 'b', 'c', 'c'],
            expected: {
              value: {
                values: [0, 0, 'missing', 'missing', 3, 3],
                fetches: 3,
              },
            },
            actual: {
              value: {
                values: [0, 0, 'missing', 'missing', 3, 3],
                fetches: 5,
              },
            },
          },
          {
            candidate: 2,
            input: ['d', 'd', 'c', 'd'],
            expected: {
              value: {
                values: ['missing', 'missing', 3, 'missing'],
                fetches: 2,
              },
            },
            actual: {
              value: {
                values: ['missing', 'missing', 3, 'missing'],
                fetches: 4,
              },
            },
          },
        ],
      },
    },
  },
  {
    id: 'frontier-refactoring-code-cleanup-integer-bankers-rounding',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Review a behavior-preserving cleanup of this three-file fixture. ledger.js accepts signed decimal integers as strings outside the Number safe range. formatter.js requires round-to-nearest ties-to-even at a divisor of ten, represented as a decimal string.

adapter.js (an ECMAScript module; all execution is strict):
export function run(x) {
const n=BigInt(x),q=n/10n,r=n%10n;const a=r<0n?-r:r;return (q+(a>5n||a===5n&&q%2n!==0n?(n<0n?-1n:1n):0n)).toString();
}

observer.js is unchanged and imports run from adapter.js:
export function observe(input) {
  try { return {value: run(JSON.parse(JSON.stringify(input)))}; }
  catch (error) { return {error: error.name}; }
}

client.js calls observe once for each input below, using a fresh adapter instance for every input. The observation is serialized immediately with JSON.stringify; only this JSON string is contractual. Objects with added non-enumerable/array non-index properties are not separately inspected. There are no other inputs or hidden requirements.
Ordered input domain:
["25","35","-25","-35","90071992547409935","90071992547409925","-90071992547409935","-30","-29","-28","-27","-26","-24","-23","-22","-21","-20","-19","-18","-17","-16","-15","-14","-13","-12","-11","-10","-9","-8","-7","-6","-5","-4","-3","-2","-1","0","1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","26","27","28","29","30","-90071992547409925"]

The following four proposals independently replace ONLY the body of run in adapter.js. Never combine proposals.
Proposal 1:
return String(Math.round(Number(x)/10));

Proposal 2:
const n=BigInt(x);return ((n+5n)/10n).toString();

Proposal 3:
const n=BigInt(x),sign=n<0n?-1n:1n,a=n*sign,q=a/10n,r=a%10n;return ((q+(r>5n||r===5n&&q%2n!==0n?1n:0n))*sign).toString();

Proposal 4:
const n=BigInt(x),q=n/10n,r=n%10n,a=r<0n?-r:r;return (q+(a>=5n?(n<0n?-1n:1n):0n)).toString();

Determine which proposals preserve every contractual observation across the ENTIRE domain, not merely a sample output. For every unsafe proposal, give the first counterexample in the listed domain (not the numerically smallest input). Return one JSON object with exactly keys "safe","witnesses" in that order. safe is the ascending array of safe proposal numbers. witnesses is ordered by proposal number; each witness has exactly keys "candidate","input","expected","actual" in that order. expected and actual are the observer objects, with "value" or "error" as appropriate, preserving every nested object key's creation order. Values missing from an array serialize as null. Do not include witnesses for safe proposals.`,
    check: {
      kind: 'json_equal',
      value: {
        safe: [3],
        witnesses: [
          {
            candidate: 1,
            input: '25',
            expected: {
              value: '2',
            },
            actual: {
              value: '3',
            },
          },
          {
            candidate: 2,
            input: '25',
            expected: {
              value: '2',
            },
            actual: {
              value: '3',
            },
          },
          {
            candidate: 4,
            input: '25',
            expected: {
              value: '2',
            },
            actual: {
              value: '3',
            },
          },
        ],
      },
    },
  },
  {
    id: 'frontier-refactoring-code-cleanup-unicode-key-identity',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Review a behavior-preserving cleanup of this three-file fixture. storage.js uses UTF-16 code-unit keys without normalization; search.js iterates Unicode code points only for display. Both index identity and display segmentation are contractual.

adapter.js (an ECMAScript module; all execution is strict):
export function run(x) {
const m=new Map();x.forEach((s,i)=>m.set(s,i));return {entries:[...m],points:x.map(s=>[...s]),units:x.map(s=>s.length)};
}

observer.js is unchanged and imports run from adapter.js:
export function observe(input) {
  try { return {value: run(JSON.parse(JSON.stringify(input)))}; }
  catch (error) { return {error: error.name}; }
}

client.js calls observe once for each input below, using a fresh adapter instance for every input. The observation is serialized immediately with JSON.stringify; only this JSON string is contractual. Objects with added non-enumerable/array non-index properties are not separately inspected. There are no other inputs or hidden requirements.
Ordered input domain:
[["é","é","𝌆"],["😀","a","😀"],["Å","Å","Å"],["a","a","𝌆"],["é","é","é"],["é","é","é"],["é","é","😀"],["é","é","a"],["é","é","é"],["é","é","é"],["é","é","😀"],["é","é","a"],["é","😀","é"],["é","😀","é"],["é","😀","😀"],["é","😀","a"],["é","a","é"],["é","a","é"],["é","a","😀"],["é","a","a"],["é","é","é"],["é","é","é"],["é","é","😀"],["é","é","a"],["é","é","é"],["é","é","é"],["é","é","😀"],["é","é","a"],["é","😀","é"],["é","😀","é"],["é","😀","😀"],["é","😀","a"],["é","a","é"],["é","a","é"],["é","a","😀"],["é","a","a"],["😀","é","é"],["😀","é","é"],["😀","é","😀"],["😀","é","a"],["😀","é","é"],["😀","é","é"],["😀","é","😀"],["😀","é","a"],["😀","😀","é"],["😀","😀","é"],["😀","😀","😀"],["😀","😀","a"],["😀","a","é"],["😀","a","é"],["😀","a","a"],["a","é","é"],["a","é","é"],["a","é","😀"],["a","é","a"],["a","é","é"],["a","é","é"],["a","é","😀"],["a","é","a"],["a","😀","é"],["a","😀","é"],["a","😀","😀"],["a","😀","a"],["a","a","é"],["a","a","é"],["a","a","😀"],["a","a","a"]]

The following four proposals independently replace ONLY the body of run in adapter.js. Never combine proposals.
Proposal 1:
const m=new Map();x.forEach((s,i)=>m.set(s.normalize('NFC'),i));return {entries:[...m],points:x.map(s=>[...s]),units:x.map(s=>s.length)};

Proposal 2:
const m=new Map(x.map((s,i)=>[s,i]));return {entries:[...m],points:x.map(s=>Array.from(s)),units:x.map(s=>s.length)};

Proposal 3:
const m=new Map(x.map((s,i)=>[s,i]));return {entries:[...m],points:x.map(s=>s.split('')),units:x.map(s=>s.length)};

Proposal 4:
const m=new Map();for(let i=0;i<x.length;i++)m.set(x[i],i);return {entries:[...m],points:x.map(s=>[...s]),units:x.map(s=>s.length)};

Determine which proposals preserve every contractual observation across the ENTIRE domain, not merely a sample output. For every unsafe proposal, give the first counterexample in the listed domain (not the numerically smallest input). Return one JSON object with exactly keys "safe","witnesses" in that order. safe is the ascending array of safe proposal numbers. witnesses is ordered by proposal number; each witness has exactly keys "candidate","input","expected","actual" in that order. expected and actual are the observer objects, with "value" or "error" as appropriate, preserving every nested object key's creation order. Values missing from an array serialize as null. Do not include witnesses for safe proposals.`,
    check: {
      kind: 'json_equal',
      value: {
        safe: [2, 4],
        witnesses: [
          {
            candidate: 1,
            input: ['é', 'é', '𝌆'],
            expected: {
              value: {
                entries: [
                  ['é', 0],
                  ['é', 1],
                  ['𝌆', 2],
                ],
                points: [['é'], ['e', '́'], ['𝌆']],
                units: [1, 2, 2],
              },
            },
            actual: {
              value: {
                entries: [
                  ['é', 1],
                  ['𝌆', 2],
                ],
                points: [['é'], ['e', '́'], ['𝌆']],
                units: [1, 2, 2],
              },
            },
          },
          {
            candidate: 3,
            input: ['é', 'é', '𝌆'],
            expected: {
              value: {
                entries: [
                  ['é', 0],
                  ['é', 1],
                  ['𝌆', 2],
                ],
                points: [['é'], ['e', '́'], ['𝌆']],
                units: [1, 2, 2],
              },
            },
            actual: {
              value: {
                entries: [
                  ['é', 0],
                  ['é', 1],
                  ['𝌆', 2],
                ],
                points: [['é'], ['e', '́'], ['�', '�']],
                units: [1, 2, 2],
              },
            },
          },
        ],
      },
    },
  },
  {
    id: 'frontier-refactoring-code-cleanup-signed-zero-saturation',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Review a behavior-preserving cleanup of this three-file fixture. numeric.js saturates into [-1,1]; protocol.js encodes signed zero and non-finite values explicitly. Algebraic min/max changes the sign of zero in one direction.

adapter.js (an ECMAScript module; all execution is strict):
export function run(x) {
const n=Number(x);const v=n<-1?-1:n>1?1:n;return Number.isNaN(v)?'nan':Object.is(v,-0)?'-0':String(v);
}

observer.js is unchanged and imports run from adapter.js:
export function observe(input) {
  try { return {value: run(JSON.parse(JSON.stringify(input)))}; }
  catch (error) { return {error: error.name}; }
}

client.js calls observe once for each input below, using a fresh adapter instance for every input. The observation is serialized immediately with JSON.stringify; only this JSON string is contractual. Objects with added non-enumerable/array non-index properties are not separately inspected. There are no other inputs or hidden requirements.
Ordered input domain:
["-0","0","-2","2","NaN","Infinity","-Infinity"]

The following four proposals independently replace ONLY the body of run in adapter.js. Never combine proposals.
Proposal 1:
const n=Number(x);const v=Math.min(1,Math.max(-1,n));return Number.isNaN(v)?'nan':Object.is(v,-0)?'-0':String(v);

Proposal 2:
const n=Number(x);const v=Math.max(-1,Math.min(1,n));return Number.isNaN(v)?'nan':Object.is(v,-0)?'-0':String(v);

Proposal 3:
const n=Number(x);const v=n===0?0:n<-1?-1:n>1?1:n;return Number.isNaN(v)?'nan':Object.is(v,-0)?'-0':String(v);

Proposal 4:
const n=Number(x);const v=Math.abs(n)>1?Math.sign(n):n;return Number.isNaN(v)?'nan':Object.is(v,-0)?'-0':String(v);

Determine which proposals preserve every contractual observation across the ENTIRE domain, not merely a sample output. For every unsafe proposal, give the first counterexample in the listed domain (not the numerically smallest input). Return one JSON object with exactly keys "safe","witnesses" in that order. safe is the ascending array of safe proposal numbers. witnesses is ordered by proposal number; each witness has exactly keys "candidate","input","expected","actual" in that order. expected and actual are the observer objects, with "value" or "error" as appropriate, preserving every nested object key's creation order. Values missing from an array serialize as null. Do not include witnesses for safe proposals.`,
    check: {
      kind: 'json_equal',
      value: {
        safe: [1, 2, 4],
        witnesses: [
          {
            candidate: 3,
            input: '-0',
            expected: {
              value: '-0',
            },
            actual: {
              value: '0',
            },
          },
        ],
      },
    },
  },
  {
    id: 'frontier-refactoring-code-cleanup-setter-copy-contract',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Review a behavior-preserving cleanup of this three-file fixture. model.js installs a prototype setter, config.js exposes enumerable getters, and adapter.js copies config onto the existing model. Setter effects, getter order, and own-key order are observable.

adapter.js (an ECMAScript module; all execution is strict):
export function run(x) {
const [a,b]=x;const log=[];const target=Object.create({set a(v){log.push('set:'+v);}});target.z=1;const source={get a(){log.push('get:a');return a;},get b(){log.push('get:b');return b;}};Object.assign(target,source);return {log,keys:Object.keys(target),b:target.b};
}

observer.js is unchanged and imports run from adapter.js:
export function observe(input) {
  try { return {value: run(JSON.parse(JSON.stringify(input)))}; }
  catch (error) { return {error: error.name}; }
}

client.js calls observe once for each input below, using a fresh adapter instance for every input. The observation is serialized immediately with JSON.stringify; only this JSON string is contractual. Objects with added non-enumerable/array non-index properties are not separately inspected. There are no other inputs or hidden requirements.
Ordered input domain:
[[2,3],[0,4],[-1,7],[-1,-2],[-1,0],[-1,4],[0,-2],[0,0],[3,-2],[3,0],[3,4]]

The following four proposals independently replace ONLY the body of run in adapter.js. Never combine proposals.
Proposal 1:
const [a,b]=x;const log=[];const target=Object.create({set a(v){log.push('set:'+v);}});target.z=1;const source={get a(){log.push('get:a');return a;},get b(){log.push('get:b');return b;}};const result={...target,...source};return {log,keys:Object.keys(result),b:result.b};

Proposal 2:
const [a,b]=x;const log=[];const target=Object.create({set a(v){log.push('set:'+v);}});target.z=1;const source={get a(){log.push('get:a');return a;},get b(){log.push('get:b');return b;}};for(const k of Object.keys(source))target[k]=source[k];return {log,keys:Object.keys(target),b:target.b};

Proposal 3:
const [a,b]=x;const log=[];const target=Object.create({set a(v){log.push('set:'+v);}});target.z=1;const source={get a(){log.push('get:a');return a;},get b(){log.push('get:b');return b;}};for(const k of Object.keys(source).reverse())target[k]=source[k];return {log,keys:Object.keys(target),b:target.b};

Proposal 4:
const [a,b]=x;const log=['get:a','set:'+a,'get:b'];return {log,keys:['z','b'],b};

Determine which proposals preserve every contractual observation across the ENTIRE domain, not merely a sample output. For every unsafe proposal, give the first counterexample in the listed domain (not the numerically smallest input). Return one JSON object with exactly keys "safe","witnesses" in that order. safe is the ascending array of safe proposal numbers. witnesses is ordered by proposal number; each witness has exactly keys "candidate","input","expected","actual" in that order. expected and actual are the observer objects, with "value" or "error" as appropriate, preserving every nested object key's creation order. Values missing from an array serialize as null. Do not include witnesses for safe proposals.`,
    check: {
      kind: 'json_equal',
      value: {
        safe: [2, 4],
        witnesses: [
          {
            candidate: 1,
            input: [2, 3],
            expected: {
              value: {
                log: ['get:a', 'set:2', 'get:b'],
                keys: ['z', 'b'],
                b: 3,
              },
            },
            actual: {
              value: {
                log: ['get:a', 'get:b'],
                keys: ['z', 'a', 'b'],
                b: 3,
              },
            },
          },
          {
            candidate: 3,
            input: [2, 3],
            expected: {
              value: {
                log: ['get:a', 'set:2', 'get:b'],
                keys: ['z', 'b'],
                b: 3,
              },
            },
            actual: {
              value: {
                log: ['get:b', 'get:a', 'set:2'],
                keys: ['z', 'b'],
                b: 3,
              },
            },
          },
        ],
      },
    },
  },
  {
    id: 'frontier-refactoring-code-cleanup-stateful-regexp-ownership',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Review a behavior-preserving cleanup of this three-file fixture. parser.js reuses one global RegExp across calls; token.js exposes both matches and lastIndex after every test. Failed tests reset lastIndex; successful tests advance it.

adapter.js (an ECMAScript module; all execution is strict):
export function run(x) {
const re=/a/g;return x.map(s=>{const hit=re.test(s);return [hit,re.lastIndex];});
}

observer.js is unchanged and imports run from adapter.js:
export function observe(input) {
  try { return {value: run(JSON.parse(JSON.stringify(input)))}; }
  catch (error) { return {error: error.name}; }
}

client.js calls observe once for each input below, using a fresh adapter instance for every input. The observation is serialized immediately with JSON.stringify; only this JSON string is contractual. Objects with added non-enumerable/array non-index properties are not separately inspected. There are no other inputs or hidden requirements.
Ordered input domain:
[["aa","aa","aa","aa"],["ba","a","ba","a"],["","a","a","aa"],["aba","aba","aba","aba"],["","",""],["","","a"],["","","aa"],["","","ba"],["","","aba"],["","a",""],["","a","a"],["","a","aa"],["","a","ba"],["","a","aba"],["","aa",""],["","aa","a"],["","aa","aa"],["","aa","ba"],["","aa","aba"],["","ba",""],["","ba","a"],["","ba","aa"],["","ba","ba"],["","ba","aba"],["","aba",""],["","aba","a"],["","aba","aa"],["","aba","ba"],["","aba","aba"],["a","",""],["a","","a"],["a","","aa"],["a","","ba"],["a","","aba"],["a","a",""],["a","a","a"],["a","a","aa"],["a","a","ba"],["a","a","aba"],["a","aa",""],["a","aa","a"],["a","aa","aa"],["a","aa","ba"],["a","aa","aba"],["a","ba",""],["a","ba","a"],["a","ba","aa"],["a","ba","ba"],["a","ba","aba"],["a","aba",""],["a","aba","a"],["a","aba","aa"],["a","aba","ba"],["a","aba","aba"],["aa","",""],["aa","","a"],["aa","","aa"],["aa","","ba"],["aa","","aba"],["aa","a",""],["aa","a","a"],["aa","a","aa"],["aa","a","ba"],["aa","a","aba"],["aa","aa",""],["aa","aa","a"],["aa","aa","aa"],["aa","aa","ba"],["aa","aa","aba"],["aa","ba",""],["aa","ba","a"],["aa","ba","aa"],["aa","ba","ba"],["aa","ba","aba"],["aa","aba",""],["aa","aba","a"],["aa","aba","aa"],["aa","aba","ba"],["aa","aba","aba"],["ba","",""],["ba","","a"],["ba","","aa"],["ba","","ba"],["ba","","aba"],["ba","a",""],["ba","a","a"],["ba","a","aa"],["ba","a","ba"],["ba","a","aba"],["ba","aa",""],["ba","aa","a"],["ba","aa","aa"],["ba","aa","ba"],["ba","aa","aba"],["ba","ba",""],["ba","ba","a"],["ba","ba","aa"],["ba","ba","ba"],["ba","ba","aba"],["ba","aba",""],["ba","aba","a"],["ba","aba","aa"],["ba","aba","ba"],["ba","aba","aba"],["aba","",""],["aba","","a"],["aba","","aa"],["aba","","ba"],["aba","","aba"],["aba","a",""],["aba","a","a"],["aba","a","aa"],["aba","a","ba"],["aba","a","aba"],["aba","aa",""],["aba","aa","a"],["aba","aa","aa"],["aba","aa","ba"],["aba","aa","aba"],["aba","ba",""],["aba","ba","a"],["aba","ba","aa"],["aba","ba","ba"],["aba","ba","aba"],["aba","aba",""],["aba","aba","a"],["aba","aba","aa"],["aba","aba","ba"],["aba","aba","aba"]]

The following four proposals independently replace ONLY the body of run in adapter.js. Never combine proposals.
Proposal 1:
return x.map(s=>{const re=/a/g;const hit=re.test(s);return [hit,re.lastIndex];});

Proposal 2:
const re=new RegExp('a','g');return x.map(s=>{const hit=Boolean(re.exec(s));return [hit,re.lastIndex];});

Proposal 3:
const re=/a/g;return x.map(s=>{re.lastIndex=0;const hit=re.test(s);return [hit,re.lastIndex];});

Proposal 4:
const re=/a/g;const out=[];for(const s of x){out.push([re.test(s),re.lastIndex]);}return out;

Determine which proposals preserve every contractual observation across the ENTIRE domain, not merely a sample output. For every unsafe proposal, give the first counterexample in the listed domain (not the numerically smallest input). Return one JSON object with exactly keys "safe","witnesses" in that order. safe is the ascending array of safe proposal numbers. witnesses is ordered by proposal number; each witness has exactly keys "candidate","input","expected","actual" in that order. expected and actual are the observer objects, with "value" or "error" as appropriate, preserving every nested object key's creation order. Values missing from an array serialize as null. Do not include witnesses for safe proposals.`,
    check: {
      kind: 'json_equal',
      value: {
        safe: [2, 4],
        witnesses: [
          {
            candidate: 1,
            input: ['aa', 'aa', 'aa', 'aa'],
            expected: {
              value: [
                [true, 1],
                [true, 2],
                [false, 0],
                [true, 1],
              ],
            },
            actual: {
              value: [
                [true, 1],
                [true, 1],
                [true, 1],
                [true, 1],
              ],
            },
          },
          {
            candidate: 3,
            input: ['aa', 'aa', 'aa', 'aa'],
            expected: {
              value: [
                [true, 1],
                [true, 2],
                [false, 0],
                [true, 1],
              ],
            },
            actual: {
              value: [
                [true, 1],
                [true, 1],
                [true, 1],
                [true, 1],
              ],
            },
          },
        ],
      },
    },
  },
  {
    id: 'frontier-refactoring-code-cleanup-reviver-postorder-deletion',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Review a behavior-preserving cleanup of this three-file fixture. codec.js revives leaf numbers before their containing objects; repository.js sums only surviving own properties. Returning undefined deletes a property, including array slots.

adapter.js (an ECMAScript module; all execution is strict):
export function run(x) {
const log=[];const result=JSON.parse(x,function(k,v){log.push(k);if(typeof v==='number')return v%2===0?undefined:v*10;if(v&&typeof v==='object'&&!Array.isArray(v))v.sum=Object.values(v).filter(n=>typeof n==='number').reduce((a,b)=>a+b,0);return v;});return {log,result};
}

observer.js is unchanged and imports run from adapter.js:
export function observe(input) {
  try { return {value: run(JSON.parse(JSON.stringify(input)))}; }
  catch (error) { return {error: error.name}; }
}

client.js calls observe once for each input below, using a fresh adapter instance for every input. The observation is serialized immediately with JSON.stringify; only this JSON string is contractual. Objects with added non-enumerable/array non-index properties are not separately inspected. There are no other inputs or hidden requirements.
Ordered input domain:
["{\\"a\\":2,\\"b\\":{\\"c\\":3,\\"d\\":4}}","{\\"a\\":[1,2,3],\\"b\\":5}","{\\"z\\":0,\\"a\\":{\\"b\\":6}}","{\\"a\\":{\\"b\\":[2,{\\"c\\":3,\\"d\\":6},7]},\\"z\\":4}","[{\\"a\\":3,\\"b\\":4},2,5]","{\\"a\\":null,\\"b\\":false,\\"c\\":{\\"sum\\":3,\\"x\\":2}}"]

The following four proposals independently replace ONLY the body of run in adapter.js. Never combine proposals.
Proposal 1:
const log=[];const result=JSON.parse(x,function(k,v){log.push(k);if(typeof v==='number')return v%2===0?null:v*10;if(v&&typeof v==='object'&&!Array.isArray(v))v.sum=Object.values(v).filter(n=>typeof n==='number').reduce((a,b)=>a+b,0);return v;});return {log,result};

Proposal 2:
const log=[];const result=JSON.parse(x,function(k,v){log.push(k);if(typeof v==='number'){if(v%2===0)return;return 10*v;}if(v!==null&&typeof v==='object'&&!Array.isArray(v)){let sum=0;for(const n of Object.values(v))if(typeof n==='number')sum+=n;v.sum=sum;}return v;});return {log,result};

Proposal 3:
const log=[];const result=JSON.parse(x,function(k,v){log.push(k);if(v&&typeof v==='object'&&!Array.isArray(v))v.sum=Object.values(v).filter(n=>typeof n==='number').reduce((a,b)=>a+b,0);if(typeof v==='number')return v%2===0?undefined:v*10;return v;});return {log,result};

Proposal 4:
const log=[];const result=JSON.parse(x,function(k,v){log.push(k);if(typeof v==='number')return v%2===0?undefined:v*10;if(v&&typeof v==='object')v.sum=Object.values(v).filter(n=>typeof n==='number').reduce((a,b)=>a+b,0);return v;});return {log,result};

Determine which proposals preserve every contractual observation across the ENTIRE domain, not merely a sample output. For every unsafe proposal, give the first counterexample in the listed domain (not the numerically smallest input). Return one JSON object with exactly keys "safe","witnesses" in that order. safe is the ascending array of safe proposal numbers. witnesses is ordered by proposal number; each witness has exactly keys "candidate","input","expected","actual" in that order. expected and actual are the observer objects, with "value" or "error" as appropriate, preserving every nested object key's creation order. Values missing from an array serialize as null. Do not include witnesses for safe proposals.`,
    check: {
      kind: 'json_equal',
      value: {
        safe: [2, 3, 4],
        witnesses: [
          {
            candidate: 1,
            input: '{"a":2,"b":{"c":3,"d":4}}',
            expected: {
              value: {
                log: ['a', 'c', 'd', 'b', ''],
                result: {
                  b: {
                    c: 30,
                    sum: 30,
                  },
                  sum: 0,
                },
              },
            },
            actual: {
              value: {
                log: ['a', 'c', 'd', 'b', ''],
                result: {
                  a: null,
                  b: {
                    c: 30,
                    d: null,
                    sum: 30,
                  },
                  sum: 0,
                },
              },
            },
          },
        ],
      },
    },
  },
  {
    id: 'frontier-refactoring-code-cleanup-reentrant-listener-snapshot',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Review a behavior-preserving cleanup of this three-file fixture. events.js copies listeners before dispatch. handlers.js removes a later listener and adds another while the first event is being dispatched. client.js then dispatches again.

adapter.js (an ECMAScript module; all execution is strict):
export function run(x) {
const [remove,add]=x;const log=[];const listeners=new Set();const b=()=>log.push('b'),c=()=>log.push('c');const a=()=>{log.push('a');if(remove)listeners.delete(b);if(add)listeners.add(c);};listeners.add(a);listeners.add(b);const fire=()=>{for(const f of [...listeners])f();};fire();fire();return log;
}

observer.js is unchanged and imports run from adapter.js:
export function observe(input) {
  try { return {value: run(JSON.parse(JSON.stringify(input)))}; }
  catch (error) { return {error: error.name}; }
}

client.js calls observe once for each input below, using a fresh adapter instance for every input. The observation is serialized immediately with JSON.stringify; only this JSON string is contractual. Objects with added non-enumerable/array non-index properties are not separately inspected. There are no other inputs or hidden requirements.
Ordered input domain:
[[false,false],[true,false],[false,true],[true,true]]

The following four proposals independently replace ONLY the body of run in adapter.js. Never combine proposals.
Proposal 1:
const [remove,add]=x;const log=[];const listeners=new Set();const b=()=>log.push('b'),c=()=>log.push('c');const a=()=>{log.push('a');if(remove)listeners.delete(b);if(add)listeners.add(c);};listeners.add(a);listeners.add(b);const fire=()=>{for(const f of listeners)f();};fire();fire();return log;

Proposal 2:
const [remove,add]=x;const log=[];const listeners=new Set();const b=()=>log.push('b'),c=()=>log.push('c');const a=()=>{log.push('a');if(remove)listeners.delete(b);if(add)listeners.add(c);};listeners.add(a);listeners.add(b);const fire=()=>{Array.from(listeners).forEach(f=>f());};fire();fire();return log;

Proposal 3:
const [remove,add]=x;return ['a',...(!remove?['b']:[]),...(add?['c']:[]),'a',...(!remove?['b']:[]),...(add?['c']:[])];

Proposal 4:
const [remove,add]=x;return ['a','b','a',...(!remove?['b']:[]),...(add?['c']:[])];

Determine which proposals preserve every contractual observation across the ENTIRE domain, not merely a sample output. For every unsafe proposal, give the first counterexample in the listed domain (not the numerically smallest input). Return one JSON object with exactly keys "safe","witnesses" in that order. safe is the ascending array of safe proposal numbers. witnesses is ordered by proposal number; each witness has exactly keys "candidate","input","expected","actual" in that order. expected and actual are the observer objects, with "value" or "error" as appropriate, preserving every nested object key's creation order. Values missing from an array serialize as null. Do not include witnesses for safe proposals.`,
    check: {
      kind: 'json_equal',
      value: {
        safe: [2, 4],
        witnesses: [
          {
            candidate: 1,
            input: [true, false],
            expected: {
              value: ['a', 'b', 'a'],
            },
            actual: {
              value: ['a', 'a'],
            },
          },
          {
            candidate: 3,
            input: [true, false],
            expected: {
              value: ['a', 'b', 'a'],
            },
            actual: {
              value: ['a', 'a'],
            },
          },
        ],
      },
    },
  },
  {
    id: 'frontier-refactoring-code-cleanup-memoized-promise-flight-identity',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Review a behavior-preserving cleanup of this three-file fixture. transport.js stores a promise before invoking a reentrant loader; client.js compares the promise returned by recursive access and clears only a matching generation. The fixture uses tokens as promise identities and synchronous events as observable interleavings.

adapter.js (an ECMAScript module; all execution is strict):
export function run(x) {
const [reenter,replace]=x;const log=[];let slot=null;let next=0;function get(nested=false){if(slot)return slot;const token=++next;slot=token;log.push('start:'+token);if(reenter&&!nested)log.push('nested:'+get(true));if(replace&&!nested){slot=null;log.push('new:'+get(true));}if(!nested&&slot===token)slot=null;return token;}const first=get();return {first,slot,log};
}

observer.js is unchanged and imports run from adapter.js:
export function observe(input) {
  try { return {value: run(JSON.parse(JSON.stringify(input)))}; }
  catch (error) { return {error: error.name}; }
}

client.js calls observe once for each input below, using a fresh adapter instance for every input. The observation is serialized immediately with JSON.stringify; only this JSON string is contractual. Objects with added non-enumerable/array non-index properties are not separately inspected. There are no other inputs or hidden requirements.
Ordered input domain:
[[false,false],[true,false],[false,true],[true,true]]

The following four proposals independently replace ONLY the body of run in adapter.js. Never combine proposals.
Proposal 1:
const [reenter,replace]=x;const log=[];let slot=null;let next=0;function get(nested=false){if(slot)return slot;const token=++next;log.push('start:'+token);if(reenter&&!nested)log.push('nested:'+get(true));slot=token;if(replace&&!nested){slot=null;log.push('new:'+get(true));}if(!nested&&slot===token)slot=null;return token;}const first=get();return {first,slot,log};

Proposal 2:
const [reenter,replace]=x;const log=[];let slot=null;let next=0;function get(nested=false){if(slot!==null)return slot;const token=++next;slot=token;log.push('start:'+token);if(reenter&&!nested)log.push('nested:'+get(true));if(replace&&!nested){slot=null;log.push('new:'+get(true));}if(!nested&&slot===token)slot=null;return token;}const first=get();return {first,slot,log};

Proposal 3:
const [reenter,replace]=x;const log=[];let slot=null;let next=0;function get(nested=false){if(slot)return slot;const token=++next;slot=token;log.push('start:'+token);if(reenter&&!nested)log.push('nested:'+get(true));if(replace&&!nested){slot=null;log.push('new:'+get(true));}if(!nested)slot=null;return token;}const first=get();return {first,slot,log};

Proposal 4:
const [reenter,replace]=x;const log=[];let slot=null;let next=0;function get(nested=false){if(slot)return slot;const token=++next;slot=token;log.push('start:'+token);if(reenter&&!nested)log.push('nested:'+get(true));if(replace&&!nested){slot=null;log.push('new:'+get(true));}if(!nested&&slot===token)slot=null;return token;}const first=get();return {first,slot,log};

Determine which proposals preserve every contractual observation across the ENTIRE domain, not merely a sample output. For every unsafe proposal, give the first counterexample in the listed domain (not the numerically smallest input). Return one JSON object with exactly keys "safe","witnesses" in that order. safe is the ascending array of safe proposal numbers. witnesses is ordered by proposal number; each witness has exactly keys "candidate","input","expected","actual" in that order. expected and actual are the observer objects, with "value" or "error" as appropriate, preserving every nested object key's creation order. Values missing from an array serialize as null. Do not include witnesses for safe proposals.`,
    check: {
      kind: 'json_equal',
      value: {
        safe: [2, 4],
        witnesses: [
          {
            candidate: 1,
            input: [true, false],
            expected: {
              value: {
                first: 1,
                slot: null,
                log: ['start:1', 'nested:1'],
              },
            },
            actual: {
              value: {
                first: 1,
                slot: null,
                log: ['start:1', 'start:2', 'nested:2'],
              },
            },
          },
          {
            candidate: 3,
            input: [false, true],
            expected: {
              value: {
                first: 1,
                slot: 2,
                log: ['start:1', 'start:2', 'new:2'],
              },
            },
            actual: {
              value: {
                first: 1,
                slot: null,
                log: ['start:1', 'start:2', 'new:2'],
              },
            },
          },
        ],
      },
    },
  },
  {
    id: 'frontier-refactoring-architecture-improvement-auth-ledger-boundaries',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Refactor the auth-ledger-boundaries multi-package subsystem without changing initialization or any public call. Choose a new owning package (integer 0,1,2) for EACH module. Data indices refer to modules in the supplied order; edges are numbered from zero in their supplied order. All quantities are exact integers.

Authoritative compatibility contract (overrides the old team's advice to minimize imports before checking eager cycles):
1. A module is indivisible. Its size consumes its assigned package's capacity. Honor every [module,package] pinned assignment, every module's allowed package list, and every separate [a,b] pair (different owners). Empty packages are allowed.
2. Each edge is [caller,callee,kind,weight]. An eager edge across packages becomes an initialization dependency; the directed graph on the three packages formed by ALL cross-package eager edges must be acyclic. Intra-package eager cycles are legal because the existing bootstrap remains atomic there. Lazy edges do not constrain initialization. Neither deleting an edge nor changing eager to lazy is allowed.
3. Every cross-package edge, eager OR lazy, needs one behavior-preserving bridge. bridgeCost is the SUM of weights of these edges, counting parallel edges independently. It must not exceed bridgeBudget. bridges is the ascending array of original edge indices that need bridges.
4. changed counts modules whose owner differs from old. moveCost sums moveCost[module] for precisely those modules. Existing internal code and callers remain unchanged except mechanically retargeting their bridge imports.
5. Minimize the metrics in priority order lexicographically (all are minimized). Only after all listed metrics tie, minimize the full owners vector lexicographically in module order. Do not optimize an unlisted metric before this tie-break.

Module ownership manifest, public API edges, and deployment constraints:
{"modules":["entry","identity","journal","codec","storage","lease","policy","replica"],"size":[2,2,3,1,2,1,2,2],"capacity":[7,7,8],"old":[0,1,2,0,1,2,0,1],"moveCost":[1,4,7,3,6,2,5,1],"edges":[[0,1,"eager",3],[1,0,"eager",3],[1,2,"eager",7],[2,3,"eager",2],[3,4,"eager",5],[4,5,"eager",3],[2,6,"eager",3],[6,7,"eager",5],[7,1,"lazy",8],[5,2,"lazy",2],[0,6,"lazy",4],[6,2,"eager",4]],"pinned":[[0,0],[4,2]],"allowed":[[0,1,2],[0,1,2],[0,1,2],[1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2]],"separate":[[1,4],[0,7]],"bridgeBudget":41,"priority":["moveCost","bridgeCost"]}

Return ONLY JSON with exactly keys "owners","loads","changed","moveCost","bridgeCost","bridges" in that order. loads is package sizes for packages 0,1,2. This is a globally optimal behavior-preserving partition, not a greedy or merely legal design.`,
    check: {
      kind: 'json_equal',
      value: {
        owners: [0, 0, 2, 2, 2, 1, 2, 1],
        loads: [4, 3, 8],
        changed: 5,
        moveCost: 20,
        bridgeCost: 29,
        bridges: [2, 5, 7, 8, 9, 10],
      },
    },
  },
  {
    id: 'frontier-refactoring-architecture-improvement-parser-registry-bootstrap',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Refactor the parser-registry-bootstrap multi-package subsystem without changing initialization or any public call. Choose a new owning package (integer 0,1,2) for EACH module. Data indices refer to modules in the supplied order; edges are numbered from zero in their supplied order. All quantities are exact integers.

Authoritative compatibility contract (overrides the old team's advice to minimize imports before checking eager cycles):
1. A module is indivisible. Its size consumes its assigned package's capacity. Honor every [module,package] pinned assignment, every module's allowed package list, and every separate [a,b] pair (different owners). Empty packages are allowed.
2. Each edge is [caller,callee,kind,weight]. An eager edge across packages becomes an initialization dependency; the directed graph on the three packages formed by ALL cross-package eager edges must be acyclic. Intra-package eager cycles are legal because the existing bootstrap remains atomic there. Lazy edges do not constrain initialization. Neither deleting an edge nor changing eager to lazy is allowed.
3. Every cross-package edge, eager OR lazy, needs one behavior-preserving bridge. bridgeCost is the SUM of weights of these edges, counting parallel edges independently. It must not exceed bridgeBudget. bridges is the ascending array of original edge indices that need bridges.
4. changed counts modules whose owner differs from old. moveCost sums moveCost[module] for precisely those modules. Existing internal code and callers remain unchanged except mechanically retargeting their bridge imports.
5. Minimize the metrics in priority order lexicographically (all are minimized). Only after all listed metrics tie, minimize the full owners vector lexicographically in module order. Do not optimize an unlisted metric before this tie-break.

Module ownership manifest, public API edges, and deployment constraints:
{"modules":["entry","identity","journal","codec","storage","lease","policy","replica"],"size":[2,2,2,2,2,1,2,2],"capacity":[8,7,8],"old":[1,2,0,1,2,0,1,2],"moveCost":[2,5,1,4,7,3,6,2],"edges":[[0,1,"eager",4],[1,0,"eager",4],[1,2,"eager",5],[2,3,"eager",3],[3,4,"eager",6],[4,5,"eager",1],[2,6,"eager",4],[6,7,"eager",6],[7,1,"lazy",6],[5,2,"lazy",3],[0,6,"lazy",5],[3,6,"eager",2]],"pinned":[[0,0],[4,2]],"allowed":[[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,2],[0,1,2],[0,1,2],[0,1,2]],"separate":[[1,2],[3,5]],"bridgeBudget":45,"priority":["bridgeCost","moveCost"]}

Return ONLY JSON with exactly keys "owners","loads","changed","moveCost","bridgeCost","bridges" in that order. loads is package sizes for packages 0,1,2. This is a globally optimal behavior-preserving partition, not a greedy or merely legal design.`,
    check: {
      kind: 'json_equal',
      value: {
        owners: [0, 0, 2, 2, 2, 1, 1, 1],
        loads: [4, 5, 6],
        changed: 6,
        moveCost: 17,
        bridgeCost: 26,
        bridges: [2, 5, 6, 8, 9, 10, 11],
      },
    },
  },
  {
    id: 'frontier-refactoring-architecture-improvement-lease-cancellation-owners',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Refactor the lease-cancellation-owners multi-package subsystem without changing initialization or any public call. Choose a new owning package (integer 0,1,2) for EACH module. Data indices refer to modules in the supplied order; edges are numbered from zero in their supplied order. All quantities are exact integers.

Authoritative compatibility contract (overrides the old team's advice to minimize imports before checking eager cycles):
1. A module is indivisible. Its size consumes its assigned package's capacity. Honor every [module,package] pinned assignment, every module's allowed package list, and every separate [a,b] pair (different owners). Empty packages are allowed.
2. Each edge is [caller,callee,kind,weight]. An eager edge across packages becomes an initialization dependency; the directed graph on the three packages formed by ALL cross-package eager edges must be acyclic. Intra-package eager cycles are legal because the existing bootstrap remains atomic there. Lazy edges do not constrain initialization. Neither deleting an edge nor changing eager to lazy is allowed.
3. Every cross-package edge, eager OR lazy, needs one behavior-preserving bridge. bridgeCost is the SUM of weights of these edges, counting parallel edges independently. It must not exceed bridgeBudget. bridges is the ascending array of original edge indices that need bridges.
4. changed counts modules whose owner differs from old. moveCost sums moveCost[module] for precisely those modules. Existing internal code and callers remain unchanged except mechanically retargeting their bridge imports.
5. Minimize the metrics in priority order lexicographically (all are minimized). Only after all listed metrics tie, minimize the full owners vector lexicographically in module order. Do not optimize an unlisted metric before this tie-break.

Module ownership manifest, public API edges, and deployment constraints:
{"modules":["entry","identity","journal","codec","storage","lease","policy","replica"],"size":[2,2,2,1,3,1,2,2],"capacity":[7,7,8],"old":[2,0,1,2,0,1,2,0],"moveCost":[3,6,2,5,1,4,7,3],"edges":[[0,1,"eager",5],[1,0,"eager",2],[1,2,"eager",6],[2,3,"eager",4],[3,4,"eager",4],[4,5,"eager",2],[2,6,"eager",5],[6,7,"eager",4],[7,1,"lazy",7],[5,2,"lazy",4],[0,6,"lazy",3],[7,4,"eager",3]],"pinned":[[0,0],[4,2]],"allowed":[[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,2],[0,1,2],[0,1,2]],"separate":[[1,4],[0,7]],"bridgeBudget":49,"priority":["changed","moveCost","bridgeCost"]}

Return ONLY JSON with exactly keys "owners","loads","changed","moveCost","bridgeCost","bridges" in that order. loads is package sizes for packages 0,1,2. This is a globally optimal behavior-preserving partition, not a greedy or merely legal design.`,
    check: {
      kind: 'json_equal',
      value: {
        owners: [0, 0, 1, 1, 2, 2, 2, 2],
        loads: [4, 3, 8],
        changed: 5,
        moveCost: 16,
        bridgeCost: 29,
        bridges: [2, 4, 6, 8, 9, 10],
      },
    },
  },
  {
    id: 'frontier-refactoring-architecture-improvement-tensor-buffer-lifetimes',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Refactor the tensor-buffer-lifetimes multi-package subsystem without changing initialization or any public call. Choose a new owning package (integer 0,1,2) for EACH module. Data indices refer to modules in the supplied order; edges are numbered from zero in their supplied order. All quantities are exact integers.

Authoritative compatibility contract (overrides the old team's advice to minimize imports before checking eager cycles):
1. A module is indivisible. Its size consumes its assigned package's capacity. Honor every [module,package] pinned assignment, every module's allowed package list, and every separate [a,b] pair (different owners). Empty packages are allowed.
2. Each edge is [caller,callee,kind,weight]. An eager edge across packages becomes an initialization dependency; the directed graph on the three packages formed by ALL cross-package eager edges must be acyclic. Intra-package eager cycles are legal because the existing bootstrap remains atomic there. Lazy edges do not constrain initialization. Neither deleting an edge nor changing eager to lazy is allowed.
3. Every cross-package edge, eager OR lazy, needs one behavior-preserving bridge. bridgeCost is the SUM of weights of these edges, counting parallel edges independently. It must not exceed bridgeBudget. bridges is the ascending array of original edge indices that need bridges.
4. changed counts modules whose owner differs from old. moveCost sums moveCost[module] for precisely those modules. Existing internal code and callers remain unchanged except mechanically retargeting their bridge imports.
5. Minimize the metrics in priority order lexicographically (all are minimized). Only after all listed metrics tie, minimize the full owners vector lexicographically in module order. Do not optimize an unlisted metric before this tie-break.

Module ownership manifest, public API edges, and deployment constraints:
{"modules":["entry","identity","journal","codec","storage","lease","policy","replica"],"size":[2,2,2,1,2,2,2,2],"capacity":[8,7,8],"old":[0,1,2,0,1,2,0,1],"moveCost":[4,7,3,6,2,5,1,4],"edges":[[0,1,"eager",3],[1,0,"eager",3],[1,2,"eager",7],[2,3,"eager",2],[3,4,"eager",5],[4,5,"eager",3],[2,6,"eager",3],[6,7,"eager",5],[7,1,"lazy",8],[5,2,"lazy",2],[0,6,"lazy",4],[6,2,"eager",4]],"pinned":[[0,0],[4,2]],"allowed":[[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[1,2],[0,1,2]],"separate":[[1,2],[3,5]],"bridgeBudget":53,"priority":["moveCost","bridgeCost"]}

Return ONLY JSON with exactly keys "owners","loads","changed","moveCost","bridgeCost","bridges" in that order. loads is package sizes for packages 0,1,2. This is a globally optimal behavior-preserving partition, not a greedy or merely legal design.`,
    check: {
      kind: 'json_equal',
      value: {
        owners: [0, 0, 1, 1, 2, 2, 1, 1],
        loads: [4, 7, 4],
        changed: 5,
        moveCost: 19,
        bridgeCost: 26,
        bridges: [2, 4, 8, 9, 10],
      },
    },
  },
  {
    id: 'frontier-refactoring-architecture-improvement-plugin-capability-isolation',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Refactor the plugin-capability-isolation multi-package subsystem without changing initialization or any public call. Choose a new owning package (integer 0,1,2) for EACH module. Data indices refer to modules in the supplied order; edges are numbered from zero in their supplied order. All quantities are exact integers.

Authoritative compatibility contract (overrides the old team's advice to minimize imports before checking eager cycles):
1. A module is indivisible. Its size consumes its assigned package's capacity. Honor every [module,package] pinned assignment, every module's allowed package list, and every separate [a,b] pair (different owners). Empty packages are allowed.
2. Each edge is [caller,callee,kind,weight]. An eager edge across packages becomes an initialization dependency; the directed graph on the three packages formed by ALL cross-package eager edges must be acyclic. Intra-package eager cycles are legal because the existing bootstrap remains atomic there. Lazy edges do not constrain initialization. Neither deleting an edge nor changing eager to lazy is allowed.
3. Every cross-package edge, eager OR lazy, needs one behavior-preserving bridge. bridgeCost is the SUM of weights of these edges, counting parallel edges independently. It must not exceed bridgeBudget. bridges is the ascending array of original edge indices that need bridges.
4. changed counts modules whose owner differs from old. moveCost sums moveCost[module] for precisely those modules. Existing internal code and callers remain unchanged except mechanically retargeting their bridge imports.
5. Minimize the metrics in priority order lexicographically (all are minimized). Only after all listed metrics tie, minimize the full owners vector lexicographically in module order. Do not optimize an unlisted metric before this tie-break.

Module ownership manifest, public API edges, and deployment constraints:
{"modules":["entry","identity","journal","codec","storage","lease","policy","replica"],"size":[2,2,2,1,2,1,3,2],"capacity":[7,7,8],"old":[1,2,0,1,2,0,1,2],"moveCost":[5,1,4,7,3,6,2,5],"edges":[[0,1,"eager",4],[1,0,"eager",4],[1,2,"eager",5],[2,3,"eager",3],[3,4,"eager",6],[4,5,"eager",1],[2,6,"eager",4],[6,7,"eager",6],[7,1,"lazy",6],[5,2,"lazy",3],[0,6,"lazy",5],[3,6,"eager",2]],"pinned":[[0,0],[4,2]],"allowed":[[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,2]],"separate":[[1,4],[0,7]],"bridgeBudget":41,"priority":["bridgeCost","moveCost"]}

Return ONLY JSON with exactly keys "owners","loads","changed","moveCost","bridgeCost","bridges" in that order. loads is package sizes for packages 0,1,2. This is a globally optimal behavior-preserving partition, not a greedy or merely legal design.`,
    check: {
      kind: 'json_equal',
      value: {
        owners: [0, 0, 0, 2, 2, 1, 2, 2],
        loads: [6, 1, 8],
        changed: 5,
        moveCost: 21,
        bridgeCost: 22,
        bridges: [3, 5, 6, 8, 9, 10],
      },
    },
  },
  {
    id: 'frontier-refactoring-architecture-improvement-stream-checkpoint-cycles',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Refactor the stream-checkpoint-cycles multi-package subsystem without changing initialization or any public call. Choose a new owning package (integer 0,1,2) for EACH module. Data indices refer to modules in the supplied order; edges are numbered from zero in their supplied order. All quantities are exact integers.

Authoritative compatibility contract (overrides the old team's advice to minimize imports before checking eager cycles):
1. A module is indivisible. Its size consumes its assigned package's capacity. Honor every [module,package] pinned assignment, every module's allowed package list, and every separate [a,b] pair (different owners). Empty packages are allowed.
2. Each edge is [caller,callee,kind,weight]. An eager edge across packages becomes an initialization dependency; the directed graph on the three packages formed by ALL cross-package eager edges must be acyclic. Intra-package eager cycles are legal because the existing bootstrap remains atomic there. Lazy edges do not constrain initialization. Neither deleting an edge nor changing eager to lazy is allowed.
3. Every cross-package edge, eager OR lazy, needs one behavior-preserving bridge. bridgeCost is the SUM of weights of these edges, counting parallel edges independently. It must not exceed bridgeBudget. bridges is the ascending array of original edge indices that need bridges.
4. changed counts modules whose owner differs from old. moveCost sums moveCost[module] for precisely those modules. Existing internal code and callers remain unchanged except mechanically retargeting their bridge imports.
5. Minimize the metrics in priority order lexicographically (all are minimized). Only after all listed metrics tie, minimize the full owners vector lexicographically in module order. Do not optimize an unlisted metric before this tie-break.

Module ownership manifest, public API edges, and deployment constraints:
{"modules":["entry","identity","journal","codec","storage","lease","policy","replica"],"size":[2,2,2,1,2,1,2,3],"capacity":[8,7,8],"old":[2,0,1,2,0,1,2,0],"moveCost":[6,2,5,1,4,7,3,6],"edges":[[0,1,"eager",5],[1,0,"eager",2],[1,2,"eager",6],[2,3,"eager",4],[3,4,"eager",4],[4,5,"eager",2],[2,6,"eager",5],[6,7,"eager",4],[7,1,"lazy",7],[5,2,"lazy",4],[0,6,"lazy",3],[7,4,"eager",3]],"pinned":[[0,0],[4,2]],"allowed":[[0,1],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2]],"separate":[[1,2],[3,5]],"bridgeBudget":45,"priority":["changed","moveCost","bridgeCost"]}

Return ONLY JSON with exactly keys "owners","loads","changed","moveCost","bridgeCost","bridges" in that order. loads is package sizes for packages 0,1,2. This is a globally optimal behavior-preserving partition, not a greedy or merely legal design.`,
    check: {
      kind: 'json_equal',
      value: {
        owners: [0, 0, 1, 1, 2, 2, 2, 2],
        loads: [4, 3, 8],
        changed: 5,
        moveCost: 24,
        bridgeCost: 29,
        bridges: [2, 4, 6, 8, 9, 10],
      },
    },
  },
  {
    id: 'frontier-refactoring-architecture-improvement-schema-codec-cutover',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Refactor the schema-codec-cutover multi-package subsystem without changing initialization or any public call. Choose a new owning package (integer 0,1,2) for EACH module. Data indices refer to modules in the supplied order; edges are numbered from zero in their supplied order. All quantities are exact integers.

Authoritative compatibility contract (overrides the old team's advice to minimize imports before checking eager cycles):
1. A module is indivisible. Its size consumes its assigned package's capacity. Honor every [module,package] pinned assignment, every module's allowed package list, and every separate [a,b] pair (different owners). Empty packages are allowed.
2. Each edge is [caller,callee,kind,weight]. An eager edge across packages becomes an initialization dependency; the directed graph on the three packages formed by ALL cross-package eager edges must be acyclic. Intra-package eager cycles are legal because the existing bootstrap remains atomic there. Lazy edges do not constrain initialization. Neither deleting an edge nor changing eager to lazy is allowed.
3. Every cross-package edge, eager OR lazy, needs one behavior-preserving bridge. bridgeCost is the SUM of weights of these edges, counting parallel edges independently. It must not exceed bridgeBudget. bridges is the ascending array of original edge indices that need bridges.
4. changed counts modules whose owner differs from old. moveCost sums moveCost[module] for precisely those modules. Existing internal code and callers remain unchanged except mechanically retargeting their bridge imports.
5. Minimize the metrics in priority order lexicographically (all are minimized). Only after all listed metrics tie, minimize the full owners vector lexicographically in module order. Do not optimize an unlisted metric before this tie-break.

Module ownership manifest, public API edges, and deployment constraints:
{"modules":["entry","identity","journal","codec","storage","lease","policy","replica"],"size":[3,2,2,1,2,1,2,2],"capacity":[7,7,8],"old":[0,1,2,0,1,2,0,1],"moveCost":[7,3,6,2,5,1,4,7],"edges":[[0,1,"eager",3],[1,0,"eager",3],[1,2,"eager",7],[2,3,"eager",2],[3,4,"eager",5],[4,5,"eager",3],[2,6,"eager",3],[6,7,"eager",5],[7,1,"lazy",8],[5,2,"lazy",2],[0,6,"lazy",4],[6,2,"eager",4]],"pinned":[[0,0],[4,2]],"allowed":[[0,1,2],[0,1],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2]],"separate":[[1,4],[0,7]],"bridgeBudget":49,"priority":["moveCost","bridgeCost"]}

Return ONLY JSON with exactly keys "owners","loads","changed","moveCost","bridgeCost","bridges" in that order. loads is package sizes for packages 0,1,2. This is a globally optimal behavior-preserving partition, not a greedy or merely legal design.`,
    check: {
      kind: 'json_equal',
      value: {
        owners: [0, 0, 2, 2, 2, 2, 2, 1],
        loads: [5, 2, 8],
        changed: 4,
        moveCost: 14,
        bridgeCost: 24,
        bridges: [2, 7, 8, 10],
      },
    },
  },
  {
    id: 'frontier-refactoring-architecture-improvement-quota-transaction-isolation',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Refactor the quota-transaction-isolation multi-package subsystem without changing initialization or any public call. Choose a new owning package (integer 0,1,2) for EACH module. Data indices refer to modules in the supplied order; edges are numbered from zero in their supplied order. All quantities are exact integers.

Authoritative compatibility contract (overrides the old team's advice to minimize imports before checking eager cycles):
1. A module is indivisible. Its size consumes its assigned package's capacity. Honor every [module,package] pinned assignment, every module's allowed package list, and every separate [a,b] pair (different owners). Empty packages are allowed.
2. Each edge is [caller,callee,kind,weight]. An eager edge across packages becomes an initialization dependency; the directed graph on the three packages formed by ALL cross-package eager edges must be acyclic. Intra-package eager cycles are legal because the existing bootstrap remains atomic there. Lazy edges do not constrain initialization. Neither deleting an edge nor changing eager to lazy is allowed.
3. Every cross-package edge, eager OR lazy, needs one behavior-preserving bridge. bridgeCost is the SUM of weights of these edges, counting parallel edges independently. It must not exceed bridgeBudget. bridges is the ascending array of original edge indices that need bridges.
4. changed counts modules whose owner differs from old. moveCost sums moveCost[module] for precisely those modules. Existing internal code and callers remain unchanged except mechanically retargeting their bridge imports.
5. Minimize the metrics in priority order lexicographically (all are minimized). Only after all listed metrics tie, minimize the full owners vector lexicographically in module order. Do not optimize an unlisted metric before this tie-break.

Module ownership manifest, public API edges, and deployment constraints:
{"modules":["entry","identity","journal","codec","storage","lease","policy","replica"],"size":[2,3,2,1,2,1,2,2],"capacity":[8,7,8],"old":[1,2,0,1,2,0,1,2],"moveCost":[1,4,7,3,6,2,5,1],"edges":[[0,1,"eager",4],[1,0,"eager",4],[1,2,"eager",5],[2,3,"eager",3],[3,4,"eager",6],[4,5,"eager",1],[2,6,"eager",4],[6,7,"eager",6],[7,1,"lazy",6],[5,2,"lazy",3],[0,6,"lazy",5],[3,6,"eager",2]],"pinned":[[0,0],[4,2]],"allowed":[[0,1,2],[0,1,2],[1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2]],"separate":[[1,2],[3,5]],"bridgeBudget":53,"priority":["bridgeCost","moveCost"]}

Return ONLY JSON with exactly keys "owners","loads","changed","moveCost","bridgeCost","bridges" in that order. loads is package sizes for packages 0,1,2. This is a globally optimal behavior-preserving partition, not a greedy or merely legal design.`,
    check: {
      kind: 'json_equal',
      value: {
        owners: [0, 0, 1, 1, 2, 2, 1, 1],
        loads: [5, 7, 3],
        changed: 5,
        moveCost: 15,
        bridgeCost: 25,
        bridges: [2, 4, 8, 9, 10],
      },
    },
  },
  {
    id: 'frontier-refactoring-architecture-improvement-search-index-generations',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Refactor the search-index-generations multi-package subsystem without changing initialization or any public call. Choose a new owning package (integer 0,1,2) for EACH module. Data indices refer to modules in the supplied order; edges are numbered from zero in their supplied order. All quantities are exact integers.

Authoritative compatibility contract (overrides the old team's advice to minimize imports before checking eager cycles):
1. A module is indivisible. Its size consumes its assigned package's capacity. Honor every [module,package] pinned assignment, every module's allowed package list, and every separate [a,b] pair (different owners). Empty packages are allowed.
2. Each edge is [caller,callee,kind,weight]. An eager edge across packages becomes an initialization dependency; the directed graph on the three packages formed by ALL cross-package eager edges must be acyclic. Intra-package eager cycles are legal because the existing bootstrap remains atomic there. Lazy edges do not constrain initialization. Neither deleting an edge nor changing eager to lazy is allowed.
3. Every cross-package edge, eager OR lazy, needs one behavior-preserving bridge. bridgeCost is the SUM of weights of these edges, counting parallel edges independently. It must not exceed bridgeBudget. bridges is the ascending array of original edge indices that need bridges.
4. changed counts modules whose owner differs from old. moveCost sums moveCost[module] for precisely those modules. Existing internal code and callers remain unchanged except mechanically retargeting their bridge imports.
5. Minimize the metrics in priority order lexicographically (all are minimized). Only after all listed metrics tie, minimize the full owners vector lexicographically in module order. Do not optimize an unlisted metric before this tie-break.

Module ownership manifest, public API edges, and deployment constraints:
{"modules":["entry","identity","journal","codec","storage","lease","policy","replica"],"size":[2,2,3,1,2,1,2,2],"capacity":[7,7,8],"old":[2,0,1,2,0,1,2,0],"moveCost":[2,5,1,4,7,3,6,2],"edges":[[0,1,"eager",5],[1,0,"eager",2],[1,2,"eager",6],[2,3,"eager",4],[3,4,"eager",4],[4,5,"eager",2],[2,6,"eager",5],[6,7,"eager",4],[7,1,"lazy",7],[5,2,"lazy",4],[0,6,"lazy",3],[7,4,"eager",3]],"pinned":[[0,0],[4,2]],"allowed":[[0,1,2],[0,1,2],[0,1,2],[1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2]],"separate":[[1,4],[0,7]],"bridgeBudget":41,"priority":["changed","moveCost","bridgeCost"]}

Return ONLY JSON with exactly keys "owners","loads","changed","moveCost","bridgeCost","bridges" in that order. loads is package sizes for packages 0,1,2. This is a globally optimal behavior-preserving partition, not a greedy or merely legal design.`,
    check: {
      kind: 'json_equal',
      value: {
        owners: [0, 0, 0, 2, 2, 1, 2, 2],
        loads: [7, 1, 7],
        changed: 4,
        moveCost: 12,
        bridgeCost: 25,
        bridges: [3, 5, 6, 8, 9, 10],
      },
    },
  },
  {
    id: 'frontier-refactoring-architecture-improvement-compiler-symbol-interning',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Refactor the compiler-symbol-interning multi-package subsystem without changing initialization or any public call. Choose a new owning package (integer 0,1,2) for EACH module. Data indices refer to modules in the supplied order; edges are numbered from zero in their supplied order. All quantities are exact integers.

Authoritative compatibility contract (overrides the old team's advice to minimize imports before checking eager cycles):
1. A module is indivisible. Its size consumes its assigned package's capacity. Honor every [module,package] pinned assignment, every module's allowed package list, and every separate [a,b] pair (different owners). Empty packages are allowed.
2. Each edge is [caller,callee,kind,weight]. An eager edge across packages becomes an initialization dependency; the directed graph on the three packages formed by ALL cross-package eager edges must be acyclic. Intra-package eager cycles are legal because the existing bootstrap remains atomic there. Lazy edges do not constrain initialization. Neither deleting an edge nor changing eager to lazy is allowed.
3. Every cross-package edge, eager OR lazy, needs one behavior-preserving bridge. bridgeCost is the SUM of weights of these edges, counting parallel edges independently. It must not exceed bridgeBudget. bridges is the ascending array of original edge indices that need bridges.
4. changed counts modules whose owner differs from old. moveCost sums moveCost[module] for precisely those modules. Existing internal code and callers remain unchanged except mechanically retargeting their bridge imports.
5. Minimize the metrics in priority order lexicographically (all are minimized). Only after all listed metrics tie, minimize the full owners vector lexicographically in module order. Do not optimize an unlisted metric before this tie-break.

Module ownership manifest, public API edges, and deployment constraints:
{"modules":["entry","identity","journal","codec","storage","lease","policy","replica"],"size":[2,2,2,2,2,1,2,2],"capacity":[8,7,8],"old":[0,1,2,0,1,2,0,1],"moveCost":[3,6,2,5,1,4,7,3],"edges":[[0,1,"eager",3],[1,0,"eager",3],[1,2,"eager",7],[2,3,"eager",2],[3,4,"eager",5],[4,5,"eager",3],[2,6,"eager",3],[6,7,"eager",5],[7,1,"lazy",8],[5,2,"lazy",2],[0,6,"lazy",4],[6,2,"eager",4]],"pinned":[[0,0],[4,2]],"allowed":[[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,2],[0,1,2],[0,1,2],[0,1,2]],"separate":[[1,2],[3,5]],"bridgeBudget":45,"priority":["moveCost","bridgeCost"]}

Return ONLY JSON with exactly keys "owners","loads","changed","moveCost","bridgeCost","bridges" in that order. loads is package sizes for packages 0,1,2. This is a globally optimal behavior-preserving partition, not a greedy or merely legal design.`,
    check: {
      kind: 'json_equal',
      value: {
        owners: [0, 0, 2, 2, 2, 1, 2, 1],
        loads: [4, 3, 8],
        changed: 5,
        moveCost: 23,
        bridgeCost: 29,
        bridges: [2, 5, 7, 8, 9, 10],
      },
    },
  },
  {
    id: 'frontier-refactoring-architecture-improvement-payment-webhook-dedup',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Refactor the payment-webhook-dedup multi-package subsystem without changing initialization or any public call. Choose a new owning package (integer 0,1,2) for EACH module. Data indices refer to modules in the supplied order; edges are numbered from zero in their supplied order. All quantities are exact integers.

Authoritative compatibility contract (overrides the old team's advice to minimize imports before checking eager cycles):
1. A module is indivisible. Its size consumes its assigned package's capacity. Honor every [module,package] pinned assignment, every module's allowed package list, and every separate [a,b] pair (different owners). Empty packages are allowed.
2. Each edge is [caller,callee,kind,weight]. An eager edge across packages becomes an initialization dependency; the directed graph on the three packages formed by ALL cross-package eager edges must be acyclic. Intra-package eager cycles are legal because the existing bootstrap remains atomic there. Lazy edges do not constrain initialization. Neither deleting an edge nor changing eager to lazy is allowed.
3. Every cross-package edge, eager OR lazy, needs one behavior-preserving bridge. bridgeCost is the SUM of weights of these edges, counting parallel edges independently. It must not exceed bridgeBudget. bridges is the ascending array of original edge indices that need bridges.
4. changed counts modules whose owner differs from old. moveCost sums moveCost[module] for precisely those modules. Existing internal code and callers remain unchanged except mechanically retargeting their bridge imports.
5. Minimize the metrics in priority order lexicographically (all are minimized). Only after all listed metrics tie, minimize the full owners vector lexicographically in module order. Do not optimize an unlisted metric before this tie-break.

Module ownership manifest, public API edges, and deployment constraints:
{"modules":["entry","identity","journal","codec","storage","lease","policy","replica"],"size":[2,2,2,1,3,1,2,2],"capacity":[7,7,8],"old":[1,2,0,1,2,0,1,2],"moveCost":[4,7,3,6,2,5,1,4],"edges":[[0,1,"eager",4],[1,0,"eager",4],[1,2,"eager",5],[2,3,"eager",3],[3,4,"eager",6],[4,5,"eager",1],[2,6,"eager",4],[6,7,"eager",6],[7,1,"lazy",6],[5,2,"lazy",3],[0,6,"lazy",5],[3,6,"eager",2]],"pinned":[[0,0],[4,2]],"allowed":[[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,2],[0,1,2],[0,1,2]],"separate":[[1,4],[0,7]],"bridgeBudget":49,"priority":["bridgeCost","moveCost"]}

Return ONLY JSON with exactly keys "owners","loads","changed","moveCost","bridgeCost","bridges" in that order. loads is package sizes for packages 0,1,2. This is a globally optimal behavior-preserving partition, not a greedy or merely legal design.`,
    check: {
      kind: 'json_equal',
      value: {
        owners: [0, 0, 2, 2, 2, 2, 1, 1],
        loads: [4, 4, 7],
        changed: 6,
        moveCost: 29,
        bridgeCost: 22,
        bridges: [2, 6, 8, 10, 11],
      },
    },
  },
  {
    id: 'frontier-refactoring-architecture-improvement-telemetry-clock-domains',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Refactor the telemetry-clock-domains multi-package subsystem without changing initialization or any public call. Choose a new owning package (integer 0,1,2) for EACH module. Data indices refer to modules in the supplied order; edges are numbered from zero in their supplied order. All quantities are exact integers.

Authoritative compatibility contract (overrides the old team's advice to minimize imports before checking eager cycles):
1. A module is indivisible. Its size consumes its assigned package's capacity. Honor every [module,package] pinned assignment, every module's allowed package list, and every separate [a,b] pair (different owners). Empty packages are allowed.
2. Each edge is [caller,callee,kind,weight]. An eager edge across packages becomes an initialization dependency; the directed graph on the three packages formed by ALL cross-package eager edges must be acyclic. Intra-package eager cycles are legal because the existing bootstrap remains atomic there. Lazy edges do not constrain initialization. Neither deleting an edge nor changing eager to lazy is allowed.
3. Every cross-package edge, eager OR lazy, needs one behavior-preserving bridge. bridgeCost is the SUM of weights of these edges, counting parallel edges independently. It must not exceed bridgeBudget. bridges is the ascending array of original edge indices that need bridges.
4. changed counts modules whose owner differs from old. moveCost sums moveCost[module] for precisely those modules. Existing internal code and callers remain unchanged except mechanically retargeting their bridge imports.
5. Minimize the metrics in priority order lexicographically (all are minimized). Only after all listed metrics tie, minimize the full owners vector lexicographically in module order. Do not optimize an unlisted metric before this tie-break.

Module ownership manifest, public API edges, and deployment constraints:
{"modules":["entry","identity","journal","codec","storage","lease","policy","replica"],"size":[2,2,2,1,2,2,2,2],"capacity":[8,7,8],"old":[2,0,1,2,0,1,2,0],"moveCost":[5,1,4,7,3,6,2,5],"edges":[[0,1,"eager",5],[1,0,"eager",2],[1,2,"eager",6],[2,3,"eager",4],[3,4,"eager",4],[4,5,"eager",2],[2,6,"eager",5],[6,7,"eager",4],[7,1,"lazy",7],[5,2,"lazy",4],[0,6,"lazy",3],[7,4,"eager",3]],"pinned":[[0,0],[4,2]],"allowed":[[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[1,2],[0,1,2]],"separate":[[1,2],[3,5]],"bridgeBudget":53,"priority":["changed","moveCost","bridgeCost"]}

Return ONLY JSON with exactly keys "owners","loads","changed","moveCost","bridgeCost","bridges" in that order. loads is package sizes for packages 0,1,2. This is a globally optimal behavior-preserving partition, not a greedy or merely legal design.`,
    check: {
      kind: 'json_equal',
      value: {
        owners: [0, 0, 1, 1, 2, 2, 2, 2],
        loads: [4, 3, 8],
        changed: 5,
        moveCost: 26,
        bridgeCost: 29,
        bridges: [2, 4, 6, 8, 9, 10],
      },
    },
  },
  {
    id: 'frontier-refactoring-architecture-improvement-cache-negative-admission',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Refactor the cache-negative-admission multi-package subsystem without changing initialization or any public call. Choose a new owning package (integer 0,1,2) for EACH module. Data indices refer to modules in the supplied order; edges are numbered from zero in their supplied order. All quantities are exact integers.

Authoritative compatibility contract (overrides the old team's advice to minimize imports before checking eager cycles):
1. A module is indivisible. Its size consumes its assigned package's capacity. Honor every [module,package] pinned assignment, every module's allowed package list, and every separate [a,b] pair (different owners). Empty packages are allowed.
2. Each edge is [caller,callee,kind,weight]. An eager edge across packages becomes an initialization dependency; the directed graph on the three packages formed by ALL cross-package eager edges must be acyclic. Intra-package eager cycles are legal because the existing bootstrap remains atomic there. Lazy edges do not constrain initialization. Neither deleting an edge nor changing eager to lazy is allowed.
3. Every cross-package edge, eager OR lazy, needs one behavior-preserving bridge. bridgeCost is the SUM of weights of these edges, counting parallel edges independently. It must not exceed bridgeBudget. bridges is the ascending array of original edge indices that need bridges.
4. changed counts modules whose owner differs from old. moveCost sums moveCost[module] for precisely those modules. Existing internal code and callers remain unchanged except mechanically retargeting their bridge imports.
5. Minimize the metrics in priority order lexicographically (all are minimized). Only after all listed metrics tie, minimize the full owners vector lexicographically in module order. Do not optimize an unlisted metric before this tie-break.

Module ownership manifest, public API edges, and deployment constraints:
{"modules":["entry","identity","journal","codec","storage","lease","policy","replica"],"size":[2,2,2,1,2,1,3,2],"capacity":[7,7,8],"old":[0,1,2,0,1,2,0,1],"moveCost":[6,2,5,1,4,7,3,6],"edges":[[0,1,"eager",3],[1,0,"eager",3],[1,2,"eager",7],[2,3,"eager",2],[3,4,"eager",5],[4,5,"eager",3],[2,6,"eager",3],[6,7,"eager",5],[7,1,"lazy",8],[5,2,"lazy",2],[0,6,"lazy",4],[6,2,"eager",4]],"pinned":[[0,0],[4,2]],"allowed":[[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,2]],"separate":[[1,4],[0,7]],"bridgeBudget":41,"priority":["moveCost","bridgeCost"]}

Return ONLY JSON with exactly keys "owners","loads","changed","moveCost","bridgeCost","bridges" in that order. loads is package sizes for packages 0,1,2. This is a globally optimal behavior-preserving partition, not a greedy or merely legal design.`,
    check: {
      kind: 'json_equal',
      value: {
        owners: [0, 0, 1, 2, 2, 2, 1, 2],
        loads: [4, 5, 6],
        changed: 6,
        moveCost: 21,
        bridgeCost: 28,
        bridges: [2, 3, 7, 8, 9, 10],
      },
    },
  },
  {
    id: 'frontier-refactoring-architecture-improvement-tenant-policy-precedence',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Refactor the tenant-policy-precedence multi-package subsystem without changing initialization or any public call. Choose a new owning package (integer 0,1,2) for EACH module. Data indices refer to modules in the supplied order; edges are numbered from zero in their supplied order. All quantities are exact integers.

Authoritative compatibility contract (overrides the old team's advice to minimize imports before checking eager cycles):
1. A module is indivisible. Its size consumes its assigned package's capacity. Honor every [module,package] pinned assignment, every module's allowed package list, and every separate [a,b] pair (different owners). Empty packages are allowed.
2. Each edge is [caller,callee,kind,weight]. An eager edge across packages becomes an initialization dependency; the directed graph on the three packages formed by ALL cross-package eager edges must be acyclic. Intra-package eager cycles are legal because the existing bootstrap remains atomic there. Lazy edges do not constrain initialization. Neither deleting an edge nor changing eager to lazy is allowed.
3. Every cross-package edge, eager OR lazy, needs one behavior-preserving bridge. bridgeCost is the SUM of weights of these edges, counting parallel edges independently. It must not exceed bridgeBudget. bridges is the ascending array of original edge indices that need bridges.
4. changed counts modules whose owner differs from old. moveCost sums moveCost[module] for precisely those modules. Existing internal code and callers remain unchanged except mechanically retargeting their bridge imports.
5. Minimize the metrics in priority order lexicographically (all are minimized). Only after all listed metrics tie, minimize the full owners vector lexicographically in module order. Do not optimize an unlisted metric before this tie-break.

Module ownership manifest, public API edges, and deployment constraints:
{"modules":["entry","identity","journal","codec","storage","lease","policy","replica"],"size":[2,2,2,1,2,1,2,3],"capacity":[8,7,8],"old":[1,2,0,1,2,0,1,2],"moveCost":[7,3,6,2,5,1,4,7],"edges":[[0,1,"eager",4],[1,0,"eager",4],[1,2,"eager",5],[2,3,"eager",3],[3,4,"eager",6],[4,5,"eager",1],[2,6,"eager",4],[6,7,"eager",6],[7,1,"lazy",6],[5,2,"lazy",3],[0,6,"lazy",5],[3,6,"eager",2]],"pinned":[[0,0],[4,2]],"allowed":[[0,1],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2]],"separate":[[1,2],[3,5]],"bridgeBudget":45,"priority":["bridgeCost","moveCost"]}

Return ONLY JSON with exactly keys "owners","loads","changed","moveCost","bridgeCost","bridges" in that order. loads is package sizes for packages 0,1,2. This is a globally optimal behavior-preserving partition, not a greedy or merely legal design.`,
    check: {
      kind: 'json_equal',
      value: {
        owners: [0, 0, 2, 2, 2, 1, 1, 1],
        loads: [4, 6, 5],
        changed: 6,
        moveCost: 26,
        bridgeCost: 26,
        bridges: [2, 5, 6, 8, 9, 10, 11],
      },
    },
  },
  {
    id: 'frontier-refactoring-architecture-improvement-replica-tombstone-ownership',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Refactor the replica-tombstone-ownership multi-package subsystem without changing initialization or any public call. Choose a new owning package (integer 0,1,2) for EACH module. Data indices refer to modules in the supplied order; edges are numbered from zero in their supplied order. All quantities are exact integers.

Authoritative compatibility contract (overrides the old team's advice to minimize imports before checking eager cycles):
1. A module is indivisible. Its size consumes its assigned package's capacity. Honor every [module,package] pinned assignment, every module's allowed package list, and every separate [a,b] pair (different owners). Empty packages are allowed.
2. Each edge is [caller,callee,kind,weight]. An eager edge across packages becomes an initialization dependency; the directed graph on the three packages formed by ALL cross-package eager edges must be acyclic. Intra-package eager cycles are legal because the existing bootstrap remains atomic there. Lazy edges do not constrain initialization. Neither deleting an edge nor changing eager to lazy is allowed.
3. Every cross-package edge, eager OR lazy, needs one behavior-preserving bridge. bridgeCost is the SUM of weights of these edges, counting parallel edges independently. It must not exceed bridgeBudget. bridges is the ascending array of original edge indices that need bridges.
4. changed counts modules whose owner differs from old. moveCost sums moveCost[module] for precisely those modules. Existing internal code and callers remain unchanged except mechanically retargeting their bridge imports.
5. Minimize the metrics in priority order lexicographically (all are minimized). Only after all listed metrics tie, minimize the full owners vector lexicographically in module order. Do not optimize an unlisted metric before this tie-break.

Module ownership manifest, public API edges, and deployment constraints:
{"modules":["entry","identity","journal","codec","storage","lease","policy","replica"],"size":[3,2,2,1,2,1,2,2],"capacity":[7,7,8],"old":[2,0,1,2,0,1,2,0],"moveCost":[1,4,7,3,6,2,5,1],"edges":[[0,1,"eager",5],[1,0,"eager",2],[1,2,"eager",6],[2,3,"eager",4],[3,4,"eager",4],[4,5,"eager",2],[2,6,"eager",5],[6,7,"eager",4],[7,1,"lazy",7],[5,2,"lazy",4],[0,6,"lazy",3],[7,4,"eager",3]],"pinned":[[0,0],[4,2]],"allowed":[[0,1,2],[0,1],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2],[0,1,2]],"separate":[[1,4],[0,7]],"bridgeBudget":49,"priority":["changed","moveCost","bridgeCost"]}

Return ONLY JSON with exactly keys "owners","loads","changed","moveCost","bridgeCost","bridges" in that order. loads is package sizes for packages 0,1,2. This is a globally optimal behavior-preserving partition, not a greedy or merely legal design.`,
    check: {
      kind: 'json_equal',
      value: {
        owners: [0, 0, 1, 2, 2, 2, 2, 2],
        loads: [5, 2, 8],
        changed: 4,
        moveCost: 10,
        bridgeCost: 29,
        bridges: [2, 3, 6, 8, 9, 10],
      },
    },
  },
  {
    id: 'frontier-refactoring-migration-ledger-dual-write-conflicts',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Plan the ledger-dual-write-conflicts cutover across reader.js, writer.js, cache.js, replay.js, fence.js, export.js and retire.js. Two independent requirements MUST both be met: reconcile the supplied conflicting legacy records and optimize the atomic deployment phases.

Specification priority: the compliance fence invariant below is absolute; the current authority manifest below overrides the older replay runbook. The old runbook says "largest wall clock wins; deploy writers first". It is explicitly obsolete, even when that would save work.

Reconciliation rules:
* Process keys in keys order. Discard quarantined records and records with generation below fence[keyIndex]. A fence applies to the entire input snapshot, regardless of event arrival order. The array is intentionally not chronological.
* Among eligible records for a key: greatest generation wins FIRST; then the source appearing EARLIEST in authority[keyIndex] wins; then greatest revision; then deleted=true wins; then lexicographically smallest id. Clock and array position are NEVER tie-breakers. A newer low-authority generation therefore beats any older generation; within one generation an authoritative old revision beats a newer revision from a lower-authority source.
* A deletion remains a winner (no resurrection/fallback). Its exported value is null. A put exports its given value. Exactly one eligible winner exists for each key. discarded contains ALL IDs other than those four winners, including quarantined and fenced records, sorted lexicographically.

Deployment rules:
* Each job appears exactly once, assigned an integer phase >=1. Phases start at 1 with no gaps. All jobs in one phase upgrade simultaneously in one atomic transaction, so no within-phase mixed-version state is observable. Phases execute sequentially.
* [a,b,false] in precedence means phase[a] <= phase[b]; [a,b,true] means phase[a] < phase[b]. Non-strict cycles require an atomic co-deploy; they are not errors and must not be broken. All pair indices are job indices.
* exclusive pairs cannot share a phase. notBefore [job,p] requires phase[job]>=p. Total effort of one phase must not exceed capacity. A phase lasts the maximum duration of its jobs. downtime is the sum of these phase durations.
* Optimize number of phases first, then downtime, then the entire phase vector lexicographically in jobs order, all minimized. This priority is normative; shortest downtime alone is wrong.

Legacy events, authority manifest, and rolling-compatibility constraints:
{"keys":["account","lease","policy","token"],"sources":["ledger","snapshot","cdc"],"events":[{"id":"e23","key":"token","source":"snapshot","generation":1,"revision":7,"deleted":false,"quarantined":false,"value":"v23","clock":1000},{"id":"e22","key":"policy","source":"ledger","generation":1,"revision":0,"deleted":false,"quarantined":false,"value":"v22","clock":1017},{"id":"e21","key":"lease","source":"cdc","generation":1,"revision":4,"deleted":false,"quarantined":false,"value":"v21","clock":1034},{"id":"e20","key":"account","source":"snapshot","generation":1,"revision":8,"deleted":true,"quarantined":false,"value":"v20","clock":1051},{"id":"e19","key":"token","source":"cdc","generation":2,"revision":1,"deleted":false,"quarantined":false,"value":"v19","clock":1068},{"id":"e18","key":"policy","source":"snapshot","generation":2,"revision":5,"deleted":false,"quarantined":false,"value":"v18","clock":1085},{"id":"e17","key":"lease","source":"ledger","generation":2,"revision":9,"deleted":false,"quarantined":false,"value":"v17","clock":1001},{"id":"e16","key":"account","source":"cdc","generation":2,"revision":2,"deleted":false,"quarantined":false,"value":"v16","clock":1018},{"id":"e15","key":"token","source":"ledger","generation":0,"revision":6,"deleted":true,"quarantined":false,"value":"v15","clock":1035},{"id":"e14","key":"policy","source":"cdc","generation":0,"revision":10,"deleted":false,"quarantined":false,"value":"v14","clock":1052},{"id":"e13","key":"lease","source":"snapshot","generation":0,"revision":3,"deleted":false,"quarantined":true,"value":"v13","clock":1069},{"id":"e12","key":"account","source":"ledger","generation":0,"revision":7,"deleted":false,"quarantined":false,"value":"v12","clock":1086},{"id":"e11","key":"token","source":"snapshot","generation":1,"revision":0,"deleted":false,"quarantined":false,"value":"v11","clock":1002},{"id":"e10","key":"policy","source":"ledger","generation":1,"revision":4,"deleted":true,"quarantined":false,"value":"v10","clock":1019},{"id":"e09","key":"lease","source":"cdc","generation":1,"revision":8,"deleted":false,"quarantined":false,"value":"v9","clock":1036},{"id":"e08","key":"account","source":"snapshot","generation":1,"revision":1,"deleted":false,"quarantined":false,"value":"v8","clock":1053},{"id":"e07","key":"token","source":"cdc","generation":2,"revision":5,"deleted":false,"quarantined":false,"value":"v7","clock":1070},{"id":"e06","key":"policy","source":"snapshot","generation":2,"revision":9,"deleted":false,"quarantined":false,"value":"v6","clock":1087},{"id":"e05","key":"lease","source":"ledger","generation":2,"revision":2,"deleted":true,"quarantined":false,"value":"v5","clock":1003},{"id":"e04","key":"account","source":"cdc","generation":2,"revision":6,"deleted":false,"quarantined":false,"value":"v4","clock":1020},{"id":"e03","key":"token","source":"ledger","generation":0,"revision":10,"deleted":false,"quarantined":false,"value":"v3","clock":1037},{"id":"e02","key":"policy","source":"cdc","generation":0,"revision":3,"deleted":false,"quarantined":false,"value":"v2","clock":1054},{"id":"e01","key":"lease","source":"snapshot","generation":0,"revision":7,"deleted":false,"quarantined":false,"value":"v1","clock":1071},{"id":"e00","key":"account","source":"ledger","generation":0,"revision":0,"deleted":true,"quarantined":true,"value":"v0","clock":1088}],"fence":[0,1,0,1],"authority":[["ledger","snapshot","cdc"],["snapshot","cdc","ledger"],["cdc","ledger","snapshot"],["ledger","snapshot","cdc"]],"jobs":["reader","writer","cache","replay","fence","export","retire"],"capacity":5,"effort":[2,2,1,2,1,2,1],"duration":[1,3,1,3,1,3,1],"precedence":[[0,1,false],[1,0,false],[2,1,false],[3,4,true],[4,6,true],[5,6,false]],"exclusive":[[1,5],[2,4]],"notBefore":[[5,2]]}

Reply ONLY with one JSON object, exactly keys "winners","discarded","phase","duration","downtime" in that order. winners is in keys order; each object has exactly keys "key","winner","deleted","value" in that order, where winner is its event ID. phase is in jobs order; duration is in phase order.`,
    check: {
      kind: 'json_equal',
      value: {
        winners: [
          {
            key: 'account',
            winner: 'e04',
            deleted: false,
            value: 'v4',
          },
          {
            key: 'lease',
            winner: 'e17',
            deleted: false,
            value: 'v17',
          },
          {
            key: 'policy',
            winner: 'e06',
            deleted: false,
            value: 'v6',
          },
          {
            key: 'token',
            winner: 'e07',
            deleted: false,
            value: 'v7',
          },
        ],
        discarded: [
          'e00',
          'e01',
          'e02',
          'e03',
          'e05',
          'e08',
          'e09',
          'e10',
          'e11',
          'e12',
          'e13',
          'e14',
          'e15',
          'e16',
          'e18',
          'e19',
          'e20',
          'e21',
          'e22',
          'e23',
        ],
        phase: [2, 2, 1, 1, 2, 3, 3],
        duration: [3, 3, 3],
        downtime: 9,
      },
    },
  },
  {
    id: 'frontier-refactoring-migration-cdc-tombstone-watermarks',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Plan the cdc-tombstone-watermarks cutover across reader.js, writer.js, cache.js, replay.js, fence.js, export.js and retire.js. Two independent requirements MUST both be met: reconcile the supplied conflicting legacy records and optimize the atomic deployment phases.

Specification priority: the compliance fence invariant below is absolute; the current authority manifest below overrides the older replay runbook. The old runbook says "largest wall clock wins; deploy writers first". It is explicitly obsolete, even when that would save work.

Reconciliation rules:
* Process keys in keys order. Discard quarantined records and records with generation below fence[keyIndex]. A fence applies to the entire input snapshot, regardless of event arrival order. The array is intentionally not chronological.
* Among eligible records for a key: greatest generation wins FIRST; then the source appearing EARLIEST in authority[keyIndex] wins; then greatest revision; then deleted=true wins; then lexicographically smallest id. Clock and array position are NEVER tie-breakers. A newer low-authority generation therefore beats any older generation; within one generation an authoritative old revision beats a newer revision from a lower-authority source.
* A deletion remains a winner (no resurrection/fallback). Its exported value is null. A put exports its given value. Exactly one eligible winner exists for each key. discarded contains ALL IDs other than those four winners, including quarantined and fenced records, sorted lexicographically.

Deployment rules:
* Each job appears exactly once, assigned an integer phase >=1. Phases start at 1 with no gaps. All jobs in one phase upgrade simultaneously in one atomic transaction, so no within-phase mixed-version state is observable. Phases execute sequentially.
* [a,b,false] in precedence means phase[a] <= phase[b]; [a,b,true] means phase[a] < phase[b]. Non-strict cycles require an atomic co-deploy; they are not errors and must not be broken. All pair indices are job indices.
* exclusive pairs cannot share a phase. notBefore [job,p] requires phase[job]>=p. Total effort of one phase must not exceed capacity. A phase lasts the maximum duration of its jobs. downtime is the sum of these phase durations.
* Optimize number of phases first, then downtime, then the entire phase vector lexicographically in jobs order, all minimized. This priority is normative; shortest downtime alone is wrong.

Legacy events, authority manifest, and rolling-compatibility constraints:
{"keys":["account","lease","policy","token"],"sources":["ledger","snapshot","cdc"],"events":[{"id":"e23","key":"token","source":"cdc","generation":2,"revision":10,"deleted":false,"quarantined":false,"value":"v23","clock":1001},{"id":"e22","key":"policy","source":"snapshot","generation":2,"revision":3,"deleted":false,"quarantined":false,"value":"v22","clock":1018},{"id":"e21","key":"lease","source":"ledger","generation":2,"revision":7,"deleted":false,"quarantined":false,"value":"v21","clock":1035},{"id":"e20","key":"account","source":"cdc","generation":2,"revision":0,"deleted":false,"quarantined":false,"value":"v20","clock":1052},{"id":"e19","key":"token","source":"ledger","generation":0,"revision":4,"deleted":true,"quarantined":false,"value":"v19","clock":1069},{"id":"e18","key":"policy","source":"cdc","generation":0,"revision":8,"deleted":false,"quarantined":false,"value":"v18","clock":1086},{"id":"e17","key":"lease","source":"snapshot","generation":0,"revision":1,"deleted":false,"quarantined":false,"value":"v17","clock":1002},{"id":"e16","key":"account","source":"ledger","generation":0,"revision":5,"deleted":false,"quarantined":false,"value":"v16","clock":1019},{"id":"e15","key":"token","source":"snapshot","generation":1,"revision":9,"deleted":false,"quarantined":false,"value":"v15","clock":1036},{"id":"e14","key":"policy","source":"ledger","generation":1,"revision":2,"deleted":true,"quarantined":false,"value":"v14","clock":1053},{"id":"e13","key":"lease","source":"cdc","generation":1,"revision":6,"deleted":false,"quarantined":false,"value":"v13","clock":1070},{"id":"e12","key":"account","source":"snapshot","generation":1,"revision":10,"deleted":false,"quarantined":false,"value":"v12","clock":1087},{"id":"e11","key":"token","source":"cdc","generation":2,"revision":3,"deleted":false,"quarantined":true,"value":"v11","clock":1003},{"id":"e10","key":"policy","source":"snapshot","generation":2,"revision":7,"deleted":false,"quarantined":false,"value":"v10","clock":1020},{"id":"e09","key":"lease","source":"ledger","generation":2,"revision":0,"deleted":true,"quarantined":false,"value":"v9","clock":1037},{"id":"e08","key":"account","source":"cdc","generation":2,"revision":4,"deleted":false,"quarantined":false,"value":"v8","clock":1054},{"id":"e07","key":"token","source":"ledger","generation":0,"revision":8,"deleted":false,"quarantined":false,"value":"v7","clock":1071},{"id":"e06","key":"policy","source":"cdc","generation":0,"revision":1,"deleted":false,"quarantined":false,"value":"v6","clock":1088},{"id":"e05","key":"lease","source":"snapshot","generation":0,"revision":5,"deleted":false,"quarantined":false,"value":"v5","clock":1004},{"id":"e04","key":"account","source":"ledger","generation":0,"revision":9,"deleted":true,"quarantined":false,"value":"v4","clock":1021},{"id":"e03","key":"token","source":"snapshot","generation":1,"revision":2,"deleted":false,"quarantined":false,"value":"v3","clock":1038},{"id":"e02","key":"policy","source":"ledger","generation":1,"revision":6,"deleted":false,"quarantined":false,"value":"v2","clock":1055},{"id":"e01","key":"lease","source":"cdc","generation":1,"revision":10,"deleted":false,"quarantined":false,"value":"v1","clock":1072},{"id":"e00","key":"account","source":"snapshot","generation":1,"revision":3,"deleted":false,"quarantined":false,"value":"v0","clock":1089}],"fence":[1,0,1,0],"authority":[["snapshot","cdc","ledger"],["cdc","ledger","snapshot"],["ledger","snapshot","cdc"],["snapshot","cdc","ledger"]],"jobs":["reader","writer","cache","replay","fence","export","retire"],"capacity":6,"effort":[2,2,1,2,1,2,1],"duration":[2,4,2,4,2,4,2],"precedence":[[0,1,true],[2,1,false],[1,4,false],[4,1,false],[3,5,true],[4,6,true],[5,6,false]],"exclusive":[[2,3],[0,5]],"notBefore":[]}

Reply ONLY with one JSON object, exactly keys "winners","discarded","phase","duration","downtime" in that order. winners is in keys order; each object has exactly keys "key","winner","deleted","value" in that order, where winner is its event ID. phase is in jobs order; duration is in phase order.`,
    check: {
      kind: 'json_equal',
      value: {
        winners: [
          {
            key: 'account',
            winner: 'e08',
            deleted: false,
            value: 'v8',
          },
          {
            key: 'lease',
            winner: 'e21',
            deleted: false,
            value: 'v21',
          },
          {
            key: 'policy',
            winner: 'e10',
            deleted: false,
            value: 'v10',
          },
          {
            key: 'token',
            winner: 'e23',
            deleted: false,
            value: 'v23',
          },
        ],
        discarded: [
          'e00',
          'e01',
          'e02',
          'e03',
          'e04',
          'e05',
          'e06',
          'e07',
          'e09',
          'e11',
          'e12',
          'e13',
          'e14',
          'e15',
          'e16',
          'e17',
          'e18',
          'e19',
          'e20',
          'e22',
        ],
        phase: [1, 2, 1, 2, 2, 3, 3],
        duration: [2, 4, 4],
        downtime: 10,
      },
    },
  },
  {
    id: 'frontier-refactoring-migration-cache-schema-epoch-cutover',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Plan the cache-schema-epoch-cutover cutover across reader.js, writer.js, cache.js, replay.js, fence.js, export.js and retire.js. Two independent requirements MUST both be met: reconcile the supplied conflicting legacy records and optimize the atomic deployment phases.

Specification priority: the compliance fence invariant below is absolute; the current authority manifest below overrides the older replay runbook. The old runbook says "largest wall clock wins; deploy writers first". It is explicitly obsolete, even when that would save work.

Reconciliation rules:
* Process keys in keys order. Discard quarantined records and records with generation below fence[keyIndex]. A fence applies to the entire input snapshot, regardless of event arrival order. The array is intentionally not chronological.
* Among eligible records for a key: greatest generation wins FIRST; then the source appearing EARLIEST in authority[keyIndex] wins; then greatest revision; then deleted=true wins; then lexicographically smallest id. Clock and array position are NEVER tie-breakers. A newer low-authority generation therefore beats any older generation; within one generation an authoritative old revision beats a newer revision from a lower-authority source.
* A deletion remains a winner (no resurrection/fallback). Its exported value is null. A put exports its given value. Exactly one eligible winner exists for each key. discarded contains ALL IDs other than those four winners, including quarantined and fenced records, sorted lexicographically.

Deployment rules:
* Each job appears exactly once, assigned an integer phase >=1. Phases start at 1 with no gaps. All jobs in one phase upgrade simultaneously in one atomic transaction, so no within-phase mixed-version state is observable. Phases execute sequentially.
* [a,b,false] in precedence means phase[a] <= phase[b]; [a,b,true] means phase[a] < phase[b]. Non-strict cycles require an atomic co-deploy; they are not errors and must not be broken. All pair indices are job indices.
* exclusive pairs cannot share a phase. notBefore [job,p] requires phase[job]>=p. Total effort of one phase must not exceed capacity. A phase lasts the maximum duration of its jobs. downtime is the sum of these phase durations.
* Optimize number of phases first, then downtime, then the entire phase vector lexicographically in jobs order, all minimized. This priority is normative; shortest downtime alone is wrong.

Legacy events, authority manifest, and rolling-compatibility constraints:
{"keys":["account","lease","policy","token"],"sources":["ledger","snapshot","cdc"],"events":[{"id":"e23","key":"token","source":"ledger","generation":0,"revision":2,"deleted":true,"quarantined":false,"value":"v23","clock":1002},{"id":"e22","key":"policy","source":"cdc","generation":0,"revision":6,"deleted":false,"quarantined":true,"value":"v22","clock":1019},{"id":"e21","key":"lease","source":"snapshot","generation":0,"revision":10,"deleted":false,"quarantined":false,"value":"v21","clock":1036},{"id":"e20","key":"account","source":"ledger","generation":0,"revision":3,"deleted":false,"quarantined":false,"value":"v20","clock":1053},{"id":"e19","key":"token","source":"snapshot","generation":1,"revision":7,"deleted":false,"quarantined":false,"value":"v19","clock":1070},{"id":"e18","key":"policy","source":"ledger","generation":1,"revision":0,"deleted":true,"quarantined":false,"value":"v18","clock":1087},{"id":"e17","key":"lease","source":"cdc","generation":1,"revision":4,"deleted":false,"quarantined":false,"value":"v17","clock":1003},{"id":"e16","key":"account","source":"snapshot","generation":1,"revision":8,"deleted":false,"quarantined":false,"value":"v16","clock":1020},{"id":"e15","key":"token","source":"cdc","generation":2,"revision":1,"deleted":false,"quarantined":false,"value":"v15","clock":1037},{"id":"e14","key":"policy","source":"snapshot","generation":2,"revision":5,"deleted":false,"quarantined":false,"value":"v14","clock":1054},{"id":"e13","key":"lease","source":"ledger","generation":2,"revision":9,"deleted":true,"quarantined":false,"value":"v13","clock":1071},{"id":"e12","key":"account","source":"cdc","generation":2,"revision":2,"deleted":false,"quarantined":false,"value":"v12","clock":1088},{"id":"e11","key":"token","source":"ledger","generation":0,"revision":6,"deleted":false,"quarantined":false,"value":"v11","clock":1004},{"id":"e10","key":"policy","source":"cdc","generation":0,"revision":10,"deleted":false,"quarantined":false,"value":"v10","clock":1021},{"id":"e09","key":"lease","source":"snapshot","generation":0,"revision":3,"deleted":false,"quarantined":true,"value":"v9","clock":1038},{"id":"e08","key":"account","source":"ledger","generation":0,"revision":7,"deleted":true,"quarantined":false,"value":"v8","clock":1055},{"id":"e07","key":"token","source":"snapshot","generation":1,"revision":0,"deleted":false,"quarantined":false,"value":"v7","clock":1072},{"id":"e06","key":"policy","source":"ledger","generation":1,"revision":4,"deleted":false,"quarantined":false,"value":"v6","clock":1089},{"id":"e05","key":"lease","source":"cdc","generation":1,"revision":8,"deleted":false,"quarantined":false,"value":"v5","clock":1005},{"id":"e04","key":"account","source":"snapshot","generation":1,"revision":1,"deleted":false,"quarantined":false,"value":"v4","clock":1022},{"id":"e03","key":"token","source":"cdc","generation":2,"revision":5,"deleted":true,"quarantined":false,"value":"v3","clock":1039},{"id":"e02","key":"policy","source":"snapshot","generation":2,"revision":9,"deleted":false,"quarantined":false,"value":"v2","clock":1056},{"id":"e01","key":"lease","source":"ledger","generation":2,"revision":2,"deleted":false,"quarantined":false,"value":"v1","clock":1073},{"id":"e00","key":"account","source":"cdc","generation":2,"revision":6,"deleted":false,"quarantined":false,"value":"v0","clock":1090}],"fence":[0,1,0,1],"authority":[["cdc","ledger","snapshot"],["ledger","snapshot","cdc"],["snapshot","cdc","ledger"],["cdc","ledger","snapshot"]],"jobs":["reader","writer","cache","replay","fence","export","retire"],"capacity":5,"effort":[2,2,1,2,1,2,1],"duration":[3,1,3,1,3,1,3],"precedence":[[0,2,false],[2,0,false],[0,1,true],[3,4,false],[4,3,false],[4,6,true],[5,6,true]],"exclusive":[[1,5],[2,4]],"notBefore":[]}

Reply ONLY with one JSON object, exactly keys "winners","discarded","phase","duration","downtime" in that order. winners is in keys order; each object has exactly keys "key","winner","deleted","value" in that order, where winner is its event ID. phase is in jobs order; duration is in phase order.`,
    check: {
      kind: 'json_equal',
      value: {
        winners: [
          {
            key: 'account',
            winner: 'e00',
            deleted: false,
            value: 'v0',
          },
          {
            key: 'lease',
            winner: 'e13',
            deleted: true,
            value: null,
          },
          {
            key: 'policy',
            winner: 'e02',
            deleted: false,
            value: 'v2',
          },
          {
            key: 'token',
            winner: 'e03',
            deleted: true,
            value: null,
          },
        ],
        discarded: [
          'e01',
          'e04',
          'e05',
          'e06',
          'e07',
          'e08',
          'e09',
          'e10',
          'e11',
          'e12',
          'e14',
          'e15',
          'e16',
          'e17',
          'e18',
          'e19',
          'e20',
          'e21',
          'e22',
          'e23',
        ],
        phase: [2, 3, 2, 1, 1, 1, 2],
        duration: [3, 3, 1],
        downtime: 7,
      },
    },
  },
  {
    id: 'frontier-refactoring-migration-tenant-policy-source-authority',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Plan the tenant-policy-source-authority cutover across reader.js, writer.js, cache.js, replay.js, fence.js, export.js and retire.js. Two independent requirements MUST both be met: reconcile the supplied conflicting legacy records and optimize the atomic deployment phases.

Specification priority: the compliance fence invariant below is absolute; the current authority manifest below overrides the older replay runbook. The old runbook says "largest wall clock wins; deploy writers first". It is explicitly obsolete, even when that would save work.

Reconciliation rules:
* Process keys in keys order. Discard quarantined records and records with generation below fence[keyIndex]. A fence applies to the entire input snapshot, regardless of event arrival order. The array is intentionally not chronological.
* Among eligible records for a key: greatest generation wins FIRST; then the source appearing EARLIEST in authority[keyIndex] wins; then greatest revision; then deleted=true wins; then lexicographically smallest id. Clock and array position are NEVER tie-breakers. A newer low-authority generation therefore beats any older generation; within one generation an authoritative old revision beats a newer revision from a lower-authority source.
* A deletion remains a winner (no resurrection/fallback). Its exported value is null. A put exports its given value. Exactly one eligible winner exists for each key. discarded contains ALL IDs other than those four winners, including quarantined and fenced records, sorted lexicographically.

Deployment rules:
* Each job appears exactly once, assigned an integer phase >=1. Phases start at 1 with no gaps. All jobs in one phase upgrade simultaneously in one atomic transaction, so no within-phase mixed-version state is observable. Phases execute sequentially.
* [a,b,false] in precedence means phase[a] <= phase[b]; [a,b,true] means phase[a] < phase[b]. Non-strict cycles require an atomic co-deploy; they are not errors and must not be broken. All pair indices are job indices.
* exclusive pairs cannot share a phase. notBefore [job,p] requires phase[job]>=p. Total effort of one phase must not exceed capacity. A phase lasts the maximum duration of its jobs. downtime is the sum of these phase durations.
* Optimize number of phases first, then downtime, then the entire phase vector lexicographically in jobs order, all minimized. This priority is normative; shortest downtime alone is wrong.

Legacy events, authority manifest, and rolling-compatibility constraints:
{"keys":["account","lease","policy","token"],"sources":["ledger","snapshot","cdc"],"events":[{"id":"e23","key":"token","source":"snapshot","generation":1,"revision":5,"deleted":false,"quarantined":false,"value":"v23","clock":1003},{"id":"e22","key":"policy","source":"ledger","generation":1,"revision":9,"deleted":true,"quarantined":false,"value":"v22","clock":1020},{"id":"e21","key":"lease","source":"cdc","generation":1,"revision":2,"deleted":false,"quarantined":false,"value":"v21","clock":1037},{"id":"e20","key":"account","source":"snapshot","generation":1,"revision":6,"deleted":false,"quarantined":true,"value":"v20","clock":1054},{"id":"e19","key":"token","source":"cdc","generation":2,"revision":10,"deleted":false,"quarantined":false,"value":"v19","clock":1071},{"id":"e18","key":"policy","source":"snapshot","generation":2,"revision":3,"deleted":false,"quarantined":false,"value":"v18","clock":1088},{"id":"e17","key":"lease","source":"ledger","generation":2,"revision":7,"deleted":true,"quarantined":false,"value":"v17","clock":1004},{"id":"e16","key":"account","source":"cdc","generation":2,"revision":0,"deleted":false,"quarantined":false,"value":"v16","clock":1021},{"id":"e15","key":"token","source":"ledger","generation":0,"revision":4,"deleted":false,"quarantined":false,"value":"v15","clock":1038},{"id":"e14","key":"policy","source":"cdc","generation":0,"revision":8,"deleted":false,"quarantined":false,"value":"v14","clock":1055},{"id":"e13","key":"lease","source":"snapshot","generation":0,"revision":1,"deleted":false,"quarantined":false,"value":"v13","clock":1072},{"id":"e12","key":"account","source":"ledger","generation":0,"revision":5,"deleted":true,"quarantined":false,"value":"v12","clock":1089},{"id":"e11","key":"token","source":"snapshot","generation":1,"revision":9,"deleted":false,"quarantined":false,"value":"v11","clock":1005},{"id":"e10","key":"policy","source":"ledger","generation":1,"revision":2,"deleted":false,"quarantined":false,"value":"v10","clock":1022},{"id":"e09","key":"lease","source":"cdc","generation":1,"revision":6,"deleted":false,"quarantined":false,"value":"v9","clock":1039},{"id":"e08","key":"account","source":"snapshot","generation":1,"revision":10,"deleted":false,"quarantined":false,"value":"v8","clock":1056},{"id":"e07","key":"token","source":"cdc","generation":2,"revision":3,"deleted":true,"quarantined":true,"value":"v7","clock":1073},{"id":"e06","key":"policy","source":"snapshot","generation":2,"revision":7,"deleted":false,"quarantined":false,"value":"v6","clock":1090},{"id":"e05","key":"lease","source":"ledger","generation":2,"revision":0,"deleted":false,"quarantined":false,"value":"v5","clock":1006},{"id":"e04","key":"account","source":"cdc","generation":2,"revision":4,"deleted":false,"quarantined":false,"value":"v4","clock":1023},{"id":"e03","key":"token","source":"ledger","generation":0,"revision":8,"deleted":false,"quarantined":false,"value":"v3","clock":1040},{"id":"e02","key":"policy","source":"cdc","generation":0,"revision":1,"deleted":true,"quarantined":false,"value":"v2","clock":1057},{"id":"e01","key":"lease","source":"snapshot","generation":0,"revision":5,"deleted":false,"quarantined":false,"value":"v1","clock":1074},{"id":"e00","key":"account","source":"ledger","generation":0,"revision":9,"deleted":false,"quarantined":false,"value":"v0","clock":1091}],"fence":[1,0,1,0],"authority":[["ledger","snapshot","cdc"],["snapshot","cdc","ledger"],["cdc","ledger","snapshot"],["ledger","snapshot","cdc"]],"jobs":["reader","writer","cache","replay","fence","export","retire"],"capacity":6,"effort":[2,2,1,2,1,2,1],"duration":[4,2,4,2,4,2,4],"precedence":[[0,1,false],[1,0,false],[2,1,false],[3,4,true],[4,6,true],[5,6,false]],"exclusive":[[2,3],[0,5]],"notBefore":[]}

Reply ONLY with one JSON object, exactly keys "winners","discarded","phase","duration","downtime" in that order. winners is in keys order; each object has exactly keys "key","winner","deleted","value" in that order, where winner is its event ID. phase is in jobs order; duration is in phase order.`,
    check: {
      kind: 'json_equal',
      value: {
        winners: [
          {
            key: 'account',
            winner: 'e04',
            deleted: false,
            value: 'v4',
          },
          {
            key: 'lease',
            winner: 'e17',
            deleted: true,
            value: null,
          },
          {
            key: 'policy',
            winner: 'e06',
            deleted: false,
            value: 'v6',
          },
          {
            key: 'token',
            winner: 'e19',
            deleted: false,
            value: 'v19',
          },
        ],
        discarded: [
          'e00',
          'e01',
          'e02',
          'e03',
          'e05',
          'e07',
          'e08',
          'e09',
          'e10',
          'e11',
          'e12',
          'e13',
          'e14',
          'e15',
          'e16',
          'e18',
          'e20',
          'e21',
          'e22',
          'e23',
        ],
        phase: [2, 2, 2, 1, 2, 1, 3],
        duration: [2, 4, 4],
        downtime: 10,
      },
    },
  },
  {
    id: 'frontier-refactoring-migration-webhook-dedup-schema-change',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Plan the webhook-dedup-schema-change cutover across reader.js, writer.js, cache.js, replay.js, fence.js, export.js and retire.js. Two independent requirements MUST both be met: reconcile the supplied conflicting legacy records and optimize the atomic deployment phases.

Specification priority: the compliance fence invariant below is absolute; the current authority manifest below overrides the older replay runbook. The old runbook says "largest wall clock wins; deploy writers first". It is explicitly obsolete, even when that would save work.

Reconciliation rules:
* Process keys in keys order. Discard quarantined records and records with generation below fence[keyIndex]. A fence applies to the entire input snapshot, regardless of event arrival order. The array is intentionally not chronological.
* Among eligible records for a key: greatest generation wins FIRST; then the source appearing EARLIEST in authority[keyIndex] wins; then greatest revision; then deleted=true wins; then lexicographically smallest id. Clock and array position are NEVER tie-breakers. A newer low-authority generation therefore beats any older generation; within one generation an authoritative old revision beats a newer revision from a lower-authority source.
* A deletion remains a winner (no resurrection/fallback). Its exported value is null. A put exports its given value. Exactly one eligible winner exists for each key. discarded contains ALL IDs other than those four winners, including quarantined and fenced records, sorted lexicographically.

Deployment rules:
* Each job appears exactly once, assigned an integer phase >=1. Phases start at 1 with no gaps. All jobs in one phase upgrade simultaneously in one atomic transaction, so no within-phase mixed-version state is observable. Phases execute sequentially.
* [a,b,false] in precedence means phase[a] <= phase[b]; [a,b,true] means phase[a] < phase[b]. Non-strict cycles require an atomic co-deploy; they are not errors and must not be broken. All pair indices are job indices.
* exclusive pairs cannot share a phase. notBefore [job,p] requires phase[job]>=p. Total effort of one phase must not exceed capacity. A phase lasts the maximum duration of its jobs. downtime is the sum of these phase durations.
* Optimize number of phases first, then downtime, then the entire phase vector lexicographically in jobs order, all minimized. This priority is normative; shortest downtime alone is wrong.

Legacy events, authority manifest, and rolling-compatibility constraints:
{"keys":["account","lease","policy","token"],"sources":["ledger","snapshot","cdc"],"events":[{"id":"e23","key":"token","source":"cdc","generation":2,"revision":8,"deleted":false,"quarantined":false,"value":"v23","clock":1004},{"id":"e22","key":"policy","source":"snapshot","generation":2,"revision":1,"deleted":false,"quarantined":false,"value":"v22","clock":1021},{"id":"e21","key":"lease","source":"ledger","generation":2,"revision":5,"deleted":true,"quarantined":false,"value":"v21","clock":1038},{"id":"e20","key":"account","source":"cdc","generation":2,"revision":9,"deleted":false,"quarantined":false,"value":"v20","clock":1055},{"id":"e19","key":"token","source":"ledger","generation":0,"revision":2,"deleted":false,"quarantined":false,"value":"v19","clock":1072},{"id":"e18","key":"policy","source":"cdc","generation":0,"revision":6,"deleted":false,"quarantined":true,"value":"v18","clock":1089},{"id":"e17","key":"lease","source":"snapshot","generation":0,"revision":10,"deleted":false,"quarantined":false,"value":"v17","clock":1005},{"id":"e16","key":"account","source":"ledger","generation":0,"revision":3,"deleted":true,"quarantined":false,"value":"v16","clock":1022},{"id":"e15","key":"token","source":"snapshot","generation":1,"revision":7,"deleted":false,"quarantined":false,"value":"v15","clock":1039},{"id":"e14","key":"policy","source":"ledger","generation":1,"revision":0,"deleted":false,"quarantined":false,"value":"v14","clock":1056},{"id":"e13","key":"lease","source":"cdc","generation":1,"revision":4,"deleted":false,"quarantined":false,"value":"v13","clock":1073},{"id":"e12","key":"account","source":"snapshot","generation":1,"revision":8,"deleted":false,"quarantined":false,"value":"v12","clock":1090},{"id":"e11","key":"token","source":"cdc","generation":2,"revision":1,"deleted":true,"quarantined":false,"value":"v11","clock":1006},{"id":"e10","key":"policy","source":"snapshot","generation":2,"revision":5,"deleted":false,"quarantined":false,"value":"v10","clock":1023},{"id":"e09","key":"lease","source":"ledger","generation":2,"revision":9,"deleted":false,"quarantined":false,"value":"v9","clock":1040},{"id":"e08","key":"account","source":"cdc","generation":2,"revision":2,"deleted":false,"quarantined":false,"value":"v8","clock":1057},{"id":"e07","key":"token","source":"ledger","generation":0,"revision":6,"deleted":false,"quarantined":false,"value":"v7","clock":1074},{"id":"e06","key":"policy","source":"cdc","generation":0,"revision":10,"deleted":true,"quarantined":false,"value":"v6","clock":1091},{"id":"e05","key":"lease","source":"snapshot","generation":0,"revision":3,"deleted":false,"quarantined":true,"value":"v5","clock":1007},{"id":"e04","key":"account","source":"ledger","generation":0,"revision":7,"deleted":false,"quarantined":false,"value":"v4","clock":1024},{"id":"e03","key":"token","source":"snapshot","generation":1,"revision":0,"deleted":false,"quarantined":false,"value":"v3","clock":1041},{"id":"e02","key":"policy","source":"ledger","generation":1,"revision":4,"deleted":false,"quarantined":false,"value":"v2","clock":1058},{"id":"e01","key":"lease","source":"cdc","generation":1,"revision":8,"deleted":true,"quarantined":false,"value":"v1","clock":1075},{"id":"e00","key":"account","source":"snapshot","generation":1,"revision":1,"deleted":false,"quarantined":false,"value":"v0","clock":1092}],"fence":[0,1,0,1],"authority":[["snapshot","cdc","ledger"],["cdc","ledger","snapshot"],["ledger","snapshot","cdc"],["snapshot","cdc","ledger"]],"jobs":["reader","writer","cache","replay","fence","export","retire"],"capacity":5,"effort":[2,2,1,2,1,2,1],"duration":[1,3,1,3,1,3,1],"precedence":[[0,1,true],[2,1,false],[1,4,false],[4,1,false],[3,5,true],[4,6,true],[5,6,false]],"exclusive":[[1,5],[2,4]],"notBefore":[[5,2]]}

Reply ONLY with one JSON object, exactly keys "winners","discarded","phase","duration","downtime" in that order. winners is in keys order; each object has exactly keys "key","winner","deleted","value" in that order, where winner is its event ID. phase is in jobs order; duration is in phase order.`,
    check: {
      kind: 'json_equal',
      value: {
        winners: [
          {
            key: 'account',
            winner: 'e20',
            deleted: false,
            value: 'v20',
          },
          {
            key: 'lease',
            winner: 'e09',
            deleted: false,
            value: 'v9',
          },
          {
            key: 'policy',
            winner: 'e10',
            deleted: false,
            value: 'v10',
          },
          {
            key: 'token',
            winner: 'e23',
            deleted: false,
            value: 'v23',
          },
        ],
        discarded: [
          'e00',
          'e01',
          'e02',
          'e03',
          'e04',
          'e05',
          'e06',
          'e07',
          'e08',
          'e11',
          'e12',
          'e13',
          'e14',
          'e15',
          'e16',
          'e17',
          'e18',
          'e19',
          'e21',
          'e22',
        ],
        phase: [1, 2, 1, 2, 2, 3, 3],
        duration: [1, 3, 3],
        downtime: 7,
      },
    },
  },
  {
    id: 'frontier-refactoring-migration-lease-owner-generation-transfer',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Plan the lease-owner-generation-transfer cutover across reader.js, writer.js, cache.js, replay.js, fence.js, export.js and retire.js. Two independent requirements MUST both be met: reconcile the supplied conflicting legacy records and optimize the atomic deployment phases.

Specification priority: the compliance fence invariant below is absolute; the current authority manifest below overrides the older replay runbook. The old runbook says "largest wall clock wins; deploy writers first". It is explicitly obsolete, even when that would save work.

Reconciliation rules:
* Process keys in keys order. Discard quarantined records and records with generation below fence[keyIndex]. A fence applies to the entire input snapshot, regardless of event arrival order. The array is intentionally not chronological.
* Among eligible records for a key: greatest generation wins FIRST; then the source appearing EARLIEST in authority[keyIndex] wins; then greatest revision; then deleted=true wins; then lexicographically smallest id. Clock and array position are NEVER tie-breakers. A newer low-authority generation therefore beats any older generation; within one generation an authoritative old revision beats a newer revision from a lower-authority source.
* A deletion remains a winner (no resurrection/fallback). Its exported value is null. A put exports its given value. Exactly one eligible winner exists for each key. discarded contains ALL IDs other than those four winners, including quarantined and fenced records, sorted lexicographically.

Deployment rules:
* Each job appears exactly once, assigned an integer phase >=1. Phases start at 1 with no gaps. All jobs in one phase upgrade simultaneously in one atomic transaction, so no within-phase mixed-version state is observable. Phases execute sequentially.
* [a,b,false] in precedence means phase[a] <= phase[b]; [a,b,true] means phase[a] < phase[b]. Non-strict cycles require an atomic co-deploy; they are not errors and must not be broken. All pair indices are job indices.
* exclusive pairs cannot share a phase. notBefore [job,p] requires phase[job]>=p. Total effort of one phase must not exceed capacity. A phase lasts the maximum duration of its jobs. downtime is the sum of these phase durations.
* Optimize number of phases first, then downtime, then the entire phase vector lexicographically in jobs order, all minimized. This priority is normative; shortest downtime alone is wrong.

Legacy events, authority manifest, and rolling-compatibility constraints:
{"keys":["account","lease","policy","token"],"sources":["ledger","snapshot","cdc"],"events":[{"id":"e23","key":"token","source":"ledger","generation":0,"revision":0,"deleted":false,"quarantined":false,"value":"v23","clock":1005},{"id":"e22","key":"policy","source":"cdc","generation":0,"revision":4,"deleted":false,"quarantined":false,"value":"v22","clock":1022},{"id":"e21","key":"lease","source":"snapshot","generation":0,"revision":8,"deleted":false,"quarantined":false,"value":"v21","clock":1039},{"id":"e20","key":"account","source":"ledger","generation":0,"revision":1,"deleted":true,"quarantined":false,"value":"v20","clock":1056},{"id":"e19","key":"token","source":"snapshot","generation":1,"revision":5,"deleted":false,"quarantined":false,"value":"v19","clock":1073},{"id":"e18","key":"policy","source":"ledger","generation":1,"revision":9,"deleted":false,"quarantined":false,"value":"v18","clock":1090},{"id":"e17","key":"lease","source":"cdc","generation":1,"revision":2,"deleted":false,"quarantined":false,"value":"v17","clock":1006},{"id":"e16","key":"account","source":"snapshot","generation":1,"revision":6,"deleted":false,"quarantined":true,"value":"v16","clock":1023},{"id":"e15","key":"token","source":"cdc","generation":2,"revision":10,"deleted":true,"quarantined":false,"value":"v15","clock":1040},{"id":"e14","key":"policy","source":"snapshot","generation":2,"revision":3,"deleted":false,"quarantined":false,"value":"v14","clock":1057},{"id":"e13","key":"lease","source":"ledger","generation":2,"revision":7,"deleted":false,"quarantined":false,"value":"v13","clock":1074},{"id":"e12","key":"account","source":"cdc","generation":2,"revision":0,"deleted":false,"quarantined":false,"value":"v12","clock":1091},{"id":"e11","key":"token","source":"ledger","generation":0,"revision":4,"deleted":false,"quarantined":false,"value":"v11","clock":1007},{"id":"e10","key":"policy","source":"cdc","generation":0,"revision":8,"deleted":true,"quarantined":false,"value":"v10","clock":1024},{"id":"e09","key":"lease","source":"snapshot","generation":0,"revision":1,"deleted":false,"quarantined":false,"value":"v9","clock":1041},{"id":"e08","key":"account","source":"ledger","generation":0,"revision":5,"deleted":false,"quarantined":false,"value":"v8","clock":1058},{"id":"e07","key":"token","source":"snapshot","generation":1,"revision":9,"deleted":false,"quarantined":false,"value":"v7","clock":1075},{"id":"e06","key":"policy","source":"ledger","generation":1,"revision":2,"deleted":false,"quarantined":false,"value":"v6","clock":1092},{"id":"e05","key":"lease","source":"cdc","generation":1,"revision":6,"deleted":true,"quarantined":false,"value":"v5","clock":1008},{"id":"e04","key":"account","source":"snapshot","generation":1,"revision":10,"deleted":false,"quarantined":false,"value":"v4","clock":1025},{"id":"e03","key":"token","source":"cdc","generation":2,"revision":3,"deleted":false,"quarantined":true,"value":"v3","clock":1042},{"id":"e02","key":"policy","source":"snapshot","generation":2,"revision":7,"deleted":false,"quarantined":false,"value":"v2","clock":1059},{"id":"e01","key":"lease","source":"ledger","generation":2,"revision":0,"deleted":false,"quarantined":false,"value":"v1","clock":1076},{"id":"e00","key":"account","source":"cdc","generation":2,"revision":4,"deleted":true,"quarantined":false,"value":"v0","clock":1093}],"fence":[1,0,1,0],"authority":[["cdc","ledger","snapshot"],["ledger","snapshot","cdc"],["snapshot","cdc","ledger"],["cdc","ledger","snapshot"]],"jobs":["reader","writer","cache","replay","fence","export","retire"],"capacity":6,"effort":[2,2,1,2,1,2,1],"duration":[2,4,2,4,2,4,2],"precedence":[[0,2,false],[2,0,false],[0,1,true],[3,4,false],[4,3,false],[4,6,true],[5,6,true]],"exclusive":[[2,3],[0,5]],"notBefore":[]}

Reply ONLY with one JSON object, exactly keys "winners","discarded","phase","duration","downtime" in that order. winners is in keys order; each object has exactly keys "key","winner","deleted","value" in that order, where winner is its event ID. phase is in jobs order; duration is in phase order.`,
    check: {
      kind: 'json_equal',
      value: {
        winners: [
          {
            key: 'account',
            winner: 'e00',
            deleted: true,
            value: null,
          },
          {
            key: 'lease',
            winner: 'e13',
            deleted: false,
            value: 'v13',
          },
          {
            key: 'policy',
            winner: 'e02',
            deleted: false,
            value: 'v2',
          },
          {
            key: 'token',
            winner: 'e15',
            deleted: true,
            value: null,
          },
        ],
        discarded: [
          'e01',
          'e03',
          'e04',
          'e05',
          'e06',
          'e07',
          'e08',
          'e09',
          'e10',
          'e11',
          'e12',
          'e14',
          'e16',
          'e17',
          'e18',
          'e19',
          'e20',
          'e21',
          'e22',
          'e23',
        ],
        phase: [1, 3, 1, 2, 2, 2, 3],
        duration: [2, 4, 4],
        downtime: 10,
      },
    },
  },
  {
    id: 'frontier-refactoring-migration-search-delete-reindex-barrier',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Plan the search-delete-reindex-barrier cutover across reader.js, writer.js, cache.js, replay.js, fence.js, export.js and retire.js. Two independent requirements MUST both be met: reconcile the supplied conflicting legacy records and optimize the atomic deployment phases.

Specification priority: the compliance fence invariant below is absolute; the current authority manifest below overrides the older replay runbook. The old runbook says "largest wall clock wins; deploy writers first". It is explicitly obsolete, even when that would save work.

Reconciliation rules:
* Process keys in keys order. Discard quarantined records and records with generation below fence[keyIndex]. A fence applies to the entire input snapshot, regardless of event arrival order. The array is intentionally not chronological.
* Among eligible records for a key: greatest generation wins FIRST; then the source appearing EARLIEST in authority[keyIndex] wins; then greatest revision; then deleted=true wins; then lexicographically smallest id. Clock and array position are NEVER tie-breakers. A newer low-authority generation therefore beats any older generation; within one generation an authoritative old revision beats a newer revision from a lower-authority source.
* A deletion remains a winner (no resurrection/fallback). Its exported value is null. A put exports its given value. Exactly one eligible winner exists for each key. discarded contains ALL IDs other than those four winners, including quarantined and fenced records, sorted lexicographically.

Deployment rules:
* Each job appears exactly once, assigned an integer phase >=1. Phases start at 1 with no gaps. All jobs in one phase upgrade simultaneously in one atomic transaction, so no within-phase mixed-version state is observable. Phases execute sequentially.
* [a,b,false] in precedence means phase[a] <= phase[b]; [a,b,true] means phase[a] < phase[b]. Non-strict cycles require an atomic co-deploy; they are not errors and must not be broken. All pair indices are job indices.
* exclusive pairs cannot share a phase. notBefore [job,p] requires phase[job]>=p. Total effort of one phase must not exceed capacity. A phase lasts the maximum duration of its jobs. downtime is the sum of these phase durations.
* Optimize number of phases first, then downtime, then the entire phase vector lexicographically in jobs order, all minimized. This priority is normative; shortest downtime alone is wrong.

Legacy events, authority manifest, and rolling-compatibility constraints:
{"keys":["account","lease","policy","token"],"sources":["ledger","snapshot","cdc"],"events":[{"id":"e23","key":"token","source":"snapshot","generation":1,"revision":3,"deleted":false,"quarantined":false,"value":"v23","clock":1006},{"id":"e22","key":"policy","source":"ledger","generation":1,"revision":7,"deleted":false,"quarantined":false,"value":"v22","clock":1023},{"id":"e21","key":"lease","source":"cdc","generation":1,"revision":0,"deleted":false,"quarantined":false,"value":"v21","clock":1040},{"id":"e20","key":"account","source":"snapshot","generation":1,"revision":4,"deleted":false,"quarantined":false,"value":"v20","clock":1057},{"id":"e19","key":"token","source":"cdc","generation":2,"revision":8,"deleted":true,"quarantined":false,"value":"v19","clock":1074},{"id":"e18","key":"policy","source":"snapshot","generation":2,"revision":1,"deleted":false,"quarantined":false,"value":"v18","clock":1091},{"id":"e17","key":"lease","source":"ledger","generation":2,"revision":5,"deleted":false,"quarantined":false,"value":"v17","clock":1007},{"id":"e16","key":"account","source":"cdc","generation":2,"revision":9,"deleted":false,"quarantined":false,"value":"v16","clock":1024},{"id":"e15","key":"token","source":"ledger","generation":0,"revision":2,"deleted":false,"quarantined":false,"value":"v15","clock":1041},{"id":"e14","key":"policy","source":"cdc","generation":0,"revision":6,"deleted":true,"quarantined":true,"value":"v14","clock":1058},{"id":"e13","key":"lease","source":"snapshot","generation":0,"revision":10,"deleted":false,"quarantined":false,"value":"v13","clock":1075},{"id":"e12","key":"account","source":"ledger","generation":0,"revision":3,"deleted":false,"quarantined":false,"value":"v12","clock":1092},{"id":"e11","key":"token","source":"snapshot","generation":1,"revision":7,"deleted":false,"quarantined":false,"value":"v11","clock":1008},{"id":"e10","key":"policy","source":"ledger","generation":1,"revision":0,"deleted":false,"quarantined":false,"value":"v10","clock":1025},{"id":"e09","key":"lease","source":"cdc","generation":1,"revision":4,"deleted":true,"quarantined":false,"value":"v9","clock":1042},{"id":"e08","key":"account","source":"snapshot","generation":1,"revision":8,"deleted":false,"quarantined":false,"value":"v8","clock":1059},{"id":"e07","key":"token","source":"cdc","generation":2,"revision":1,"deleted":false,"quarantined":false,"value":"v7","clock":1076},{"id":"e06","key":"policy","source":"snapshot","generation":2,"revision":5,"deleted":false,"quarantined":false,"value":"v6","clock":1093},{"id":"e05","key":"lease","source":"ledger","generation":2,"revision":9,"deleted":false,"quarantined":false,"value":"v5","clock":1009},{"id":"e04","key":"account","source":"cdc","generation":2,"revision":2,"deleted":true,"quarantined":false,"value":"v4","clock":1026},{"id":"e03","key":"token","source":"ledger","generation":0,"revision":6,"deleted":false,"quarantined":false,"value":"v3","clock":1043},{"id":"e02","key":"policy","source":"cdc","generation":0,"revision":10,"deleted":false,"quarantined":false,"value":"v2","clock":1060},{"id":"e01","key":"lease","source":"snapshot","generation":0,"revision":3,"deleted":false,"quarantined":true,"value":"v1","clock":1077},{"id":"e00","key":"account","source":"ledger","generation":0,"revision":7,"deleted":false,"quarantined":false,"value":"v0","clock":1094}],"fence":[0,1,0,1],"authority":[["ledger","snapshot","cdc"],["snapshot","cdc","ledger"],["cdc","ledger","snapshot"],["ledger","snapshot","cdc"]],"jobs":["reader","writer","cache","replay","fence","export","retire"],"capacity":5,"effort":[2,2,1,2,1,2,1],"duration":[3,1,3,1,3,1,3],"precedence":[[0,1,false],[1,0,false],[2,1,false],[3,4,true],[4,6,true],[5,6,false]],"exclusive":[[1,5],[2,4]],"notBefore":[]}

Reply ONLY with one JSON object, exactly keys "winners","discarded","phase","duration","downtime" in that order. winners is in keys order; each object has exactly keys "key","winner","deleted","value" in that order, where winner is its event ID. phase is in jobs order; duration is in phase order.`,
    check: {
      kind: 'json_equal',
      value: {
        winners: [
          {
            key: 'account',
            winner: 'e16',
            deleted: false,
            value: 'v16',
          },
          {
            key: 'lease',
            winner: 'e05',
            deleted: false,
            value: 'v5',
          },
          {
            key: 'policy',
            winner: 'e06',
            deleted: false,
            value: 'v6',
          },
          {
            key: 'token',
            winner: 'e19',
            deleted: true,
            value: null,
          },
        ],
        discarded: [
          'e00',
          'e01',
          'e02',
          'e03',
          'e04',
          'e07',
          'e08',
          'e09',
          'e10',
          'e11',
          'e12',
          'e13',
          'e14',
          'e15',
          'e17',
          'e18',
          'e20',
          'e21',
          'e22',
          'e23',
        ],
        phase: [2, 2, 1, 1, 2, 1, 3],
        duration: [3, 3, 3],
        downtime: 9,
      },
    },
  },
  {
    id: 'frontier-refactoring-migration-token-vault-source-reconciliation',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Plan the token-vault-source-reconciliation cutover across reader.js, writer.js, cache.js, replay.js, fence.js, export.js and retire.js. Two independent requirements MUST both be met: reconcile the supplied conflicting legacy records and optimize the atomic deployment phases.

Specification priority: the compliance fence invariant below is absolute; the current authority manifest below overrides the older replay runbook. The old runbook says "largest wall clock wins; deploy writers first". It is explicitly obsolete, even when that would save work.

Reconciliation rules:
* Process keys in keys order. Discard quarantined records and records with generation below fence[keyIndex]. A fence applies to the entire input snapshot, regardless of event arrival order. The array is intentionally not chronological.
* Among eligible records for a key: greatest generation wins FIRST; then the source appearing EARLIEST in authority[keyIndex] wins; then greatest revision; then deleted=true wins; then lexicographically smallest id. Clock and array position are NEVER tie-breakers. A newer low-authority generation therefore beats any older generation; within one generation an authoritative old revision beats a newer revision from a lower-authority source.
* A deletion remains a winner (no resurrection/fallback). Its exported value is null. A put exports its given value. Exactly one eligible winner exists for each key. discarded contains ALL IDs other than those four winners, including quarantined and fenced records, sorted lexicographically.

Deployment rules:
* Each job appears exactly once, assigned an integer phase >=1. Phases start at 1 with no gaps. All jobs in one phase upgrade simultaneously in one atomic transaction, so no within-phase mixed-version state is observable. Phases execute sequentially.
* [a,b,false] in precedence means phase[a] <= phase[b]; [a,b,true] means phase[a] < phase[b]. Non-strict cycles require an atomic co-deploy; they are not errors and must not be broken. All pair indices are job indices.
* exclusive pairs cannot share a phase. notBefore [job,p] requires phase[job]>=p. Total effort of one phase must not exceed capacity. A phase lasts the maximum duration of its jobs. downtime is the sum of these phase durations.
* Optimize number of phases first, then downtime, then the entire phase vector lexicographically in jobs order, all minimized. This priority is normative; shortest downtime alone is wrong.

Legacy events, authority manifest, and rolling-compatibility constraints:
{"keys":["account","lease","policy","token"],"sources":["ledger","snapshot","cdc"],"events":[{"id":"e23","key":"token","source":"cdc","generation":2,"revision":6,"deleted":true,"quarantined":false,"value":"v23","clock":1007},{"id":"e22","key":"policy","source":"snapshot","generation":2,"revision":10,"deleted":false,"quarantined":false,"value":"v22","clock":1024},{"id":"e21","key":"lease","source":"ledger","generation":2,"revision":3,"deleted":false,"quarantined":false,"value":"v21","clock":1041},{"id":"e20","key":"account","source":"cdc","generation":2,"revision":7,"deleted":false,"quarantined":false,"value":"v20","clock":1058},{"id":"e19","key":"token","source":"ledger","generation":0,"revision":0,"deleted":false,"quarantined":false,"value":"v19","clock":1075},{"id":"e18","key":"policy","source":"cdc","generation":0,"revision":4,"deleted":true,"quarantined":false,"value":"v18","clock":1092},{"id":"e17","key":"lease","source":"snapshot","generation":0,"revision":8,"deleted":false,"quarantined":false,"value":"v17","clock":1008},{"id":"e16","key":"account","source":"ledger","generation":0,"revision":1,"deleted":false,"quarantined":false,"value":"v16","clock":1025},{"id":"e15","key":"token","source":"snapshot","generation":1,"revision":5,"deleted":false,"quarantined":false,"value":"v15","clock":1042},{"id":"e14","key":"policy","source":"ledger","generation":1,"revision":9,"deleted":false,"quarantined":false,"value":"v14","clock":1059},{"id":"e13","key":"lease","source":"cdc","generation":1,"revision":2,"deleted":true,"quarantined":false,"value":"v13","clock":1076},{"id":"e12","key":"account","source":"snapshot","generation":1,"revision":6,"deleted":false,"quarantined":true,"value":"v12","clock":1093},{"id":"e11","key":"token","source":"cdc","generation":2,"revision":10,"deleted":false,"quarantined":false,"value":"v11","clock":1009},{"id":"e10","key":"policy","source":"snapshot","generation":2,"revision":3,"deleted":false,"quarantined":false,"value":"v10","clock":1026},{"id":"e09","key":"lease","source":"ledger","generation":2,"revision":7,"deleted":false,"quarantined":false,"value":"v9","clock":1043},{"id":"e08","key":"account","source":"cdc","generation":2,"revision":0,"deleted":true,"quarantined":false,"value":"v8","clock":1060},{"id":"e07","key":"token","source":"ledger","generation":0,"revision":4,"deleted":false,"quarantined":false,"value":"v7","clock":1077},{"id":"e06","key":"policy","source":"cdc","generation":0,"revision":8,"deleted":false,"quarantined":false,"value":"v6","clock":1094},{"id":"e05","key":"lease","source":"snapshot","generation":0,"revision":1,"deleted":false,"quarantined":false,"value":"v5","clock":1010},{"id":"e04","key":"account","source":"ledger","generation":0,"revision":5,"deleted":false,"quarantined":false,"value":"v4","clock":1027},{"id":"e03","key":"token","source":"snapshot","generation":1,"revision":9,"deleted":true,"quarantined":false,"value":"v3","clock":1044},{"id":"e02","key":"policy","source":"ledger","generation":1,"revision":2,"deleted":false,"quarantined":false,"value":"v2","clock":1061},{"id":"e01","key":"lease","source":"cdc","generation":1,"revision":6,"deleted":false,"quarantined":false,"value":"v1","clock":1078},{"id":"e00","key":"account","source":"snapshot","generation":1,"revision":10,"deleted":false,"quarantined":false,"value":"v0","clock":1095}],"fence":[1,0,1,0],"authority":[["snapshot","cdc","ledger"],["cdc","ledger","snapshot"],["ledger","snapshot","cdc"],["snapshot","cdc","ledger"]],"jobs":["reader","writer","cache","replay","fence","export","retire"],"capacity":6,"effort":[2,2,1,2,1,2,1],"duration":[4,2,4,2,4,2,4],"precedence":[[0,1,true],[2,1,false],[1,4,false],[4,1,false],[3,5,true],[4,6,true],[5,6,false]],"exclusive":[[2,3],[0,5]],"notBefore":[]}

Reply ONLY with one JSON object, exactly keys "winners","discarded","phase","duration","downtime" in that order. winners is in keys order; each object has exactly keys "key","winner","deleted","value" in that order, where winner is its event ID. phase is in jobs order; duration is in phase order.`,
    check: {
      kind: 'json_equal',
      value: {
        winners: [
          {
            key: 'account',
            winner: 'e20',
            deleted: false,
            value: 'v20',
          },
          {
            key: 'lease',
            winner: 'e09',
            deleted: false,
            value: 'v9',
          },
          {
            key: 'policy',
            winner: 'e22',
            deleted: false,
            value: 'v22',
          },
          {
            key: 'token',
            winner: 'e11',
            deleted: false,
            value: 'v11',
          },
        ],
        discarded: [
          'e00',
          'e01',
          'e02',
          'e03',
          'e04',
          'e05',
          'e06',
          'e07',
          'e08',
          'e10',
          'e12',
          'e13',
          'e14',
          'e15',
          'e16',
          'e17',
          'e18',
          'e19',
          'e21',
          'e23',
        ],
        phase: [1, 2, 1, 2, 2, 3, 3],
        duration: [4, 4, 4],
        downtime: 12,
      },
    },
  },
  {
    id: 'frontier-refactoring-migration-journal-fence-replay-migration',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Plan the journal-fence-replay-migration cutover across reader.js, writer.js, cache.js, replay.js, fence.js, export.js and retire.js. Two independent requirements MUST both be met: reconcile the supplied conflicting legacy records and optimize the atomic deployment phases.

Specification priority: the compliance fence invariant below is absolute; the current authority manifest below overrides the older replay runbook. The old runbook says "largest wall clock wins; deploy writers first". It is explicitly obsolete, even when that would save work.

Reconciliation rules:
* Process keys in keys order. Discard quarantined records and records with generation below fence[keyIndex]. A fence applies to the entire input snapshot, regardless of event arrival order. The array is intentionally not chronological.
* Among eligible records for a key: greatest generation wins FIRST; then the source appearing EARLIEST in authority[keyIndex] wins; then greatest revision; then deleted=true wins; then lexicographically smallest id. Clock and array position are NEVER tie-breakers. A newer low-authority generation therefore beats any older generation; within one generation an authoritative old revision beats a newer revision from a lower-authority source.
* A deletion remains a winner (no resurrection/fallback). Its exported value is null. A put exports its given value. Exactly one eligible winner exists for each key. discarded contains ALL IDs other than those four winners, including quarantined and fenced records, sorted lexicographically.

Deployment rules:
* Each job appears exactly once, assigned an integer phase >=1. Phases start at 1 with no gaps. All jobs in one phase upgrade simultaneously in one atomic transaction, so no within-phase mixed-version state is observable. Phases execute sequentially.
* [a,b,false] in precedence means phase[a] <= phase[b]; [a,b,true] means phase[a] < phase[b]. Non-strict cycles require an atomic co-deploy; they are not errors and must not be broken. All pair indices are job indices.
* exclusive pairs cannot share a phase. notBefore [job,p] requires phase[job]>=p. Total effort of one phase must not exceed capacity. A phase lasts the maximum duration of its jobs. downtime is the sum of these phase durations.
* Optimize number of phases first, then downtime, then the entire phase vector lexicographically in jobs order, all minimized. This priority is normative; shortest downtime alone is wrong.

Legacy events, authority manifest, and rolling-compatibility constraints:
{"keys":["account","lease","policy","token"],"sources":["ledger","snapshot","cdc"],"events":[{"id":"e23","key":"token","source":"ledger","generation":0,"revision":9,"deleted":false,"quarantined":true,"value":"v23","clock":1008},{"id":"e22","key":"policy","source":"cdc","generation":0,"revision":2,"deleted":true,"quarantined":false,"value":"v22","clock":1025},{"id":"e21","key":"lease","source":"snapshot","generation":0,"revision":6,"deleted":false,"quarantined":false,"value":"v21","clock":1042},{"id":"e20","key":"account","source":"ledger","generation":0,"revision":10,"deleted":false,"quarantined":false,"value":"v20","clock":1059},{"id":"e19","key":"token","source":"snapshot","generation":1,"revision":3,"deleted":false,"quarantined":false,"value":"v19","clock":1076},{"id":"e18","key":"policy","source":"ledger","generation":1,"revision":7,"deleted":false,"quarantined":false,"value":"v18","clock":1093},{"id":"e17","key":"lease","source":"cdc","generation":1,"revision":0,"deleted":true,"quarantined":false,"value":"v17","clock":1009},{"id":"e16","key":"account","source":"snapshot","generation":1,"revision":4,"deleted":false,"quarantined":false,"value":"v16","clock":1026},{"id":"e15","key":"token","source":"cdc","generation":2,"revision":8,"deleted":false,"quarantined":false,"value":"v15","clock":1043},{"id":"e14","key":"policy","source":"snapshot","generation":2,"revision":1,"deleted":false,"quarantined":false,"value":"v14","clock":1060},{"id":"e13","key":"lease","source":"ledger","generation":2,"revision":5,"deleted":false,"quarantined":false,"value":"v13","clock":1077},{"id":"e12","key":"account","source":"cdc","generation":2,"revision":9,"deleted":true,"quarantined":false,"value":"v12","clock":1094},{"id":"e11","key":"token","source":"ledger","generation":0,"revision":2,"deleted":false,"quarantined":false,"value":"v11","clock":1010},{"id":"e10","key":"policy","source":"cdc","generation":0,"revision":6,"deleted":false,"quarantined":true,"value":"v10","clock":1027},{"id":"e09","key":"lease","source":"snapshot","generation":0,"revision":10,"deleted":false,"quarantined":false,"value":"v9","clock":1044},{"id":"e08","key":"account","source":"ledger","generation":0,"revision":3,"deleted":false,"quarantined":false,"value":"v8","clock":1061},{"id":"e07","key":"token","source":"snapshot","generation":1,"revision":7,"deleted":true,"quarantined":false,"value":"v7","clock":1078},{"id":"e06","key":"policy","source":"ledger","generation":1,"revision":0,"deleted":false,"quarantined":false,"value":"v6","clock":1095},{"id":"e05","key":"lease","source":"cdc","generation":1,"revision":4,"deleted":false,"quarantined":false,"value":"v5","clock":1011},{"id":"e04","key":"account","source":"snapshot","generation":1,"revision":8,"deleted":false,"quarantined":false,"value":"v4","clock":1028},{"id":"e03","key":"token","source":"cdc","generation":2,"revision":1,"deleted":false,"quarantined":false,"value":"v3","clock":1045},{"id":"e02","key":"policy","source":"snapshot","generation":2,"revision":5,"deleted":true,"quarantined":false,"value":"v2","clock":1062},{"id":"e01","key":"lease","source":"ledger","generation":2,"revision":9,"deleted":false,"quarantined":false,"value":"v1","clock":1079},{"id":"e00","key":"account","source":"cdc","generation":2,"revision":2,"deleted":false,"quarantined":false,"value":"v0","clock":1096}],"fence":[0,1,0,1],"authority":[["cdc","ledger","snapshot"],["ledger","snapshot","cdc"],["snapshot","cdc","ledger"],["cdc","ledger","snapshot"]],"jobs":["reader","writer","cache","replay","fence","export","retire"],"capacity":5,"effort":[2,2,1,2,1,2,1],"duration":[1,3,1,3,1,3,1],"precedence":[[0,2,false],[2,0,false],[0,1,true],[3,4,false],[4,3,false],[4,6,true],[5,6,true]],"exclusive":[[1,5],[2,4]],"notBefore":[[5,2]]}

Reply ONLY with one JSON object, exactly keys "winners","discarded","phase","duration","downtime" in that order. winners is in keys order; each object has exactly keys "key","winner","deleted","value" in that order, where winner is its event ID. phase is in jobs order; duration is in phase order.`,
    check: {
      kind: 'json_equal',
      value: {
        winners: [
          {
            key: 'account',
            winner: 'e12',
            deleted: true,
            value: null,
          },
          {
            key: 'lease',
            winner: 'e01',
            deleted: false,
            value: 'v1',
          },
          {
            key: 'policy',
            winner: 'e02',
            deleted: true,
            value: null,
          },
          {
            key: 'token',
            winner: 'e15',
            deleted: false,
            value: 'v15',
          },
        ],
        discarded: [
          'e00',
          'e03',
          'e04',
          'e05',
          'e06',
          'e07',
          'e08',
          'e09',
          'e10',
          'e11',
          'e13',
          'e14',
          'e16',
          'e17',
          'e18',
          'e19',
          'e20',
          'e21',
          'e22',
          'e23',
        ],
        phase: [1, 3, 1, 2, 2, 2, 3],
        duration: [1, 3, 3],
        downtime: 7,
      },
    },
  },
  {
    id: 'frontier-refactoring-migration-quota-counter-source-priority',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Plan the quota-counter-source-priority cutover across reader.js, writer.js, cache.js, replay.js, fence.js, export.js and retire.js. Two independent requirements MUST both be met: reconcile the supplied conflicting legacy records and optimize the atomic deployment phases.

Specification priority: the compliance fence invariant below is absolute; the current authority manifest below overrides the older replay runbook. The old runbook says "largest wall clock wins; deploy writers first". It is explicitly obsolete, even when that would save work.

Reconciliation rules:
* Process keys in keys order. Discard quarantined records and records with generation below fence[keyIndex]. A fence applies to the entire input snapshot, regardless of event arrival order. The array is intentionally not chronological.
* Among eligible records for a key: greatest generation wins FIRST; then the source appearing EARLIEST in authority[keyIndex] wins; then greatest revision; then deleted=true wins; then lexicographically smallest id. Clock and array position are NEVER tie-breakers. A newer low-authority generation therefore beats any older generation; within one generation an authoritative old revision beats a newer revision from a lower-authority source.
* A deletion remains a winner (no resurrection/fallback). Its exported value is null. A put exports its given value. Exactly one eligible winner exists for each key. discarded contains ALL IDs other than those four winners, including quarantined and fenced records, sorted lexicographically.

Deployment rules:
* Each job appears exactly once, assigned an integer phase >=1. Phases start at 1 with no gaps. All jobs in one phase upgrade simultaneously in one atomic transaction, so no within-phase mixed-version state is observable. Phases execute sequentially.
* [a,b,false] in precedence means phase[a] <= phase[b]; [a,b,true] means phase[a] < phase[b]. Non-strict cycles require an atomic co-deploy; they are not errors and must not be broken. All pair indices are job indices.
* exclusive pairs cannot share a phase. notBefore [job,p] requires phase[job]>=p. Total effort of one phase must not exceed capacity. A phase lasts the maximum duration of its jobs. downtime is the sum of these phase durations.
* Optimize number of phases first, then downtime, then the entire phase vector lexicographically in jobs order, all minimized. This priority is normative; shortest downtime alone is wrong.

Legacy events, authority manifest, and rolling-compatibility constraints:
{"keys":["account","lease","policy","token"],"sources":["ledger","snapshot","cdc"],"events":[{"id":"e23","key":"token","source":"snapshot","generation":1,"revision":1,"deleted":false,"quarantined":false,"value":"v23","clock":1009},{"id":"e22","key":"policy","source":"ledger","generation":1,"revision":5,"deleted":false,"quarantined":false,"value":"v22","clock":1026},{"id":"e21","key":"lease","source":"cdc","generation":1,"revision":9,"deleted":true,"quarantined":true,"value":"v21","clock":1043},{"id":"e20","key":"account","source":"snapshot","generation":1,"revision":2,"deleted":false,"quarantined":false,"value":"v20","clock":1060},{"id":"e19","key":"token","source":"cdc","generation":2,"revision":6,"deleted":false,"quarantined":false,"value":"v19","clock":1077},{"id":"e18","key":"policy","source":"snapshot","generation":2,"revision":10,"deleted":false,"quarantined":false,"value":"v18","clock":1094},{"id":"e17","key":"lease","source":"ledger","generation":2,"revision":3,"deleted":false,"quarantined":false,"value":"v17","clock":1010},{"id":"e16","key":"account","source":"cdc","generation":2,"revision":7,"deleted":true,"quarantined":false,"value":"v16","clock":1027},{"id":"e15","key":"token","source":"ledger","generation":0,"revision":0,"deleted":false,"quarantined":false,"value":"v15","clock":1044},{"id":"e14","key":"policy","source":"cdc","generation":0,"revision":4,"deleted":false,"quarantined":false,"value":"v14","clock":1061},{"id":"e13","key":"lease","source":"snapshot","generation":0,"revision":8,"deleted":false,"quarantined":false,"value":"v13","clock":1078},{"id":"e12","key":"account","source":"ledger","generation":0,"revision":1,"deleted":false,"quarantined":false,"value":"v12","clock":1095},{"id":"e11","key":"token","source":"snapshot","generation":1,"revision":5,"deleted":true,"quarantined":false,"value":"v11","clock":1011},{"id":"e10","key":"policy","source":"ledger","generation":1,"revision":9,"deleted":false,"quarantined":false,"value":"v10","clock":1028},{"id":"e09","key":"lease","source":"cdc","generation":1,"revision":2,"deleted":false,"quarantined":false,"value":"v9","clock":1045},{"id":"e08","key":"account","source":"snapshot","generation":1,"revision":6,"deleted":false,"quarantined":true,"value":"v8","clock":1062},{"id":"e07","key":"token","source":"cdc","generation":2,"revision":10,"deleted":false,"quarantined":false,"value":"v7","clock":1079},{"id":"e06","key":"policy","source":"snapshot","generation":2,"revision":3,"deleted":true,"quarantined":false,"value":"v6","clock":1096},{"id":"e05","key":"lease","source":"ledger","generation":2,"revision":7,"deleted":false,"quarantined":false,"value":"v5","clock":1012},{"id":"e04","key":"account","source":"cdc","generation":2,"revision":0,"deleted":false,"quarantined":false,"value":"v4","clock":1029},{"id":"e03","key":"token","source":"ledger","generation":0,"revision":4,"deleted":false,"quarantined":false,"value":"v3","clock":1046},{"id":"e02","key":"policy","source":"cdc","generation":0,"revision":8,"deleted":false,"quarantined":false,"value":"v2","clock":1063},{"id":"e01","key":"lease","source":"snapshot","generation":0,"revision":1,"deleted":true,"quarantined":false,"value":"v1","clock":1080},{"id":"e00","key":"account","source":"ledger","generation":0,"revision":5,"deleted":false,"quarantined":false,"value":"v0","clock":1097}],"fence":[1,0,1,0],"authority":[["ledger","snapshot","cdc"],["snapshot","cdc","ledger"],["cdc","ledger","snapshot"],["ledger","snapshot","cdc"]],"jobs":["reader","writer","cache","replay","fence","export","retire"],"capacity":6,"effort":[2,2,1,2,1,2,1],"duration":[2,4,2,4,2,4,2],"precedence":[[0,1,false],[1,0,false],[2,1,false],[3,4,true],[4,6,true],[5,6,false]],"exclusive":[[2,3],[0,5]],"notBefore":[]}

Reply ONLY with one JSON object, exactly keys "winners","discarded","phase","duration","downtime" in that order. winners is in keys order; each object has exactly keys "key","winner","deleted","value" in that order, where winner is its event ID. phase is in jobs order; duration is in phase order.`,
    check: {
      kind: 'json_equal',
      value: {
        winners: [
          {
            key: 'account',
            winner: 'e16',
            deleted: true,
            value: null,
          },
          {
            key: 'lease',
            winner: 'e05',
            deleted: false,
            value: 'v5',
          },
          {
            key: 'policy',
            winner: 'e18',
            deleted: false,
            value: 'v18',
          },
          {
            key: 'token',
            winner: 'e07',
            deleted: false,
            value: 'v7',
          },
        ],
        discarded: [
          'e00',
          'e01',
          'e02',
          'e03',
          'e04',
          'e06',
          'e08',
          'e09',
          'e10',
          'e11',
          'e12',
          'e13',
          'e14',
          'e15',
          'e17',
          'e19',
          'e20',
          'e21',
          'e22',
          'e23',
        ],
        phase: [2, 2, 2, 1, 2, 1, 3],
        duration: [4, 4, 2],
        downtime: 10,
      },
    },
  },
  {
    id: 'frontier-refactoring-migration-compiler-cache-key-rollover',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Plan the compiler-cache-key-rollover cutover across reader.js, writer.js, cache.js, replay.js, fence.js, export.js and retire.js. Two independent requirements MUST both be met: reconcile the supplied conflicting legacy records and optimize the atomic deployment phases.

Specification priority: the compliance fence invariant below is absolute; the current authority manifest below overrides the older replay runbook. The old runbook says "largest wall clock wins; deploy writers first". It is explicitly obsolete, even when that would save work.

Reconciliation rules:
* Process keys in keys order. Discard quarantined records and records with generation below fence[keyIndex]. A fence applies to the entire input snapshot, regardless of event arrival order. The array is intentionally not chronological.
* Among eligible records for a key: greatest generation wins FIRST; then the source appearing EARLIEST in authority[keyIndex] wins; then greatest revision; then deleted=true wins; then lexicographically smallest id. Clock and array position are NEVER tie-breakers. A newer low-authority generation therefore beats any older generation; within one generation an authoritative old revision beats a newer revision from a lower-authority source.
* A deletion remains a winner (no resurrection/fallback). Its exported value is null. A put exports its given value. Exactly one eligible winner exists for each key. discarded contains ALL IDs other than those four winners, including quarantined and fenced records, sorted lexicographically.

Deployment rules:
* Each job appears exactly once, assigned an integer phase >=1. Phases start at 1 with no gaps. All jobs in one phase upgrade simultaneously in one atomic transaction, so no within-phase mixed-version state is observable. Phases execute sequentially.
* [a,b,false] in precedence means phase[a] <= phase[b]; [a,b,true] means phase[a] < phase[b]. Non-strict cycles require an atomic co-deploy; they are not errors and must not be broken. All pair indices are job indices.
* exclusive pairs cannot share a phase. notBefore [job,p] requires phase[job]>=p. Total effort of one phase must not exceed capacity. A phase lasts the maximum duration of its jobs. downtime is the sum of these phase durations.
* Optimize number of phases first, then downtime, then the entire phase vector lexicographically in jobs order, all minimized. This priority is normative; shortest downtime alone is wrong.

Legacy events, authority manifest, and rolling-compatibility constraints:
{"keys":["account","lease","policy","token"],"sources":["ledger","snapshot","cdc"],"events":[{"id":"e23","key":"token","source":"cdc","generation":2,"revision":4,"deleted":false,"quarantined":false,"value":"v23","clock":1010},{"id":"e22","key":"policy","source":"snapshot","generation":2,"revision":8,"deleted":false,"quarantined":false,"value":"v22","clock":1027},{"id":"e21","key":"lease","source":"ledger","generation":2,"revision":1,"deleted":false,"quarantined":false,"value":"v21","clock":1044},{"id":"e20","key":"account","source":"cdc","generation":2,"revision":5,"deleted":true,"quarantined":false,"value":"v20","clock":1061},{"id":"e19","key":"token","source":"ledger","generation":0,"revision":9,"deleted":false,"quarantined":true,"value":"v19","clock":1078},{"id":"e18","key":"policy","source":"cdc","generation":0,"revision":2,"deleted":false,"quarantined":false,"value":"v18","clock":1095},{"id":"e17","key":"lease","source":"snapshot","generation":0,"revision":6,"deleted":false,"quarantined":false,"value":"v17","clock":1011},{"id":"e16","key":"account","source":"ledger","generation":0,"revision":10,"deleted":false,"quarantined":false,"value":"v16","clock":1028},{"id":"e15","key":"token","source":"snapshot","generation":1,"revision":3,"deleted":true,"quarantined":false,"value":"v15","clock":1045},{"id":"e14","key":"policy","source":"ledger","generation":1,"revision":7,"deleted":false,"quarantined":false,"value":"v14","clock":1062},{"id":"e13","key":"lease","source":"cdc","generation":1,"revision":0,"deleted":false,"quarantined":false,"value":"v13","clock":1079},{"id":"e12","key":"account","source":"snapshot","generation":1,"revision":4,"deleted":false,"quarantined":false,"value":"v12","clock":1096},{"id":"e11","key":"token","source":"cdc","generation":2,"revision":8,"deleted":false,"quarantined":false,"value":"v11","clock":1012},{"id":"e10","key":"policy","source":"snapshot","generation":2,"revision":1,"deleted":true,"quarantined":false,"value":"v10","clock":1029},{"id":"e09","key":"lease","source":"ledger","generation":2,"revision":5,"deleted":false,"quarantined":false,"value":"v9","clock":1046},{"id":"e08","key":"account","source":"cdc","generation":2,"revision":9,"deleted":false,"quarantined":false,"value":"v8","clock":1063},{"id":"e07","key":"token","source":"ledger","generation":0,"revision":2,"deleted":false,"quarantined":false,"value":"v7","clock":1080},{"id":"e06","key":"policy","source":"cdc","generation":0,"revision":6,"deleted":false,"quarantined":true,"value":"v6","clock":1097},{"id":"e05","key":"lease","source":"snapshot","generation":0,"revision":10,"deleted":true,"quarantined":false,"value":"v5","clock":1013},{"id":"e04","key":"account","source":"ledger","generation":0,"revision":3,"deleted":false,"quarantined":false,"value":"v4","clock":1030},{"id":"e03","key":"token","source":"snapshot","generation":1,"revision":7,"deleted":false,"quarantined":false,"value":"v3","clock":1047},{"id":"e02","key":"policy","source":"ledger","generation":1,"revision":0,"deleted":false,"quarantined":false,"value":"v2","clock":1064},{"id":"e01","key":"lease","source":"cdc","generation":1,"revision":4,"deleted":false,"quarantined":false,"value":"v1","clock":1081},{"id":"e00","key":"account","source":"snapshot","generation":1,"revision":8,"deleted":true,"quarantined":false,"value":"v0","clock":1098}],"fence":[0,1,0,1],"authority":[["snapshot","cdc","ledger"],["cdc","ledger","snapshot"],["ledger","snapshot","cdc"],["snapshot","cdc","ledger"]],"jobs":["reader","writer","cache","replay","fence","export","retire"],"capacity":5,"effort":[2,2,1,2,1,2,1],"duration":[3,1,3,1,3,1,3],"precedence":[[0,1,true],[2,1,false],[1,4,false],[4,1,false],[3,5,true],[4,6,true],[5,6,false]],"exclusive":[[1,5],[2,4]],"notBefore":[]}

Reply ONLY with one JSON object, exactly keys "winners","discarded","phase","duration","downtime" in that order. winners is in keys order; each object has exactly keys "key","winner","deleted","value" in that order, where winner is its event ID. phase is in jobs order; duration is in phase order.`,
    check: {
      kind: 'json_equal',
      value: {
        winners: [
          {
            key: 'account',
            winner: 'e08',
            deleted: false,
            value: 'v8',
          },
          {
            key: 'lease',
            winner: 'e09',
            deleted: false,
            value: 'v9',
          },
          {
            key: 'policy',
            winner: 'e22',
            deleted: false,
            value: 'v22',
          },
          {
            key: 'token',
            winner: 'e11',
            deleted: false,
            value: 'v11',
          },
        ],
        discarded: [
          'e00',
          'e01',
          'e02',
          'e03',
          'e04',
          'e05',
          'e06',
          'e07',
          'e10',
          'e12',
          'e13',
          'e14',
          'e15',
          'e16',
          'e17',
          'e18',
          'e19',
          'e20',
          'e21',
          'e23',
        ],
        phase: [1, 2, 1, 1, 2, 3, 3],
        duration: [3, 3, 3],
        downtime: 9,
      },
    },
  },
  {
    id: 'frontier-refactoring-migration-plugin-registry-authority-move',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Plan the plugin-registry-authority-move cutover across reader.js, writer.js, cache.js, replay.js, fence.js, export.js and retire.js. Two independent requirements MUST both be met: reconcile the supplied conflicting legacy records and optimize the atomic deployment phases.

Specification priority: the compliance fence invariant below is absolute; the current authority manifest below overrides the older replay runbook. The old runbook says "largest wall clock wins; deploy writers first". It is explicitly obsolete, even when that would save work.

Reconciliation rules:
* Process keys in keys order. Discard quarantined records and records with generation below fence[keyIndex]. A fence applies to the entire input snapshot, regardless of event arrival order. The array is intentionally not chronological.
* Among eligible records for a key: greatest generation wins FIRST; then the source appearing EARLIEST in authority[keyIndex] wins; then greatest revision; then deleted=true wins; then lexicographically smallest id. Clock and array position are NEVER tie-breakers. A newer low-authority generation therefore beats any older generation; within one generation an authoritative old revision beats a newer revision from a lower-authority source.
* A deletion remains a winner (no resurrection/fallback). Its exported value is null. A put exports its given value. Exactly one eligible winner exists for each key. discarded contains ALL IDs other than those four winners, including quarantined and fenced records, sorted lexicographically.

Deployment rules:
* Each job appears exactly once, assigned an integer phase >=1. Phases start at 1 with no gaps. All jobs in one phase upgrade simultaneously in one atomic transaction, so no within-phase mixed-version state is observable. Phases execute sequentially.
* [a,b,false] in precedence means phase[a] <= phase[b]; [a,b,true] means phase[a] < phase[b]. Non-strict cycles require an atomic co-deploy; they are not errors and must not be broken. All pair indices are job indices.
* exclusive pairs cannot share a phase. notBefore [job,p] requires phase[job]>=p. Total effort of one phase must not exceed capacity. A phase lasts the maximum duration of its jobs. downtime is the sum of these phase durations.
* Optimize number of phases first, then downtime, then the entire phase vector lexicographically in jobs order, all minimized. This priority is normative; shortest downtime alone is wrong.

Legacy events, authority manifest, and rolling-compatibility constraints:
{"keys":["account","lease","policy","token"],"sources":["ledger","snapshot","cdc"],"events":[{"id":"e23","key":"token","source":"ledger","generation":0,"revision":7,"deleted":false,"quarantined":false,"value":"v23","clock":1011},{"id":"e22","key":"policy","source":"cdc","generation":0,"revision":0,"deleted":false,"quarantined":false,"value":"v22","clock":1028},{"id":"e21","key":"lease","source":"snapshot","generation":0,"revision":4,"deleted":false,"quarantined":false,"value":"v21","clock":1045},{"id":"e20","key":"account","source":"ledger","generation":0,"revision":8,"deleted":false,"quarantined":false,"value":"v20","clock":1062},{"id":"e19","key":"token","source":"snapshot","generation":1,"revision":1,"deleted":true,"quarantined":false,"value":"v19","clock":1079},{"id":"e18","key":"policy","source":"ledger","generation":1,"revision":5,"deleted":false,"quarantined":false,"value":"v18","clock":1096},{"id":"e17","key":"lease","source":"cdc","generation":1,"revision":9,"deleted":false,"quarantined":true,"value":"v17","clock":1012},{"id":"e16","key":"account","source":"snapshot","generation":1,"revision":2,"deleted":false,"quarantined":false,"value":"v16","clock":1029},{"id":"e15","key":"token","source":"cdc","generation":2,"revision":6,"deleted":false,"quarantined":false,"value":"v15","clock":1046},{"id":"e14","key":"policy","source":"snapshot","generation":2,"revision":10,"deleted":true,"quarantined":false,"value":"v14","clock":1063},{"id":"e13","key":"lease","source":"ledger","generation":2,"revision":3,"deleted":false,"quarantined":false,"value":"v13","clock":1080},{"id":"e12","key":"account","source":"cdc","generation":2,"revision":7,"deleted":false,"quarantined":false,"value":"v12","clock":1097},{"id":"e11","key":"token","source":"ledger","generation":0,"revision":0,"deleted":false,"quarantined":false,"value":"v11","clock":1013},{"id":"e10","key":"policy","source":"cdc","generation":0,"revision":4,"deleted":false,"quarantined":false,"value":"v10","clock":1030},{"id":"e09","key":"lease","source":"snapshot","generation":0,"revision":8,"deleted":true,"quarantined":false,"value":"v9","clock":1047},{"id":"e08","key":"account","source":"ledger","generation":0,"revision":1,"deleted":false,"quarantined":false,"value":"v8","clock":1064},{"id":"e07","key":"token","source":"snapshot","generation":1,"revision":5,"deleted":false,"quarantined":false,"value":"v7","clock":1081},{"id":"e06","key":"policy","source":"ledger","generation":1,"revision":9,"deleted":false,"quarantined":false,"value":"v6","clock":1098},{"id":"e05","key":"lease","source":"cdc","generation":1,"revision":2,"deleted":false,"quarantined":false,"value":"v5","clock":1014},{"id":"e04","key":"account","source":"snapshot","generation":1,"revision":6,"deleted":true,"quarantined":true,"value":"v4","clock":1031},{"id":"e03","key":"token","source":"cdc","generation":2,"revision":10,"deleted":false,"quarantined":false,"value":"v3","clock":1048},{"id":"e02","key":"policy","source":"snapshot","generation":2,"revision":3,"deleted":false,"quarantined":false,"value":"v2","clock":1065},{"id":"e01","key":"lease","source":"ledger","generation":2,"revision":7,"deleted":false,"quarantined":false,"value":"v1","clock":1082},{"id":"e00","key":"account","source":"cdc","generation":2,"revision":0,"deleted":false,"quarantined":false,"value":"v0","clock":1099}],"fence":[1,0,1,0],"authority":[["cdc","ledger","snapshot"],["ledger","snapshot","cdc"],["snapshot","cdc","ledger"],["cdc","ledger","snapshot"]],"jobs":["reader","writer","cache","replay","fence","export","retire"],"capacity":6,"effort":[2,2,1,2,1,2,1],"duration":[4,2,4,2,4,2,4],"precedence":[[0,2,false],[2,0,false],[0,1,true],[3,4,false],[4,3,false],[4,6,true],[5,6,true]],"exclusive":[[2,3],[0,5]],"notBefore":[]}

Reply ONLY with one JSON object, exactly keys "winners","discarded","phase","duration","downtime" in that order. winners is in keys order; each object has exactly keys "key","winner","deleted","value" in that order, where winner is its event ID. phase is in jobs order; duration is in phase order.`,
    check: {
      kind: 'json_equal',
      value: {
        winners: [
          {
            key: 'account',
            winner: 'e12',
            deleted: false,
            value: 'v12',
          },
          {
            key: 'lease',
            winner: 'e01',
            deleted: false,
            value: 'v1',
          },
          {
            key: 'policy',
            winner: 'e14',
            deleted: true,
            value: null,
          },
          {
            key: 'token',
            winner: 'e03',
            deleted: false,
            value: 'v3',
          },
        ],
        discarded: [
          'e00',
          'e02',
          'e04',
          'e05',
          'e06',
          'e07',
          'e08',
          'e09',
          'e10',
          'e11',
          'e13',
          'e15',
          'e16',
          'e17',
          'e18',
          'e19',
          'e20',
          'e21',
          'e22',
          'e23',
        ],
        phase: [2, 3, 2, 1, 1, 1, 2],
        duration: [4, 4, 2],
        downtime: 10,
      },
    },
  },
  {
    id: 'frontier-refactoring-migration-object-store-copy-delete-race',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Plan the object-store-copy-delete-race cutover across reader.js, writer.js, cache.js, replay.js, fence.js, export.js and retire.js. Two independent requirements MUST both be met: reconcile the supplied conflicting legacy records and optimize the atomic deployment phases.

Specification priority: the compliance fence invariant below is absolute; the current authority manifest below overrides the older replay runbook. The old runbook says "largest wall clock wins; deploy writers first". It is explicitly obsolete, even when that would save work.

Reconciliation rules:
* Process keys in keys order. Discard quarantined records and records with generation below fence[keyIndex]. A fence applies to the entire input snapshot, regardless of event arrival order. The array is intentionally not chronological.
* Among eligible records for a key: greatest generation wins FIRST; then the source appearing EARLIEST in authority[keyIndex] wins; then greatest revision; then deleted=true wins; then lexicographically smallest id. Clock and array position are NEVER tie-breakers. A newer low-authority generation therefore beats any older generation; within one generation an authoritative old revision beats a newer revision from a lower-authority source.
* A deletion remains a winner (no resurrection/fallback). Its exported value is null. A put exports its given value. Exactly one eligible winner exists for each key. discarded contains ALL IDs other than those four winners, including quarantined and fenced records, sorted lexicographically.

Deployment rules:
* Each job appears exactly once, assigned an integer phase >=1. Phases start at 1 with no gaps. All jobs in one phase upgrade simultaneously in one atomic transaction, so no within-phase mixed-version state is observable. Phases execute sequentially.
* [a,b,false] in precedence means phase[a] <= phase[b]; [a,b,true] means phase[a] < phase[b]. Non-strict cycles require an atomic co-deploy; they are not errors and must not be broken. All pair indices are job indices.
* exclusive pairs cannot share a phase. notBefore [job,p] requires phase[job]>=p. Total effort of one phase must not exceed capacity. A phase lasts the maximum duration of its jobs. downtime is the sum of these phase durations.
* Optimize number of phases first, then downtime, then the entire phase vector lexicographically in jobs order, all minimized. This priority is normative; shortest downtime alone is wrong.

Legacy events, authority manifest, and rolling-compatibility constraints:
{"keys":["account","lease","policy","token"],"sources":["ledger","snapshot","cdc"],"events":[{"id":"e23","key":"token","source":"snapshot","generation":1,"revision":10,"deleted":true,"quarantined":false,"value":"v23","clock":1012},{"id":"e22","key":"policy","source":"ledger","generation":1,"revision":3,"deleted":false,"quarantined":false,"value":"v22","clock":1029},{"id":"e21","key":"lease","source":"cdc","generation":1,"revision":7,"deleted":false,"quarantined":false,"value":"v21","clock":1046},{"id":"e20","key":"account","source":"snapshot","generation":1,"revision":0,"deleted":false,"quarantined":false,"value":"v20","clock":1063},{"id":"e19","key":"token","source":"cdc","generation":2,"revision":4,"deleted":false,"quarantined":false,"value":"v19","clock":1080},{"id":"e18","key":"policy","source":"snapshot","generation":2,"revision":8,"deleted":true,"quarantined":false,"value":"v18","clock":1097},{"id":"e17","key":"lease","source":"ledger","generation":2,"revision":1,"deleted":false,"quarantined":false,"value":"v17","clock":1013},{"id":"e16","key":"account","source":"cdc","generation":2,"revision":5,"deleted":false,"quarantined":false,"value":"v16","clock":1030},{"id":"e15","key":"token","source":"ledger","generation":0,"revision":9,"deleted":false,"quarantined":true,"value":"v15","clock":1047},{"id":"e14","key":"policy","source":"cdc","generation":0,"revision":2,"deleted":false,"quarantined":false,"value":"v14","clock":1064},{"id":"e13","key":"lease","source":"snapshot","generation":0,"revision":6,"deleted":true,"quarantined":false,"value":"v13","clock":1081},{"id":"e12","key":"account","source":"ledger","generation":0,"revision":10,"deleted":false,"quarantined":false,"value":"v12","clock":1098},{"id":"e11","key":"token","source":"snapshot","generation":1,"revision":3,"deleted":false,"quarantined":false,"value":"v11","clock":1014},{"id":"e10","key":"policy","source":"ledger","generation":1,"revision":7,"deleted":false,"quarantined":false,"value":"v10","clock":1031},{"id":"e09","key":"lease","source":"cdc","generation":1,"revision":0,"deleted":false,"quarantined":false,"value":"v9","clock":1048},{"id":"e08","key":"account","source":"snapshot","generation":1,"revision":4,"deleted":true,"quarantined":false,"value":"v8","clock":1065},{"id":"e07","key":"token","source":"cdc","generation":2,"revision":8,"deleted":false,"quarantined":false,"value":"v7","clock":1082},{"id":"e06","key":"policy","source":"snapshot","generation":2,"revision":1,"deleted":false,"quarantined":false,"value":"v6","clock":1099},{"id":"e05","key":"lease","source":"ledger","generation":2,"revision":5,"deleted":false,"quarantined":false,"value":"v5","clock":1015},{"id":"e04","key":"account","source":"cdc","generation":2,"revision":9,"deleted":false,"quarantined":false,"value":"v4","clock":1032},{"id":"e03","key":"token","source":"ledger","generation":0,"revision":2,"deleted":true,"quarantined":false,"value":"v3","clock":1049},{"id":"e02","key":"policy","source":"cdc","generation":0,"revision":6,"deleted":false,"quarantined":true,"value":"v2","clock":1066},{"id":"e01","key":"lease","source":"snapshot","generation":0,"revision":10,"deleted":false,"quarantined":false,"value":"v1","clock":1083},{"id":"e00","key":"account","source":"ledger","generation":0,"revision":3,"deleted":false,"quarantined":false,"value":"v0","clock":1100}],"fence":[0,1,0,1],"authority":[["ledger","snapshot","cdc"],["snapshot","cdc","ledger"],["cdc","ledger","snapshot"],["ledger","snapshot","cdc"]],"jobs":["reader","writer","cache","replay","fence","export","retire"],"capacity":5,"effort":[2,2,1,2,1,2,1],"duration":[1,3,1,3,1,3,1],"precedence":[[0,1,false],[1,0,false],[2,1,false],[3,4,true],[4,6,true],[5,6,false]],"exclusive":[[1,5],[2,4]],"notBefore":[[5,2]]}

Reply ONLY with one JSON object, exactly keys "winners","discarded","phase","duration","downtime" in that order. winners is in keys order; each object has exactly keys "key","winner","deleted","value" in that order, where winner is its event ID. phase is in jobs order; duration is in phase order.`,
    check: {
      kind: 'json_equal',
      value: {
        winners: [
          {
            key: 'account',
            winner: 'e04',
            deleted: false,
            value: 'v4',
          },
          {
            key: 'lease',
            winner: 'e05',
            deleted: false,
            value: 'v5',
          },
          {
            key: 'policy',
            winner: 'e18',
            deleted: true,
            value: null,
          },
          {
            key: 'token',
            winner: 'e07',
            deleted: false,
            value: 'v7',
          },
        ],
        discarded: [
          'e00',
          'e01',
          'e02',
          'e03',
          'e06',
          'e08',
          'e09',
          'e10',
          'e11',
          'e12',
          'e13',
          'e14',
          'e15',
          'e16',
          'e17',
          'e19',
          'e20',
          'e21',
          'e22',
          'e23',
        ],
        phase: [2, 2, 1, 1, 2, 3, 3],
        duration: [3, 3, 3],
        downtime: 9,
      },
    },
  },
  {
    id: 'frontier-refactoring-migration-regional-session-epoch-upgrade',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Plan the regional-session-epoch-upgrade cutover across reader.js, writer.js, cache.js, replay.js, fence.js, export.js and retire.js. Two independent requirements MUST both be met: reconcile the supplied conflicting legacy records and optimize the atomic deployment phases.

Specification priority: the compliance fence invariant below is absolute; the current authority manifest below overrides the older replay runbook. The old runbook says "largest wall clock wins; deploy writers first". It is explicitly obsolete, even when that would save work.

Reconciliation rules:
* Process keys in keys order. Discard quarantined records and records with generation below fence[keyIndex]. A fence applies to the entire input snapshot, regardless of event arrival order. The array is intentionally not chronological.
* Among eligible records for a key: greatest generation wins FIRST; then the source appearing EARLIEST in authority[keyIndex] wins; then greatest revision; then deleted=true wins; then lexicographically smallest id. Clock and array position are NEVER tie-breakers. A newer low-authority generation therefore beats any older generation; within one generation an authoritative old revision beats a newer revision from a lower-authority source.
* A deletion remains a winner (no resurrection/fallback). Its exported value is null. A put exports its given value. Exactly one eligible winner exists for each key. discarded contains ALL IDs other than those four winners, including quarantined and fenced records, sorted lexicographically.

Deployment rules:
* Each job appears exactly once, assigned an integer phase >=1. Phases start at 1 with no gaps. All jobs in one phase upgrade simultaneously in one atomic transaction, so no within-phase mixed-version state is observable. Phases execute sequentially.
* [a,b,false] in precedence means phase[a] <= phase[b]; [a,b,true] means phase[a] < phase[b]. Non-strict cycles require an atomic co-deploy; they are not errors and must not be broken. All pair indices are job indices.
* exclusive pairs cannot share a phase. notBefore [job,p] requires phase[job]>=p. Total effort of one phase must not exceed capacity. A phase lasts the maximum duration of its jobs. downtime is the sum of these phase durations.
* Optimize number of phases first, then downtime, then the entire phase vector lexicographically in jobs order, all minimized. This priority is normative; shortest downtime alone is wrong.

Legacy events, authority manifest, and rolling-compatibility constraints:
{"keys":["account","lease","policy","token"],"sources":["ledger","snapshot","cdc"],"events":[{"id":"e23","key":"token","source":"cdc","generation":2,"revision":2,"deleted":false,"quarantined":false,"value":"v23","clock":1013},{"id":"e22","key":"policy","source":"snapshot","generation":2,"revision":6,"deleted":true,"quarantined":false,"value":"v22","clock":1030},{"id":"e21","key":"lease","source":"ledger","generation":2,"revision":10,"deleted":false,"quarantined":false,"value":"v21","clock":1047},{"id":"e20","key":"account","source":"cdc","generation":2,"revision":3,"deleted":false,"quarantined":false,"value":"v20","clock":1064},{"id":"e19","key":"token","source":"ledger","generation":0,"revision":7,"deleted":false,"quarantined":false,"value":"v19","clock":1081},{"id":"e18","key":"policy","source":"cdc","generation":0,"revision":0,"deleted":false,"quarantined":false,"value":"v18","clock":1098},{"id":"e17","key":"lease","source":"snapshot","generation":0,"revision":4,"deleted":true,"quarantined":false,"value":"v17","clock":1014},{"id":"e16","key":"account","source":"ledger","generation":0,"revision":8,"deleted":false,"quarantined":false,"value":"v16","clock":1031},{"id":"e15","key":"token","source":"snapshot","generation":1,"revision":1,"deleted":false,"quarantined":false,"value":"v15","clock":1048},{"id":"e14","key":"policy","source":"ledger","generation":1,"revision":5,"deleted":false,"quarantined":false,"value":"v14","clock":1065},{"id":"e13","key":"lease","source":"cdc","generation":1,"revision":9,"deleted":false,"quarantined":true,"value":"v13","clock":1082},{"id":"e12","key":"account","source":"snapshot","generation":1,"revision":2,"deleted":true,"quarantined":false,"value":"v12","clock":1099},{"id":"e11","key":"token","source":"cdc","generation":2,"revision":6,"deleted":false,"quarantined":false,"value":"v11","clock":1015},{"id":"e10","key":"policy","source":"snapshot","generation":2,"revision":10,"deleted":false,"quarantined":false,"value":"v10","clock":1032},{"id":"e09","key":"lease","source":"ledger","generation":2,"revision":3,"deleted":false,"quarantined":false,"value":"v9","clock":1049},{"id":"e08","key":"account","source":"cdc","generation":2,"revision":7,"deleted":false,"quarantined":false,"value":"v8","clock":1066},{"id":"e07","key":"token","source":"ledger","generation":0,"revision":0,"deleted":true,"quarantined":false,"value":"v7","clock":1083},{"id":"e06","key":"policy","source":"cdc","generation":0,"revision":4,"deleted":false,"quarantined":false,"value":"v6","clock":1100},{"id":"e05","key":"lease","source":"snapshot","generation":0,"revision":8,"deleted":false,"quarantined":false,"value":"v5","clock":1016},{"id":"e04","key":"account","source":"ledger","generation":0,"revision":1,"deleted":false,"quarantined":false,"value":"v4","clock":1033},{"id":"e03","key":"token","source":"snapshot","generation":1,"revision":5,"deleted":false,"quarantined":false,"value":"v3","clock":1050},{"id":"e02","key":"policy","source":"ledger","generation":1,"revision":9,"deleted":true,"quarantined":false,"value":"v2","clock":1067},{"id":"e01","key":"lease","source":"cdc","generation":1,"revision":2,"deleted":false,"quarantined":false,"value":"v1","clock":1084},{"id":"e00","key":"account","source":"snapshot","generation":1,"revision":6,"deleted":false,"quarantined":true,"value":"v0","clock":1000}],"fence":[1,0,1,0],"authority":[["snapshot","cdc","ledger"],["cdc","ledger","snapshot"],["ledger","snapshot","cdc"],["snapshot","cdc","ledger"]],"jobs":["reader","writer","cache","replay","fence","export","retire"],"capacity":6,"effort":[2,2,1,2,1,2,1],"duration":[2,4,2,4,2,4,2],"precedence":[[0,1,true],[2,1,false],[1,4,false],[4,1,false],[3,5,true],[4,6,true],[5,6,false]],"exclusive":[[2,3],[0,5]],"notBefore":[]}

Reply ONLY with one JSON object, exactly keys "winners","discarded","phase","duration","downtime" in that order. winners is in keys order; each object has exactly keys "key","winner","deleted","value" in that order, where winner is its event ID. phase is in jobs order; duration is in phase order.`,
    check: {
      kind: 'json_equal',
      value: {
        winners: [
          {
            key: 'account',
            winner: 'e08',
            deleted: false,
            value: 'v8',
          },
          {
            key: 'lease',
            winner: 'e21',
            deleted: false,
            value: 'v21',
          },
          {
            key: 'policy',
            winner: 'e10',
            deleted: false,
            value: 'v10',
          },
          {
            key: 'token',
            winner: 'e11',
            deleted: false,
            value: 'v11',
          },
        ],
        discarded: [
          'e00',
          'e01',
          'e02',
          'e03',
          'e04',
          'e05',
          'e06',
          'e07',
          'e09',
          'e12',
          'e13',
          'e14',
          'e15',
          'e16',
          'e17',
          'e18',
          'e19',
          'e20',
          'e22',
          'e23',
        ],
        phase: [1, 2, 1, 2, 2, 3, 3],
        duration: [2, 4, 4],
        downtime: 10,
      },
    },
  },
  {
    id: 'frontier-refactoring-migration-audit-export-redaction-cutover',
    tier: 'frontier',
    taskType: 'refactoring',
    subtaskType: 'migration',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Plan the audit-export-redaction-cutover cutover across reader.js, writer.js, cache.js, replay.js, fence.js, export.js and retire.js. Two independent requirements MUST both be met: reconcile the supplied conflicting legacy records and optimize the atomic deployment phases.

Specification priority: the compliance fence invariant below is absolute; the current authority manifest below overrides the older replay runbook. The old runbook says "largest wall clock wins; deploy writers first". It is explicitly obsolete, even when that would save work.

Reconciliation rules:
* Process keys in keys order. Discard quarantined records and records with generation below fence[keyIndex]. A fence applies to the entire input snapshot, regardless of event arrival order. The array is intentionally not chronological.
* Among eligible records for a key: greatest generation wins FIRST; then the source appearing EARLIEST in authority[keyIndex] wins; then greatest revision; then deleted=true wins; then lexicographically smallest id. Clock and array position are NEVER tie-breakers. A newer low-authority generation therefore beats any older generation; within one generation an authoritative old revision beats a newer revision from a lower-authority source.
* A deletion remains a winner (no resurrection/fallback). Its exported value is null. A put exports its given value. Exactly one eligible winner exists for each key. discarded contains ALL IDs other than those four winners, including quarantined and fenced records, sorted lexicographically.

Deployment rules:
* Each job appears exactly once, assigned an integer phase >=1. Phases start at 1 with no gaps. All jobs in one phase upgrade simultaneously in one atomic transaction, so no within-phase mixed-version state is observable. Phases execute sequentially.
* [a,b,false] in precedence means phase[a] <= phase[b]; [a,b,true] means phase[a] < phase[b]. Non-strict cycles require an atomic co-deploy; they are not errors and must not be broken. All pair indices are job indices.
* exclusive pairs cannot share a phase. notBefore [job,p] requires phase[job]>=p. Total effort of one phase must not exceed capacity. A phase lasts the maximum duration of its jobs. downtime is the sum of these phase durations.
* Optimize number of phases first, then downtime, then the entire phase vector lexicographically in jobs order, all minimized. This priority is normative; shortest downtime alone is wrong.

Legacy events, authority manifest, and rolling-compatibility constraints:
{"keys":["account","lease","policy","token"],"sources":["ledger","snapshot","cdc"],"events":[{"id":"e23","key":"token","source":"ledger","generation":0,"revision":5,"deleted":false,"quarantined":false,"value":"v23","clock":1014},{"id":"e22","key":"policy","source":"cdc","generation":0,"revision":9,"deleted":false,"quarantined":false,"value":"v22","clock":1031},{"id":"e21","key":"lease","source":"snapshot","generation":0,"revision":2,"deleted":true,"quarantined":false,"value":"v21","clock":1048},{"id":"e20","key":"account","source":"ledger","generation":0,"revision":6,"deleted":false,"quarantined":false,"value":"v20","clock":1065},{"id":"e19","key":"token","source":"snapshot","generation":1,"revision":10,"deleted":false,"quarantined":false,"value":"v19","clock":1082},{"id":"e18","key":"policy","source":"ledger","generation":1,"revision":3,"deleted":false,"quarantined":false,"value":"v18","clock":1099},{"id":"e17","key":"lease","source":"cdc","generation":1,"revision":7,"deleted":false,"quarantined":false,"value":"v17","clock":1015},{"id":"e16","key":"account","source":"snapshot","generation":1,"revision":0,"deleted":true,"quarantined":false,"value":"v16","clock":1032},{"id":"e15","key":"token","source":"cdc","generation":2,"revision":4,"deleted":false,"quarantined":false,"value":"v15","clock":1049},{"id":"e14","key":"policy","source":"snapshot","generation":2,"revision":8,"deleted":false,"quarantined":false,"value":"v14","clock":1066},{"id":"e13","key":"lease","source":"ledger","generation":2,"revision":1,"deleted":false,"quarantined":false,"value":"v13","clock":1083},{"id":"e12","key":"account","source":"cdc","generation":2,"revision":5,"deleted":false,"quarantined":false,"value":"v12","clock":1100},{"id":"e11","key":"token","source":"ledger","generation":0,"revision":9,"deleted":true,"quarantined":true,"value":"v11","clock":1016},{"id":"e10","key":"policy","source":"cdc","generation":0,"revision":2,"deleted":false,"quarantined":false,"value":"v10","clock":1033},{"id":"e09","key":"lease","source":"snapshot","generation":0,"revision":6,"deleted":false,"quarantined":false,"value":"v9","clock":1050},{"id":"e08","key":"account","source":"ledger","generation":0,"revision":10,"deleted":false,"quarantined":false,"value":"v8","clock":1067},{"id":"e07","key":"token","source":"snapshot","generation":1,"revision":3,"deleted":false,"quarantined":false,"value":"v7","clock":1084},{"id":"e06","key":"policy","source":"ledger","generation":1,"revision":7,"deleted":true,"quarantined":false,"value":"v6","clock":1000},{"id":"e05","key":"lease","source":"cdc","generation":1,"revision":0,"deleted":false,"quarantined":false,"value":"v5","clock":1017},{"id":"e04","key":"account","source":"snapshot","generation":1,"revision":4,"deleted":false,"quarantined":false,"value":"v4","clock":1034},{"id":"e03","key":"token","source":"cdc","generation":2,"revision":8,"deleted":false,"quarantined":false,"value":"v3","clock":1051},{"id":"e02","key":"policy","source":"snapshot","generation":2,"revision":1,"deleted":false,"quarantined":false,"value":"v2","clock":1068},{"id":"e01","key":"lease","source":"ledger","generation":2,"revision":5,"deleted":true,"quarantined":false,"value":"v1","clock":1085},{"id":"e00","key":"account","source":"cdc","generation":2,"revision":9,"deleted":false,"quarantined":false,"value":"v0","clock":1001}],"fence":[0,1,0,1],"authority":[["cdc","ledger","snapshot"],["ledger","snapshot","cdc"],["snapshot","cdc","ledger"],["cdc","ledger","snapshot"]],"jobs":["reader","writer","cache","replay","fence","export","retire"],"capacity":5,"effort":[2,2,1,2,1,2,1],"duration":[3,1,3,1,3,1,3],"precedence":[[0,2,false],[2,0,false],[0,1,true],[3,4,false],[4,3,false],[4,6,true],[5,6,true]],"exclusive":[[1,5],[2,4]],"notBefore":[]}

Reply ONLY with one JSON object, exactly keys "winners","discarded","phase","duration","downtime" in that order. winners is in keys order; each object has exactly keys "key","winner","deleted","value" in that order, where winner is its event ID. phase is in jobs order; duration is in phase order.`,
    check: {
      kind: 'json_equal',
      value: {
        winners: [
          {
            key: 'account',
            winner: 'e00',
            deleted: false,
            value: 'v0',
          },
          {
            key: 'lease',
            winner: 'e01',
            deleted: true,
            value: null,
          },
          {
            key: 'policy',
            winner: 'e14',
            deleted: false,
            value: 'v14',
          },
          {
            key: 'token',
            winner: 'e03',
            deleted: false,
            value: 'v3',
          },
        ],
        discarded: [
          'e02',
          'e04',
          'e05',
          'e06',
          'e07',
          'e08',
          'e09',
          'e10',
          'e11',
          'e12',
          'e13',
          'e15',
          'e16',
          'e17',
          'e18',
          'e19',
          'e20',
          'e21',
          'e22',
          'e23',
        ],
        phase: [2, 3, 2, 1, 1, 1, 2],
        duration: [3, 3, 1],
        downtime: 7,
      },
    },
  },
];
