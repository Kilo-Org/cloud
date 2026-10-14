import type { DeciderCase } from '../decider-cases';

const CODE_SYS =
  'You are a precise coding assistant. Answer with only what is asked, no explanations.';

export const DEBUGGING_V2_CASES: readonly DeciderCase[] = [
  {
    id: 'debug-rca-v2-concurrent-balance',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      "The two credits should produce 15 but do not. Identify the cause from lost_update, stale_cache, numeric_rounding, or duplicate_callback. Reply with JSON keys \"cause\", \"observed\" in that order; observed is the logged number.\n\n```javascript\nlet balance = 0;\nconst events = [];\nconst { promise: gate, resolve: release } = Promise.withResolvers();\nasync function credit(id, amount) {\n  const before = balance;\n  events.push(id + ':read');\n  await gate;\n  balance = before + amount;\n  events.push(id + ':write');\n}\nasync function main() {\n  const first = credit('a', 7);\n  const second = credit('b', 8);\n  release();\n  await Promise.all([first, second]);\n  console.log(balance);\n}\nmain();\n```",
    check: {
      kind: 'json_equal',
      value: {
        cause: 'lost_update',
        observed: 8,
      },
    },
  },
  {
    id: 'debug-rca-v2-foreach-await',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The caller expects all three results before the returned snapshot. Select the cause: dropped_return, unawaited_callbacks, unstable_sort, shared_input. Reply JSON with keys "cause", "observed"; observed is the logged array.\n\n```javascript\nasync function load(ids) {\n  const rows = [];\n  ids.forEach(async id => {\n    await Promise.resolve();\n    await Promise.resolve();\n    rows.push(id * 10);\n  });\n  return rows.slice();\n}\nasync function main() {\n  const snapshot = await load([3, 1, 2]);\n  await Promise.resolve();\n  console.log(JSON.stringify(snapshot));\n}\nmain();\n```',
    check: {
      kind: 'json_equal',
      value: {
        cause: 'unawaited_callbacks',
        observed: [],
      },
    },
  },
  {
    id: 'debug-rca-v2-tenant-cache',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      "The second tenant receives a wrong price. Select cache_key_collision, stale_closure, reference_alias, or integer_overflow. Reply JSON keys \"cause\", \"observed\"; observed is the logged array.\n\n```javascript\nconst prices = new Map([\n  ['north:sku-7', 120],\n  ['south:sku-7', 95],\n  ['south:sku-8', 44],\n]);\nconst cache = new Map();\nfunction price(tenant, sku) {\n  const key = sku;\n  if (cache.has(key)) return cache.get(key);\n  const value = prices.get(tenant + ':' + sku);\n  cache.set(key, value);\n  return value;\n}\nconst results = [price('north', 'sku-7'), price('south', 'sku-7'), price('south', 'sku-8')];\nconsole.log(JSON.stringify(results));\n```",
    check: {
      kind: 'json_equal',
      value: {
        cause: 'cache_key_collision',
        observed: [120, 120, 44],
      },
    },
  },
  {
    id: 'debug-rca-v2-identity-deduplication',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      "The pipeline intends distinct ids with totals, but counts duplicate records. Select identity_equality, hash_collision, sparse_array, or key_coercion. Reply JSON keys \"cause\", \"observed\"; observed is the logged object.\n\n```javascript\nconst shared = { id: 'b', amount: 4 };\nconst rows = [\n  { id: 'a', amount: 3 },\n  { id: 'a', amount: 3 },\n  shared,\n  shared,\n];\nconst distinct = [...new Set(rows)];\nconst totals = distinct.reduce((out, row) => {\n  out[row.id] = (out[row.id] ?? 0) + row.amount;\n  return out;\n}, {});\nconsole.log(JSON.stringify({ count: distinct.length, totals }));\n```",
    check: {
      kind: 'json_equal',
      value: {
        cause: 'identity_equality',
        observed: {
          count: 3,
          totals: {
            a: 6,
            b: 4,
          },
        },
      },
    },
  },
  {
    id: 'debug-rca-v2-global-validator',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      "Repeated valid inputs alternate unexpectedly. Select regex_cursor_state, unicode_normalization, accidental_coercion, or mutable_input. Reply JSON keys \"cause\", \"observed\"; observed is the logged array.\n\n```javascript\nconst validator = /^[a-z]+$/g;\nfunction validate(values) {\n  return values.map(value => {\n    const before = validator.lastIndex;\n    const valid = validator.test(value);\n    const after = validator.lastIndex;\n    return { value, before, valid, after };\n  });\n}\nfunction audit(batches) {\n  const trace = [];\n  const accepted = [];\n  for (const batch of batches) {\n    const rows = validate(batch);\n    for (const row of rows) {\n      trace.push(row.value + ':' + row.before + '>' + row.after);\n      if (row.valid) accepted.push(row.value);\n    }\n  }\n  return { accepted, trace };\n}\nconst batches = [\n  ['aa', 'bb', '123'],\n  ['c', 'dddd', 'ee'],\n  ['', 'f'],\n];\nconst report = audit(batches);\nconst summary = [report.accepted, report.trace];\nconsole.log(JSON.stringify(summary));\n```",
    check: {
      kind: 'json_equal',
      value: {
        cause: 'regex_cursor_state',
        observed: [
          ['aa', 'c', 'ee', 'f'],
          ['aa:0>2', 'bb:2>0', '123:0>0', 'c:0>1', 'dddd:1>0', 'ee:0>2', ':2>0', 'f:0>1'],
        ],
      },
    },
  },
  {
    id: 'debug-rca-v2-lexical-priority',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      "Jobs should sort ascending numerically by priority. Select lexical_comparison, comparator_mutation, unstable_iteration, or missing_filter. Reply JSON keys \"cause\", \"observed\"; observed is the logged id array.\n\n```javascript\nconst jobs = [\n  { id: 'a', priority: 20 },\n  { id: 'b', priority: 3 },\n  { id: 'c', priority: 100 },\n  { id: 'd', priority: 11 },\n];\nconst byPriority = jobs.map(job => job.priority).sort();\nconst ids = byPriority.map(priority => jobs.find(job => job.priority === priority).id);\nconsole.log(JSON.stringify(ids));\n```",
    check: {
      kind: 'json_equal',
      value: {
        cause: 'lexical_comparison',
        observed: ['c', 'd', 'a', 'b'],
      },
    },
  },
  {
    id: 'debug-rca-v2-map-parser-arity',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      "The parser should preserve the decimal integers in each batch, but its results are corrupted. Diagnose the root cause in the current code; do not fix it or report the corrected program's output. Select exactly one cause: callback_arity, whitespace_trimming, unsafe_integer, or sparse_iteration. Reply only with one JSON object containing exactly the keys \"cause\", \"observed\" in that order. The cause must be the exact selected token as a JSON string. The observed value must be the nested JSON array printed by the buggy program, not a JSON-encoded string; preserve its nesting and order, use JSON numbers for numeric entries and JSON null for null entries.\n\n```javascript\nfunction parseBatch(values) {\n  const parsed = values.map(parseInt);\n  return parsed.map(value => Number.isFinite(value) ? value : null);\n}\nfunction summarize(batch) {\n  const parsed = parseBatch(batch);\n  let valid = 0;\n  let sum = 0;\n  const rejected = [];\n  for (let index = 0; index < parsed.length; index++) {\n    const value = parsed[index];\n    if (value === null) {\n      rejected.push(index);\n    } else {\n      valid++;\n      sum += value;\n    }\n  }\n  return { parsed, valid, sum, rejected };\n}\nconst batches = [\n  ['10', '10', '10', '10'],\n  ['11', '01', '11', '21', '10'],\n];\nconst reports = batches.map(summarize);\nconst totals = reports.map(report => report.sum);\nconst values = reports.map(report => report.parsed);\nconsole.log(JSON.stringify([values, totals, reports.map(report => report.rejected)]));\n```",
    check: {
      kind: 'json_equal',
      value: {
        cause: 'callback_arity',
        observed: [
          [
            [10, null, 2, 3],
            [11, null, 3, 7, 4],
          ],
          [15, 25],
          [[1], [1]],
        ],
      },
    },
  },
  {
    id: 'debug-rca-v2-nested-clone',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      "Editing the draft must not edit the original. Select nested_alias, prototype_lookup, array_holes, or default_parameter. Reply JSON keys \"cause\", \"observed\"; observed is the logged array.\n\n```javascript\nfunction makeDraft(source) {\n  return { ...source };\n}\nfunction saveDraft(draft) {\n  return { ...draft, meta: { ...draft.meta } };\n}\nfunction editDraft(draft, label) {\n  draft.meta.tags.push(label);\n  draft.count += 2;\n}\nconst original = {\n  meta: { tags: ['stable'] },\n  count: 1,\n};\nconst draft = makeDraft(original);\neditDraft(draft, 'draft');\nconst saved = saveDraft(draft);\nsaved.meta.tags[0] = 'changed';\nconst another = makeDraft(original);\neditDraft(another, 'again');\nconst result = [\n  original.meta.tags.join('/'),\n  original.count,\n  draft.count,\n  another.count,\n  saved.meta === draft.meta,\n  saved.meta.tags === original.meta.tags,\n];\nconsole.log(JSON.stringify(result));\n```",
    check: {
      kind: 'json_equal',
      value: {
        cause: 'nested_alias',
        observed: ['changed/draft/again', 1, 3, 3, false, true],
      },
    },
  },
  {
    id: 'debug-rca-v2-sparse-workers',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The author expects four generated values. Select array_holes, falsey_filter, integer_overflow, or async_rejection. Reply JSON keys "cause", "observed"; observed is the logged object.\n\n```javascript\nlet calls = 0;\nconst slots = new Array(4);\nslots[2] = 5;\nconst values = slots.map((value, index) => {\n  calls++;\n  return (value ?? 0) + index;\n});\nconsole.log(JSON.stringify({ calls, values: [...values] }));\n```',
    check: {
      kind: 'json_equal',
      value: {
        cause: 'array_holes',
        observed: {
          calls: 1,
          values: [null, null, 7, null],
        },
      },
    },
  },
  {
    id: 'debug-rca-v2-finally-result',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      "Successful parsing and malformed input produce the same result. Select finally_return_override, parse_coercion, catch_scope, or hoisting. Reply JSON keys \"cause\", \"observed\"; observed is the logged array.\n\n```javascript\nfunction read(text) {\n  try {\n    const row = JSON.parse(text);\n    return { status: 'ok', value: row.value };\n  } catch {\n    return { status: 'bad' };\n  } finally {\n    return { status: 'closed' };\n  }\n}\nconsole.log(JSON.stringify([read('{\"value\":7}'), read('{')]));\n```",
    check: {
      kind: 'json_equal',
      value: {
        cause: 'finally_return_override',
        observed: [
          {
            status: 'closed',
          },
          {
            status: 'closed',
          },
        ],
      },
    },
  },
  {
    id: 'debug-rca-v2-inherited-cache',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      "Only own cached values should be used. Select prototype_lookup, numeric_coercion, insertion_order, or lost_update. Reply JSON keys \"cause\", \"observed\"; observed is the logged array.\n\n```javascript\nconst fallback = { alpha: 90 };\nconst cache = Object.create(fallback);\ncache.beta = 0;\nlet loads = 0;\nfunction lookup(key) {\n  if (key in cache) return cache[key];\n  loads++;\n  return cache[key] = key.length;\n}\nconst results = [lookup('alpha'), lookup('beta'), lookup('gamma')];\nconsole.log(JSON.stringify([...results, loads]));\n```",
    check: {
      kind: 'json_equal',
      value: {
        cause: 'prototype_lookup',
        observed: [90, 0, 5, 1],
      },
    },
  },
  {
    id: 'debug-rca-v2-zero-default',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Bug report: I explicitly set retries=0 to disable retries and delay=0 to run immediately, but the normalized settings unexpectedly enable three retries and a delay of 40. Null settings are supposed to use defaults, while explicit zero settings must remain zero. Diagnose the root cause in the code below; do not repair the code. Choose exactly one cause: truthiness_default, integer_truncation, mutation_alias, or property_order. Reply only with JSON keys "cause", "observed" in that order; observed must be the logged array that reproduces the symptom.\n\n```javascript\nconst defaults = { retries: 3, delay: 40 };\nfunction options(input) {\n  return {\n    retries: input.retries || defaults.retries,\n    delay: input.delay || defaults.delay,\n  };\n}\nconst a = options({ retries: 0, delay: 0 });\nconst b = options({ retries: null, delay: 5 });\nconsole.log(JSON.stringify([a.retries, a.delay, b.retries, b.delay]));\n```',
    check: {
      kind: 'json_equal',
      value: {
        cause: 'truthiness_default',
        observed: [3, 40, 3, 5],
      },
    },
  },
  {
    id: 'debug-rca-v2-unicode-units',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      "The quota is meant to count Unicode code points, not grapheme clusters or bytes. Select utf16_code_units, utf8_bytes, combining_normalization, or integer_rounding. Reply JSON keys \"cause\", \"observed\"; observed is the logged array.\n\n```javascript\nconst labels = ['A😀B', 'é', 'é'];\nfunction quota(text) {\n  return { used: text.length, remaining: 5 - text.length };\n}\nconsole.log(JSON.stringify(labels.map(label => quota(label).used)));\n```",
    check: {
      kind: 'json_equal',
      value: {
        cause: 'utf16_code_units',
        observed: [4, 1, 2],
      },
    },
  },
  {
    id: 'debug-rca-v2-identifier-precision',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      "Distinct integer ids collapse after parsing. Select unsafe_integer_precision, lexical_comparison, hash_collision, or octal_parsing. Reply JSON keys \"cause\", \"observed\"; observed is the logged object.\n\n```javascript\nconst textIds = ['9007199254740992', '9007199254740993', '9007199254740994'];\nconst ids = textIds.map(Number);\nconst unique = new Set(ids);\nconsole.log(JSON.stringify({ size: unique.size, equal: ids[0] === ids[1], last: String(ids[2]) }));\n```",
    check: {
      kind: 'json_equal',
      value: {
        cause: 'unsafe_integer_precision',
        observed: {
          size: 2,
          equal: true,
          last: '9007199254740994',
        },
      },
    },
  },
  {
    id: 'debug-rca-v2-splice-skip',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      'All negative entries should be deleted. Select shifted_index_skip, sparse_array, comparator_error, or shared_reference. Reply JSON keys "cause", "observed"; observed is the logged array.\n\n```javascript\nfunction clean(readings) {\n  const removed = [];\n  for (let index = 0; index < readings.length; index++) {\n    if (readings[index] < 0) {\n      removed.push(readings[index]);\n      readings.splice(index, 1);\n    }\n  }\n  return removed;\n}\nfunction analyze(input) {\n  const readings = input.slice();\n  const first = clean(readings);\n  const afterFirst = readings.slice();\n  const second = clean(readings);\n  const afterSecond = readings.slice();\n  return { first, afterFirst, second, afterSecond };\n}\nconst batches = [\n  [4, -1, -2, 5, -3, -4, 6],\n  [-8, -7, -6, 1],\n];\nconst reports = batches.map(analyze);\nconst result = reports.map(report => [\n  report.first,\n  report.afterFirst,\n  report.second,\n  report.afterSecond,\n]);\nconsole.log(JSON.stringify(result));\n```',
    check: {
      kind: 'json_equal',
      value: {
        cause: 'shifted_index_skip',
        observed: [
          [
            [-1, -3],
            [4, -2, 5, -4, 6],
            [-2, -4],
            [4, 5, 6],
          ],
          [[-8, -6], [-7, 1], [-7], [1]],
        ],
      },
    },
  },
  {
    id: 'debug-rca-v2-loop-binding',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      "Each handler should capture its own row index. Select shared_loop_binding, reference_alias, async_race, or arithmetic_precedence. Reply JSON keys \"cause\", \"observed\"; observed is the logged array.\n\n```javascript\nfunction createHandlers(rows) {\n  const handlers = [];\n  for (var index = 0; index < rows.length; index++) {\n    const label = rows[index];\n    const snapshot = index;\n    handlers.push(() => {\n      return {\n        label,\n        snapshot,\n        live: index,\n        current: rows[snapshot] ?? 'missing',\n      };\n    });\n  }\n  return handlers;\n}\nconst rows = ['red', 'green', 'blue'];\nconst handlers = createHandlers(rows);\nrows[1] = 'lime';\nrows.pop();\nrows.push('cyan');\nrows.push('amber');\nconst first = handlers[0]();\nconst last = handlers[2]();\nconst output = [\n  first.label + ':' + first.snapshot + ':' + first.live + ':' + first.current,\n  handlers[1]().label + ':' + handlers[1]().current,\n  last.label + ':' + last.snapshot + ':' + last.live + ':' + last.current,\n];\nconsole.log(JSON.stringify(output));\n```",
    check: {
      kind: 'json_equal',
      value: {
        cause: 'shared_loop_binding',
        observed: ['red:0:3:red', 'green:lime', 'blue:2:3:cyan'],
      },
    },
  },
  {
    id: 'debug-rca-v2-reduce-seed',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The accumulator must always be a number. Select omitted_initial_accumulator, parse_radix, integer_overflow, or wrong_sort. Reply JSON keys "cause", "observed"; observed is the logged array.\n\n```javascript\nfunction total(rows) {\n  return rows.reduce((sum, row) => sum + row.amount);\n}\nfunction report(rows) {\n  try {\n    const value = total(rows);\n    return {\n      type: typeof value,\n      value,\n      finite: Number.isFinite(value),\n    };\n  } catch (error) {\n    return { error: error.name };\n  }\n}\nconst batches = [\n  [],\n  [{ amount: 5 }],\n  [{ amount: 5 }, { amount: 7 }],\n  [{ amount: 0 }, { amount: -2 }, { amount: 3 }],\n];\nconst reports = batches.map(report);\nconst result = reports.map(row => {\n  if (row.error) return [row.error];\n  return [\n    row.type,\n    row.value,\n    row.finite,\n  ];\n});\nconsole.log(JSON.stringify(result));\n```',
    check: {
      kind: 'json_equal',
      value: {
        cause: 'omitted_initial_accumulator',
        observed: [
          ['TypeError'],
          [
            'object',
            {
              amount: 5,
            },
            false,
          ],
          ['string', '[object Object]7', false],
          ['string', '[object Object]-23', false],
        ],
      },
    },
  },
  {
    id: 'debug-rca-v2-catch-recovery',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      "A failed operation must reject, but the caller sees success. Select swallowed_rejection, stale_cache, duplicate_execution, or microtask_starvation. Reply JSON keys \"cause\", \"observed\"; observed is the logged array.\n\n```javascript\nconst events = [];\nasync function operation() {\n  throw new Error('offline');\n}\noperation()\n  .catch(error => {\n    events.push('logged:' + error.message);\n  })\n  .then(value => {\n    events.push('success:' + String(value));\n  }, error => {\n    events.push('failure:' + error.message);\n  })\n  .then(() => console.log(JSON.stringify(events)));\n```",
    check: {
      kind: 'json_equal',
      value: {
        cause: 'swallowed_rejection',
        observed: ['logged:offline', 'success:undefined'],
      },
    },
  },
  {
    id: 'debug-rca-v2-nullable-destructuring',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The default is intended for missing and null limits, but null leaks through. Select undefined_only_default, coercive_equality, prototype_pollution, or integer_precision. Reply JSON keys "cause", "observed"; observed is the logged array.\n\n```javascript\nfunction normalize(input) {\n  const { limit = 10 } = input;\n  return { limit, doubled: limit * 2 };\n}\nconst inputs = [{}, { limit: null }, { limit: 0 }];\nconsole.log(JSON.stringify(inputs.map(normalize)));\n```',
    check: {
      kind: 'json_equal',
      value: {
        cause: 'undefined_only_default',
        observed: [
          {
            limit: 10,
            doubled: 20,
          },
          {
            limit: null,
            doubled: 0,
          },
          {
            limit: 0,
            doubled: 0,
          },
        ],
      },
    },
  },
  {
    id: 'debug-rca-v2-nonfinite-transport',
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    systemPrompt: CODE_SYS,
    userPrompt:
      'Transport loses the distinction among three numeric results. Select nonfinite_json_conversion, sparse_iteration, decimal_rounding, or key_reordering. Reply JSON keys "cause", "observed"; observed is the logged round-tripped object.\n\n```javascript\nconst measurements = { missing: NaN, high: Infinity, low: -Infinity, valid: 0 };\nconst wire = JSON.stringify(measurements);\nconst decoded = JSON.parse(wire);\nconsole.log(JSON.stringify(decoded));\n```',
    check: {
      kind: 'json_equal',
      value: {
        cause: 'nonfinite_json_conversion',
        observed: {
          missing: null,
          high: null,
          low: null,
          valid: 0,
        },
      },
    },
  },
  {
    id: 'debug-fix-v2-lower-bound-duplicates',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "lowerBound must return the first index with value >= target, or the array length. The watchdog protects this buggy version from hanging; remove its effect by fixing the search update. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nfunction lowerBound(values, target) {\n  let lo = 0;\n  let hi = values.length;\n  let steps = 0;\n  while (lo < hi) {\n    if (++steps > 20) return -99;\n    const mid = lo + Math.floor((hi - lo) / 2);\n    if (values[mid] < target) {\n      lo = mid;\n    } else {\n      hi = mid;\n    }\n  }\n  return lo;\n}\nfunction locate(values, targets) {\n  return targets.map(target => {\n    const index = lowerBound(values, target);\n    return { target, index, found: values[index] === target };\n  });\n}\nconst values = [-3, 0, 0, 0, 7, 9];\nconst targets = [-4, 0, 1, 9, 10];\nconst result = locate(values, targets);\nconsole.log(JSON.stringify(result));\n```",
    check: {
      kind: 'json_equal',
      value: [
        {
          target: -4,
          index: 0,
          found: false,
        },
        {
          target: 0,
          index: 1,
          found: true,
        },
        {
          target: 1,
          index: 4,
          found: false,
        },
        {
          target: 9,
          index: 5,
          found: true,
        },
        {
          target: 10,
          index: 6,
          found: false,
        },
      ],
    },
  },
  {
    id: 'debug-fix-v2-inclusive-range-prefix',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "The prefix array starts with zero. sum(lo, hi) must include both endpoints, including singleton ranges. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nconst input = [5, -2, 7, 0, -3];\nconst prefix = [0];\nfor (const value of input) {\n  prefix.push(prefix[prefix.length - 1] + value);\n}\nfunction sum(lo, hi) {\n  return prefix[hi] - prefix[lo];\n}\nconst ranges = [[0, 0], [1, 3], [0, 4], [4, 4]];\nconsole.log(JSON.stringify(ranges.map(([lo, hi]) => sum(lo, hi))));\n```",
    check: {
      kind: 'json_equal',
      value: [5, 5, 7, -3],
    },
  },
  {
    id: 'debug-fix-v2-half-open-overlap',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "Intervals are half-open [start,end); two intervals touching at an endpoint do not overlap. Each input interval has positive length. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nfunction conflicts(a, b) {\n  return a[0] <= b[1] && b[0] <= a[1];\n}\nconst pairs = [\n  [[1, 4], [4, 8]],\n  [[1, 5], [4, 8]],\n  [[-3, 0], [0, 2]],\n  [[2, 6], [3, 4]],\n];\nconsole.log(JSON.stringify(pairs.map(([a, b]) => conflicts(a, b))));\n```",
    check: {
      kind: 'json_equal',
      value: [false, true, false, true],
    },
  },
  {
    id: 'debug-fix-v2-lru-touch-order',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "The Map is ordered least-recently-used first. Every get of an existing key must make that key most recent without changing its value. Repair get; put and eviction are correct. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nfunction createCache(capacity) {\n  const entries = new Map();\n  return {\n    get(key) {\n      if (!entries.has(key)) return null;\n      const value = entries.get(key);\n      entries.set(key, value);\n      return value;\n    },\n    put(key, value) {\n      entries.delete(key);\n      entries.set(key, value);\n      if (entries.size > capacity) {\n        const oldest = entries.keys().next().value;\n        entries.delete(oldest);\n      }\n    },\n    keys() {\n      return [...entries.keys()];\n    },\n  };\n}\nconst cache = createCache(2);\ncache.put('a', 0);\ncache.put('b', 2);\nconst first = cache.get('a');\ncache.put('c', 3);\nconst second = cache.get('b');\nconst third = cache.get('c');\nconsole.log(JSON.stringify({ first, second, third, keys: cache.keys() }));\n```",
    check: {
      kind: 'json_equal',
      value: {
        first: 0,
        second: null,
        third: 3,
        keys: ['a', 'c'],
      },
    },
  },
  {
    id: 'debug-fix-v2-numeric-tie-sort',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "Order by ascending priority, then ascending numeric sequence. The comparator mistakenly sorts sequence strings lexically. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nconst jobs = [\n  { id: 'a', priority: 2, sequence: '2' },\n  { id: 'b', priority: 1, sequence: '11' },\n  { id: 'c', priority: 1, sequence: '3' },\n  { id: 'd', priority: 2, sequence: '10' },\n];\njobs.sort((a, b) => a.priority - b.priority || a.sequence.localeCompare(b.sequence));\nconsole.log(JSON.stringify(jobs.map(job => job.id)));\n```",
    check: {
      kind: 'json_equal',
      value: ['c', 'b', 'a', 'd'],
    },
  },
  {
    id: 'debug-fix-v2-async-reduce-accumulator',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "The asynchronous reducer must await the preceding accumulated numeric total before adding the next row. Keep the final await. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nasync function amount(row) {\n  await Promise.resolve();\n  return row.base * row.quantity;\n}\nasync function total(rows) {\n  return await rows.reduce(async (sum, row) => {\n    const value = await amount(row);\n    return sum + value;\n  }, 0);\n}\nconst rows = [{ base: 3, quantity: 2 }, { base: -1, quantity: 4 }, { base: 5, quantity: 3 }];\ntotal(rows).then(value => console.log(JSON.stringify(value)));\n```",
    check: {
      kind: 'exact',
      value: '17',
    },
  },
  {
    id: 'debug-fix-v2-memoized-zero',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "Cached zero and false are legitimate hits. Repair only the hit condition so each distinct key is loaded once. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nconst cache = new Map();\nlet calls = 0;\nfunction load(key) {\n  calls++;\n  return key === 'zero' ? 0 : key === 'flag' ? false : 7;\n}\nfunction lookup(key) {\n  if (cache.get(key)) return cache.get(key);\n  const value = load(key);\n  cache.set(key, value);\n  return value;\n}\nconst values = ['zero', 'flag', 'other', 'zero', 'flag', 'other'].map(lookup);\nconsole.log(JSON.stringify({ values, calls }));\n```",
    check: {
      kind: 'json_equal',
      value: {
        values: [0, false, 7, 0, false, 7],
        calls: 3,
      },
    },
  },
  {
    id: 'debug-fix-v2-literal-regex-source',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "The dynamically constructed regular expression must match the literal string a+b.c, anchored to the whole input. Correct the pattern construction; do not change the inputs. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nconst literal = 'a+b.c';\nconst pattern = new RegExp('^' + literal + '$');\nconst samples = ['a+b.c', 'aaabxc', 'ab.c', 'xa+b.c', 'a+b.cx'];\nconsole.log(JSON.stringify(samples.map(value => pattern.test(value))));\n```",
    check: {
      kind: 'json_equal',
      value: [true, false, false, false, false],
    },
  },
  {
    id: 'debug-fix-v2-ring-negative-offset',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "ring(index,size) must map every integer index into [0,size), including negative multiples and offsets. Correct the remainder expression. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nfunction ring(index, size) {\n  return index % size;\n}\nconst indexes = [-11, -10, -1, 0, 1, 12];\nconst slots = ['a', 'b', 'c', 'd', 'e'];\nconst result = indexes.map(index => {\n  const offset = ring(index, slots.length);\n  return { offset, value: slots[offset] ?? null };\n});\nconsole.log(JSON.stringify(result));\n```",
    check: {
      kind: 'json_equal',
      value: [
        {
          offset: 4,
          value: 'e',
        },
        {
          offset: 0,
          value: 'a',
        },
        {
          offset: 4,
          value: 'e',
        },
        {
          offset: 0,
          value: 'a',
        },
        {
          offset: 1,
          value: 'b',
        },
        {
          offset: 2,
          value: 'c',
        },
      ],
    },
  },
  {
    id: 'debug-fix-v2-utf8-budget',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "The message budget is three UTF-8 bytes, not UTF-16 code units. Repair the length measurement, without altering the boundary <= budget. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nconst budget = 3;\nfunction fits(text) {\n  const bytes = text.length;\n  return bytes <= budget;\n}\nconst messages = ['abc', 'éa', '😀', '€', 'éé', ''];\nconsole.log(JSON.stringify(messages.map(fits)));\n```",
    check: {
      kind: 'json_equal',
      value: [true, true, false, true, false, true],
    },
  },
  {
    id: 'debug-fix-v2-unsigned-flags',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "The extractor must interpret flags as an unsigned 32-bit value and return its upper eight bits (0..255), rather than sign-extending. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nfunction upperByte(flags) {\n  return flags >> 24;\n}\nconst words = [0x00000000, 0x7f123456, 0x80123456, 0xff000001];\nconsole.log(JSON.stringify(words.map(upperByte)));\n```",
    check: {
      kind: 'json_equal',
      value: [0, 127, 128, 255],
    },
  },
  {
    id: 'debug-fix-v2-large-id-increment',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "nextId must add exactly one to a decimal integer string without ever rounding through Number; the output remains a string. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nfunction nextId(text) {\n  return String(Number(text) + 1);\n}\nconst ids = ['9', '9007199254740992', '9007199254740993', '999999999999999999999'];\nconsole.log(JSON.stringify(ids.map(nextId)));\n```",
    check: {
      kind: 'json_equal',
      value: ['10', '9007199254740993', '9007199254740994', '1000000000000000000000'],
    },
  },
  {
    id: 'debug-fix-v2-expiry-boundary',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "A token is valid only while now < expiresAt. At the expiry instant it is already expired. Leave missing-token handling unchanged. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nfunction valid(token, now) {\n  if (token === null) return false;\n  return now <= token.expiresAt;\n}\nconst token = { expiresAt: 100 };\nconsole.log(JSON.stringify([valid(token, 99), valid(token, 100), valid(token, 101), valid(null, 0)]));\n```",
    check: {
      kind: 'json_equal',
      value: [true, false, false, false],
    },
  },
  {
    id: 'debug-fix-v2-clamped-month',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "addMonth must move a UTC date forward one calendar month, clamping its original day to the target month's last day. Repair the implementation, not the fixtures. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nfunction addMonth(text) {\n  const date = new Date(text + 'T00:00:00Z');\n  date.setUTCMonth(date.getUTCMonth() + 1);\n  return date.toISOString().slice(0, 10);\n}\nconst dates = ['2024-01-31', '2023-01-31', '2024-02-29', '2024-12-31'];\nconsole.log(JSON.stringify(dates.map(addMonth)));\n```",
    check: {
      kind: 'json_equal',
      value: ['2024-02-29', '2023-02-28', '2024-03-29', '2025-01-31'],
    },
  },
  {
    id: 'debug-fix-v2-patch-null-vs-undefined',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "An undefined patch value leaves a field unchanged; null explicitly clears it; all other values, including 0 and false, replace it. Repair the condition. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nfunction patch(base, changes) {\n  const result = { ...base };\n  for (const [key, value] of Object.entries(changes)) {\n    if (value != null) result[key] = value;\n  }\n  return result;\n}\nconst base = { name: 'old', count: 8, enabled: true, note: 'keep' };\nconst changes = { name: null, count: 0, enabled: false, note: undefined };\nconsole.log(JSON.stringify(patch(base, changes)));\n```",
    check: {
      kind: 'json_equal',
      value: {
        name: null,
        count: 0,
        enabled: false,
        note: 'keep',
      },
    },
  },
  {
    id: 'debug-fix-v2-composite-dedupe',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "Keep the first occurrence of each exact pair of strings. Separator characters may occur inside either string, so concatenating with a colon is not an injective key. Correct the key. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nconst pairs = [['a:b', 'c'], ['a', 'b:c'], ['a:b', 'c'], ['', ':'], [':', '']];\nconst seen = new Set();\nconst output = [];\nfor (const pair of pairs) {\n  const key = pair[0] + ':' + pair[1];\n  if (seen.has(key)) continue;\n  seen.add(key);\n  output.push(pair);\n}\nconsole.log(JSON.stringify(output));\n```",
    check: {
      kind: 'json_equal',
      value: [
        ['a:b', 'c'],
        ['a', 'b:c'],
        ['', ':'],
        [':', ''],
      ],
    },
  },
  {
    id: 'debug-fix-v2-heap-smallest-child',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "pop removes the minimum from a min-heap. Sift-down must compare against the smaller existing child. Repair the chosen-child expression; other heap operations are correct. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nconst heap = [1, 4, 2, 8, 7, 3, 6];\nfunction pop() {\n  const result = heap[0];\n  const last = heap.pop();\n  if (heap.length === 0) return result;\n  heap[0] = last;\n  let parent = 0;\n  while (2 * parent + 1 < heap.length) {\n    const left = 2 * parent + 1;\n    const right = left + 1;\n    const child = left;\n    if (heap[parent] <= heap[child]) break;\n    [heap[parent], heap[child]] = [heap[child], heap[parent]];\n    parent = child;\n  }\n  return result;\n}\nconst result = [];\nwhile (heap.length) result.push(pop());\nconsole.log(JSON.stringify(result));\n```",
    check: {
      kind: 'json_equal',
      value: [1, 2, 3, 4, 6, 7, 8],
    },
  },
  {
    id: 'debug-fix-v2-cursor-tie-break',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "Rows are sorted by (time,id) ascending. page must include rows strictly after the complete cursor tuple, including rows at the same timestamp with a greater id. Correct the filter predicate. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nconst rows = [\n  { time: 10, id: 'a' },\n  { time: 10, id: 'b' },\n  { time: 10, id: 'c' },\n  { time: 11, id: 'a' },\n  { time: 12, id: 'a' },\n];\nfunction page(cursor, size) {\n  return rows.filter(row => row.time > cursor.time).slice(0, size).map(row => row.id + ':' + row.time);\n}\nconsole.log(JSON.stringify([page({ time: 10, id: 'a' }, 3), page({ time: 10, id: 'c' }, 2)]));\n```",
    check: {
      kind: 'json_equal',
      value: [
        ['b:10', 'c:10', 'a:11'],
        ['a:11', 'a:12'],
      ],
    },
  },
  {
    id: 'debug-fix-v2-topological-indegree',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "Each edge [from,to] means from must run before to. Correct the indegree update. Node insertion order and FIFO queue order break ties deterministically. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nconst nodes = ['a', 'b', 'c', 'd', 'e'];\nconst edges = [['a', 'c'], ['b', 'c'], ['c', 'd'], ['b', 'e']];\nconst indegree = new Map(nodes.map(node => [node, 0]));\nconst outgoing = new Map(nodes.map(node => [node, []]));\nfor (const [from, to] of edges) {\n  outgoing.get(from).push(to);\n  indegree.set(from, indegree.get(from) + 1);\n}\nconst queue = nodes.filter(node => indegree.get(node) === 0);\nconst ordered = [];\nwhile (queue.length) {\n  const node = queue.shift();\n  ordered.push(node);\n  for (const next of outgoing.get(node)) {\n    indegree.set(next, indegree.get(next) - 1);\n    if (indegree.get(next) === 0) queue.push(next);\n  }\n}\nconsole.log(JSON.stringify(ordered));\n```",
    check: {
      kind: 'json_equal',
      value: ['a', 'b', 'c', 'e', 'd'],
    },
  },
  {
    id: 'debug-fix-v2-retry-total-attempts',
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    systemPrompt: CODE_SYS,
    userPrompt:
      "attempts is the total maximum number of calls, not additional retries. For each fixture, the operation fails for failUntil calls, then succeeds. Correct the loop boundary without changing the error behavior. Repair the bug while preserving the stated contract. Reply only with the final corrected program's logged JSON value, not code or an explanation.\n\n```javascript\nasync function scenario(attempts, failUntil) {\n  let calls = 0;\n  async function operation() {\n    calls++;\n    if (calls <= failUntil) throw new Error('busy');\n    return 'ok';\n  }\n  try {\n    for (let index = 0; index <= attempts; index++) {\n      try {\n        const value = await operation();\n        return { calls, value };\n      } catch (error) {\n        if (index === attempts - 1) throw error;\n      }\n    }\n    return { calls, value: 'exhausted' };\n  } catch {\n    return { calls, value: 'failed' };\n  }\n}\nPromise.all([scenario(0, 0), scenario(1, 1), scenario(3, 2), scenario(3, 5)])\n  .then(result => console.log(JSON.stringify(result)));\n```",
    check: {
      kind: 'json_equal',
      value: [
        {
          calls: 0,
          value: 'exhausted',
        },
        {
          calls: 1,
          value: 'failed',
        },
        {
          calls: 3,
          value: 'ok',
        },
        {
          calls: 3,
          value: 'failed',
        },
      ],
    },
  },
  {
    id: 'debug-repair-v2-group-first-seen',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The implementation below is correct. A test has a stale expected JSON snapshot [{"team":"1","ids":[4]},{"team":"2","ids":[2,5]},{"team":"10","ids":[1,3]}]. Groups retain first-seen key order; each group lists ids in input order. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nfunction group(rows) {\n  const groups = new Map();\n  for (const row of rows) {\n    if (!groups.has(row.team)) groups.set(row.team, []);\n    groups.get(row.team).push(row.id);\n  }\n  return [...groups].map(([team, ids]) => ({ team, ids }));\n}\nconst rows = [\n  { id: 1, team: \'10\' },\n  { id: 2, team: \'2\' },\n  { id: 3, team: \'10\' },\n  { id: 4, team: \'1\' },\n  { id: 5, team: \'2\' },\n];\nconsole.log(JSON.stringify(group(rows)));\n```',
    check: {
      kind: 'json_equal',
      value: [
        {
          team: '10',
          ids: [1, 3],
        },
        {
          team: '2',
          ids: [2, 5],
        },
        {
          team: '1',
          ids: [4],
        },
      ],
    },
  },
  {
    id: 'debug-repair-v2-query-duplicate-encoding',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The implementation below is correct. A test has a stale expected JSON snapshot {"before":["a+b","a+b"],"tags":["x y+z","last"],"wire":"tag=x%20y%2Bz&space=%20&tag=last"}. URLSearchParams uses form-style plus decoding and set removes extra values for a key. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nconst query = new URLSearchParams(\'tag=a+b&tag=a%2Bb&empty=&space=%20\');\nconst before = query.getAll(\'tag\');\nquery.set(\'tag\', \'x y+z\');\nquery.append(\'tag\', \'last\');\nquery.delete(\'empty\');\nconsole.log(JSON.stringify({ before, tags: query.getAll(\'tag\'), wire: query.toString() }));\n```',
    check: {
      kind: 'json_equal',
      value: {
        before: ['a b', 'a+b'],
        tags: ['x y+z', 'last'],
        wire: 'tag=x+y%2Bz&space=+&tag=last',
      },
    },
  },
  {
    id: 'debug-repair-v2-serialization-hooks',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The implementation below is correct. A test has a stale expected JSON snapshot {"events":["replace:value","toJSON:item"],"value":{"item":{"value":4},"list":[2]}}. toJSON runs before the replacer; undefined object properties disappear, while undefined array slots become null. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nconst events = [];\nconst source = {\n  item: {\n    raw: 8,\n    toJSON(key) {\n      events.push(\'toJSON:\' + key);\n      return { value: this.raw / 2, ignored: undefined };\n    },\n  },\n  list: [undefined, 2],\n};\nconst wire = JSON.stringify(source, (key, value) => {\n  if (key === \'value\') {\n    events.push(\'replace:value\');\n    return value + 1;\n  }\n  return value;\n});\nconsole.log(JSON.stringify({ events, value: JSON.parse(wire) }));\n```',
    check: {
      kind: 'json_equal',
      value: {
        events: ['toJSON:item', 'replace:value'],
        value: {
          item: {
            value: 5,
          },
          list: [null, 2],
        },
      },
    },
  },
  {
    id: 'debug-repair-v2-promise-finally-rejection',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      "The implementation below is correct. A test has a stale expected JSON snapshot [\"start\",\"cleanup\",\"success:ready\",null]. finally preserves the previous settled value unless it throws, in which case the thrown error replaces it. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nconst events = [];\nPromise.resolve('start')\n  .then(value => {\n    events.push(value);\n    return 'ready';\n  })\n  .finally(() => {\n    events.push('cleanup');\n    throw new Error('cleanup failed');\n  })\n  .then(value => {\n    events.push('success:' + value);\n  }, error => {\n    events.push('failure:' + error.message);\n    return 'recovered';\n  })\n  .then(value => {\n    events.push(value);\n    console.log(JSON.stringify(events));\n  });\n```",
    check: {
      kind: 'json_equal',
      value: ['start', 'cleanup', 'failure:cleanup failed', 'recovered'],
    },
  },
  {
    id: 'debug-repair-v2-set-live-iteration',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      "The implementation below is correct. A test has a stale expected JSON snapshot {\"visited\":[\"a\",\"b\",\"c\"],\"remaining\":[\"c\",\"d\",\"b\"]}. Set iteration is live: deleted unvisited items are skipped and newly appended items are visited. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nconst values = new Set(['a', 'b', 'c']);\nconst visited = [];\nfor (const value of values) {\n  visited.push(value);\n  if (value === 'a') {\n    values.delete('b');\n    values.add('d');\n  }\n  if (value === 'c') {\n    values.delete('a');\n    values.add('b');\n  }\n}\nconsole.log(JSON.stringify({ visited, remaining: [...values] }));\n```",
    check: {
      kind: 'json_equal',
      value: {
        visited: ['a', 'c', 'd', 'b'],
        remaining: ['c', 'd', 'b'],
      },
    },
  },
  {
    id: 'debug-repair-v2-map-same-value-zero',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      "The implementation below is correct. A test has a stale expected JSON snapshot {\"size\":6,\"nan\":null,\"zero\":\"minus\",\"objects\":[\"updated\",\"updated\"]}. Map uses SameValueZero key equality: NaN equals NaN for keys, and +0 and -0 are the same key; object keys use identity. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nconst first = { id: 1 };\nconst second = { id: 1 };\nconst values = new Map();\nvalues.set(NaN, 'old');\nvalues.set(Number('bad'), 'new');\nvalues.set(-0, 'minus');\nvalues.set(+0, 'plus');\nvalues.set(first, 'first');\nvalues.set(second, 'second');\nvalues.set(first, 'updated');\nconsole.log(JSON.stringify({ size: values.size, nan: values.get(NaN), zero: values.get(-0), objects: [values.get(first), values.get(second)] }));\n```",
    check: {
      kind: 'json_equal',
      value: {
        size: 4,
        nan: 'new',
        zero: 'plus',
        objects: ['updated', 'second'],
      },
    },
  },
  {
    id: 'debug-repair-v2-fake-clock-reentrant',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      "The implementation below is correct. A test has a stale expected JSON snapshot [\"a@2\",\"b@2\",\"canceled\",\"end@5\"]. The scheduler executes due timers in (due,id) order. Newly scheduled timers due by the target also run in the same advance call; canceled timers never run. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nfunction createClock() {\n  let now = 0;\n  let serial = 0;\n  const timers = [];\n  return {\n    schedule(delay, callback) {\n      const timer = { id: ++serial, due: now + delay, callback, active: true };\n      timers.push(timer);\n      return () => { timer.active = false; };\n    },\n    advance(delta) {\n      const target = now + delta;\n      while (true) {\n        const due = timers.filter(timer => timer.active && timer.due <= target);\n        due.sort((a, b) => a.due - b.due || a.id - b.id);\n        const timer = due[0];\n        if (!timer) break;\n        now = timer.due;\n        timer.active = false;\n        timer.callback();\n      }\n      now = target;\n    },\n    now() { return now; },\n  };\n}\nconst clock = createClock();\nconst events = [];\nconst cancel = clock.schedule(4, () => events.push('canceled'));\nclock.schedule(2, () => {\n  events.push('a@' + clock.now());\n  cancel();\n  clock.schedule(0, () => events.push('nested@' + clock.now()));\n  clock.schedule(3, () => events.push('later@' + clock.now()));\n});\nclock.schedule(2, () => events.push('b@' + clock.now()));\nclock.advance(5);\nevents.push('end@' + clock.now());\nconsole.log(JSON.stringify(events));\n```",
    check: {
      kind: 'json_equal',
      value: ['a@2', 'b@2', 'nested@2', 'later@5', 'end@5'],
    },
  },
  {
    id: 'debug-repair-v2-inflight-dedup-spy',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The implementation below is correct. A test has a stale expected JSON snapshot {"same":false,"values":["A","A","B"],"again":"A","calls":["a","a","b","a"]}. Concurrent callers share the same in-flight promise. Entries are deleted after settlement, so a later call reloads. The expected snapshot includes loader invocation counts. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nfunction memoizeInFlight(load) {\n  const pending = new Map();\n  return key => {\n    if (pending.has(key)) return pending.get(key);\n    const promise = Promise.resolve().then(() => load(key));\n    pending.set(key, promise);\n    const cleanup = () => {\n      if (pending.get(key) === promise) pending.delete(key);\n    };\n    promise.then(cleanup, cleanup);\n    return promise;\n  };\n}\nasync function main() {\n  const calls = [];\n  const get = memoizeInFlight(async key => {\n    calls.push(key);\n    await Promise.resolve();\n    return key.toUpperCase();\n  });\n  const first = get(\'a\');\n  const duplicate = get(\'a\');\n  const other = get(\'b\');\n  const same = first === duplicate;\n  const values = await Promise.all([first, duplicate, other]);\n  const again = await get(\'a\');\n  console.log(JSON.stringify({ same, values, again, calls }));\n}\nmain();\n```',
    check: {
      kind: 'json_equal',
      value: {
        same: true,
        values: ['A', 'A', 'B'],
        again: 'A',
        calls: ['a', 'b', 'a'],
      },
    },
  },
  {
    id: 'debug-repair-v2-generator-return-value',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The implementation below is correct. A test has a stale expected JSON snapshot {"steps":[{"value":2,"done":false},{"value":102,"done":false},{"value":8,"done":true},{"value":null,"done":true}],"spread":[2,null,null]}. A generator\'s return value is observed by next(), but is not included by iteration. Values sent to next() resume the pending yield. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nfunction* sequence() {\n  const first = yield 2;\n  const second = yield first + 3;\n  return second * 2;\n}\nconst iterator = sequence();\nconst steps = [iterator.next(99), iterator.next(4), iterator.next(6), iterator.next()];\nconst result = steps.map(step => ({ value: step.value ?? null, done: step.done }));\nconsole.log(JSON.stringify({ steps: result, spread: [...sequence()] }));\n```',
    check: {
      kind: 'json_equal',
      value: {
        steps: [
          {
            value: 2,
            done: false,
          },
          {
            value: 7,
            done: false,
          },
          {
            value: 12,
            done: true,
          },
          {
            value: null,
            done: true,
          },
        ],
        spread: [2, null],
      },
    },
  },
  {
    id: 'debug-repair-v2-enumeration-integer-keys',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The implementation below is correct. A test has a stale expected JSON snapshot {"keys":["10","2","01","a","4294967295","1","z"],"values":[2,3,4,5,6,7,8]}. Canonical array-index keys enumerate ascending before other string keys, which retain insertion order. "01" and "4294967295" are not array-index keys. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nconst record = {};\nrecord.z = 1;\nrecord[\'10\'] = 2;\nrecord[\'2\'] = 3;\nrecord[\'01\'] = 4;\nrecord.a = 5;\nrecord[\'4294967295\'] = 6;\nrecord[\'1\'] = 7;\ndelete record.z;\nrecord.z = 8;\nconsole.log(JSON.stringify({ keys: Object.keys(record), values: Object.values(record) }));\n```',
    check: {
      kind: 'json_equal',
      value: {
        keys: ['1', '2', '10', '01', 'a', '4294967295', 'z'],
        values: [7, 3, 2, 4, 5, 6, 8],
      },
    },
  },
  {
    id: 'debug-repair-v2-utc-overflow-normalization',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The implementation below is correct. A test has a stale expected JSON snapshot ["2024-02-29","2023-02-28","2025-01-01","2024-01-01"]. UTC construction normalizes day and month overflow and underflow. The result does not depend on local timezone. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nfunction day(year, month, date) {\n  return new Date(Date.UTC(year, month, date)).toISOString().slice(0, 10);\n}\nconst values = [\n  day(2024, 1, 30),\n  day(2023, 1, 29),\n  day(2024, 12, 0),\n  day(2024, 0, 0),\n];\nconsole.log(JSON.stringify(values));\n```',
    check: {
      kind: 'json_equal',
      value: ['2024-03-01', '2023-03-01', '2024-12-31', '2023-12-31'],
    },
  },
  {
    id: 'debug-repair-v2-signed-zero-observation',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The implementation below is correct. A test has a stale expected JSON snapshot [{"rounded":0,"negativeZero":false,"reciprocal":"Infinity"},{"rounded":-1,"negativeZero":false,"reciprocal":"-1"},{"rounded":0,"negativeZero":false,"reciprocal":"Infinity"},{"rounded":-2,"negativeZero":false,"reciprocal":"-0.5"},{"rounded":2,"negativeZero":false,"reciprocal":"0.5"}]. The implementation intentionally exposes signed zero through Object.is and reciprocal; JSON serialization alone would lose that distinction. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nconst inputs = [-0.4, -0.5, 0.4, -1.5, 1.5];\nconst result = inputs.map(input => {\n  const rounded = Math.round(input);\n  return {\n    rounded,\n    negativeZero: Object.is(rounded, -0),\n    reciprocal: String(1 / rounded),\n  };\n});\nconsole.log(JSON.stringify(result));\n```',
    check: {
      kind: 'json_equal',
      value: [
        {
          rounded: 0,
          negativeZero: true,
          reciprocal: '-Infinity',
        },
        {
          rounded: 0,
          negativeZero: true,
          reciprocal: '-Infinity',
        },
        {
          rounded: 0,
          negativeZero: false,
          reciprocal: 'Infinity',
        },
        {
          rounded: -1,
          negativeZero: false,
          reciprocal: '-1',
        },
        {
          rounded: 2,
          negativeZero: false,
          reciprocal: '0.5',
        },
      ],
    },
  },
  {
    id: 'debug-repair-v2-stable-sort-mutation',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The implementation below is correct. A test has a stale expected JSON snapshot {"original":["a:2","b:1","c:2","d:1"],"sorted":["b:9","d:1","a:2","c:2"]}. sort is stable and mutates the array it is called on; sorting a shallow array copy preserves the original array order but retains element aliases. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nconst rows = [\n  { id: \'a\', score: 2 },\n  { id: \'b\', score: 1 },\n  { id: \'c\', score: 2 },\n  { id: \'d\', score: 1 },\n];\nconst sorted = rows.slice().sort((a, b) => a.score - b.score);\nsorted[0].score = 9;\nconsole.log(JSON.stringify({ original: rows.map(row => row.id + \':\' + row.score), sorted: sorted.map(row => row.id + \':\' + row.score) }));\n```',
    check: {
      kind: 'json_equal',
      value: {
        original: ['a:2', 'b:9', 'c:2', 'd:1'],
        sorted: ['b:9', 'd:1', 'a:2', 'c:2'],
      },
    },
  },
  {
    id: 'debug-repair-v2-descriptor-spread-snapshot',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The implementation below is correct. A test has a stale expected JSON snapshot {"first":{"hidden":7,"visible":1},"second":{"hidden":7,"visible":2},"reads":2,"getter":"function","hidden":true}. Object spread copies enumerable own values, reading getters once and not retaining the getter descriptor or nonenumerable fields. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nlet reads = 0;\nconst source = {};\nObject.defineProperty(source, \'hidden\', { value: 7, enumerable: false });\nObject.defineProperty(source, \'visible\', {\n  enumerable: true,\n  get() { return ++reads; },\n});\nconst first = { ...source };\nconst second = { ...source };\nconst descriptor = Object.getOwnPropertyDescriptor(first, \'visible\');\nconsole.log(JSON.stringify({ first, second, reads, getter: typeof descriptor.get, hidden: Object.hasOwn(first, \'hidden\') }));\n```',
    check: {
      kind: 'json_equal',
      value: {
        first: {
          visible: 1,
        },
        second: {
          visible: 2,
        },
        reads: 2,
        getter: 'undefined',
        hidden: false,
      },
    },
  },
  {
    id: 'debug-repair-v2-split-capturing-delimiters',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The implementation below is correct. A test has a stale expected JSON snapshot {"capturing":["a","b","c"],"limited":["a","b","c"],"plain":["a","b","c"]}. Regex capturing groups insert captured separators into split results, and the limit counts those entries too. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nconst text = \'a12b003c\';\nconst capturing = text.split(/(\\d+)/);\nconst limited = text.split(/(\\d+)/, 3);\nconst plain = text.split(/\\d+/);\nconsole.log(JSON.stringify({ capturing, limited, plain }));\n```',
    check: {
      kind: 'json_equal',
      value: {
        capturing: ['a', '12', 'b', '003', 'c'],
        limited: ['a', '12', 'b'],
        plain: ['a', 'b', 'c'],
      },
    },
  },
  {
    id: 'debug-repair-v2-replacement-token-expansion',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The implementation below is correct. A test has a stale expected JSON snapshot {"expanded":"xa[$$][$&][$1][$`][$\']cy","literal":"xa[$][$b][$b][xa][cy]cy"}. String replacement patterns expand $&, $1, prefix and suffix tokens. A function replacer\'s returned string is inserted literally. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nconst text = \'xabcy\';\nconst pattern = /(b)/;\nconst replacement = "[$$][$&][$1][$`][$\']";\nconst expanded = text.replace(pattern, replacement);\nconst literal = text.replace(pattern, () => replacement);\nconsole.log(JSON.stringify({ expanded, literal }));\n```',
    check: {
      kind: 'json_equal',
      value: {
        expanded: 'xa[$][b][b][xa][cy]cy',
        literal: "xa[$$][$&][$1][$`][$']cy",
      },
    },
  },
  {
    id: 'debug-repair-v2-all-settled-input-order',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The implementation below is correct. A test has a stale expected JSON snapshot [{"status":"rejected","reason":"blocked"},{"status":"fulfilled","value":"fast"},{"status":"fulfilled","value":"slow"}]. allSettled preserves input order, regardless of resolution order, and never rejects because an input rejects. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nasync function main() {\n  const { promise: first, resolve: resolveFirst } = Promise.withResolvers();\n  const second = Promise.reject(new Error(\'blocked\'));\n  const third = Promise.resolve(\'fast\');\n  const resultPromise = Promise.allSettled([first, second, third]);\n  resolveFirst(\'slow\');\n  const result = await resultPromise;\n  const snapshot = result.map(row => row.status === \'fulfilled\'\n    ? { status: row.status, value: row.value }\n    : { status: row.status, reason: row.reason.message });\n  console.log(JSON.stringify(snapshot));\n}\nmain();\n```',
    check: {
      kind: 'json_equal',
      value: [
        {
          status: 'fulfilled',
          value: 'slow',
        },
        {
          status: 'rejected',
          reason: 'blocked',
        },
        {
          status: 'fulfilled',
          value: 'fast',
        },
      ],
    },
  },
  {
    id: 'debug-repair-v2-buffer-view-versus-copy',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The implementation below is correct. A test has a stale expected JSON snapshot {"original":[10,20,77,40],"view":[99,30],"copy":[20,55]}. Buffer.subarray shares storage; Buffer.from(buffer) copies bytes. Later writes through either view affect the original. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nconst original = Buffer.from([10, 20, 30, 40]);\nconst view = original.subarray(1, 3);\nconst copy = Buffer.from(view);\nview[0] = 99;\noriginal[2] = 77;\ncopy[1] = 55;\nconsole.log(JSON.stringify({ original: [...original], view: [...view], copy: [...copy] }));\n```',
    check: {
      kind: 'json_equal',
      value: {
        original: [10, 99, 77, 40],
        view: [99, 77],
        copy: [20, 55],
      },
    },
  },
  {
    id: 'debug-repair-v2-structured-clone-aliases',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The implementation below is correct. A test has a stale expected JSON snapshot {"shared":false,"detached":true,"cycle":false,"source":2,"second":2}. structuredClone separates source storage while preserving repeated-reference identity and cycles inside the clone. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nconst child = { value: 2 };\nconst original = { first: child, second: child };\noriginal.self = original;\nconst clone = structuredClone(original);\nclone.first.value = 8;\nconsole.log(JSON.stringify({ shared: clone.first === clone.second, detached: clone.first !== child, cycle: clone.self === clone, source: child.value, second: clone.second.value }));\n```',
    check: {
      kind: 'json_equal',
      value: {
        shared: true,
        detached: true,
        cycle: true,
        source: 2,
        second: 8,
      },
    },
  },
  {
    id: 'debug-repair-v2-nested-microtask-queue',
    taskType: 'debugging',
    subtaskType: 'test_repair',
    systemPrompt: CODE_SYS,
    userPrompt:
      'The implementation below is correct. A test has a stale expected JSON snapshot ["C","A","F","B","D","E","G"]. Use only standard Promise and queueMicrotask FIFO semantics. The first then schedules additional work; its chained then is not enqueued until that callback completes. Repair only the expectation. Reply only with the replacement JSON snapshot matching the logged value, with object keys in the logged order.\n\n```javascript\nconst events = [];\nPromise.resolve()\n  .then(() => {\n    events.push(\'A\');\n    queueMicrotask(() => {\n      events.push(\'D\');\n      Promise.resolve().then(() => events.push(\'G\'));\n    });\n    Promise.resolve().then(() => events.push(\'E\'));\n  })\n  .then(() => events.push(\'F\'));\nqueueMicrotask(() => events.push(\'B\'));\nevents.push(\'C\');\nsetTimeout(() => console.log(JSON.stringify(events)), 0);\n```',
    check: {
      kind: 'json_equal',
      value: ['C', 'A', 'B', 'D', 'E', 'F', 'G'],
    },
  },
];
