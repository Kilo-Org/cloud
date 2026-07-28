# Reading Kilobot's no-findings state

Symptom: the completion gate wants "Kilobot has reviewed the latest head", but no inline review threads ever appear, and it is unclear whether the review happened.

Cause: with the bot skip/permit config (#4765), a clean review produces no threads — it produces a green `Kilo Code Review` check plus exactly one issue comment from `kilo-code-bot[bot]` headed `Status: No Issues Found | Recommendation: Merge`.

Fix: that combination — green check on the current head, the no-issues summary comment, zero review threads (`gh api repos/.../pulls/<n>/comments` empty) — *is* the reviewed-with-no-findings state. There is nothing to reply to or resolve; the gate is met. A `BLOCKED`/`REVIEW_REQUIRED` merge state at that point only means the requested human review is pending — the expected terminal state.
