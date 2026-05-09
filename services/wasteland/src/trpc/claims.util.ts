const PR_KIND_KEYWORDS: ReadonlyArray<{
  keyword: string;
  kind: 'claim' | 'done' | 'unclaim' | 'edit';
}> = [
  { keyword: 'unclaim', kind: 'unclaim' },
  { keyword: 'done', kind: 'done' },
  { keyword: 'claim', kind: 'claim' },
  { keyword: 'update', kind: 'edit' },
  { keyword: 'edit', kind: 'edit' },
];

export function inferPrKind(title: string): 'claim' | 'done' | 'unclaim' | 'edit' | 'unknown' {
  const lower = title.toLowerCase();
  for (const { keyword, kind } of PR_KIND_KEYWORDS) {
    if (lower.includes(keyword)) return kind;
  }
  return 'unknown';
}
