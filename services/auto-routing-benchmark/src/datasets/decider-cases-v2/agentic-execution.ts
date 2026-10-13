import type { DeciderCase } from '../decider-cases';

const AGENT_SYS =
  'You are a precise coding agent with file and terminal tools available. Complete the task exactly as specified, then answer with only what is asked, no explanations.';

export const AGENTIC_EXECUTION_V2_CASES: readonly DeciderCase[] = [
  {
    id: 'agentic-tool-v2-revision-tombstones',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"events.jsonl\": \"{\\\"id\\\":\\\"b\\\",\\\"rev\\\":2,\\\"value\\\":9}\\n{\\\"id\\\":\\\"a\\\",\\\"rev\\\":1,\\\"value\\\":4}\\n{\\\"id\\\":\\\"b\\\",\\\"rev\\\":1,\\\"value\\\":7}\\n{\\\"id\\\":\\\"a\\\",\\\"rev\\\":3,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"c\\\",\\\"rev\\\":2,\\\"value\\\":-5}\\n{\\\"id\\\":\\\"c\\\",\\\"rev\\\":2,\\\"value\\\":6}\\n{\\\"id\\\":\\\"d\\\",\\\"rev\\\":0,\\\"value\\\":0}\\n\"\n}\n\nRead JSONL. Keep the highest revision for each id, with the later line winning equal revisions. Remove records whose winning revision has deleted:true. Write winners.json as an array of [id,value] pairs sorted by id using code-unit order. Read it back. Report keys ids (array) then total (number).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"ids":["b","c","d"],"total":15} },
  },
  {
    id: 'agentic-tool-v2-quoted-csv',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"sales.csv\": \"id,region,amount\\n\\\"a,1\\\",west,12\\n\\\"b\\\"\\\"2\\\",east,-3\\nc,west,8\\n\\\"line\\nbreak\\\",west,5\\nd,east,10\\n\"\n}\n\nParse RFC 4180-style CSV, including quoted commas, doubled quotes and a newline within a quoted field. Header is not data. Sum amount only for west. Write west.json with the matching ids in input order. Read it back. Report keys rows (number of all data records), ids, total.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"rows":5,"ids":["a,1","c","line\nbreak"],"total":25} },
  },
  {
    id: 'agentic-tool-v2-utf8-offsets',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"text.txt\": \"Aé🙂\\r\\nZ\\n\"\n}\n\nRead the file as bytes, not UTF-16 characters. Report keys bytes (byte length), lfOffsets (zero-based byte indexes of LF), hex (lowercase hexadecimal encoding).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"bytes":11,"lfOffsets":[8,10],"hex":"41c3a9f09f99820d0a5a0a"} },
  },
  {
    id: 'agentic-tool-v2-recursive-manifest',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"tree/z.txt\": \"Z\\n\",\n  \"tree/a/b.txt\": \"bb\",\n  \"tree/a/.hidden\": \"h\",\n  \"tree/a/c.json\": \"{}\",\n  \"tree/.top.txt\": \"x\",\n  \"tree/skip.tmp\": \"omit\"\n}\n\nRecursively list regular .txt files under tree, excluding any path with a component beginning with a dot. Sort their relative POSIX paths in code-unit order. Write manifest.txt, one path per line with a final LF. Report keys paths, bytes (size of manifest.txt).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"paths":["a/b.txt","z.txt"],"bytes":14} },
  },
  {
    id: 'agentic-tool-v2-symlink-inventory',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"assets/data.txt\": \"abc\",\n  \"assets/other.txt\": \"12345\"\n}\n\nCreate assets/alias.txt as a symbolic link to data.txt, assets/missing.txt as a symbolic link to absent.txt, and assets/data-copy.txt as a hard link to data.txt. With lstat, count regular directory entries and symbolic links without following them. Sum sizes of regular entries, counting hard-linked names separately. Report keys regular, symlinks, regularBytes.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"regular":3,"symlinks":2,"regularBytes":11} },
  },
  {
    id: 'agentic-tool-v2-safe-path-normalization',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"paths.json\": \"[\\\"src/../lib/a.js\\\",\\\"../escape.js\\\",\\\"./lib/a.js\\\",\\\"lib//b.js\\\",\\\"/absolute.js\\\",\\\"a/../../escape.js\\\",\\\"lib/c/../b.js\\\",\\\".\\\"]\"\n}\n\nUse path.posix.normalize on each string. Reject input paths that are absolute, normalized paths equal to .. or starting ../, and normalized paths equal to . . Deduplicate remaining normalized paths and code-unit sort them. Write accepted.json and read it back. Report keys accepted, rejected (input count rejected before deduplication).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"accepted":["lib/a.js","lib/b.js"],"rejected":4} },
  },
  {
    id: 'agentic-tool-v2-patch-preimages',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"config.txt\": \"mode=old\\nmode=older\\nmode=old\\nlimit=3\\n\"\n}\n\nReplace only whole lines equal to mode=old with mode=new. Preserve the final newline and all other bytes. Write patched.txt. Report keys replacements, sha256 (full lowercase SHA-256 of patched.txt bytes).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"replacements":2,"sha256":"df300c8febe658b2677de0d3554d255a47a4a51f56154724c7caca2798d2262b"} },
  },
  {
    id: 'agentic-tool-v2-merge-null-values',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"base.json\": \"{\\\"a\\\":1,\\\"nested\\\":{\\\"x\\\":2,\\\"y\\\":3},\\\"items\\\":[1,2],\\\"keep\\\":true}\",\n  \"patch.json\": \"{\\\"a\\\":null,\\\"nested\\\":{\\\"x\\\":null,\\\"z\\\":4},\\\"items\\\":[3],\\\"new\\\":{\\\"p\\\":null,\\\"q\\\":5}}\"\n}\n\nApply JSON Merge Patch semantics: null deletes a key, objects recursively merge, arrays replace wholesale. Write result.json compactly with keys keep, items, nested, new in that order; nested has y,z and new has q. Read result.json and report exactly that object.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"keep":true,"items":[3],"nested":{"y":3,"z":4},"new":{"q":5}} },
  },
  {
    id: 'agentic-tool-v2-binary-endianness',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"bytes.json\": \"[255,255,255,255,0,0,0,128,120,86,52,18,1,0,0,0]\"\n}\n\nWrite bytes.bin from the byte array. Read four signed 32-bit little-endian integers from the file. Sum with BigInt. Report keys values (numbers), sum (decimal string), unsignedLast (last word read unsigned little-endian).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"values":[-1,-2147483648,305419896,1],"sum":"-1842063752","unsignedLast":1} },
  },
  {
    id: 'agentic-tool-v2-base64-stream-chunks',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"chunks.json\": \"[\\\"aGV\\\",\\\"sbG8\\\",\\\"A8J\\\",\\\"+Zgg==\\\"]\"\n}\n\nConcatenate the encoded chunks before decoding base64 (do not decode chunks separately). Write decoded.bin. Report keys hex, bytes, sha256 of decoded.bin.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"hex":"68656c6c6f00f09f9982","bytes":10,"sha256":"10404c2f33622143c93d55929951fb42ecc8a14c8e30d14460d8e7d91f7281f6"} },
  },
  {
    id: 'agentic-tool-v2-ndjson-blank-tail',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"records.jsonl\": \"\\n{\\\"n\\\":12}\\r\\n   \\n{\\\"n\\\":-4}\\n{\\\"n\\\":0}\\n{\\\"n\\\":7}\"\n}\n\nRead JSONL, ignoring whitespace-only lines. Do not drop the last record without a final newline. Write totals.json. Report keys records, sum, positive (strictly greater than zero).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"records":4,"sum":15,"positive":2} },
  },
  {
    id: 'agentic-tool-v2-ini-section-overrides',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"settings.ini\": \"mode=base\\n[prod]\\nthreads=4\\nmode=fast\\n[dev]\\nthreads=1\\n[prod]\\nthreads=8\\n# mode=ignored\\nempty=\\n\"\n}\n\nParse INI: trim lines, ignore blank lines and lines beginning #; entries before a section are defaults inherited by each named section; repeated sections merge and later keys win. Empty values remain empty strings. Write prod.json with keys mode, threads, empty in that order, all as strings, and report its parsed contents.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"mode":"fast","threads":"8","empty":""} },
  },
  {
    id: 'agentic-tool-v2-url-query-multiplicity',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"url.txt\": \"https://example.invalid/a?tag=a%2Bb&tag=a+b&empty=&x=1&tag=%E2%9C%93#tag=ignored\"\n}\n\nRead the URL using the standard URL class. Report keys tags (all tag values in order), empty (empty value string), entries (total query entries). Fragment text is not a query entry.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"tags":["a+b","a b","✓"],"empty":"","entries":5} },
  },
  {
    id: 'agentic-tool-v2-unicode-normalized-dedup',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"names.json\": \"[\\\"é\\\",\\\"é\\\",\\\"É\\\",\\\"e\\\",\\\"E\\\",\\\"Å\\\",\\\"Å\\\",\\\"å\\\"]\"\n}\n\nRead strings, normalize each to NFC then lowercase using toLowerCase. Deduplicate and sort in JavaScript default code-unit order. Write normalized.txt joined by LF with a final LF. Report keys names, bytes (UTF-8 file size).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"names":["e","å","é"],"bytes":8} },
  },
  {
    id: 'agentic-tool-v2-global-regex-reset',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"lines.txt\": \"ababa\\naba\\nxaba\\nnone\\nabaaba\\n\"\n}\n\nFor each line independently, find all non-overlapping matches of /aba/g, resetting the regex state for each line. Write matches.json with an array of zero-based starting offsets per input line (ignore the final empty line caused by final LF). Report keys offsets, total.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"offsets":[[0],[0],[1],[],[0,3]],"total":5} },
  },
  {
    id: 'agentic-tool-v2-zero-byte-vs-empty-lines',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"a.txt\": \"\",\n  \"b.txt\": \"\\n\",\n  \"c.txt\": \"x\\n\\n\",\n  \"d.txt\": \"x\"\n}\n\nFor files a.txt through d.txt in that order, report byte length and LF byte count, not split-array length. Write report.json as {files:[{name,bytes,lf},...]} and return that object.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"files":[{"name":"a.txt","bytes":0,"lf":0},{"name":"b.txt","bytes":1,"lf":1},{"name":"c.txt","bytes":3,"lf":2},{"name":"d.txt","bytes":1,"lf":0}]} },
  },
  {
    id: 'agentic-tool-v2-decimal-cents',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"payments.txt\": \"12.30\\n-0.05\\n90071992547409.91\\n0.04\\n-12.29\\n\"\n}\n\nRead fixed-point decimal amounts, all with exactly two fractional digits. Sum exactly using integer cents with BigInt, not floating point. Write the formatted sum with exactly two fractional digits to total.txt without a newline. Return only its contents.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only the requested final output line.",
    check: { kind: 'exact', value: "90071992547409.91" },
  },
  {
    id: 'agentic-tool-v2-file-range-overwrite',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"seed.txt\": \"abcdefghij\"\n}\n\nCopy seed.txt to edited.bin. Open edited.bin for read/write without truncation. Overwrite two bytes at offset 3 with XY, then overwrite two bytes at offset 8 with 12. Truncate to 9 bytes. Read back and report keys text, bytes, sha256.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"text":"abcXYfgh1","bytes":9,"sha256":"cf92f25b3e39ff9538bf4b2991f9da18a9423afcc88b4e5fcec75a5323068e50"} },
  },
  {
    id: 'agentic-tool-v2-length-prefixed-frames',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"frames.json\": \"[\\\"\\\",\\\"é\\\",\\\"a\\\\u0000b\\\",\\\"🙂\\\"]\"\n}\n\nEncode each decoded JSON string as UTF-8 bytes preceded by its byte length in a 16-bit unsigned big-endian prefix. Concatenate the frames in order and write wire.bin. Report keys bytes, hex, sha256.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"bytes":17,"hex":"00000002c3a900036100620004f09f9982","sha256":"368f959267b69cdf74b33e5b0a153cb29f26400c226b5daf60fefd01a3def223"} },
  },
  {
    id: 'agentic-tool-v2-content-addressed-duplicates',
    taskType: 'agentic_execution',
    subtaskType: 'tool_usage',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"in/a.txt\": \"same\\n\",\n  \"in/b.txt\": \"same\",\n  \"in/c.txt\": \"same\\n\",\n  \"in/d.txt\": \"other\\n\",\n  \"in/e.txt\": \"same\"\n}\n\nGroup the five files by SHA-256 of raw bytes, without trimming. Within each group code-unit sort filenames; order groups by their first filename. Write duplicates.json containing only groups with more than one member. Read and report keys groups (filename arrays), unique (number of distinct contents across all five files).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"groups":[["a.txt","c.txt"],["b.txt","e.txt"]],"unique":3} },
  },
  {
    id: 'agentic-multi-v2-dependency-batches',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"graph.json\": \"{\\\"a\\\":[],\\\"b\\\":[\\\"a\\\"],\\\"c\\\":[\\\"a\\\"],\\\"d\\\":[\\\"b\\\",\\\"c\\\"],\\\"e\\\":[\\\"c\\\"],\\\"f\\\":[\\\"d\\\",\\\"e\\\"],\\\"g\\\":[]}\"\n}\n\nImplement dependency scheduling in a Node script. At each round select every not-yet-completed node whose dependencies were completed before the round began. Code-unit sort each batch. Write batches.json, then read it to produce keys batches, rounds, widest (maximum batch size).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"batches":[["a","g"],["b","c"],["d","e"],["f"]],"rounds":4,"widest":2} },
  },
  {
    id: 'agentic-multi-v2-ledger-replay',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"ledger.json\": \"[{\\\"id\\\":\\\"1\\\",\\\"account\\\":\\\"a\\\",\\\"delta\\\":8},{\\\"id\\\":\\\"2\\\",\\\"account\\\":\\\"b\\\",\\\"delta\\\":4},{\\\"id\\\":\\\"1\\\",\\\"account\\\":\\\"a\\\",\\\"delta\\\":100},{\\\"id\\\":\\\"3\\\",\\\"account\\\":\\\"a\\\",\\\"delta\\\":-3},{\\\"id\\\":\\\"4\\\",\\\"account\\\":\\\"b\\\",\\\"delta\\\":-6},{\\\"id\\\":\\\"5\\\",\\\"account\\\":\\\"c\\\",\\\"delta\\\":0},{\\\"id\\\":\\\"2\\\",\\\"account\\\":\\\"b\\\",\\\"delta\\\":9}]\"\n}\n\nReplay records in order, skipping duplicate transaction ids globally (first occurrence wins). Write balances.json with accounts sorted by name, retaining zero balances. Read balances.json. Report keys balances (array of [account,balance]), applied, skipped.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"balances":[["a",5],["b",-2],["c",0]],"applied":5,"skipped":2} },
  },
  {
    id: 'agentic-multi-v2-join-latest-owner',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"users.json\": \"[{\\\"id\\\":\\\"u1\\\",\\\"name\\\":\\\"Ada\\\"},{\\\"id\\\":\\\"u2\\\",\\\"name\\\":\\\"Bo\\\"},{\\\"id\\\":\\\"u1\\\",\\\"name\\\":\\\"Ana\\\"}]\",\n  \"orders.json\": \"[{\\\"user\\\":\\\"u1\\\",\\\"cents\\\":120},{\\\"user\\\":\\\"u3\\\",\\\"cents\\\":50},{\\\"user\\\":\\\"u2\\\",\\\"cents\\\":-20},{\\\"user\\\":\\\"u1\\\",\\\"cents\\\":80}]\"\n}\n\nBuild users-by-id using the last user occurrence. Inner-join orders to users, ignoring unknown user ids. Aggregate cents per current user name. Write joined.json with [name,cents] rows sorted by name. Read it back and report keys totals, orphanOrders.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"totals":[["Ana",200],["Bo",-20]],"orphanOrders":1} },
  },
  {
    id: 'agentic-multi-v2-external-merge-dedup',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"left.txt\": \"-4\\n2\\n2\\n10\\n20\\n\",\n  \"right.txt\": \"-4\\n-1\\n2\\n3\\n20\\n30\\n\"\n}\n\nMerge the two numerically sorted files into a sorted deduplicated sequence without lexicographic sorting. Write merged.txt with one number per line and final LF. Read it back and report keys values, sum, sha256 of merged.txt bytes.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"values":[-4,-1,2,3,10,20,30],"sum":60,"sha256":"99f7079b07c5f9b8343a35dcab621d5881b85e25bb3331183385aa9d2f7ea198"} },
  },
  {
    id: 'agentic-multi-v2-interval-coverage',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"intervals.json\": \"[[8,12],[1,4],[3,8],[12,12],[15,18],[17,20],[-2,0],[0,1]]\"\n}\n\nInterpret intervals as half-open [start,end), discard zero-length intervals, sort numerically by start then end, and merge overlapping or touching intervals. Write merged.json. Read it and report keys intervals, covered (total length), gaps (number of gaps between merged intervals).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"intervals":[[-2,12],[15,20]],"covered":19,"gaps":1} },
  },
  {
    id: 'agentic-multi-v2-run-length-roundtrip',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"input.txt\": \"aaabb\\n\\nccc🙂🙂a\"\n}\n\nRun-length encode by Unicode code points, not UTF-16 units. Write runs.json containing [character,count] pairs. Decode those runs into roundtrip.txt and verify exact original bytes. Report keys runs (number of runs), codePoints, bytes, sha256 of roundtrip.txt.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"runs":6,"codePoints":13,"bytes":19,"sha256":"f9d65b8053eb879a26727ad8cf8d5e2944afae2a6cd47f79e9c0f73ed7368bbd"} },
  },
  {
    id: 'agentic-multi-v2-retry-state-machine',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"events.json\": \"[\\\"fail\\\",\\\"fail\\\",\\\"ok\\\",\\\"fail\\\",\\\"ok\\\",\\\"ok\\\",\\\"fail\\\",\\\"fail\\\",\\\"fail\\\",\\\"ok\\\"]\"\n}\n\nSimulate a consecutive-failure counter starting 0. Each fail increments it; each ok resets it. After the third consecutive fail, stop consuming further events and mark halted. Write states.json with the counter after each consumed event. Read it back. Report keys states, consumed, halted, remaining.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"states":[1,2,0,1,0,0,1,2,3],"consumed":9,"halted":true,"remaining":1} },
  },
  {
    id: 'agentic-multi-v2-pagination-overlap',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"pages/1.json\": \"{\\\"items\\\":[{\\\"id\\\":\\\"a\\\",\\\"v\\\":1},{\\\"id\\\":\\\"b\\\",\\\"v\\\":2}],\\\"next\\\":\\\"2\\\"}\",\n  \"pages/2.json\": \"{\\\"items\\\":[{\\\"id\\\":\\\"b\\\",\\\"v\\\":9},{\\\"id\\\":\\\"c\\\",\\\"v\\\":3}],\\\"next\\\":\\\"3\\\"}\",\n  \"pages/3.json\": \"{\\\"items\\\":[{\\\"id\\\":\\\"d\\\",\\\"v\\\":4},{\\\"id\\\":\\\"a\\\",\\\"v\\\":8}],\\\"next\\\":null}\"\n}\n\nBegin at page 1 and follow next strings until null. Deduplicate ids using first-seen values and first-seen ordering. Write all.json as the retained item array. Read it and report keys ids, sum, pages, duplicates.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"ids":["a","b","c","d"],"sum":10,"pages":3,"duplicates":2} },
  },
  {
    id: 'agentic-multi-v2-lru-eviction',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"accesses.json\": \"[\\\"a\\\",\\\"b\\\",\\\"c\\\",\\\"a\\\",\\\"d\\\",\\\"b\\\",\\\"d\\\",\\\"e\\\",\\\"b\\\",\\\"a\\\"]\"\n}\n\nSimulate an initially empty LRU cache of capacity 3. Every access makes its key most recent; a miss inserts it and evicts least recent if full. Write cache.json as keys from least to most recent. Read it and report keys cache, hits, misses, evicted (eviction sequence).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"cache":["e","b","a"],"hits":3,"misses":7,"evicted":["b","c","a","d"]} },
  },
  {
    id: 'agentic-multi-v2-stable-priority-drain',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"jobs.json\": \"[{\\\"id\\\":\\\"z\\\",\\\"priority\\\":2},{\\\"id\\\":\\\"a\\\",\\\"priority\\\":1},{\\\"id\\\":\\\"y\\\",\\\"priority\\\":2},{\\\"id\\\":\\\"b\\\",\\\"priority\\\":1},{\\\"id\\\":\\\"x\\\",\\\"priority\\\":0},{\\\"id\\\":\\\"c\\\",\\\"priority\\\":1}]\"\n}\n\nSort jobs by ascending numeric priority, preserving input order for equal priorities (not by id). Drain jobs into batches of two. Write batches.json as arrays of ids. Read it and report keys batches, order (flattened ids joined by comma).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"batches":[["x","a"],["b","c"],["z","y"]],"order":"x,a,b,c,z,y"} },
  },
  {
    id: 'agentic-multi-v2-transaction-rollback',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"operations.json\": \"[[[\\\"set\\\",\\\"a\\\",4],[\\\"add\\\",\\\"a\\\",3]],[[\\\"set\\\",\\\"b\\\",8],[\\\"assert\\\",\\\"a\\\",9],[\\\"add\\\",\\\"b\\\",1]],[[\\\"add\\\",\\\"a\\\",-2],[\\\"set\\\",\\\"c\\\",0]],[[\\\"assert\\\",\\\"c\\\",0],[\\\"add\\\",\\\"c\\\",5]]]\"\n}\n\nExecute each outer array as an atomic transaction, starting with an empty key/value map. set assigns; add treats missing as 0; assert fails unless the current value strictly equals its operand. Failed transactions roll back entirely and stop their remaining operations. Write state.json with keys sorted. Report keys state, committed, rolledBack.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"state":{"a":5,"c":5},"committed":3,"rolledBack":1} },
  },
  {
    id: 'agentic-multi-v2-partition-checksums',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"records.json\": \"[{\\\"id\\\":8,\\\"v\\\":\\\"a\\\"},{\\\"id\\\":1,\\\"v\\\":\\\"b\\\"},{\\\"id\\\":5,\\\"v\\\":\\\"c\\\"},{\\\"id\\\":2,\\\"v\\\":\\\"d\\\"},{\\\"id\\\":4,\\\"v\\\":\\\"e\\\"},{\\\"id\\\":0,\\\"v\\\":\\\"f\\\"},{\\\"id\\\":7,\\\"v\\\":\\\"g\\\"}]\"\n}\n\nPartition records by id modulo 3. For each partition sort by numeric id, write part-0.json, part-1.json, part-2.json using compact JSON and no newline. Concatenate those three file byte sequences in partition order into combined.bin. Report keys counts (three numbers), sha256 of combined.bin.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"counts":[1,3,3],"sha256":"e9cfc3f04585c62852f7be5b2e6d585e8535ae5f21fbd669fa7feccc75380ea4"} },
  },
  {
    id: 'agentic-multi-v2-chunk-boundary-lines',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"source.txt\": \"α\\r\\nbeta\\n\\nlast\"\n}\n\nRead source.txt through a Node read stream with highWaterMark:2 and decode UTF-8 without breaking multibyte characters. Split logical lines on LF, strip one trailing CR from each line, preserve interior empty lines and the final unterminated line. Write lines.json. Read it and report keys lines, count.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"lines":["α","beta","","last"],"count":4} },
  },
  {
    id: 'agentic-multi-v2-shortest-path-tie',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"graph.json\": \"{\\\"s\\\":{\\\"a\\\":2,\\\"b\\\":1},\\\"a\\\":{\\\"t\\\":3,\\\"c\\\":1},\\\"b\\\":{\\\"a\\\":1,\\\"t\\\":8,\\\"c\\\":2},\\\"c\\\":{\\\"t\\\":2},\\\"t\\\":{}}\"\n}\n\nCompute all simple paths from s to t and their total edge weights. Choose minimum weight; break ties by code-unit lexicographic order of the full path joined with >. Write chosen.json with keys path (node array), cost. Read it and report keys path, cost, minimumPaths (number of simple paths tied at minimum cost).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"path":["s","a","c","t"],"cost":5,"minimumPaths":5} },
  },
  {
    id: 'agentic-multi-v2-rolling-window',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"events.json\": \"[{\\\"t\\\":0,\\\"n\\\":2},{\\\"t\\\":2,\\\"n\\\":3},{\\\"t\\\":5,\\\"n\\\":7},{\\\"t\\\":5,\\\"n\\\":-1},{\\\"t\\\":8,\\\"n\\\":4},{\\\"t\\\":10,\\\"n\\\":6}]\"\n}\n\nFor each input event in order, include already-seen events with timestamp strictly greater than current t minus 5 and less than or equal to current t, including the current event. Later events at the same timestamp are not yet seen. Write rolling.json containing each sum. Read it and report keys sums, peak, last.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"sums":[2,5,10,9,10,10],"peak":10,"last":10} },
  },
  {
    id: 'agentic-multi-v2-atomic-snapshot',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"live/state.json\": \"{\\\"revision\\\":1,\\\"items\\\":[1,2]}\",\n  \"updates.json\": \"[{\\\"revision\\\":3,\\\"items\\\":[7]},{\\\"revision\\\":2,\\\"items\\\":[9,9]},{\\\"revision\\\":3,\\\"items\\\":[8]},{\\\"revision\\\":4,\\\"items\\\":[]}]\"\n}\n\nProcess update snapshots in order. Accept only revisions strictly greater than the currently stored revision. For each accepted snapshot write live/state.tmp then rename it over live/state.json. Stale or equal revisions are ignored. Read the final state. Report keys revision, items, accepted, ignored, tempExists.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"revision":4,"items":[],"accepted":2,"ignored":2,"tempExists":false} },
  },
  {
    id: 'agentic-multi-v2-balanced-delimiter-parser',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"source.txt\": \"call(\\\"([)]\\\", [1, {x: \\\"]\\\", y: [2,3]}]);\\nnext({a:\\\"escaped \\\\\\\" ]\\\", b:[]});\"\n}\n\nValidate brackets (),[],{} with a stack, ignoring brackets inside double-quoted strings; backslash escapes the next character inside strings. The input has no comments or single-quoted strings. Write analysis.json. Report keys valid, pairs (matched closing delimiters), maximumDepth (stack depth outside strings).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"valid":true,"pairs":7,"maximumDepth":4} },
  },
  {
    id: 'agentic-multi-v2-tombstone-compaction',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"segments/0.json\": \"[{\\\"k\\\":\\\"a\\\",\\\"v\\\":1},{\\\"k\\\":\\\"b\\\",\\\"v\\\":2},{\\\"k\\\":\\\"c\\\",\\\"v\\\":3}]\",\n  \"segments/1.json\": \"[{\\\"k\\\":\\\"b\\\",\\\"deleted\\\":true},{\\\"k\\\":\\\"a\\\",\\\"v\\\":4},{\\\"k\\\":\\\"d\\\",\\\"v\\\":5}]\",\n  \"segments/2.json\": \"[{\\\"k\\\":\\\"c\\\",\\\"deleted\\\":true},{\\\"k\\\":\\\"b\\\",\\\"v\\\":6},{\\\"k\\\":\\\"d\\\",\\\"deleted\\\":true}]\"\n}\n\nReplay segments 0,1,2 and records within each in order; the last record per key wins. Compact by dropping winning tombstones. Write compact.json as live records sorted by k, each with keys k,v. Read it and report keys keys (key array), sum, discarded (input records minus output records).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"keys":["a","b"],"sum":10,"discarded":7} },
  },
  {
    id: 'agentic-multi-v2-matrix-transpose-hash',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"matrix.json\": \"[[1,2,3,4],[5,6,7,8],[9,10,11,12]]\"\n}\n\nTranspose the matrix and write transpose.csv: each transposed row joined by commas, rows joined by LF, one final LF, no header. Read the CSV back. Report keys rows, columns, diagonalSum (sum [i][i] over the smaller dimension), sha256 of transpose.csv.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"rows":4,"columns":3,"diagonalSum":18,"sha256":"2ee00c26d7fa021a8ca160e5382d3c2ff85926cea47c3d71615ab117c5ff549c"} },
  },
  {
    id: 'agentic-multi-v2-rename-cycle',
    taskType: 'agentic_execution',
    subtaskType: 'multi_step_execution',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"files/a.txt\": \"alpha\",\n  \"files/b.txt\": \"beta\",\n  \"files/c.txt\": \"gamma\"\n}\n\nRotate file names simultaneously: original a.txt becomes b.txt, original b.txt becomes c.txt, original c.txt becomes a.txt. Use a temporary filename and renames (no overwrite losing content, no content rewrites). Read the three final files in a,b,c order. Report keys contents (array), tempExists (whether the temporary file remains).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"contents":["gamma","alpha","beta"],"tempExists":false} },
  },
  {
    id: 'agentic-term-v2-pipeline-last-status',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"input.txt\": \"apple\\npear\\n\"\n}\n\nRun this POSIX sh command exactly (no pipefail): sh -c 'grep kiwi input.txt | sort > sorted.txt; printf \"%s\\n\" \"$?\" > status.txt'. Then use Node to report keys status (number in status.txt), bytes (sorted.txt size).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"status":0,"bytes":0} },
  },
  {
    id: 'agentic-term-v2-and-or-associativity',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"anchor.txt\": \"anchor\"\n}\n\nRun: sh -c 'false && printf A > trace.txt || printf B > trace.txt && printf C >> trace.txt; true || printf D >> trace.txt; printf E >> trace.txt'. Report only trace.txt contents, with no extra text.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only the requested final output line.",
    check: { kind: 'exact', value: "BCE" },
  },
  {
    id: 'agentic-term-v2-subshell-working-directory',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"nested/value.txt\": \"inside\",\n  \"value.txt\": \"outside\"\n}\n\nRun: sh -c '(cd nested && cat value.txt) > sub.txt; cat value.txt > parent.txt'. Read the output files and report keys sub, parent (strings).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"sub":"inside","parent":"outside"} },
  },
  {
    id: 'agentic-term-v2-temporary-env-scope',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"read-env.cjs\": \"const fs = require(\\\"node:fs\\\"); fs.writeFileSync(process.argv[2], process.env.LABEL);\\n\"\n}\n\nRun: sh -c 'LABEL=outer; export LABEL; LABEL=inner node read-env.cjs first.txt; node read-env.cjs second.txt; printf \"%s\" \"$LABEL\" > third.txt'. Read the three files and report keys values (array in first,second,third order), distinct (number of distinct values).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"values":["inner","outer","outer"],"distinct":2} },
  },
  {
    id: 'agentic-term-v2-positional-shift',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"anchor.txt\": \"x\"\n}\n\nRun: sh -c 'set -- \"a b\" \"\" \"c*\" \"tail\"; shift; printf \"%s\\n\" \"$#\" \"$1\" \"$2\" \"$3\" > args.txt'. Treat every LF as a delimiter, preserving empty fields except the final trailing separator. Report keys count (first field as number), args (remaining three strings), bytes (args.txt size).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"count":3,"args":["","c*","tail"],"bytes":11} },
  },
  {
    id: 'agentic-term-v2-numeric-sort-unique',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"numbers.txt\": \"10\\n2\\n-1\\n02\\n10\\n2.0\\n-10\\n\"\n}\n\nRun: sh -c 'LC_ALL=C sort -n numbers.txt | uniq > sorted.txt'. Note uniq compares literal adjacent lines, not numerical values. Report keys lines (array, excluding final trailing separator), count.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"lines":["-10","-1","02","2","2.0","10"],"count":6} },
  },
  {
    id: 'agentic-term-v2-redirection-order',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"emit.cjs\": \"process.stdout.write(\\\"OUT\\\\n\\\"); process.stderr.write(\\\"ERR\\\\n\\\");\\n\"\n}\n\nUse Node spawnSync to run sh -c \"node emit.cjs > first.txt 2>&1\" and then sh -c \"node emit.cjs 2>&1 > second.txt\", capturing shell stdout. Write second-captured.txt from the second shell stdout. Report keys first (first.txt string), second (second.txt string), captured (second-captured.txt string).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"first":"OUT\nERR\n","second":"OUT\n","captured":"ERR\n"} },
  },
  {
    id: 'agentic-term-v2-heredoc-expansion',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"anchor.txt\": \"x\"\n}\n\nRun this script with POSIX sh. The quoted and unquoted heredoc delimiters are intentional:\nNAME=world\ncat > literal.txt <<'EOF'\nhello $NAME\n$(printf hidden)\nEOF\ncat > expanded.txt <<EOF\nhello $NAME\n$(printf visible)\nEOF\nThen report keys literal, expanded as complete file contents, including final newlines.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"literal":"hello $NAME\n$(printf hidden)\n","expanded":"hello world\nvisible\n"} },
  },
  {
    id: 'agentic-term-v2-command-substitution-newlines',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"value.txt\": \"alpha\\n\\n\\n\"\n}\n\nRun: sh -c 'v=$(cat value.txt); printf \"[%s]\" \"$v\" > result.txt'. Report keys text (result.txt), bytes (its byte length), sourceLf (number of LF bytes in value.txt).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"text":"[alpha]","bytes":7,"sourceLf":3} },
  },
  {
    id: 'agentic-term-v2-set-e-exempt-conditions',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"anchor.txt\": \"x\"\n}\n\nRun this script with POSIX sh and capture exit status:\nset -e\nif false; then printf X > trace.txt; else printf A > trace.txt; fi\nfalse || printf B >> trace.txt\nfalse && printf X >> trace.txt\nprintf C >> trace.txt\nfalse\nprintf D >> trace.txt\nReport keys status, trace (trace.txt contents).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"status":1,"trace":"ABC"} },
  },
  {
    id: 'agentic-term-v2-quoted-glob-boundaries',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"data/a b.txt\": \"1\",\n  \"data/c.txt\": \"22\",\n  \"data/.hidden.txt\": \"333\",\n  \"data/no.dat\": \"4444\"\n}\n\nRun: sh -c 'LC_ALL=C; export LC_ALL; set -- data/*.txt; printf \"%s\\n\" \"$@\" > matches.txt'. Read matches.txt and report keys paths (array), bytes (sum of matched file sizes). Hidden names must not match the glob.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"paths":["data/a b.txt","data/c.txt"],"bytes":3} },
  },
  {
    id: 'agentic-term-v2-find-null-filenames',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"data/a b.txt\": \"aa\",\n  \"data/line\\nbreak.txt\": \"bbb\",\n  \"data/nested/c.txt\": \"c\",\n  \"data/no.json\": \"{}\"\n}\n\nSpawn find with arguments [\"data\",\"-type\",\"f\",\"-name\",\"*.txt\",\"-print0\"]. Parse the captured stdout as NUL-delimited filenames (never newline-delimited). Code-unit sort them and write paths.json. Read it and report keys paths, count, bytes (sum of listed file sizes).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"paths":["data/a b.txt","data/line\nbreak.txt","data/nested/c.txt"],"count":3,"bytes":6} },
  },
  {
    id: 'agentic-term-v2-trap-exit-status',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"seed.txt\": \"seed\"\n}\n\nRun this POSIX sh script using Node spawnSync and record the status:\ntrap 'printf \"clean\" > cleanup.txt' 0\nprintf partial > work.tmp\nexit 7\nThen report keys status, cleanup (cleanup.txt contents), workBytes (work.tmp size).\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"status":7,"cleanup":"clean","workBytes":7} },
  },
  {
    id: 'agentic-term-v2-offline-npm-lifecycle',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"package.json\": \"{\\\"name\\\":\\\"fixture\\\",\\\"version\\\":\\\"1.0.0\\\",\\\"private\\\":true,\\\"scripts\\\":{\\\"prebuild\\\":\\\"node stage.cjs pre\\\",\\\"build\\\":\\\"node stage.cjs build\\\",\\\"postbuild\\\":\\\"node stage.cjs post\\\"}}\",\n  \"stage.cjs\": \"const fs=require(\\\"node:fs\\\"); const stage=process.argv[2]; const text=fs.existsSync(\\\"trace.txt\\\")?fs.readFileSync(\\\"trace.txt\\\",\\\"utf8\\\"):\\\"\\\"; fs.writeFileSync(\\\"trace.txt\\\",text+stage+\\\"\\\\n\\\");\\n\"\n}\n\nRun npm run build --offline --ignore-scripts (do not run npm install). This option runs the explicitly requested script, but not its pre/post lifecycle hooks. Then run npm run build --offline without --ignore-scripts. Read trace.txt. Report keys stages (array of lines without final trailing separator), count.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"stages":["build","pre","build","post"],"count":4} },
  },
  {
    id: 'agentic-term-v2-child-failure-artifact',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"worker.cjs\": \"const fs=require(\\\"node:fs\\\"); fs.writeFileSync(\\\"artifact.txt\\\",\\\"ready\\\\n\\\"); process.stdout.write(\\\"notice\\\\n\\\"); process.stderr.write(\\\"failure\\\\n\\\"); process.exitCode=23;\\n\"\n}\n\nSpawn node worker.cjs from Node, capture stdout, stderr, and status, and do not throw merely because status is nonzero. Write captured.json with keys stdout, stderr, status; read it back. Report keys status, stdout, stderr, artifact (artifact.txt contents), in that order.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"status":23,"stdout":"notice\n","stderr":"failure\n","artifact":"ready\n"} },
  },
  {
    id: 'agentic-term-v2-stdin-binary-framing',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"input.json\": \"[0,10,13,255,65,0,66,10]\",\n  \"worker.cjs\": \"const fs=require(\\\"node:fs\\\"); const b=fs.readFileSync(0); const out=Buffer.concat([Buffer.from([b.length]),Buffer.from(b).reverse(),Buffer.from([0])]); fs.writeFileSync(\\\"framed.bin\\\",out);\\n\"\n}\n\nDecode input.json as a byte array and pipe those bytes, not JSON text, into node worker.cjs using spawnSync input. Report only the full lowercase SHA-256 of framed.bin.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only the requested final output line.",
    check: { kind: 'exact', value: "2428f4d942398f79720ddb15c435386f5eb34e092c0b990f309e6b7c70b90159" },
  },
  {
    id: 'agentic-term-v2-recursive-script-module-mode',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"package.json\": \"{\\\"type\\\":\\\"module\\\"}\",\n  \"data.json\": \"[3,10,2,3,-1]\",\n  \"scripts/worker.cjs\": \"const fs=require(\\\"node:fs\\\"); const values=JSON.parse(fs.readFileSync(\\\"data.json\\\",\\\"utf8\\\")); const sorted=[...new Set(values)].sort((a,b)=>a-b); fs.writeFileSync(\\\"result.txt\\\",sorted.join(\\\",\\\"));\\n\"\n}\n\nRun node scripts/worker.cjs from the directory containing package.json (do not cd into scripts). The .cjs file is CommonJS despite package type module. Report only result.txt contents.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only the requested final output line.",
    check: { kind: 'exact', value: "-1,2,3,10" },
  },
  {
    id: 'agentic-term-v2-microtask-nexttick-trace',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"seed.json\": \"7\",\n  \"run.cjs\": \"const fs = require('node:fs');\\nconst seed = JSON.parse(fs.readFileSync('seed.json', 'utf8'));\\nconst trace = [];\\nfunction log(value) {\\n  trace.push(value);\\n}\\nlog('start:' + seed);\\nprocess.nextTick(() => {\\n  log('tick');\\n  Promise.resolve().then(() => log('tick-promise'));\\n});\\nPromise.resolve().then(() => {\\n  log('promise-1');\\n  queueMicrotask(() => log('nested-micro'));\\n  process.nextTick(() => log('nested-tick'));\\n});\\nqueueMicrotask(() => {\\n  log('micro-1');\\n  Promise.resolve().then(() => log('micro-promise'));\\n});\\nasync function work() {\\n  log('work-before');\\n  await 0;\\n  log('work-after');\\n  await Promise.resolve();\\n  log('work-end');\\n}\\nwork().then(() => log('work-done'));\\nlog('sync-end');\\nsetImmediate(() => {\\n  fs.writeFileSync('trace.json', JSON.stringify(trace));\\n  const parsed = JSON.parse(fs.readFileSync('trace.json', 'utf8'));\\n  process.stdout.write(JSON.stringify({ trace: parsed, count: parsed.length }));\\n});\\n\"\n}\n\nRun node run.cjs exactly. Wait for exit, then return only the compact JSON it prints. Keys are trace then count. Do not rewrite the script or move it into an ES module.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"trace":["start:7","work-before","sync-end","tick","promise-1","micro-1","work-after","tick-promise","nested-micro","micro-promise","work-end","work-done","nested-tick"],"count":13} },
  },
  {
    id: 'agentic-term-v2-buffer-alias-overlap',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"seed.json\": \"[0,1,2,3,4,5,6,7,8,9]\",\n  \"run.cjs\": \"const fs = require('node:fs');\\nconst crypto = require('node:crypto');\\nconst source = JSON.parse(fs.readFileSync('seed.json', 'utf8'));\\nconst base = Buffer.from(source);\\nconst view = base.subarray(2, 7);\\nconst copy = Buffer.from(view);\\nconst shared = new Uint8Array(base.buffer, base.byteOffset + 1, 5);\\nconst snapshots = [];\\nfunction record(label) {\\n  snapshots.push({\\n    label,\\n    base: base.toString('hex'),\\n    view: view.toString('hex'),\\n    copy: copy.toString('hex'),\\n  });\\n}\\nrecord('initial');\\nview.fill(255, 1, 3);\\nrecord('fill');\\nshared[0] = 42;\\nshared[4] = 0;\\nrecord('shared');\\ncopy[0] = 99;\\nrecord('copy');\\nbase.copy(base, 3, 0, 5);\\nrecord('overlap');\\nconst parts = [base, view, copy];\\nfs.writeFileSync('result.bin', Buffer.concat(parts));\\nfs.writeFileSync('snapshots.json', JSON.stringify(snapshots));\\nconst output = fs.readFileSync('result.bin');\\nconst sha256 = crypto.createHash('sha256').update(output).digest('hex');\\nprocess.stdout.write(JSON.stringify({\\n  final: base.toString('hex'),\\n  bytes: output.length,\\n  sha256,\\n}));\\n\"\n}\n\nRun node run.cjs exactly. The distinction between shared views, copied buffers, and overlapping copies matters. Return only its JSON stdout with keys final, bytes, sha256.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only compact JSON with the exact keys in the requested order.",
    check: { kind: 'json_equal', value: {"final":"002a02002a02ffff0809","bytes":20,"sha256":"21720088552c05715688e4d71444c76f54f7c417aa2373eb575b096660dc4cd1"} },
  },
  {
    id: 'agentic-term-v2-bigint-modular-residue-hash',
    taskType: 'agentic_execution',
    subtaskType: 'terminal_operations',
    systemPrompt: AGENT_SYS,
    userPrompt:
      "Work in a new empty directory. Create these files with exactly the UTF-8 contents below; contents are encoded as JSON strings (decode the escapes, and add no extra newline):\n{\n  \"config.json\": \"{\\\"modulus\\\":\\\"1000000007\\\",\\\"pairs\\\":[[\\\"9007199254740993\\\",\\\"17\\\"],[\\\"123456789123456789\\\",\\\"31\\\"],[\\\"2\\\",\\\"1000\\\"],[\\\"5\\\",\\\"0\\\"],[\\\"1000000007\\\",\\\"9\\\"]]}\",\n  \"run.cjs\": \"const fs = require('node:fs');\\nconst crypto = require('node:crypto');\\nconst config = JSON.parse(fs.readFileSync('config.json', 'utf8'));\\nconst modulus = BigInt(config.modulus);\\nfunction modPow(base, exponent) {\\n  let value = 1n;\\n  base %= modulus;\\n  while (exponent > 0n) {\\n    if ((exponent & 1n) === 1n) {\\n      value = value * base % modulus;\\n    }\\n    base = base * base % modulus;\\n    exponent >>= 1n;\\n  }\\n  return value;\\n}\\nconst rows = [];\\nfor (const pair of config.pairs) {\\n  const base = BigInt(pair[0]);\\n  const exponent = BigInt(pair[1]);\\n  const result = modPow(base, exponent);\\n  rows.push({ base: pair[0], exponent: pair[1], result: result.toString() });\\n}\\nrows.sort((a, b) => {\\n  const x = BigInt(a.result);\\n  const y = BigInt(b.result);\\n  return x < y ? -1 : x > y ? 1 : 0;\\n});\\nconst serialized = rows.map(row => row.result).join('\\\\n') + '\\\\n';\\nfs.writeFileSync('residues.txt', serialized);\\nconst bytes = fs.readFileSync('residues.txt');\\nconst digest = crypto.createHash('sha256').update(bytes).digest('hex');\\nprocess.stdout.write(digest);\\n\"\n}\n\nRun node run.cjs exactly, using no dependencies or network. Do not replace BigInt arithmetic with Number. Report only its stdout: the full lowercase SHA-256 of residues.txt.\nUse file and terminal tools: write and run a Node.js script against the files; do not just reason from the prompt. Return only the requested final output line.",
    check: { kind: 'exact', value: "228575e3f2f37845a3396eb6003d0dddf57461b658c7146744f2285add7e7b57" },
  },
];
