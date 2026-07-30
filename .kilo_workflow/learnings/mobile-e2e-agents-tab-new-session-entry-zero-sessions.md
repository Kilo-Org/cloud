# mobile e2e: Agents tab "New session" header button is hidden on zero-session accounts — tap "New coding task"

Symptom: flows that `tapOn('New session')` after switching to the Agents tab
time out on fresh e2e accounts.

Cause: `SessionListHeaderActions` gets `showNewSession={hasAnySessions}` —
with zero sessions the header Plus button is not rendered and the list's
empty-state CTA button `New coding task` (text match) is the only creation
affordance. After a first session exists, both paths can appear.

Fix: poll for either entry point (`New session` OR `New coding task`) and tap
whichever appears. Also note when detecting a session detail's loaded-empty
state: the header title text (`<instance> · <project>`) is NOT transcript
content — exclude it; `No messages yet` remains the only definitive text
signal for an idle remote session.
