# Webhook "View logs" centered Dialog — bounds and interaction check

Date: 2026-10-20T15:19Z
No screenshots were taken, per instruction (hold until PR is opened).

## Build identity

- Worktree: `/workspace/app`
- Branch: `kilo/orbital-pond-sjb`
- HEAD: `303c4fd198551eed639472c35da73704d6ed260f`
- Working tree: dirty, only the pre-existing modification under test:
  `apps/web/src/app/(app)/cloud/webhooks/[triggerId]/requests/WebhookRequestsContent.tsx`
  (mtime 15:03:42Z; whitespace/formatting of the Dialog block plus existing `tabIndex` pre elements)
- Next.js dev process started 15:07:28Z, after the file's last edit; services were not restarted during the checks.
- App: `http://localhost:3000` (worktree offset 0, from `pnpm dev:status --json`)
- Webhook worker: `http://localhost:8793` (started for this check; app `WEBHOOK_AGENT_URL` resolves to it)

## Test data

- Trigger: `verify-dialog-001`
- Captured request: `7c262da1-88a1-43a1-8206-1673221e28b3`
- Request deliberately contains a long unbroken header value and a long unbroken JSON body token.

## Steps

1. Fake-login as the seeded sandbox user with `callbackPath=/cloud/triggers/verify-dialog-001/requests`.
2. Wait for the requests table and the `View logs` button.
3. For each viewport, open the dialog from `View logs`, expand `Request details`, and read geometry/computed styles.
4. Press Escape and assert the dialog is gone and focus restored.
5. At 375 px, inject a long `<pre>` sample into the execution-output region and read its computed wrapping.

## Results

| Criterion | Result | Evidence |
|---|---|---|
| 1440x900 bounds | PASS — dialog `896x765` at `(265,68)`, bottom 833; exactly `min(85dvh,800) x max-w-4xl`; inside viewport | measurements below |
| 768x1024 bounds | PASS — dialog `736x800` at `(9,112)`, bottom 912; 800 px cap engaged; inside viewport | measurements below |
| 375x812 bounds | PASS — dialog `343x690` at `(9,61)`, bottom 751; inside viewport; no page horizontal overflow | measurements below |
| Readable height | PASS — 85% of viewport on desktop/mobile; table cap 800 px on tablet. Execution-log region: 399 px on mobile, 538 px on desktop | measurements below |
| Escape closes and restores focus | PASS at all three sizes — `closed:true`, focus returned to the `View logs` button | measurements below |
| Dialog semantics | PASS — `role="dialog"`, `aria-labelledby` and `aria-describedby` resolve to title/description; initial focus lands inside the dialog | measurements below |
| `View logs` button unchanged | PASS — single `View logs` trigger, label preserved | page eval |
| Headers/body `pre` tabindex | PASS — both `pre` elements have `tabIndex:0` at every size | measurements below |
| Mobile code wrap | PASS — at 375 px execution-output `pre` computes `white-space:pre-wrap`, `word-break:break-all`, `scrollWidth=clientWidth=275` for a 560-char unbroken token; at 1440 px it remains `pre` with contained horizontal scroll | measurements below |
| No tracked edits | PASS — `git status --short` still shows only the pre-existing modified component; no product source was changed for this check | `git status` |

Observation, not a failure: the Radix content element had no `aria-modal` attribute in this build; `role="dialog"` plus labelledby/describedby and focus/Escape behavior were present.

## Raw measurements

### 1440x900

```json
{"dialog":true,"vw":1440,"vh":900,"dpr":1,"rect":{"x":265,"y":68,"w":896,"h":765,"top":68,"bottom":833,"left":265,"right":1161},"expectedH":765,"expectedW":896,"withinBounds":true,"docOverflowX":false,"dialogOverflowY":false,"title":"Execution logs","ariaLabelledby":"radix-_r_2_","ariaDescribedby":"radix-_r_3_","role":"dialog","modal":null,"pres":[{"tabIndex":0,"clientWidth":836,"scrollWidth":2393,"clientHeight":192,"scrollHeight":216,"whiteSpace":"pre","overflowX":"auto","textLength":646},{"tabIndex":0,"clientWidth":836,"scrollWidth":2314,"clientHeight":168,"scrollHeight":168,"whiteSpace":"pre","overflowX":"auto","textLength":524}]}
{"closed":true,"focusText":"View logs","focusTag":"BUTTON"}
```

### 768x1024

```json
{"dialog":true,"vw":768,"vh":1024,"dpr":1,"rect":{"x":9,"y":112,"w":736,"h":800,"top":112,"bottom":912,"left":9,"right":745},"expectedH":800,"expectedW":736,"withinBounds":true,"docOverflowX":false,"dialogOverflowY":false,"title":"Execution logs","ariaLabelledby":"radix-_r_2_","ariaDescribedby":"radix-_r_3_","role":"dialog","modal":null,"pres":[{"tabIndex":0,"clientWidth":676,"scrollWidth":2393,"clientHeight":192,"scrollHeight":216,"whiteSpace":"pre","overflowX":"auto","textLength":646},{"tabIndex":0,"clientWidth":676,"scrollWidth":2314,"clientHeight":168,"scrollHeight":168,"whiteSpace":"pre","overflowX":"auto","textLength":524}]}
{"closed":true,"focusText":"View logs","focusTag":"BUTTON"}
```

### 375x812

```json
{"dialog":true,"vw":375,"vh":812,"dpr":1,"rect":{"x":9,"y":61,"w":343,"h":690,"top":61,"bottom":751,"left":9,"right":352},"expectedH":690,"expectedW":343,"withinBounds":true,"docOverflowX":false,"dialogOverflowY":false,"title":"Execution logs","ariaLabelledby":"radix-_r_2_","ariaDescribedby":"radix-_r_3_","role":"dialog","modal":null,"pres":[{"tabIndex":0,"clientWidth":283,"scrollWidth":2393,"clientHeight":192,"scrollHeight":216,"whiteSpace":"pre","overflowX":"auto","textLength":646},{"tabIndex":0,"clientWidth":283,"scrollWidth":2314,"clientHeight":168,"scrollHeight":168,"whiteSpace":"pre","overflowX":"auto","textLength":524}]}
{"closed":true,"focusText":"View logs","focusTag":"BUTTON"}
```

### Execution-log area and mobile wrap

```json
{"vw":375,"vh":812,"dialogH":690,"sectionH":439,"regionH":399,"regionScrollH":397,"regionText":"No execution logs available for this run.","wrap":{"whiteSpace":"pre-wrap","wordBreak":"break-all","clientWidth":275,"scrollWidth":275,"textLength":560},"activeInDialog":true,"activeTag":"BUTTON"}
{"vw":1440,"vh":900,"dialogH":765,"sectionH":578,"regionH":538,"regionScrollH":536,"regionText":"No execution logs available for this run.","wrap":{"whiteSpace":"pre","wordBreak":"normal","clientWidth":812,"scrollWidth":4705,"textLength":560},"activeInDialog":true,"activeTag":"BUTTON"}
```

## Notes

- `.e2e-evidence/` is not git-ignored in this repo. This directory and its report are untracked; nothing was committed.
- Execution logs for the synthetic request are empty ("No execution logs available for this run."); the transcript wrap check used a DOM-only sample inside the real region because the captured request has no transcript.
