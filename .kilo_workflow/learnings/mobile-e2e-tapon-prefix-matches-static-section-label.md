# mobile e2e: tapOn prefix regex matches the static section label above the real button

Symptom: `tapOn(/^Run on: /)` on the new-session screen silently taps nothing; the
follow-up wait times out. No product defect.

Cause: `tapOn` sorts matches topmost-first (y, then x) and taps index 0. The form's
static section header Text (`Run on`, y=322) sorts ABOVE the interactive row button
(`Run on: Cloud Agent`, y=347) and matches the same prefix pattern, so the tap lands
on the non-interactive label.

Fix: always match the control's FULL exact accessibility label
(`tapOn(/^Run on: Cloud Agent$/)`), never a prefix that also fits a sibling heading.
When a tap "does nothing", dump the hierarchy and compare every match's rect before
blaming the app — the topmost match wins, not the most interactive one.
