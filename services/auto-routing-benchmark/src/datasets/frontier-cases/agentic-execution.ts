import type { DeciderCase } from '../decider-cases';

export const AGENTIC_EXECUTION_FRONTIER_CASES: readonly DeciderCase[] = [
  {
    "id": "frontier-agentic-tool_usage-dependency-release",
    "taskType": "agentic_execution",
    "subtaskType": "tool_usage",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"jobs.json\": \"[{\\\"id\\\":\\\"a\\\",\\\"duration\\\":4},{\\\"id\\\":\\\"b\\\",\\\"duration\\\":11},{\\\"id\\\":\\\"c\\\",\\\"duration\\\":7},{\\\"id\\\":\\\"d\\\",\\\"duration\\\":3},{\\\"id\\\":\\\"e\\\",\\\"duration\\\":10},{\\\"id\\\":\\\"f\\\",\\\"duration\\\":6},{\\\"id\\\":\\\"g\\\",\\\"duration\\\":2},{\\\"id\\\":\\\"h\\\",\\\"duration\\\":9},{\\\"id\\\":\\\"i\\\",\\\"duration\\\":5},{\\\"id\\\":\\\"j\\\",\\\"duration\\\":1},{\\\"id\\\":\\\"k\\\",\\\"duration\\\":8}]\",\n  \"edges.json\": \"[[\\\"b\\\",\\\"c\\\"],[\\\"a\\\",\\\"b\\\"],[\\\"i\\\",\\\"k\\\"],[\\\"f\\\",\\\"k\\\"],[\\\"b\\\",\\\"k\\\"],[\\\"h\\\",\\\"j\\\"],[\\\"d\\\",\\\"j\\\"],[\\\"a\\\",\\\"j\\\"],[\\\"f\\\",\\\"i\\\"],[\\\"c\\\",\\\"i\\\"],[\\\"e\\\",\\\"h\\\"],[\\\"a\\\",\\\"h\\\"],[\\\"c\\\",\\\"g\\\"],[\\\"e\\\",\\\"f\\\"],[\\\"b\\\",\\\"f\\\"],[\\\"d\\\",\\\"e\\\"],[\\\"b\\\",\\\"d\\\"],[\\\"a\\\",\\\"c\\\"]]\"\n}\n\nRead both files. Deduplicate directed dependency edges. For an unlimited-worker earliest-start schedule, a job begins only after every predecessor finishes; roots begin at 0. Write timeline.tsv, sorted by job id, each line id<TAB>start<TAB>finish with final LF. Write report.json with makespan (maximum finish), critical (all ids whose finish equals makespan, sorted), sha256 (timeline.tsv).\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"makespan\", \"critical\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "makespan": 47,
        "critical": [
          "k"
        ],
        "sha256": "b56750935d8c88137deda69a5a50fd1db6d9cba059237d7e0d555e7a528ec009"
      }
    }
  },
  {
    "id": "frontier-agentic-tool_usage-revision-reconciliation",
    "taskType": "agentic_execution",
    "subtaskType": "tool_usage",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"one.jsonl\": \"{\\\"id\\\":\\\"key3\\\",\\\"rev\\\":1,\\\"source\\\":0,\\\"value\\\":-10,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key1\\\",\\\"rev\\\":0,\\\"source\\\":1,\\\"value\\\":3}\\n{\\\"id\\\":\\\"key8\\\",\\\"rev\\\":5,\\\"source\\\":2,\\\"value\\\":16}\\n{\\\"id\\\":\\\"key6\\\",\\\"rev\\\":4,\\\"source\\\":0,\\\"value\\\":-2}\\n{\\\"id\\\":\\\"key4\\\",\\\"rev\\\":3,\\\"source\\\":1,\\\"value\\\":11}\\n{\\\"id\\\":\\\"key2\\\",\\\"rev\\\":2,\\\"source\\\":2,\\\"value\\\":-7}\\n{\\\"id\\\":\\\"key0\\\",\\\"rev\\\":1,\\\"source\\\":0,\\\"value\\\":6}\\n{\\\"id\\\":\\\"key7\\\",\\\"rev\\\":0,\\\"source\\\":1,\\\"value\\\":19,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key5\\\",\\\"rev\\\":5,\\\"source\\\":2,\\\"value\\\":1}\\n{\\\"id\\\":\\\"key3\\\",\\\"rev\\\":4,\\\"source\\\":0,\\\"value\\\":14}\\n{\\\"id\\\":\\\"key1\\\",\\\"rev\\\":3,\\\"source\\\":1,\\\"value\\\":-4}\\n{\\\"id\\\":\\\"key8\\\",\\\"rev\\\":2,\\\"source\\\":2,\\\"value\\\":9}\\n{\\\"id\\\":\\\"key6\\\",\\\"rev\\\":1,\\\"source\\\":0,\\\"value\\\":-9}\\n{\\\"id\\\":\\\"key4\\\",\\\"rev\\\":0,\\\"source\\\":1,\\\"value\\\":4}\\n{\\\"id\\\":\\\"key2\\\",\\\"rev\\\":5,\\\"source\\\":2,\\\"value\\\":17,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key0\\\",\\\"rev\\\":4,\\\"source\\\":0,\\\"value\\\":-1}\\n{\\\"id\\\":\\\"key7\\\",\\\"rev\\\":3,\\\"source\\\":1,\\\"value\\\":12}\\n{\\\"id\\\":\\\"key5\\\",\\\"rev\\\":2,\\\"source\\\":2,\\\"value\\\":-6}\\n{\\\"id\\\":\\\"key3\\\",\\\"rev\\\":1,\\\"source\\\":0,\\\"value\\\":7}\\n{\\\"id\\\":\\\"key1\\\",\\\"rev\\\":0,\\\"source\\\":1,\\\"value\\\":20}\\n\",\n  \"two.jsonl\": \"{\\\"id\\\":\\\"key8\\\",\\\"rev\\\":5,\\\"source\\\":2,\\\"value\\\":2}\\n{\\\"id\\\":\\\"key6\\\",\\\"rev\\\":4,\\\"source\\\":0,\\\"value\\\":15,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key4\\\",\\\"rev\\\":3,\\\"source\\\":1,\\\"value\\\":-3}\\n{\\\"id\\\":\\\"key2\\\",\\\"rev\\\":2,\\\"source\\\":2,\\\"value\\\":10}\\n{\\\"id\\\":\\\"key0\\\",\\\"rev\\\":1,\\\"source\\\":0,\\\"value\\\":-8}\\n{\\\"id\\\":\\\"key7\\\",\\\"rev\\\":0,\\\"source\\\":1,\\\"value\\\":5}\\n{\\\"id\\\":\\\"key5\\\",\\\"rev\\\":5,\\\"source\\\":2,\\\"value\\\":18}\\n{\\\"id\\\":\\\"key3\\\",\\\"rev\\\":4,\\\"source\\\":0,\\\"value\\\":0}\\n{\\\"id\\\":\\\"key1\\\",\\\"rev\\\":3,\\\"source\\\":1,\\\"value\\\":13,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key8\\\",\\\"rev\\\":2,\\\"source\\\":2,\\\"value\\\":-5}\\n{\\\"id\\\":\\\"key6\\\",\\\"rev\\\":1,\\\"source\\\":0,\\\"value\\\":8}\\n{\\\"id\\\":\\\"key4\\\",\\\"rev\\\":0,\\\"source\\\":1,\\\"value\\\":-10}\\n{\\\"id\\\":\\\"key2\\\",\\\"rev\\\":5,\\\"source\\\":2,\\\"value\\\":3}\\n{\\\"id\\\":\\\"key0\\\",\\\"rev\\\":4,\\\"source\\\":0,\\\"value\\\":16}\\n{\\\"id\\\":\\\"key7\\\",\\\"rev\\\":3,\\\"source\\\":1,\\\"value\\\":-2}\\n{\\\"id\\\":\\\"key5\\\",\\\"rev\\\":2,\\\"source\\\":2,\\\"value\\\":11,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key3\\\",\\\"rev\\\":1,\\\"source\\\":0,\\\"value\\\":-7}\\n{\\\"id\\\":\\\"key1\\\",\\\"rev\\\":0,\\\"source\\\":1,\\\"value\\\":6}\"\n}\n\nRead one.jsonl then two.jsonl, treating them as one ordered stream. For each id choose highest rev, then highest source, then latest stream position. Tombstones participate in winner selection and only winning tombstones are removed; never resurrect a lower revision. Write winners.json as [id,value] pairs in ascending code-unit id order, compact JSON with no newline. Write report.json with count, sum of live values, sha256 of winners.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"count\", \"sum\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "count": 7,
        "sum": 34,
        "sha256": "4be577bcb518eb95603624086dae2f3b7fb005ce98ae5b08514d4aaea7faec39"
      }
    }
  },
  {
    "id": "frontier-agentic-tool_usage-zigzag-binary-index",
    "taskType": "agentic_execution",
    "subtaskType": "tool_usage",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"integers.json\": \"[\\\"0\\\",\\\"-1\\\",\\\"127\\\",\\\"-128\\\",\\\"128\\\",\\\"-129\\\",\\\"16384\\\",\\\"-8193\\\",\\\"9007199254740993\\\",\\\"-4611686018427387904\\\"]\"\n}\n\nRead signed decimal integers as BigInt. Zigzag encode n as 2*n for nonnegative n, otherwise -2*n-1, then encode unsigned LEB128 (least-significant 7-bit groups first, continuation high bit). Concatenate into values.bin. Decode values.bin again and write decoded.json as decimal strings. Write report.json with bytes (values.bin length), offsets (each encoded integer starting byte offset), sum (decoded BigInt decimal sum), sha256 of values.bin.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"bytes\", \"offsets\", \"sum\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "bytes": 33,
        "offsets": [
          0,
          1,
          2,
          4,
          6,
          8,
          10,
          13,
          16,
          24
        ],
        "sum": "-4602678819172638723",
        "sha256": "dbb748fa460943c7ea8be237a2a5ccdab90b9a8238a7791d2e3b5d883cd7ca46"
      }
    }
  },
  {
    "id": "frontier-agentic-tool_usage-streaming-unicode",
    "taskType": "agentic_execution",
    "subtaskType": "tool_usage",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"chunks.json\": \"[\\\"ceb1\\\",\\\"f09f99\\\",\\\"820d\\\",\\\"0a7a65\\\",\\\"726f\\\",\\\"0065cc\\\",\\\"810a\\\",\\\"f09090\\\",\\\"80e7\\\",\\\"b5820d\\\",\\\"0ac3\\\",\\\"a9c3a9\\\",\\\"c3a9\\\",\\\"0a\\\"]\"\n}\n\nRead hex byte chunks in order. Decode incrementally with TextDecoder in streaming mode; UTF-8 code points may cross chunk boundaries. Flush the decoder at EOF. Replace CRLF with LF after concatenation, then normalize the whole decoded text to NFC. Write normalized.bin. Write report.json with bytes (normalized.bin size), codePoints (Unicode scalar count, including controls), lfOffsets (zero-based byte indexes of LF), sha256 of normalized.bin.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"bytes\", \"codePoints\", \"lfOffsets\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "bytes": 30,
        "codePoints": 17,
        "lfOffsets": [
          6,
          14,
          22,
          29
        ],
        "sha256": "2db6035e0ed535319fdbadad424a9e1c375748d08c37ea01addae4763dd9d100"
      }
    }
  },
  {
    "id": "frontier-agentic-tool_usage-merkle-file-tree",
    "taskType": "agentic_execution",
    "subtaskType": "tool_usage",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"tree/a.txt\": \"A\\n\",\n  \"tree/z/é.txt\": \"é🙂\",\n  \"tree/z/empty\": \"\",\n  \"tree/.hidden/keep\": \"included\",\n  \"tree/b.txt\": \"BBB\"\n}\n\nRecursively inventory tree, including dotfiles and empty files. A file digest is SHA-256 of its bytes. A directory digest is SHA-256 of UTF-8 concatenated child records sorted by JavaScript default code-unit name order. A child record is name + NUL + type (F for file, D for directory) + NUL + child digest + LF. Never normalize names or contents. Write merkle.json containing root (digest of tree), files (regular file count), bytes (sum of file bytes). Report merkle.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"root\", \"files\", \"bytes\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "root": "5e7bb4088b1f31ffa0f9fa548feeda69dc8a850132ce7371435aee42606e35cf",
        "files": 5,
        "bytes": 20
      }
    }
  },
  {
    "id": "frontier-agentic-tool_usage-crash-journal",
    "taskType": "agentic_execution",
    "subtaskType": "tool_usage",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"snapshot.json\": \"{\\\"x\\\":0,\\\"y\\\":1}\",\n  \"wal.jsonl\": \"[\\\"begin\\\",\\\"a\\\"]\\n[\\\"set\\\",\\\"a\\\",\\\"x\\\",12]\\n[\\\"begin\\\",\\\"b\\\"]\\n[\\\"set\\\",\\\"b\\\",\\\"x\\\",23]\\n[\\\"commit\\\",\\\"a\\\"]\\n[\\\"set\\\",\\\"b\\\",\\\"y\\\",4]\\n[\\\"begin\\\",\\\"c\\\"]\\n[\\\"set\\\",\\\"c\\\",\\\"z\\\",99]\\n[\\\"abort\\\",\\\"c\\\"]\\n[\\\"commit\\\",\\\"b\\\"]\\n[\\\"begin\\\",\\\"d\\\"]\\n[\\\"delete\\\",\\\"d\\\",\\\"x\\\"]\\n[\\\"set\\\",\\\"d\\\",\\\"q\\\",7]\\n[\\\"commit\\\",\\\"d\\\"]\\n[\\\"begin\\\",\\\"e\\\"]\\n[\\\"set\\\",\\\"e\\\",\\\"y\\\",-8]\\n[\\\"begin\\\",\\\"f\\\"]\\n[\\\"set\\\",\\\"f\\\",\\\"q\\\",30]\\n[\\\"commit\\\",\\\"f\\\"]\\n[\\\"set\\\",\\\"e\\\",\\\"r\\\",100]\"\n}\n\nReplay the WAL from snapshot.json. begin opens an isolated write buffer; set/delete append to that transaction. commit applies its buffered operations to current global state in order, not to a begin-time snapshot. abort discards it. Discard every still-open transaction at EOF (simulated crash). Write recovered.json as [key,value] pairs in ascending key order, compact JSON without newline. Write report.json with rows, commits (committed transaction ids in commit order), discarded (still-open ids sorted), sha256 of recovered.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"rows\", \"commits\", \"discarded\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "rows": [
          [
            "q",
            30
          ],
          [
            "y",
            4
          ]
        ],
        "commits": [
          "a",
          "b",
          "d",
          "f"
        ],
        "discarded": [
          "e"
        ],
        "sha256": "a19d2db860bf3934184f42a1440349ec9f7e9d4f151afd0d7c82526db08fb54a"
      }
    }
  },
  {
    "id": "frontier-agentic-tool_usage-quoted-temporal-join",
    "taskType": "agentic_execution",
    "subtaskType": "tool_usage",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"sales.csv\": \"id,region,amount,time\\r\\n\\\"a,1\\\",west,11,2\\r\\n\\\"b\\\"\\\"2\\\",east,-3,3\\r\\n\\\"line\\nbreak\\\",west,7,5\\r\\né,east,4,1\\r\\ndup,west,-8,6\\r\\ndup,west,12,4\\r\\n\",\n  \"rates.json\": \"[[\\\"west\\\",0,4,3],[\\\"west\\\",4,7,5],[\\\"east\\\",0,3,7],[\\\"east\\\",3,8,2]]\"\n}\n\nParse CSV including doubled quotes, embedded LF and commas; CRLF separates records only outside quotes. Header is not data. Rate tuples are [region,start,end,multiplier]. Join each sale to its unique rate with start<=time<end. Keep duplicate ids and input record order. Write joined.json as [id,amount*multiplier] pairs, compact JSON without newline. Write report.json with rows (data record count), total, sha256 of joined.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"rows\", \"total\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "rows": 6,
        "total": 110,
        "sha256": "0c7a1b1a7c0f02889c1f0db62069e4504c832658ff82c399caeadb89f32963d8"
      }
    }
  },
  {
    "id": "frontier-agentic-tool_usage-bounded-allocation",
    "taskType": "agentic_execution",
    "subtaskType": "tool_usage",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"jobs.json\": \"[{\\\"id\\\":\\\"a\\\",\\\"size\\\":2,\\\"value\\\":3},{\\\"id\\\":\\\"b\\\",\\\"size\\\":2,\\\"value\\\":14},{\\\"id\\\":\\\"c\\\",\\\"size\\\":2,\\\"value\\\":8},{\\\"id\\\":\\\"d\\\",\\\"size\\\":2,\\\"value\\\":2},{\\\"id\\\":\\\"e\\\",\\\"size\\\":2,\\\"value\\\":13},{\\\"id\\\":\\\"f\\\",\\\"size\\\":2,\\\"value\\\":7},{\\\"id\\\":\\\"g\\\",\\\"size\\\":2,\\\"value\\\":18},{\\\"id\\\":\\\"h\\\",\\\"size\\\":2,\\\"value\\\":12},{\\\"id\\\":\\\"i\\\",\\\"size\\\":2,\\\"value\\\":6}]\",\n  \"limit.json\": \"{\\\"capacity\\\":7}\"\n}\n\nRead job sizes and values. Exhaustively choose a subset with total size <= capacity. Maximize value; among equal values minimize used size; among equal values and size choose lexicographically smallest comma-joined sorted id list (JavaScript string comparison). Write selected.json as chosen ids sorted ascending. Write report.json with ids, size, value, sha256 of compact selected.json without newline.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"ids\", \"size\", \"value\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "ids": [
          "b",
          "e",
          "g"
        ],
        "size": 6,
        "value": 45,
        "sha256": "282c23ef64714d248be5c61ecd817c7cb871b5efae6d87706aa4dd42fdd797b7"
      }
    }
  },
  {
    "id": "frontier-agentic-tool_usage-modular-recurrence",
    "taskType": "agentic_execution",
    "subtaskType": "tool_usage",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"matrix.json\": \"[[\\\"1\\\",\\\"6\\\",\\\"2\\\",\\\"7\\\"],[\\\"8\\\",\\\"4\\\",\\\"0\\\",\\\"5\\\"],[\\\"6\\\",\\\"2\\\",\\\"7\\\",\\\"3\\\"],[\\\"4\\\",\\\"0\\\",\\\"5\\\",\\\"1\\\"]]\",\n  \"state.json\": \"[\\\"1\\\",\\\"2\\\",\\\"3\\\",\\\"4\\\"]\",\n  \"steps.txt\": \"35\"\n}\n\nTreat matrix rows and state as decimal BigInt. Execute exactly steps synchronous iterations of newState[i]=sum(matrix[i][j]*oldState[j]) modulo 1000000007. Do not update state in place or use floating point. Write state-final.json as decimal strings, compact with no newline. Write report.json with state, sum (sum of residues as a decimal string, not reduced again), sha256 of state-final.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"state\", \"sum\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "state": [
          "168674142",
          "395883409",
          "790428314",
          "127455393"
        ],
        "sum": "1482441258",
        "sha256": "5ccf14dd1f5ffdb60214dc0b4e2ccdf8a511b97592c5f8e34436394200c82fe1"
      }
    }
  },
  {
    "id": "frontier-agentic-tool_usage-pointer-patch-sequence",
    "taskType": "agentic_execution",
    "subtaskType": "tool_usage",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"base.json\": \"{\\\"a\\\":[\\\"p\\\",\\\"q\\\",\\\"r\\\",\\\"s\\\",\\\"t\\\"],\\\"obj\\\":{\\\"a/b\\\":1}}\",\n  \"patch.json\": \"[{\\\"op\\\":\\\"move\\\",\\\"from\\\":\\\"/a/1\\\",\\\"path\\\":\\\"/a/3\\\"},{\\\"op\\\":\\\"copy\\\",\\\"from\\\":\\\"/a/0\\\",\\\"path\\\":\\\"/obj/copied\\\"},{\\\"op\\\":\\\"replace\\\",\\\"path\\\":\\\"/obj/a~1b\\\",\\\"value\\\":10},{\\\"op\\\":\\\"remove\\\",\\\"path\\\":\\\"/a/0\\\"},{\\\"op\\\":\\\"add\\\",\\\"path\\\":\\\"/a/-\\\",\\\"value\\\":\\\"tail0\\\"},{\\\"op\\\":\\\"move\\\",\\\"from\\\":\\\"/obj/copied\\\",\\\"path\\\":\\\"/a/1\\\"},{\\\"op\\\":\\\"add\\\",\\\"path\\\":\\\"/obj/~0\\\",\\\"value\\\":[false,null]},{\\\"op\\\":\\\"copy\\\",\\\"from\\\":\\\"/obj/~0\\\",\\\"path\\\":\\\"/obj/list\\\"},{\\\"op\\\":\\\"replace\\\",\\\"path\\\":\\\"/obj/~0/0\\\",\\\"value\\\":false}]\"\n}\n\nApply the JSON Patch operations in order. Decode JSON Pointer ~1 as slash and ~0 as tilde. move removes the source before evaluating the destination; an array add inserts and - appends. copy deep-clones; existing copied values must not change after later mutations. Preserve object insertion order as JavaScript does. Write result.json as compact JSON without newline. Write report.json with a (final array), slash (obj[\"a/b\"]), tilde (obj[\"~\"]), list (obj.list), sha256 of result.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"a\", \"slash\", \"tilde\", \"list\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "a": [
          "r",
          "p",
          "s",
          "q",
          "t",
          "tail0"
        ],
        "slash": 10,
        "tilde": [
          false,
          null
        ],
        "list": [
          true,
          null
        ],
        "sha256": "c41c1c62a0f0b8987c40026bd2605612b4ce68a950e48d5f2091b7b57e69cb99"
      }
    }
  },
  {
    "id": "frontier-agentic-tool_usage-module-condensation",
    "taskType": "agentic_execution",
    "subtaskType": "tool_usage",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"modules.json\": \"[[\\\"k\\\",\\\"j\\\"],[\\\"j\\\",\\\"k\\\"],[\\\"j\\\",\\\"i\\\"],[\\\"h\\\",\\\"i\\\"],[\\\"h\\\",\\\"f\\\"],[\\\"g\\\",\\\"h\\\"],[\\\"f\\\",\\\"g\\\"],[\\\"e\\\",\\\"f\\\"],[\\\"e\\\",\\\"d\\\"],[\\\"d\\\",\\\"e\\\"],[\\\"c\\\",\\\"d\\\"],[\\\"c\\\",\\\"a\\\"],[\\\"b\\\",\\\"c\\\"],[\\\"a\\\",\\\"b\\\"]]\"\n}\n\nTreat each tuple as a directed import edge. Compute strongly connected components. Sort each component by id, then sort components by their smallest id; this order assigns zero-based component indexes. Write components.json compactly without newline. Deduplicate intercomponent edges and sort numerically by source index then target index. Write report.json with components, edges (condensation edges), sha256 of components.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"components\", \"edges\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "components": [
          [
            "a",
            "b",
            "c"
          ],
          [
            "d",
            "e"
          ],
          [
            "f",
            "g",
            "h"
          ],
          [
            "i"
          ],
          [
            "j",
            "k"
          ]
        ],
        "edges": [
          [
            0,
            1
          ],
          [
            1,
            2
          ],
          [
            2,
            3
          ],
          [
            4,
            3
          ]
        ],
        "sha256": "0f50809e22266d2c3198913d033689ddc50fb4e3a7ad09869f38b4f802d23c81"
      }
    }
  },
  {
    "id": "frontier-agentic-tool_usage-external-merge-normalization",
    "taskType": "agentic_execution",
    "subtaskType": "tool_usage",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"records.jsonl\": \"{\\\"key\\\":\\\"é\\\",\\\"rev\\\":1,\\\"value\\\":-5}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":4,\\\"value\\\":2}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":7,\\\"value\\\":9}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":2,\\\"value\\\":16}\\n{\\\"key\\\":\\\"a\\\",\\\"rev\\\":5,\\\"value\\\":23}\\n{\\\"key\\\":\\\"A\\\",\\\"rev\\\":0,\\\"value\\\":30}\\n{\\\"key\\\":\\\"🙂\\\",\\\"rev\\\":3,\\\"value\\\":37}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":6,\\\"value\\\":44}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":1,\\\"value\\\":51}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":4,\\\"value\\\":58}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":7,\\\"value\\\":65}\\n{\\\"key\\\":\\\"a\\\",\\\"rev\\\":2,\\\"value\\\":72}\\n{\\\"key\\\":\\\"A\\\",\\\"rev\\\":5,\\\"value\\\":79}\\n{\\\"key\\\":\\\"🙂\\\",\\\"rev\\\":0,\\\"value\\\":86}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":3,\\\"value\\\":93}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":6,\\\"value\\\":100}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":1,\\\"value\\\":107}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":4,\\\"value\\\":114}\\n{\\\"key\\\":\\\"a\\\",\\\"rev\\\":7,\\\"value\\\":121}\\n{\\\"key\\\":\\\"A\\\",\\\"rev\\\":2,\\\"value\\\":128}\\n{\\\"key\\\":\\\"🙂\\\",\\\"rev\\\":5,\\\"value\\\":135}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":0,\\\"value\\\":142}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":3,\\\"value\\\":149}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":6,\\\"value\\\":156}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":1,\\\"value\\\":163}\\n{\\\"key\\\":\\\"a\\\",\\\"rev\\\":4,\\\"value\\\":170}\\n{\\\"key\\\":\\\"A\\\",\\\"rev\\\":7,\\\"value\\\":177}\\n{\\\"key\\\":\\\"🙂\\\",\\\"rev\\\":2,\\\"value\\\":184}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":5,\\\"value\\\":191}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":0,\\\"value\\\":198}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":3,\\\"value\\\":205}\"\n}\n\nRead the records as JSONL. Produce sorted run files with at most 6 input records per run, then merge them. Group keys after NFC normalization then toLowerCase; choose highest rev then latest original input position per normalized key. Final rows are [normalizedKey,rev,value], sorted by unsigned UTF-8 byte order (Buffer.compare), not locale order. Write merged.jsonl with one compact row per line and a final LF. Write report.json with rows, runs (ceiling of input count / 6), sha256 of merged.jsonl.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"rows\", \"runs\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "rows": [
          [
            "a",
            7,
            177
          ],
          [
            "å",
            7,
            65
          ],
          [
            "é",
            6,
            100
          ],
          [
            "🙂",
            5,
            135
          ]
        ],
        "runs": 6,
        "sha256": "31c0697098cec66e361e9c9e4570ef2023aa38ef72e4ffd5ecfafd0c0ab435da"
      }
    }
  },
  {
    "id": "frontier-agentic-tool_usage-link-aware-inventory",
    "taskType": "agentic_execution",
    "subtaskType": "tool_usage",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"assets/a.txt\": \"hello🙂\",\n  \"assets/b.txt\": \"xy\",\n  \"assets/empty\": \"\"\n}\n\nCreate hard link assets/a-copy.txt to assets/a.txt. Create symlinks assets/a-link -> a.txt, assets/dangling -> missing, assets/cycle1 -> cycle2, assets/cycle2 -> cycle1 (relative targets). Inventory with lstat, never follow symlinks. Write inventory.json with regular entry paths sorted ascending and symbolic entry paths sorted ascending. Compute bytesPerName over regular entries; compute uniqueBytes counting each (dev,ino) once. Do not sum symlink lengths. Write report.json with regular, symlinks, bytesPerName, uniqueBytes, sha256 of compact inventory.json without newline. inventory.json keys must be regular then symlinks.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"regular\", \"symlinks\", \"bytesPerName\", \"uniqueBytes\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "regular": [
          "assets/a-copy.txt",
          "assets/a.txt",
          "assets/b.txt",
          "assets/empty"
        ],
        "symlinks": [
          "assets/a-link",
          "assets/cycle1",
          "assets/cycle2",
          "assets/dangling"
        ],
        "bytesPerName": 20,
        "uniqueBytes": 11,
        "sha256": "a50b4c66d1d28a4faad043bf5dbb76adbed414782e2493bc4c49a2bf9e5a0553"
      }
    }
  },
  {
    "id": "frontier-agentic-tool_usage-framed-json-stream",
    "taskType": "agentic_execution",
    "subtaskType": "tool_usage",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"chunks.json\": \"[\\\"7b\\\",\\\"2278\\\",\\\"223a312c22\\\",\\\"73223a\\\",\\\"227d205b205c2222\\\",\\\"2c\\\",\\\"2261\\\",\\\"7272223a5b\\\",\\\"312c7b\\\",\\\"2279223a327d5d7d\\\",\\\"0d\\\",\\\"0a7b\\\",\\\"226e657874\\\",\\\"223a31\\\",\\\"7d20205b312c322c\\\",\\\"7b\\\",\\\"226b\\\",\\\"223a22c3a9\\\",\\\"f09f99\\\",\\\"82227d5d\\\"]\"\n}\n\nIncrementally decode the UTF-8 hex chunks. Split adjacent top-level JSON objects/arrays using balanced braces/brackets while respecting quoted strings and backslash escapes; whitespace between documents is ignored, delimiters inside strings are not nesting. Parse each complete document, serialize it compactly in input order to values.jsonl with final LF. Write report.json with documents, bytes (values.jsonl byte length), sha256 of values.jsonl.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"documents\", \"bytes\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "documents": 3,
        "bytes": 71,
        "sha256": "80c62a70ab1f6937928c18c02128d52331b56173b06bce7185c0762fc0c5014b"
      }
    }
  },
  {
    "id": "frontier-agentic-tool_usage-minimum-audit-cover",
    "taskType": "agentic_execution",
    "subtaskType": "tool_usage",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"checks.json\": \"[{\\\"id\\\":\\\"a\\\",\\\"cost\\\":3,\\\"covers\\\":[0,2,5]},{\\\"id\\\":\\\"b\\\",\\\"cost\\\":2,\\\"covers\\\":[0,2,4,6]},{\\\"id\\\":\\\"c\\\",\\\"cost\\\":9,\\\"covers\\\":[1,3,6]},{\\\"id\\\":\\\"d\\\",\\\"cost\\\":8,\\\"covers\\\":[1,3,5]},{\\\"id\\\":\\\"e\\\",\\\"cost\\\":7,\\\"covers\\\":[0,2,4]},{\\\"id\\\":\\\"f\\\",\\\"cost\\\":6,\\\"covers\\\":[2,4,6]},{\\\"id\\\":\\\"g\\\",\\\"cost\\\":5,\\\"covers\\\":[1,3,5]},{\\\"id\\\":\\\"h\\\",\\\"cost\\\":4,\\\"covers\\\":[0,3,5]},{\\\"id\\\":\\\"i\\\",\\\"cost\\\":3,\\\"covers\\\":[0,2,4,6]},{\\\"id\\\":\\\"j\\\",\\\"cost\\\":2,\\\"covers\\\":[1,4,6]}]\",\n  \"required.json\": \"[0,1,2,3,4,5,6]\"\n}\n\nExecute an offline audit-plan calculation from both files. Choose checks whose union covers every required item. Minimize total cost, then minimize number of checks, then choose lexicographically smallest comma-joined ascending id list. Write plan.json with ids then cost, compact with no newline. Read it back and independently confirm coverage. Write report.json with ids, cost, covered (sorted unique coverage union, including any non-required items), sha256 of plan.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"ids\", \"cost\", \"covered\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "ids": [
          "b",
          "g"
        ],
        "cost": 7,
        "covered": [
          0,
          1,
          2,
          3,
          4,
          5,
          6
        ],
        "sha256": "36608c51ba75dc8f522379fc2025808ea44e6131add093a4794a481b4510570f"
      }
    }
  },
  {
    "id": "frontier-agentic-terminal_operations-dependency-release",
    "taskType": "agentic_execution",
    "subtaskType": "terminal_operations",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"jobs.json\": \"[{\\\"id\\\":\\\"a\\\",\\\"duration\\\":7},{\\\"id\\\":\\\"b\\\",\\\"duration\\\":3},{\\\"id\\\":\\\"c\\\",\\\"duration\\\":10},{\\\"id\\\":\\\"d\\\",\\\"duration\\\":6},{\\\"id\\\":\\\"e\\\",\\\"duration\\\":2},{\\\"id\\\":\\\"f\\\",\\\"duration\\\":9},{\\\"id\\\":\\\"g\\\",\\\"duration\\\":5},{\\\"id\\\":\\\"h\\\",\\\"duration\\\":1},{\\\"id\\\":\\\"i\\\",\\\"duration\\\":8},{\\\"id\\\":\\\"j\\\",\\\"duration\\\":4},{\\\"id\\\":\\\"k\\\",\\\"duration\\\":11},{\\\"id\\\":\\\"l\\\",\\\"duration\\\":7},{\\\"id\\\":\\\"m\\\",\\\"duration\\\":3}]\",\n  \"edges.json\": \"[[\\\"b\\\",\\\"c\\\"],[\\\"a\\\",\\\"b\\\"],[\\\"i\\\",\\\"m\\\"],[\\\"f\\\",\\\"m\\\"],[\\\"b\\\",\\\"m\\\"],[\\\"k\\\",\\\"l\\\"],[\\\"h\\\",\\\"l\\\"],[\\\"d\\\",\\\"l\\\"],[\\\"a\\\",\\\"l\\\"],[\\\"j\\\",\\\"k\\\"],[\\\"f\\\",\\\"k\\\"],[\\\"c\\\",\\\"k\\\"],[\\\"h\\\",\\\"j\\\"],[\\\"e\\\",\\\"j\\\"],[\\\"a\\\",\\\"j\\\"],[\\\"g\\\",\\\"i\\\"],[\\\"c\\\",\\\"i\\\"],[\\\"e\\\",\\\"h\\\"],[\\\"b\\\",\\\"h\\\"],[\\\"d\\\",\\\"g\\\"],[\\\"b\\\",\\\"f\\\"],[\\\"d\\\",\\\"e\\\"],[\\\"a\\\",\\\"e\\\"],[\\\"c\\\",\\\"d\\\"],[\\\"a\\\",\\\"c\\\"]]\"\n}\n\nRead both files. Deduplicate directed dependency edges. For an unlimited-worker earliest-start schedule, a job begins only after every predecessor finishes; roots begin at 0. Write timeline.tsv, sorted by job id, each line id<TAB>start<TAB>finish with final LF. Write report.json with makespan (maximum finish), critical (all ids whose finish equals makespan, sorted), sha256 (timeline.tsv).\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"makespan\", \"critical\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "makespan": 51,
        "critical": [
          "l"
        ],
        "sha256": "6fec89eb104acc231c0512e53e5698b093ac7aabf20ba4811df4cf32ff6872bc"
      }
    }
  },
  {
    "id": "frontier-agentic-terminal_operations-revision-reconciliation",
    "taskType": "agentic_execution",
    "subtaskType": "terminal_operations",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"one.jsonl\": \"{\\\"id\\\":\\\"key3\\\",\\\"rev\\\":2,\\\"source\\\":0,\\\"value\\\":-10,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key1\\\",\\\"rev\\\":1,\\\"source\\\":1,\\\"value\\\":3}\\n{\\\"id\\\":\\\"key8\\\",\\\"rev\\\":0,\\\"source\\\":2,\\\"value\\\":16}\\n{\\\"id\\\":\\\"key6\\\",\\\"rev\\\":5,\\\"source\\\":0,\\\"value\\\":-2}\\n{\\\"id\\\":\\\"key4\\\",\\\"rev\\\":4,\\\"source\\\":1,\\\"value\\\":11}\\n{\\\"id\\\":\\\"key2\\\",\\\"rev\\\":3,\\\"source\\\":2,\\\"value\\\":-7}\\n{\\\"id\\\":\\\"key0\\\",\\\"rev\\\":2,\\\"source\\\":0,\\\"value\\\":6}\\n{\\\"id\\\":\\\"key7\\\",\\\"rev\\\":1,\\\"source\\\":1,\\\"value\\\":19,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key5\\\",\\\"rev\\\":0,\\\"source\\\":2,\\\"value\\\":1}\\n{\\\"id\\\":\\\"key3\\\",\\\"rev\\\":5,\\\"source\\\":0,\\\"value\\\":14}\\n{\\\"id\\\":\\\"key1\\\",\\\"rev\\\":4,\\\"source\\\":1,\\\"value\\\":-4}\\n{\\\"id\\\":\\\"key8\\\",\\\"rev\\\":3,\\\"source\\\":2,\\\"value\\\":9}\\n{\\\"id\\\":\\\"key6\\\",\\\"rev\\\":2,\\\"source\\\":0,\\\"value\\\":-9}\\n{\\\"id\\\":\\\"key4\\\",\\\"rev\\\":1,\\\"source\\\":1,\\\"value\\\":4}\\n{\\\"id\\\":\\\"key2\\\",\\\"rev\\\":0,\\\"source\\\":2,\\\"value\\\":17,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key0\\\",\\\"rev\\\":5,\\\"source\\\":0,\\\"value\\\":-1}\\n{\\\"id\\\":\\\"key7\\\",\\\"rev\\\":4,\\\"source\\\":1,\\\"value\\\":12}\\n{\\\"id\\\":\\\"key5\\\",\\\"rev\\\":3,\\\"source\\\":2,\\\"value\\\":-6}\\n{\\\"id\\\":\\\"key3\\\",\\\"rev\\\":2,\\\"source\\\":0,\\\"value\\\":7}\\n{\\\"id\\\":\\\"key1\\\",\\\"rev\\\":1,\\\"source\\\":1,\\\"value\\\":20}\\n\",\n  \"two.jsonl\": \"{\\\"id\\\":\\\"key8\\\",\\\"rev\\\":0,\\\"source\\\":2,\\\"value\\\":2}\\n{\\\"id\\\":\\\"key6\\\",\\\"rev\\\":5,\\\"source\\\":0,\\\"value\\\":15,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key4\\\",\\\"rev\\\":4,\\\"source\\\":1,\\\"value\\\":-3}\\n{\\\"id\\\":\\\"key2\\\",\\\"rev\\\":3,\\\"source\\\":2,\\\"value\\\":10}\\n{\\\"id\\\":\\\"key0\\\",\\\"rev\\\":2,\\\"source\\\":0,\\\"value\\\":-8}\\n{\\\"id\\\":\\\"key7\\\",\\\"rev\\\":1,\\\"source\\\":1,\\\"value\\\":5}\\n{\\\"id\\\":\\\"key5\\\",\\\"rev\\\":0,\\\"source\\\":2,\\\"value\\\":18}\\n{\\\"id\\\":\\\"key3\\\",\\\"rev\\\":5,\\\"source\\\":0,\\\"value\\\":0}\\n{\\\"id\\\":\\\"key1\\\",\\\"rev\\\":4,\\\"source\\\":1,\\\"value\\\":13,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key8\\\",\\\"rev\\\":3,\\\"source\\\":2,\\\"value\\\":-5}\\n{\\\"id\\\":\\\"key6\\\",\\\"rev\\\":2,\\\"source\\\":0,\\\"value\\\":8}\\n{\\\"id\\\":\\\"key4\\\",\\\"rev\\\":1,\\\"source\\\":1,\\\"value\\\":-10}\\n{\\\"id\\\":\\\"key2\\\",\\\"rev\\\":0,\\\"source\\\":2,\\\"value\\\":3}\\n{\\\"id\\\":\\\"key0\\\",\\\"rev\\\":5,\\\"source\\\":0,\\\"value\\\":16}\\n{\\\"id\\\":\\\"key7\\\",\\\"rev\\\":4,\\\"source\\\":1,\\\"value\\\":-2}\\n{\\\"id\\\":\\\"key5\\\",\\\"rev\\\":3,\\\"source\\\":2,\\\"value\\\":11,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key3\\\",\\\"rev\\\":2,\\\"source\\\":0,\\\"value\\\":-7}\\n{\\\"id\\\":\\\"key1\\\",\\\"rev\\\":1,\\\"source\\\":1,\\\"value\\\":6}\\n{\\\"id\\\":\\\"key8\\\",\\\"rev\\\":0,\\\"source\\\":2,\\\"value\\\":19}\\n{\\\"id\\\":\\\"key6\\\",\\\"rev\\\":5,\\\"source\\\":0,\\\"value\\\":1}\\n{\\\"id\\\":\\\"key4\\\",\\\"rev\\\":4,\\\"source\\\":1,\\\"value\\\":14}\\n{\\\"id\\\":\\\"key2\\\",\\\"rev\\\":3,\\\"source\\\":2,\\\"value\\\":-4}\\n{\\\"id\\\":\\\"key0\\\",\\\"rev\\\":2,\\\"source\\\":0,\\\"value\\\":9,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key7\\\",\\\"rev\\\":1,\\\"source\\\":1,\\\"value\\\":-9}\\n{\\\"id\\\":\\\"key5\\\",\\\"rev\\\":0,\\\"source\\\":2,\\\"value\\\":4}\"\n}\n\nRead one.jsonl then two.jsonl, treating them as one ordered stream. For each id choose highest rev, then highest source, then latest stream position. Tombstones participate in winner selection and only winning tombstones are removed; never resurrect a lower revision. Write winners.json as [id,value] pairs in ascending code-unit id order, compact JSON with no newline. Write report.json with count, sum of live values, sha256 of winners.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"count\", \"sum\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "count": 7,
        "sum": 20,
        "sha256": "723e52b61b1514ec5900810300e7563ae092284c5c18ab0dbf6c19e6e28c2a55"
      }
    }
  },
  {
    "id": "frontier-agentic-terminal_operations-zigzag-binary-index",
    "taskType": "agentic_execution",
    "subtaskType": "terminal_operations",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"integers.json\": \"[\\\"0\\\",\\\"-1\\\",\\\"127\\\",\\\"-128\\\",\\\"128\\\",\\\"-129\\\",\\\"16384\\\",\\\"-8193\\\",\\\"9007199254740994\\\",\\\"-4611686018427387903\\\"]\"\n}\n\nRead signed decimal integers as BigInt. Zigzag encode n as 2*n for nonnegative n, otherwise -2*n-1, then encode unsigned LEB128 (least-significant 7-bit groups first, continuation high bit). Concatenate into values.bin. Decode values.bin again and write decoded.json as decimal strings. Write report.json with bytes (values.bin length), offsets (each encoded integer starting byte offset), sum (decoded BigInt decimal sum), sha256 of values.bin.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"bytes\", \"offsets\", \"sum\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "bytes": 33,
        "offsets": [
          0,
          1,
          2,
          4,
          6,
          8,
          10,
          13,
          16,
          24
        ],
        "sum": "-4602678819172638721",
        "sha256": "9f076b69539a74908dc011aa602b0c1b291a8ba87e5228852d1656c7e5bf1958"
      }
    }
  },
  {
    "id": "frontier-agentic-terminal_operations-streaming-unicode",
    "taskType": "agentic_execution",
    "subtaskType": "terminal_operations",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"chunks.json\": \"[\\\"ceb1f0\\\",\\\"9f99\\\",\\\"820d0a\\\",\\\"7a65\\\",\\\"726f00\\\",\\\"65cc\\\",\\\"810af0\\\",\\\"9090\\\",\\\"80e7b5\\\",\\\"820d\\\",\\\"0ac3a9\\\",\\\"c3a9\\\",\\\"c3a9c3\\\",\\\"a90a\\\"]\"\n}\n\nRead hex byte chunks in order. Decode incrementally with TextDecoder in streaming mode; UTF-8 code points may cross chunk boundaries. Flush the decoder at EOF. Replace CRLF with LF after concatenation, then normalize the whole decoded text to NFC. Write normalized.bin. Write report.json with bytes (normalized.bin size), codePoints (Unicode scalar count, including controls), lfOffsets (zero-based byte indexes of LF), sha256 of normalized.bin.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"bytes\", \"codePoints\", \"lfOffsets\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "bytes": 32,
        "codePoints": 18,
        "lfOffsets": [
          6,
          14,
          22,
          31
        ],
        "sha256": "a5a54fd1206ebc38ee1f8dbdce3eed1a464fb82b306e4633686de80bcacf0517"
      }
    }
  },
  {
    "id": "frontier-agentic-terminal_operations-merkle-file-tree",
    "taskType": "agentic_execution",
    "subtaskType": "terminal_operations",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"tree/a.txt\": \"A\\n\",\n  \"tree/z/é.txt\": \"é🙂\",\n  \"tree/z/empty\": \"\",\n  \"tree/.hidden/keep\": \"included\",\n  \"tree/b.txt\": \"BBBB\"\n}\n\nRecursively inventory tree, including dotfiles and empty files. A file digest is SHA-256 of its bytes. A directory digest is SHA-256 of UTF-8 concatenated child records sorted by JavaScript default code-unit name order. A child record is name + NUL + type (F for file, D for directory) + NUL + child digest + LF. Never normalize names or contents. Write merkle.json containing root (digest of tree), files (regular file count), bytes (sum of file bytes). Report merkle.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"root\", \"files\", \"bytes\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "root": "9fa3384cd7c0941541eb464762b105ba54f593c670a01538b45e2c7ec651500f",
        "files": 5,
        "bytes": 21
      }
    }
  },
  {
    "id": "frontier-agentic-terminal_operations-crash-journal",
    "taskType": "agentic_execution",
    "subtaskType": "terminal_operations",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"snapshot.json\": \"{\\\"x\\\":0,\\\"y\\\":1}\",\n  \"wal.jsonl\": \"[\\\"begin\\\",\\\"a\\\"]\\n[\\\"set\\\",\\\"a\\\",\\\"x\\\",13]\\n[\\\"begin\\\",\\\"b\\\"]\\n[\\\"set\\\",\\\"b\\\",\\\"x\\\",23]\\n[\\\"commit\\\",\\\"a\\\"]\\n[\\\"set\\\",\\\"b\\\",\\\"y\\\",4]\\n[\\\"begin\\\",\\\"c\\\"]\\n[\\\"set\\\",\\\"c\\\",\\\"z\\\",99]\\n[\\\"abort\\\",\\\"c\\\"]\\n[\\\"commit\\\",\\\"b\\\"]\\n[\\\"begin\\\",\\\"d\\\"]\\n[\\\"delete\\\",\\\"d\\\",\\\"x\\\"]\\n[\\\"set\\\",\\\"d\\\",\\\"q\\\",7]\\n[\\\"commit\\\",\\\"d\\\"]\\n[\\\"begin\\\",\\\"e\\\"]\\n[\\\"set\\\",\\\"e\\\",\\\"y\\\",-8]\\n[\\\"begin\\\",\\\"f\\\"]\\n[\\\"set\\\",\\\"f\\\",\\\"q\\\",31]\\n[\\\"commit\\\",\\\"f\\\"]\\n[\\\"set\\\",\\\"e\\\",\\\"r\\\",100]\"\n}\n\nReplay the WAL from snapshot.json. begin opens an isolated write buffer; set/delete append to that transaction. commit applies its buffered operations to current global state in order, not to a begin-time snapshot. abort discards it. Discard every still-open transaction at EOF (simulated crash). Write recovered.json as [key,value] pairs in ascending key order, compact JSON without newline. Write report.json with rows, commits (committed transaction ids in commit order), discarded (still-open ids sorted), sha256 of recovered.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"rows\", \"commits\", \"discarded\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "rows": [
          [
            "q",
            31
          ],
          [
            "y",
            4
          ]
        ],
        "commits": [
          "a",
          "b",
          "d",
          "f"
        ],
        "discarded": [
          "e"
        ],
        "sha256": "083961bab37fd7f8fa05eb09448f4ed06c711cee1ba3e466ba822d81f4ab4554"
      }
    }
  },
  {
    "id": "frontier-agentic-terminal_operations-quoted-temporal-join",
    "taskType": "agentic_execution",
    "subtaskType": "terminal_operations",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"sales.csv\": \"id,region,amount,time\\r\\n\\\"a,1\\\",west,12,2\\r\\n\\\"b\\\"\\\"2\\\",east,-3,3\\r\\n\\\"line\\nbreak\\\",west,7,5\\r\\né,east,4,1\\r\\ndup,west,-8,6\\r\\ndup,west,12,4\\r\\n\",\n  \"rates.json\": \"[[\\\"west\\\",0,4,3],[\\\"west\\\",4,7,6],[\\\"east\\\",0,3,7],[\\\"east\\\",3,8,2]]\"\n}\n\nParse CSV including doubled quotes, embedded LF and commas; CRLF separates records only outside quotes. Header is not data. Rate tuples are [region,start,end,multiplier]. Join each sale to its unique rate with start<=time<end. Keep duplicate ids and input record order. Write joined.json as [id,amount*multiplier] pairs, compact JSON without newline. Write report.json with rows (data record count), total, sha256 of joined.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"rows\", \"total\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "rows": 6,
        "total": 124,
        "sha256": "ebdeaa111dacc351d326e935f5f5920cf1a054de696b967b3ddeffba1169cab5"
      }
    }
  },
  {
    "id": "frontier-agentic-terminal_operations-bounded-allocation",
    "taskType": "agentic_execution",
    "subtaskType": "terminal_operations",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"jobs.json\": \"[{\\\"id\\\":\\\"a\\\",\\\"size\\\":3,\\\"value\\\":4},{\\\"id\\\":\\\"b\\\",\\\"size\\\":3,\\\"value\\\":15},{\\\"id\\\":\\\"c\\\",\\\"size\\\":3,\\\"value\\\":9},{\\\"id\\\":\\\"d\\\",\\\"size\\\":3,\\\"value\\\":3},{\\\"id\\\":\\\"e\\\",\\\"size\\\":3,\\\"value\\\":14},{\\\"id\\\":\\\"f\\\",\\\"size\\\":3,\\\"value\\\":8},{\\\"id\\\":\\\"g\\\",\\\"size\\\":3,\\\"value\\\":2},{\\\"id\\\":\\\"h\\\",\\\"size\\\":3,\\\"value\\\":13},{\\\"id\\\":\\\"i\\\",\\\"size\\\":3,\\\"value\\\":7}]\",\n  \"limit.json\": \"{\\\"capacity\\\":8}\"\n}\n\nRead job sizes and values. Exhaustively choose a subset with total size <= capacity. Maximize value; among equal values minimize used size; among equal values and size choose lexicographically smallest comma-joined sorted id list (JavaScript string comparison). Write selected.json as chosen ids sorted ascending. Write report.json with ids, size, value, sha256 of compact selected.json without newline.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"ids\", \"size\", \"value\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "ids": [
          "b",
          "e"
        ],
        "size": 6,
        "value": 29,
        "sha256": "d9991efbb41b718646a52e9dd5fc5cae03a80506ed40ed0326b5fe9ca6567a72"
      }
    }
  },
  {
    "id": "frontier-agentic-terminal_operations-modular-recurrence",
    "taskType": "agentic_execution",
    "subtaskType": "terminal_operations",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"matrix.json\": \"[[\\\"2\\\",\\\"7\\\",\\\"3\\\",\\\"8\\\"],[\\\"0\\\",\\\"5\\\",\\\"1\\\",\\\"6\\\"],[\\\"7\\\",\\\"3\\\",\\\"8\\\",\\\"4\\\"],[\\\"5\\\",\\\"1\\\",\\\"6\\\",\\\"2\\\"]]\",\n  \"state.json\": \"[\\\"1\\\",\\\"2\\\",\\\"3\\\",\\\"4\\\"]\",\n  \"steps.txt\": \"46\"\n}\n\nTreat matrix rows and state as decimal BigInt. Execute exactly steps synchronous iterations of newState[i]=sum(matrix[i][j]*oldState[j]) modulo 1000000007. Do not update state in place or use floating point. Write state-final.json as decimal strings, compact with no newline. Write report.json with state, sum (sum of residues as a decimal string, not reduced again), sha256 of state-final.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"state\", \"sum\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "state": [
          "964064740",
          "987105792",
          "46782616",
          "69823668"
        ],
        "sum": "2067776816",
        "sha256": "26e232a41e0c307df90ed8d527dc99f3bba3a779fb9e9ac3eb43a74d51810cc4"
      }
    }
  },
  {
    "id": "frontier-agentic-terminal_operations-pointer-patch-sequence",
    "taskType": "agentic_execution",
    "subtaskType": "terminal_operations",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"base.json\": \"{\\\"a\\\":[\\\"p\\\",\\\"q\\\",\\\"r\\\",\\\"s\\\",\\\"t\\\"],\\\"obj\\\":{\\\"a/b\\\":1}}\",\n  \"patch.json\": \"[{\\\"op\\\":\\\"move\\\",\\\"from\\\":\\\"/a/1\\\",\\\"path\\\":\\\"/a/3\\\"},{\\\"op\\\":\\\"copy\\\",\\\"from\\\":\\\"/a/0\\\",\\\"path\\\":\\\"/obj/copied\\\"},{\\\"op\\\":\\\"replace\\\",\\\"path\\\":\\\"/obj/a~1b\\\",\\\"value\\\":11},{\\\"op\\\":\\\"remove\\\",\\\"path\\\":\\\"/a/0\\\"},{\\\"op\\\":\\\"add\\\",\\\"path\\\":\\\"/a/-\\\",\\\"value\\\":\\\"tail1\\\"},{\\\"op\\\":\\\"move\\\",\\\"from\\\":\\\"/obj/copied\\\",\\\"path\\\":\\\"/a/1\\\"},{\\\"op\\\":\\\"add\\\",\\\"path\\\":\\\"/obj/~0\\\",\\\"value\\\":[false,null]},{\\\"op\\\":\\\"copy\\\",\\\"from\\\":\\\"/obj/~0\\\",\\\"path\\\":\\\"/obj/list\\\"},{\\\"op\\\":\\\"replace\\\",\\\"path\\\":\\\"/obj/~0/0\\\",\\\"value\\\":false}]\"\n}\n\nApply the JSON Patch operations in order. Decode JSON Pointer ~1 as slash and ~0 as tilde. move removes the source before evaluating the destination; an array add inserts and - appends. copy deep-clones; existing copied values must not change after later mutations. Preserve object insertion order as JavaScript does. Write result.json as compact JSON without newline. Write report.json with a (final array), slash (obj[\"a/b\"]), tilde (obj[\"~\"]), list (obj.list), sha256 of result.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"a\", \"slash\", \"tilde\", \"list\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "a": [
          "r",
          "p",
          "s",
          "q",
          "t",
          "tail1"
        ],
        "slash": 11,
        "tilde": [
          false,
          null
        ],
        "list": [
          true,
          null
        ],
        "sha256": "14d4a411cb3a68198e10c7748523db23846f00d92b9d10b82e914734991a8967"
      }
    }
  },
  {
    "id": "frontier-agentic-terminal_operations-module-condensation",
    "taskType": "agentic_execution",
    "subtaskType": "terminal_operations",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"modules.json\": \"[[\\\"i\\\",\\\"d\\\"],[\\\"k\\\",\\\"j\\\"],[\\\"j\\\",\\\"k\\\"],[\\\"j\\\",\\\"i\\\"],[\\\"h\\\",\\\"i\\\"],[\\\"h\\\",\\\"f\\\"],[\\\"g\\\",\\\"h\\\"],[\\\"f\\\",\\\"g\\\"],[\\\"e\\\",\\\"f\\\"],[\\\"e\\\",\\\"d\\\"],[\\\"d\\\",\\\"e\\\"],[\\\"c\\\",\\\"d\\\"],[\\\"c\\\",\\\"a\\\"],[\\\"b\\\",\\\"c\\\"],[\\\"a\\\",\\\"b\\\"]]\"\n}\n\nTreat each tuple as a directed import edge. Compute strongly connected components. Sort each component by id, then sort components by their smallest id; this order assigns zero-based component indexes. Write components.json compactly without newline. Deduplicate intercomponent edges and sort numerically by source index then target index. Write report.json with components, edges (condensation edges), sha256 of components.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"components\", \"edges\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "components": [
          [
            "a",
            "b",
            "c"
          ],
          [
            "d",
            "e",
            "f",
            "g",
            "h",
            "i"
          ],
          [
            "j",
            "k"
          ]
        ],
        "edges": [
          [
            0,
            1
          ],
          [
            2,
            1
          ]
        ],
        "sha256": "0da8fd161928672df4a79b9e08b0b091cb0a356e609ef04b88c95bb63e955f46"
      }
    }
  },
  {
    "id": "frontier-agentic-terminal_operations-external-merge-normalization",
    "taskType": "agentic_execution",
    "subtaskType": "terminal_operations",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"records.jsonl\": \"{\\\"key\\\":\\\"é\\\",\\\"rev\\\":2,\\\"value\\\":-5}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":5,\\\"value\\\":2}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":0,\\\"value\\\":9}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":3,\\\"value\\\":16}\\n{\\\"key\\\":\\\"a\\\",\\\"rev\\\":6,\\\"value\\\":23}\\n{\\\"key\\\":\\\"A\\\",\\\"rev\\\":1,\\\"value\\\":30}\\n{\\\"key\\\":\\\"🙂\\\",\\\"rev\\\":4,\\\"value\\\":37}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":7,\\\"value\\\":44}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":2,\\\"value\\\":51}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":5,\\\"value\\\":58}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":0,\\\"value\\\":65}\\n{\\\"key\\\":\\\"a\\\",\\\"rev\\\":3,\\\"value\\\":72}\\n{\\\"key\\\":\\\"A\\\",\\\"rev\\\":6,\\\"value\\\":79}\\n{\\\"key\\\":\\\"🙂\\\",\\\"rev\\\":1,\\\"value\\\":86}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":4,\\\"value\\\":93}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":7,\\\"value\\\":100}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":2,\\\"value\\\":107}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":5,\\\"value\\\":114}\\n{\\\"key\\\":\\\"a\\\",\\\"rev\\\":0,\\\"value\\\":121}\\n{\\\"key\\\":\\\"A\\\",\\\"rev\\\":3,\\\"value\\\":128}\\n{\\\"key\\\":\\\"🙂\\\",\\\"rev\\\":6,\\\"value\\\":135}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":1,\\\"value\\\":142}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":4,\\\"value\\\":149}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":7,\\\"value\\\":156}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":2,\\\"value\\\":163}\\n{\\\"key\\\":\\\"a\\\",\\\"rev\\\":5,\\\"value\\\":170}\\n{\\\"key\\\":\\\"A\\\",\\\"rev\\\":0,\\\"value\\\":177}\\n{\\\"key\\\":\\\"🙂\\\",\\\"rev\\\":3,\\\"value\\\":184}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":6,\\\"value\\\":191}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":1,\\\"value\\\":198}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":4,\\\"value\\\":205}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":7,\\\"value\\\":212}\\n{\\\"key\\\":\\\"a\\\",\\\"rev\\\":2,\\\"value\\\":219}\\n{\\\"key\\\":\\\"A\\\",\\\"rev\\\":5,\\\"value\\\":226}\\n{\\\"key\\\":\\\"🙂\\\",\\\"rev\\\":0,\\\"value\\\":233}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":3,\\\"value\\\":240}\"\n}\n\nRead the records as JSONL. Produce sorted run files with at most 6 input records per run, then merge them. Group keys after NFC normalization then toLowerCase; choose highest rev then latest original input position per normalized key. Final rows are [normalizedKey,rev,value], sorted by unsigned UTF-8 byte order (Buffer.compare), not locale order. Write merged.jsonl with one compact row per line and a final LF. Write report.json with rows, runs (ceiling of input count / 6), sha256 of merged.jsonl.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"rows\", \"runs\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "rows": [
          [
            "a",
            6,
            79
          ],
          [
            "å",
            7,
            212
          ],
          [
            "é",
            7,
            100
          ],
          [
            "🙂",
            6,
            135
          ]
        ],
        "runs": 6,
        "sha256": "ff143357512c825a0759578a40a7588df27e8141fa46b10f5f5081fed8f60c6e"
      }
    }
  },
  {
    "id": "frontier-agentic-terminal_operations-link-aware-inventory",
    "taskType": "agentic_execution",
    "subtaskType": "terminal_operations",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"assets/a.txt\": \"hello🙂\",\n  \"assets/b.txt\": \"xyxy\",\n  \"assets/empty\": \"\"\n}\n\nCreate hard link assets/a-copy.txt to assets/a.txt. Create symlinks assets/a-link -> a.txt, assets/dangling -> missing, assets/cycle1 -> cycle2, assets/cycle2 -> cycle1 (relative targets). Inventory with lstat, never follow symlinks. Write inventory.json with regular entry paths sorted ascending and symbolic entry paths sorted ascending. Compute bytesPerName over regular entries; compute uniqueBytes counting each (dev,ino) once. Do not sum symlink lengths. Write report.json with regular, symlinks, bytesPerName, uniqueBytes, sha256 of compact inventory.json without newline. inventory.json keys must be regular then symlinks.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"regular\", \"symlinks\", \"bytesPerName\", \"uniqueBytes\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "regular": [
          "assets/a-copy.txt",
          "assets/a.txt",
          "assets/b.txt",
          "assets/empty"
        ],
        "symlinks": [
          "assets/a-link",
          "assets/cycle1",
          "assets/cycle2",
          "assets/dangling"
        ],
        "bytesPerName": 22,
        "uniqueBytes": 13,
        "sha256": "a50b4c66d1d28a4faad043bf5dbb76adbed414782e2493bc4c49a2bf9e5a0553"
      }
    }
  },
  {
    "id": "frontier-agentic-terminal_operations-framed-json-stream",
    "taskType": "agentic_execution",
    "subtaskType": "terminal_operations",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"chunks.json\": \"[\\\"7b\\\",\\\"2278\\\",\\\"223a312c22\\\",\\\"73223a\\\",\\\"227d205b205c2222\\\",\\\"2c\\\",\\\"2261\\\",\\\"7272223a5b\\\",\\\"312c7b\\\",\\\"2279223a327d5d7d\\\",\\\"0d\\\",\\\"0a7b\\\",\\\"226e657874\\\",\\\"223a32\\\",\\\"7d20205b312c322c\\\",\\\"7b\\\",\\\"226b\\\",\\\"223a22c3a9\\\",\\\"f09f99\\\",\\\"82227d5d\\\"]\"\n}\n\nIncrementally decode the UTF-8 hex chunks. Split adjacent top-level JSON objects/arrays using balanced braces/brackets while respecting quoted strings and backslash escapes; whitespace between documents is ignored, delimiters inside strings are not nesting. Parse each complete document, serialize it compactly in input order to values.jsonl with final LF. Write report.json with documents, bytes (values.jsonl byte length), sha256 of values.jsonl.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"documents\", \"bytes\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "documents": 3,
        "bytes": 71,
        "sha256": "c76a738a36d7b2dfa27afacea9d936f2e934147851e1dd999aef32f79aa979e0"
      }
    }
  },
  {
    "id": "frontier-agentic-terminal_operations-minimum-audit-cover",
    "taskType": "agentic_execution",
    "subtaskType": "terminal_operations",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"checks.json\": \"[{\\\"id\\\":\\\"a\\\",\\\"cost\\\":4,\\\"covers\\\":[0,2,4]},{\\\"id\\\":\\\"b\\\",\\\"cost\\\":3,\\\"covers\\\":[2,4,6]},{\\\"id\\\":\\\"c\\\",\\\"cost\\\":2,\\\"covers\\\":[1,3,5]},{\\\"id\\\":\\\"d\\\",\\\"cost\\\":9,\\\"covers\\\":[0,3,5]},{\\\"id\\\":\\\"e\\\",\\\"cost\\\":8,\\\"covers\\\":[0,2,4,6]},{\\\"id\\\":\\\"f\\\",\\\"cost\\\":7,\\\"covers\\\":[1,4,6]},{\\\"id\\\":\\\"g\\\",\\\"cost\\\":6,\\\"covers\\\":[1,3,5]},{\\\"id\\\":\\\"h\\\",\\\"cost\\\":5,\\\"covers\\\":[0,2,5]},{\\\"id\\\":\\\"i\\\",\\\"cost\\\":4,\\\"covers\\\":[0,2,4,6]},{\\\"id\\\":\\\"j\\\",\\\"cost\\\":3,\\\"covers\\\":[1,3,6]}]\",\n  \"required.json\": \"[0,1,2,3,4,5,6]\"\n}\n\nExecute an offline audit-plan calculation from both files. Choose checks whose union covers every required item. Minimize total cost, then minimize number of checks, then choose lexicographically smallest comma-joined ascending id list. Write plan.json with ids then cost, compact with no newline. Read it back and independently confirm coverage. Write report.json with ids, cost, covered (sorted unique coverage union, including any non-required items), sha256 of plan.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"ids\", \"cost\", \"covered\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "ids": [
          "c",
          "i"
        ],
        "cost": 6,
        "covered": [
          0,
          1,
          2,
          3,
          4,
          5,
          6
        ],
        "sha256": "f0f7ae0c746d6e06a2e42d041da257d8ef52d349783b44d4c2fb9cc270317654"
      }
    }
  },
  {
    "id": "frontier-agentic-multi_step_execution-dependency-release",
    "taskType": "agentic_execution",
    "subtaskType": "multi_step_execution",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"jobs.json\": \"[{\\\"id\\\":\\\"a\\\",\\\"duration\\\":10},{\\\"id\\\":\\\"b\\\",\\\"duration\\\":6},{\\\"id\\\":\\\"c\\\",\\\"duration\\\":2},{\\\"id\\\":\\\"d\\\",\\\"duration\\\":9},{\\\"id\\\":\\\"e\\\",\\\"duration\\\":5},{\\\"id\\\":\\\"f\\\",\\\"duration\\\":1},{\\\"id\\\":\\\"g\\\",\\\"duration\\\":8},{\\\"id\\\":\\\"h\\\",\\\"duration\\\":4},{\\\"id\\\":\\\"i\\\",\\\"duration\\\":11},{\\\"id\\\":\\\"j\\\",\\\"duration\\\":7},{\\\"id\\\":\\\"k\\\",\\\"duration\\\":3},{\\\"id\\\":\\\"l\\\",\\\"duration\\\":10},{\\\"id\\\":\\\"m\\\",\\\"duration\\\":6},{\\\"id\\\":\\\"n\\\",\\\"duration\\\":2},{\\\"id\\\":\\\"o\\\",\\\"duration\\\":9}]\",\n  \"edges.json\": \"[[\\\"b\\\",\\\"c\\\"],[\\\"a\\\",\\\"b\\\"],[\\\"m\\\",\\\"o\\\"],[\\\"i\\\",\\\"o\\\"],[\\\"f\\\",\\\"o\\\"],[\\\"b\\\",\\\"o\\\"],[\\\"k\\\",\\\"n\\\"],[\\\"h\\\",\\\"n\\\"],[\\\"d\\\",\\\"n\\\"],[\\\"a\\\",\\\"n\\\"],[\\\"j\\\",\\\"m\\\"],[\\\"f\\\",\\\"m\\\"],[\\\"c\\\",\\\"m\\\"],[\\\"h\\\",\\\"l\\\"],[\\\"e\\\",\\\"l\\\"],[\\\"a\\\",\\\"l\\\"],[\\\"j\\\",\\\"k\\\"],[\\\"g\\\",\\\"k\\\"],[\\\"c\\\",\\\"k\\\"],[\\\"i\\\",\\\"j\\\"],[\\\"e\\\",\\\"j\\\"],[\\\"b\\\",\\\"j\\\"],[\\\"g\\\",\\\"i\\\"],[\\\"d\\\",\\\"i\\\"],[\\\"f\\\",\\\"h\\\"],[\\\"b\\\",\\\"h\\\"],[\\\"d\\\",\\\"g\\\"],[\\\"a\\\",\\\"g\\\"],[\\\"c\\\",\\\"f\\\"],[\\\"a\\\",\\\"e\\\"],[\\\"c\\\",\\\"d\\\"],[\\\"b\\\",\\\"c\\\"]]\"\n}\n\nRead both files. Deduplicate directed dependency edges. For an unlimited-worker earliest-start schedule, a job begins only after every predecessor finishes; roots begin at 0. Write timeline.tsv, sorted by job id, each line id<TAB>start<TAB>finish with final LF. Write report.json with makespan (maximum finish), critical (all ids whose finish equals makespan, sorted), sha256 (timeline.tsv).\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"makespan\", \"critical\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "makespan": 68,
        "critical": [
          "o"
        ],
        "sha256": "5e813fd9045fb944b02787a27930b5de2a494aef79c839b6b885500481fea72e"
      }
    }
  },
  {
    "id": "frontier-agentic-multi_step_execution-revision-reconciliation",
    "taskType": "agentic_execution",
    "subtaskType": "multi_step_execution",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"one.jsonl\": \"{\\\"id\\\":\\\"key3\\\",\\\"rev\\\":3,\\\"source\\\":0,\\\"value\\\":-10,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key1\\\",\\\"rev\\\":2,\\\"source\\\":1,\\\"value\\\":3}\\n{\\\"id\\\":\\\"key8\\\",\\\"rev\\\":1,\\\"source\\\":2,\\\"value\\\":16}\\n{\\\"id\\\":\\\"key6\\\",\\\"rev\\\":0,\\\"source\\\":0,\\\"value\\\":-2}\\n{\\\"id\\\":\\\"key4\\\",\\\"rev\\\":5,\\\"source\\\":1,\\\"value\\\":11}\\n{\\\"id\\\":\\\"key2\\\",\\\"rev\\\":4,\\\"source\\\":2,\\\"value\\\":-7}\\n{\\\"id\\\":\\\"key0\\\",\\\"rev\\\":3,\\\"source\\\":0,\\\"value\\\":6}\\n{\\\"id\\\":\\\"key7\\\",\\\"rev\\\":2,\\\"source\\\":1,\\\"value\\\":19,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key5\\\",\\\"rev\\\":1,\\\"source\\\":2,\\\"value\\\":1}\\n{\\\"id\\\":\\\"key3\\\",\\\"rev\\\":0,\\\"source\\\":0,\\\"value\\\":14}\\n{\\\"id\\\":\\\"key1\\\",\\\"rev\\\":5,\\\"source\\\":1,\\\"value\\\":-4}\\n{\\\"id\\\":\\\"key8\\\",\\\"rev\\\":4,\\\"source\\\":2,\\\"value\\\":9}\\n{\\\"id\\\":\\\"key6\\\",\\\"rev\\\":3,\\\"source\\\":0,\\\"value\\\":-9}\\n{\\\"id\\\":\\\"key4\\\",\\\"rev\\\":2,\\\"source\\\":1,\\\"value\\\":4}\\n{\\\"id\\\":\\\"key2\\\",\\\"rev\\\":1,\\\"source\\\":2,\\\"value\\\":17,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key0\\\",\\\"rev\\\":0,\\\"source\\\":0,\\\"value\\\":-1}\\n{\\\"id\\\":\\\"key7\\\",\\\"rev\\\":5,\\\"source\\\":1,\\\"value\\\":12}\\n{\\\"id\\\":\\\"key5\\\",\\\"rev\\\":4,\\\"source\\\":2,\\\"value\\\":-6}\\n{\\\"id\\\":\\\"key3\\\",\\\"rev\\\":3,\\\"source\\\":0,\\\"value\\\":7}\\n{\\\"id\\\":\\\"key1\\\",\\\"rev\\\":2,\\\"source\\\":1,\\\"value\\\":20}\\n\",\n  \"two.jsonl\": \"{\\\"id\\\":\\\"key8\\\",\\\"rev\\\":1,\\\"source\\\":2,\\\"value\\\":2}\\n{\\\"id\\\":\\\"key6\\\",\\\"rev\\\":0,\\\"source\\\":0,\\\"value\\\":15,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key4\\\",\\\"rev\\\":5,\\\"source\\\":1,\\\"value\\\":-3}\\n{\\\"id\\\":\\\"key2\\\",\\\"rev\\\":4,\\\"source\\\":2,\\\"value\\\":10}\\n{\\\"id\\\":\\\"key0\\\",\\\"rev\\\":3,\\\"source\\\":0,\\\"value\\\":-8}\\n{\\\"id\\\":\\\"key7\\\",\\\"rev\\\":2,\\\"source\\\":1,\\\"value\\\":5}\\n{\\\"id\\\":\\\"key5\\\",\\\"rev\\\":1,\\\"source\\\":2,\\\"value\\\":18}\\n{\\\"id\\\":\\\"key3\\\",\\\"rev\\\":0,\\\"source\\\":0,\\\"value\\\":0}\\n{\\\"id\\\":\\\"key1\\\",\\\"rev\\\":5,\\\"source\\\":1,\\\"value\\\":13,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key8\\\",\\\"rev\\\":4,\\\"source\\\":2,\\\"value\\\":-5}\\n{\\\"id\\\":\\\"key6\\\",\\\"rev\\\":3,\\\"source\\\":0,\\\"value\\\":8}\\n{\\\"id\\\":\\\"key4\\\",\\\"rev\\\":2,\\\"source\\\":1,\\\"value\\\":-10}\\n{\\\"id\\\":\\\"key2\\\",\\\"rev\\\":1,\\\"source\\\":2,\\\"value\\\":3}\\n{\\\"id\\\":\\\"key0\\\",\\\"rev\\\":0,\\\"source\\\":0,\\\"value\\\":16}\\n{\\\"id\\\":\\\"key7\\\",\\\"rev\\\":5,\\\"source\\\":1,\\\"value\\\":-2}\\n{\\\"id\\\":\\\"key5\\\",\\\"rev\\\":4,\\\"source\\\":2,\\\"value\\\":11,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key3\\\",\\\"rev\\\":3,\\\"source\\\":0,\\\"value\\\":-7}\\n{\\\"id\\\":\\\"key1\\\",\\\"rev\\\":2,\\\"source\\\":1,\\\"value\\\":6}\\n{\\\"id\\\":\\\"key8\\\",\\\"rev\\\":1,\\\"source\\\":2,\\\"value\\\":19}\\n{\\\"id\\\":\\\"key6\\\",\\\"rev\\\":0,\\\"source\\\":0,\\\"value\\\":1}\\n{\\\"id\\\":\\\"key4\\\",\\\"rev\\\":5,\\\"source\\\":1,\\\"value\\\":14}\\n{\\\"id\\\":\\\"key2\\\",\\\"rev\\\":4,\\\"source\\\":2,\\\"value\\\":-4}\\n{\\\"id\\\":\\\"key0\\\",\\\"rev\\\":3,\\\"source\\\":0,\\\"value\\\":9,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key7\\\",\\\"rev\\\":2,\\\"source\\\":1,\\\"value\\\":-9}\\n{\\\"id\\\":\\\"key5\\\",\\\"rev\\\":1,\\\"source\\\":2,\\\"value\\\":4}\\n{\\\"id\\\":\\\"key3\\\",\\\"rev\\\":0,\\\"source\\\":0,\\\"value\\\":17}\\n{\\\"id\\\":\\\"key1\\\",\\\"rev\\\":5,\\\"source\\\":1,\\\"value\\\":-1}\\n{\\\"id\\\":\\\"key8\\\",\\\"rev\\\":4,\\\"source\\\":2,\\\"value\\\":12}\\n{\\\"id\\\":\\\"key6\\\",\\\"rev\\\":3,\\\"source\\\":0,\\\"value\\\":-6}\\n{\\\"id\\\":\\\"key4\\\",\\\"rev\\\":2,\\\"source\\\":1,\\\"value\\\":7,\\\"deleted\\\":true}\\n{\\\"id\\\":\\\"key2\\\",\\\"rev\\\":1,\\\"source\\\":2,\\\"value\\\":20}\\n{\\\"id\\\":\\\"key0\\\",\\\"rev\\\":0,\\\"source\\\":0,\\\"value\\\":2}\"\n}\n\nRead one.jsonl then two.jsonl, treating them as one ordered stream. For each id choose highest rev, then highest source, then latest stream position. Tombstones participate in winner selection and only winning tombstones are removed; never resurrect a lower revision. Write winners.json as [id,value] pairs in ascending code-unit id order, compact JSON with no newline. Write report.json with count, sum of live values, sha256 of winners.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"count\", \"sum\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "count": 7,
        "sum": 6,
        "sha256": "fba9ed777866357950b44899e31aeab492b395abb634ca4a285608c211443ecc"
      }
    }
  },
  {
    "id": "frontier-agentic-multi_step_execution-zigzag-binary-index",
    "taskType": "agentic_execution",
    "subtaskType": "multi_step_execution",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"integers.json\": \"[\\\"0\\\",\\\"-1\\\",\\\"127\\\",\\\"-128\\\",\\\"128\\\",\\\"-129\\\",\\\"16384\\\",\\\"-8193\\\",\\\"9007199254740995\\\",\\\"-4611686018427387902\\\"]\"\n}\n\nRead signed decimal integers as BigInt. Zigzag encode n as 2*n for nonnegative n, otherwise -2*n-1, then encode unsigned LEB128 (least-significant 7-bit groups first, continuation high bit). Concatenate into values.bin. Decode values.bin again and write decoded.json as decimal strings. Write report.json with bytes (values.bin length), offsets (each encoded integer starting byte offset), sum (decoded BigInt decimal sum), sha256 of values.bin.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"bytes\", \"offsets\", \"sum\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "bytes": 33,
        "offsets": [
          0,
          1,
          2,
          4,
          6,
          8,
          10,
          13,
          16,
          24
        ],
        "sum": "-4602678819172638719",
        "sha256": "be503a2cfc2b2f9f6949572d5097f02d4c6639d0d8ceff253a2629c24df169eb"
      }
    }
  },
  {
    "id": "frontier-agentic-multi_step_execution-streaming-unicode",
    "taskType": "agentic_execution",
    "subtaskType": "multi_step_execution",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"chunks.json\": \"[\\\"ceb1f09f\\\",\\\"99\\\",\\\"820d0a7a\\\",\\\"65\\\",\\\"726f0065\\\",\\\"cc\\\",\\\"810af090\\\",\\\"90\\\",\\\"80e7b582\\\",\\\"0d\\\",\\\"0ac3a9c3\\\",\\\"a9\\\",\\\"c3a9c3a9\\\",\\\"c3\\\",\\\"a90a\\\"]\"\n}\n\nRead hex byte chunks in order. Decode incrementally with TextDecoder in streaming mode; UTF-8 code points may cross chunk boundaries. Flush the decoder at EOF. Replace CRLF with LF after concatenation, then normalize the whole decoded text to NFC. Write normalized.bin. Write report.json with bytes (normalized.bin size), codePoints (Unicode scalar count, including controls), lfOffsets (zero-based byte indexes of LF), sha256 of normalized.bin.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"bytes\", \"codePoints\", \"lfOffsets\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "bytes": 34,
        "codePoints": 19,
        "lfOffsets": [
          6,
          14,
          22,
          33
        ],
        "sha256": "458612022df48fd036afd7f2af3443d74100ec1a7893284caef17ba39b375772"
      }
    }
  },
  {
    "id": "frontier-agentic-multi_step_execution-merkle-file-tree",
    "taskType": "agentic_execution",
    "subtaskType": "multi_step_execution",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"tree/a.txt\": \"A\\n\",\n  \"tree/z/é.txt\": \"é🙂\",\n  \"tree/z/empty\": \"\",\n  \"tree/.hidden/keep\": \"included\",\n  \"tree/b.txt\": \"BBBBB\"\n}\n\nRecursively inventory tree, including dotfiles and empty files. A file digest is SHA-256 of its bytes. A directory digest is SHA-256 of UTF-8 concatenated child records sorted by JavaScript default code-unit name order. A child record is name + NUL + type (F for file, D for directory) + NUL + child digest + LF. Never normalize names or contents. Write merkle.json containing root (digest of tree), files (regular file count), bytes (sum of file bytes). Report merkle.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"root\", \"files\", \"bytes\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "root": "c0d70e372fb23c0815f386331f8639628815b6b0bde62391c4ca0857b5220db6",
        "files": 5,
        "bytes": 22
      }
    }
  },
  {
    "id": "frontier-agentic-multi_step_execution-crash-journal",
    "taskType": "agentic_execution",
    "subtaskType": "multi_step_execution",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"snapshot.json\": \"{\\\"x\\\":0,\\\"y\\\":1}\",\n  \"wal.jsonl\": \"[\\\"begin\\\",\\\"a\\\"]\\n[\\\"set\\\",\\\"a\\\",\\\"x\\\",14]\\n[\\\"begin\\\",\\\"b\\\"]\\n[\\\"set\\\",\\\"b\\\",\\\"x\\\",23]\\n[\\\"commit\\\",\\\"a\\\"]\\n[\\\"set\\\",\\\"b\\\",\\\"y\\\",4]\\n[\\\"begin\\\",\\\"c\\\"]\\n[\\\"set\\\",\\\"c\\\",\\\"z\\\",99]\\n[\\\"abort\\\",\\\"c\\\"]\\n[\\\"commit\\\",\\\"b\\\"]\\n[\\\"begin\\\",\\\"d\\\"]\\n[\\\"delete\\\",\\\"d\\\",\\\"x\\\"]\\n[\\\"set\\\",\\\"d\\\",\\\"q\\\",7]\\n[\\\"commit\\\",\\\"d\\\"]\\n[\\\"begin\\\",\\\"e\\\"]\\n[\\\"set\\\",\\\"e\\\",\\\"y\\\",-8]\\n[\\\"begin\\\",\\\"f\\\"]\\n[\\\"set\\\",\\\"f\\\",\\\"q\\\",32]\\n[\\\"commit\\\",\\\"f\\\"]\\n[\\\"set\\\",\\\"e\\\",\\\"r\\\",100]\"\n}\n\nReplay the WAL from snapshot.json. begin opens an isolated write buffer; set/delete append to that transaction. commit applies its buffered operations to current global state in order, not to a begin-time snapshot. abort discards it. Discard every still-open transaction at EOF (simulated crash). Write recovered.json as [key,value] pairs in ascending key order, compact JSON without newline. Write report.json with rows, commits (committed transaction ids in commit order), discarded (still-open ids sorted), sha256 of recovered.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"rows\", \"commits\", \"discarded\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "rows": [
          [
            "q",
            32
          ],
          [
            "y",
            4
          ]
        ],
        "commits": [
          "a",
          "b",
          "d",
          "f"
        ],
        "discarded": [
          "e"
        ],
        "sha256": "b78b6090d9ef8265fdc2d1bd259e9fd1aa66fb25c61ffbccb2cabc5b7d7e4e14"
      }
    }
  },
  {
    "id": "frontier-agentic-multi_step_execution-quoted-temporal-join",
    "taskType": "agentic_execution",
    "subtaskType": "multi_step_execution",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"sales.csv\": \"id,region,amount,time\\r\\n\\\"a,1\\\",west,13,2\\r\\n\\\"b\\\"\\\"2\\\",east,-3,3\\r\\n\\\"line\\nbreak\\\",west,7,5\\r\\né,east,4,1\\r\\ndup,west,-8,6\\r\\ndup,west,12,4\\r\\n\",\n  \"rates.json\": \"[[\\\"west\\\",0,4,3],[\\\"west\\\",4,7,7],[\\\"east\\\",0,3,7],[\\\"east\\\",3,8,2]]\"\n}\n\nParse CSV including doubled quotes, embedded LF and commas; CRLF separates records only outside quotes. Header is not data. Rate tuples are [region,start,end,multiplier]. Join each sale to its unique rate with start<=time<end. Keep duplicate ids and input record order. Write joined.json as [id,amount*multiplier] pairs, compact JSON without newline. Write report.json with rows (data record count), total, sha256 of joined.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"rows\", \"total\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "rows": 6,
        "total": 138,
        "sha256": "5752f9465a0af34a4f803eebf34e2027968df191272c42a4f480b34bd6b7be5b"
      }
    }
  },
  {
    "id": "frontier-agentic-multi_step_execution-bounded-allocation",
    "taskType": "agentic_execution",
    "subtaskType": "multi_step_execution",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"jobs.json\": \"[{\\\"id\\\":\\\"a\\\",\\\"size\\\":4,\\\"value\\\":5},{\\\"id\\\":\\\"b\\\",\\\"size\\\":4,\\\"value\\\":16},{\\\"id\\\":\\\"c\\\",\\\"size\\\":4,\\\"value\\\":10},{\\\"id\\\":\\\"d\\\",\\\"size\\\":4,\\\"value\\\":4},{\\\"id\\\":\\\"e\\\",\\\"size\\\":4,\\\"value\\\":15},{\\\"id\\\":\\\"f\\\",\\\"size\\\":4,\\\"value\\\":9},{\\\"id\\\":\\\"g\\\",\\\"size\\\":4,\\\"value\\\":3},{\\\"id\\\":\\\"h\\\",\\\"size\\\":4,\\\"value\\\":14},{\\\"id\\\":\\\"i\\\",\\\"size\\\":4,\\\"value\\\":8}]\",\n  \"limit.json\": \"{\\\"capacity\\\":9}\"\n}\n\nRead job sizes and values. Exhaustively choose a subset with total size <= capacity. Maximize value; among equal values minimize used size; among equal values and size choose lexicographically smallest comma-joined sorted id list (JavaScript string comparison). Write selected.json as chosen ids sorted ascending. Write report.json with ids, size, value, sha256 of compact selected.json without newline.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"ids\", \"size\", \"value\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "ids": [
          "b",
          "e"
        ],
        "size": 8,
        "value": 31,
        "sha256": "d9991efbb41b718646a52e9dd5fc5cae03a80506ed40ed0326b5fe9ca6567a72"
      }
    }
  },
  {
    "id": "frontier-agentic-multi_step_execution-modular-recurrence",
    "taskType": "agentic_execution",
    "subtaskType": "multi_step_execution",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"matrix.json\": \"[[\\\"3\\\",\\\"8\\\",\\\"4\\\",\\\"0\\\"],[\\\"1\\\",\\\"6\\\",\\\"2\\\",\\\"7\\\"],[\\\"8\\\",\\\"4\\\",\\\"0\\\",\\\"5\\\"],[\\\"6\\\",\\\"2\\\",\\\"7\\\",\\\"3\\\"]]\",\n  \"state.json\": \"[\\\"1\\\",\\\"2\\\",\\\"3\\\",\\\"4\\\"]\",\n  \"steps.txt\": \"57\"\n}\n\nTreat matrix rows and state as decimal BigInt. Execute exactly steps synchronous iterations of newState[i]=sum(matrix[i][j]*oldState[j]) modulo 1000000007. Do not update state in place or use floating point. Write state-final.json as decimal strings, compact with no newline. Write report.json with state, sum (sum of residues as a decimal string, not reduced again), sha256 of state-final.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"state\", \"sum\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "state": [
          "339169558",
          "908648103",
          "212469638",
          "791886147"
        ],
        "sum": "2252173446",
        "sha256": "e5faf9538ed26213d4436c1c523a49898c475aa20abe0cdcb34f4a610fb1e145"
      }
    }
  },
  {
    "id": "frontier-agentic-multi_step_execution-pointer-patch-sequence",
    "taskType": "agentic_execution",
    "subtaskType": "multi_step_execution",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"base.json\": \"{\\\"a\\\":[\\\"p\\\",\\\"q\\\",\\\"r\\\",\\\"s\\\",\\\"t\\\"],\\\"obj\\\":{\\\"a/b\\\":1}}\",\n  \"patch.json\": \"[{\\\"op\\\":\\\"move\\\",\\\"from\\\":\\\"/a/1\\\",\\\"path\\\":\\\"/a/3\\\"},{\\\"op\\\":\\\"copy\\\",\\\"from\\\":\\\"/a/0\\\",\\\"path\\\":\\\"/obj/copied\\\"},{\\\"op\\\":\\\"replace\\\",\\\"path\\\":\\\"/obj/a~1b\\\",\\\"value\\\":12},{\\\"op\\\":\\\"remove\\\",\\\"path\\\":\\\"/a/0\\\"},{\\\"op\\\":\\\"add\\\",\\\"path\\\":\\\"/a/-\\\",\\\"value\\\":\\\"tail2\\\"},{\\\"op\\\":\\\"move\\\",\\\"from\\\":\\\"/obj/copied\\\",\\\"path\\\":\\\"/a/1\\\"},{\\\"op\\\":\\\"add\\\",\\\"path\\\":\\\"/obj/~0\\\",\\\"value\\\":[false,null]},{\\\"op\\\":\\\"copy\\\",\\\"from\\\":\\\"/obj/~0\\\",\\\"path\\\":\\\"/obj/list\\\"},{\\\"op\\\":\\\"replace\\\",\\\"path\\\":\\\"/obj/~0/0\\\",\\\"value\\\":false}]\"\n}\n\nApply the JSON Patch operations in order. Decode JSON Pointer ~1 as slash and ~0 as tilde. move removes the source before evaluating the destination; an array add inserts and - appends. copy deep-clones; existing copied values must not change after later mutations. Preserve object insertion order as JavaScript does. Write result.json as compact JSON without newline. Write report.json with a (final array), slash (obj[\"a/b\"]), tilde (obj[\"~\"]), list (obj.list), sha256 of result.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"a\", \"slash\", \"tilde\", \"list\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "a": [
          "r",
          "p",
          "s",
          "q",
          "t",
          "tail2"
        ],
        "slash": 12,
        "tilde": [
          false,
          null
        ],
        "list": [
          true,
          null
        ],
        "sha256": "658142aaa0f63e07760b54569a44bdb01dd76b218f724e9a74b8878c4279415e"
      }
    }
  },
  {
    "id": "frontier-agentic-multi_step_execution-module-condensation",
    "taskType": "agentic_execution",
    "subtaskType": "multi_step_execution",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"modules.json\": \"[[\\\"k\\\",\\\"b\\\"],[\\\"i\\\",\\\"j\\\"],[\\\"k\\\",\\\"j\\\"],[\\\"j\\\",\\\"k\\\"],[\\\"j\\\",\\\"i\\\"],[\\\"h\\\",\\\"i\\\"],[\\\"h\\\",\\\"f\\\"],[\\\"g\\\",\\\"h\\\"],[\\\"f\\\",\\\"g\\\"],[\\\"e\\\",\\\"f\\\"],[\\\"e\\\",\\\"d\\\"],[\\\"d\\\",\\\"e\\\"],[\\\"c\\\",\\\"d\\\"],[\\\"c\\\",\\\"a\\\"],[\\\"b\\\",\\\"c\\\"],[\\\"a\\\",\\\"b\\\"]]\"\n}\n\nTreat each tuple as a directed import edge. Compute strongly connected components. Sort each component by id, then sort components by their smallest id; this order assigns zero-based component indexes. Write components.json compactly without newline. Deduplicate intercomponent edges and sort numerically by source index then target index. Write report.json with components, edges (condensation edges), sha256 of components.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"components\", \"edges\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "components": [
          [
            "a",
            "b",
            "c",
            "d",
            "e",
            "f",
            "g",
            "h",
            "i",
            "j",
            "k"
          ]
        ],
        "edges": [],
        "sha256": "143a3fce5745344acdfa03c5fd90eafe01744a512c237e2f058bac386cdbd8c7"
      }
    }
  },
  {
    "id": "frontier-agentic-multi_step_execution-external-merge-normalization",
    "taskType": "agentic_execution",
    "subtaskType": "multi_step_execution",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"records.jsonl\": \"{\\\"key\\\":\\\"é\\\",\\\"rev\\\":3,\\\"value\\\":-5}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":6,\\\"value\\\":2}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":1,\\\"value\\\":9}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":4,\\\"value\\\":16}\\n{\\\"key\\\":\\\"a\\\",\\\"rev\\\":7,\\\"value\\\":23}\\n{\\\"key\\\":\\\"A\\\",\\\"rev\\\":2,\\\"value\\\":30}\\n{\\\"key\\\":\\\"🙂\\\",\\\"rev\\\":5,\\\"value\\\":37}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":0,\\\"value\\\":44}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":3,\\\"value\\\":51}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":6,\\\"value\\\":58}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":1,\\\"value\\\":65}\\n{\\\"key\\\":\\\"a\\\",\\\"rev\\\":4,\\\"value\\\":72}\\n{\\\"key\\\":\\\"A\\\",\\\"rev\\\":7,\\\"value\\\":79}\\n{\\\"key\\\":\\\"🙂\\\",\\\"rev\\\":2,\\\"value\\\":86}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":5,\\\"value\\\":93}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":0,\\\"value\\\":100}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":3,\\\"value\\\":107}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":6,\\\"value\\\":114}\\n{\\\"key\\\":\\\"a\\\",\\\"rev\\\":1,\\\"value\\\":121}\\n{\\\"key\\\":\\\"A\\\",\\\"rev\\\":4,\\\"value\\\":128}\\n{\\\"key\\\":\\\"🙂\\\",\\\"rev\\\":7,\\\"value\\\":135}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":2,\\\"value\\\":142}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":5,\\\"value\\\":149}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":0,\\\"value\\\":156}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":3,\\\"value\\\":163}\\n{\\\"key\\\":\\\"a\\\",\\\"rev\\\":6,\\\"value\\\":170}\\n{\\\"key\\\":\\\"A\\\",\\\"rev\\\":1,\\\"value\\\":177}\\n{\\\"key\\\":\\\"🙂\\\",\\\"rev\\\":4,\\\"value\\\":184}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":7,\\\"value\\\":191}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":2,\\\"value\\\":198}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":5,\\\"value\\\":205}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":0,\\\"value\\\":212}\\n{\\\"key\\\":\\\"a\\\",\\\"rev\\\":3,\\\"value\\\":219}\\n{\\\"key\\\":\\\"A\\\",\\\"rev\\\":6,\\\"value\\\":226}\\n{\\\"key\\\":\\\"🙂\\\",\\\"rev\\\":1,\\\"value\\\":233}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":4,\\\"value\\\":240}\\n{\\\"key\\\":\\\"é\\\",\\\"rev\\\":7,\\\"value\\\":247}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":2,\\\"value\\\":254}\\n{\\\"key\\\":\\\"Å\\\",\\\"rev\\\":5,\\\"value\\\":261}\\n{\\\"key\\\":\\\"a\\\",\\\"rev\\\":0,\\\"value\\\":268}\\n{\\\"key\\\":\\\"A\\\",\\\"rev\\\":3,\\\"value\\\":275}\"\n}\n\nRead the records as JSONL. Produce sorted run files with at most 6 input records per run, then merge them. Group keys after NFC normalization then toLowerCase; choose highest rev then latest original input position per normalized key. Final rows are [normalizedKey,rev,value], sorted by unsigned UTF-8 byte order (Buffer.compare), not locale order. Write merged.jsonl with one compact row per line and a final LF. Write report.json with rows, runs (ceiling of input count / 6), sha256 of merged.jsonl.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"rows\", \"runs\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "rows": [
          [
            "a",
            7,
            79
          ],
          [
            "å",
            6,
            114
          ],
          [
            "é",
            7,
            247
          ],
          [
            "🙂",
            7,
            135
          ]
        ],
        "runs": 7,
        "sha256": "3ae90c13953797b2801cdf4e5ba055ce820f6e978ff884894602b3c745bb79bd"
      }
    }
  },
  {
    "id": "frontier-agentic-multi_step_execution-link-aware-inventory",
    "taskType": "agentic_execution",
    "subtaskType": "multi_step_execution",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"assets/a.txt\": \"hello🙂\",\n  \"assets/b.txt\": \"xyxyxy\",\n  \"assets/empty\": \"\"\n}\n\nCreate hard link assets/a-copy.txt to assets/a.txt. Create symlinks assets/a-link -> a.txt, assets/dangling -> missing, assets/cycle1 -> cycle2, assets/cycle2 -> cycle1 (relative targets). Inventory with lstat, never follow symlinks. Write inventory.json with regular entry paths sorted ascending and symbolic entry paths sorted ascending. Compute bytesPerName over regular entries; compute uniqueBytes counting each (dev,ino) once. Do not sum symlink lengths. Write report.json with regular, symlinks, bytesPerName, uniqueBytes, sha256 of compact inventory.json without newline. inventory.json keys must be regular then symlinks.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"regular\", \"symlinks\", \"bytesPerName\", \"uniqueBytes\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "regular": [
          "assets/a-copy.txt",
          "assets/a.txt",
          "assets/b.txt",
          "assets/empty"
        ],
        "symlinks": [
          "assets/a-link",
          "assets/cycle1",
          "assets/cycle2",
          "assets/dangling"
        ],
        "bytesPerName": 24,
        "uniqueBytes": 15,
        "sha256": "a50b4c66d1d28a4faad043bf5dbb76adbed414782e2493bc4c49a2bf9e5a0553"
      }
    }
  },
  {
    "id": "frontier-agentic-multi_step_execution-framed-json-stream",
    "taskType": "agentic_execution",
    "subtaskType": "multi_step_execution",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"chunks.json\": \"[\\\"7b\\\",\\\"2278\\\",\\\"223a312c22\\\",\\\"73223a\\\",\\\"227d205b205c2222\\\",\\\"2c\\\",\\\"2261\\\",\\\"7272223a5b\\\",\\\"312c7b\\\",\\\"2279223a327d5d7d\\\",\\\"0d\\\",\\\"0a7b\\\",\\\"226e657874\\\",\\\"223a33\\\",\\\"7d20205b312c322c\\\",\\\"7b\\\",\\\"226b\\\",\\\"223a22c3a9\\\",\\\"f09f99\\\",\\\"82227d5d\\\"]\"\n}\n\nIncrementally decode the UTF-8 hex chunks. Split adjacent top-level JSON objects/arrays using balanced braces/brackets while respecting quoted strings and backslash escapes; whitespace between documents is ignored, delimiters inside strings are not nesting. Parse each complete document, serialize it compactly in input order to values.jsonl with final LF. Write report.json with documents, bytes (values.jsonl byte length), sha256 of values.jsonl.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"documents\", \"bytes\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "documents": 3,
        "bytes": 71,
        "sha256": "017b5b6d0c6e6351b5fc324d7c88b808b64227b9214cea885198992ee43529d7"
      }
    }
  },
  {
    "id": "frontier-agentic-multi_step_execution-minimum-audit-cover",
    "taskType": "agentic_execution",
    "subtaskType": "multi_step_execution",
    "tier": "frontier",
    "systemPrompt": "You are an offline coding agent with file and terminal tools. Perform the requested filesystem workflow in node:22-slim without network access. Return only the requested compact JSON, with no markdown or prose.",
    "userPrompt": "In a new empty directory, create these UTF-8 files from the JSON-encoded contents, without adding bytes:\n{\n  \"checks.json\": \"[{\\\"id\\\":\\\"a\\\",\\\"cost\\\":5,\\\"covers\\\":[0,2,4,6]},{\\\"id\\\":\\\"b\\\",\\\"cost\\\":4,\\\"covers\\\":[1,4,6]},{\\\"id\\\":\\\"c\\\",\\\"cost\\\":3,\\\"covers\\\":[1,3,5]},{\\\"id\\\":\\\"d\\\",\\\"cost\\\":2,\\\"covers\\\":[0,2,5]},{\\\"id\\\":\\\"e\\\",\\\"cost\\\":9,\\\"covers\\\":[0,2,4,6]},{\\\"id\\\":\\\"f\\\",\\\"cost\\\":8,\\\"covers\\\":[1,3,6]},{\\\"id\\\":\\\"g\\\",\\\"cost\\\":7,\\\"covers\\\":[1,3,5]},{\\\"id\\\":\\\"h\\\",\\\"cost\\\":6,\\\"covers\\\":[0,2,4]},{\\\"id\\\":\\\"i\\\",\\\"cost\\\":5,\\\"covers\\\":[2,4,6]},{\\\"id\\\":\\\"j\\\",\\\"cost\\\":4,\\\"covers\\\":[1,3,5]}]\",\n  \"required.json\": \"[0,1,2,3,4,5,6]\"\n}\n\nExecute an offline audit-plan calculation from both files. Choose checks whose union covers every required item. Minimize total cost, then minimize number of checks, then choose lexicographically smallest comma-joined ascending id list. Write plan.json with ids then cost, compact with no newline. Read it back and independently confirm coverage. Write report.json with ids, cost, covered (sorted unique coverage union, including any non-required items), sha256 of plan.json.\nUse file and terminal tools to write and run a Node.js program. Write the required intermediate and final artifacts, read the final artifact back, and report its contents. Do not just reason from the prompt. Built-in Node modules only; no network or package installation. Return only compact JSON with exactly these keys in this order: \"ids\", \"cost\", \"covered\", \"sha256\". All hashes are full lowercase SHA-256 of the exact artifact bytes.",
    "check": {
      "kind": "json_equal",
      "value": {
        "ids": [
          "a",
          "c"
        ],
        "cost": 8,
        "covered": [
          0,
          1,
          2,
          3,
          4,
          5,
          6
        ],
        "sha256": "9ece091aa824bc82fdcf27ec4ebd62e3e7f7b53c4d8144811158bf930787e218"
      }
    }
  }
];
