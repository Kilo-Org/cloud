# Mobile Session Live Activity (iOS and Android)

## Role of This Document

This spec defines the business rules and invariants for the per-session
session card on iOS (an ActivityKit Live Activity) and on Android (an ongoing
notification). It is the source of truth for _what_ the system
must guarantee — valid states, ownership boundaries, privacy, and
user-facing behavior. It deliberately does not prescribe _how_ to
implement those guarantees: handler names, column layouts, and other
implementation choices belong in plan documents and code, not here.

## Status

Draft -- created 2026-10-12.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

## Definitions

- **Aggregate card**: The existing Active Agents Live Activity. It shows
  counts for one scope (personal or one organization).
- **Session card**: The surface for exactly one Cloud Agent session: a Live
  Activity on iOS, an ongoing notification on Android. Both render the one
  content contract, so a rule about the card holds on both platforms unless it
  names one.
- **Follow**: The user action that starts a session card on this device.
- **Unfollow**: The user action that ends a session card on this device. On
  Android, dismissing the notification is also an unfollow.
- **Followed session**: A session that has a live session card on any of
  the user's devices in the current scope.
- **Scope**: The personal surface or one organization, as for the
  aggregate card.
- **Status kind**: The shared glanceable vocabulary from
  `glanceableStatusKind` (`needsInput`, `running`, `idle`, `scheduled`),
  plus `failed` for a run that stopped with an error.

## Overview

A user who wants to watch one session taps Follow in that session's
screen. On iOS the device starts a session card on the Lock Screen and in the
Dynamic Island; on Android it posts one silent ongoing notification in its own
notification group and channel. The card shows the session title, its state, and how long
it has been in that state. When the agent needs a permission, the card
offers Approve. A tap on the card opens that session.

The aggregate card keeps working for the sessions the user does not
follow. When every live session is followed, the aggregate card ends.
The session card ends when the user unfollows, when the session finishes
its turn, or when the user loses access to the session.

## Rules

### Starting a session card

1. The system MUST start a session card only from a direct user action
   (Follow) on this device. The system MUST NOT start a session card on
   its own or by push-to-start in this version.
2. The Follow control MUST appear only for a session whose status kind is
   `running`, `needsInput`, or `scheduled`, and only while the Live
   Activity switch and the notification permission both allow Live
   Activities.
3. A device MUST hold at most one session card for one session. A second
   Follow for a followed session MUST NOT start another card.
4. The session card MUST start collapsed and silent, like the aggregate
   card. The system MUST NOT expand or vibrate it without a user action.
5. If iOS refuses the start (Live Activities disabled, or the app is at
   its system limit of activities), the session MUST stay unfollowed, the
   Follow control MUST show its normal state, and the system MUST show a
   short in-app message. The aggregate card MUST keep counting the
   session.

### Content

1. The session card MUST show: the Kilo logo, the session title, the
   status label, and the time in the current state.
2. The title MUST come from the same source as the home widget row title.
   An untitled session MUST show `common.agent`. A placeholder ISO title
   MUST NOT appear.
3. The status label MUST follow the status kind:
   - `running`: "Working" and a timer that counts up from the last status
     change.
   - `needsInput`: "Needs input" and the time it started waiting. If the
     session waits on a permission, the card MUST show Approve and Open.
   - `scheduled`: "Scheduled" and the wake time, with the same time rules
     as the home widget. It MUST NOT read "Idle".
   - `idle`: "Finished" and the finish time.
   - `failed`: a stop reason and the time it stopped.
4. The status label MUST NOT truncate. The card MUST give the label, and
   every number it shows, priority over the optional detail lines.
5. The card MUST show the session's current step when one is known: the
   verb of the latest tool call in the card's own vocabulary ("Editing",
   "Reading", "Run", "Web search", "Thinking it through") and its short
   target, capped in length. The card MUST NOT repeat the step on a
   second line.
6. The card MUST show plan progress when the session keeps a plan. The
   compact Lock Screen card shows the count ("3 of 7"); the expanded view
   also shows the bar and the current step's name, capped in length.
7. A `running` card whose session has no activity for
   `SESSION_CARD_QUIET_AFTER_MS` (5 minutes) MUST replace the step line
   with a quiet warning that names the quiet time. The card MUST NOT show
   "Last known" at the same time.
8. The card MUST show the diff size when the session has changed files:
   the file count, the added lines, and the removed lines. On the compact
   Lock Screen card it appears on the same line as the plan count.
9. A card that waits on a permission MUST show the command the request
   runs, trimmed to one short line, beside the Approve control. A card
   that waits on a question MUST NOT show Approve.
10. An `idle` card MUST show the duration of the run and its outcome when
    one is known: that a pull request opened, or the diff size.
11. The cost so far MUST appear only in the expanded view and on a
    finished or failed card. It MUST NOT appear on a working Lock Screen
    card.
12. The timer MUST count on the device. The server MUST NOT push an update
    only to advance a clock.
13. The session card MUST NOT show the organization name, the repository,
    the agent's message text, the session id, or an account id. The
    session id MAY travel in the card's data for routing and approval, but
    MUST NOT be drawn.
14. The card MUST follow the existing glanceable design rules: equal
    padding, the real logo, RTL mirroring, digits in the app language, and
    no repeated information.

### Content budget

1. The compact Lock Screen card MUST fit the surface's own height. It
   shows at most three single-line rows: the header (logo, title, and a
   last-known time when the content is out of date), the status row (the
   state label, the state time, and the controls), and one merged detail
   row. Every row is one line, and no row wraps.
2. The merged detail row carries the state's own line: the current step,
   the quiet warning, the command a permission wait runs, or the stop
   reason. The compact facts — the plan count, the diff size, and the file
   count — follow it on the same row while the row has room. The cost
   joins them only on a finished or failed card.
3. When the state's own line needs the whole row, it keeps the row and the
   compact facts move to the expanded view. Two states are that case: a
   `failed` card, whose stop reason names nothing when it is cut, and a
   permission wait, whose command must read in full beside the Approve
   control.
4. The expanded view MUST show the full set: the rows above, the plan bar
   and the current step's name, and the cost.
5. The status label and every number MUST NOT truncate in either view.
   Only a label truncates, and only at its end.
6. A card whose content is wider than the surface MUST drop the least
   important fact rather than truncate the state line, the status label,
   or a number.

### Presentation order

1. Across all of this app's cards, the Dynamic Island MUST show the card
   with the highest importance, and the Lock Screen MUST order cards by
   importance.
2. Importance order, highest first: a session card in `needsInput`, the
   aggregate card with needs input, a session card in `running` or
   `scheduled`, the aggregate card without needs input, a session card in
   `idle`.
3. Between cards of equal importance, the card whose state changed most
   recently MUST come first.

### Actions

1. A tap on the session card MUST open that session's chat
   (`kiloapp:///cloud/sessions/<encoded id>`).
2. Approve MUST answer the exact permission request the card shows. It
   MUST revalidate that request before it answers, as Approve does on the
   aggregate card. A stale or already-answered request MUST NOT be
   approved.
3. After Approve, the card MUST show the progress state and then the
   result state, or the failure notice, as the aggregate card does.
4. The session screen MUST show Unfollow while this device follows the
   session. Unfollow MUST end the card immediately.

### Updates

1. The server MUST update a session card on every status kind change of
   its session, on every change of the waiting permission request, and on
   a changed current step, plan, or diff size.
2. The server MUST NOT update a session card for a change that does not
   change what the card shows. A step-only change MUST be coalesced with
   the other updates of the same session within the refresh window.
3. Updates that move a card into `needsInput` or `failed`, and every
   ending, MUST use APNs priority 10. All other session card updates MUST
   use APNs priority 5, which does not count toward the iOS update budget.
4. Each update MUST carry a revision time, so iOS drops an update that
   arrives after a newer one.
5. A session card MUST carry a stale date. If no update arrives before
   it, the card MUST keep its last-known content with an honest time. It
   MUST NOT show "Status expired" or "no longer current". A running card's
   stale date MUST follow the session's last activity, so a quiet session
   reaches the quiet state without a clock update.

### Aggregate card coexistence

1. The aggregate card MUST count only the sessions in its scope that are
   not followed. The server's update excludes the sessions followed on any
   of the user's iOS devices, while the app's local update excludes only
   the sessions this device follows.
2. When the unfollowed count of startable work reaches zero, the
   aggregate card MUST end as it does today for an empty scope.
3. When a session is unfollowed, or its session card ends, the aggregate
   card MUST count it again in the next update.
4. The rule "show at most one Live Activity" now means at most one
   aggregate card. Session cards MUST NOT be swept away by the aggregate
   card's duplicate cleanup, and the aggregate card MUST NOT be swept
   away by session card cleanup.

### Ending a session card

1. When the session's status kind becomes `idle`, the system MUST end the
   card with the "Finished" content and dismiss it from the Lock Screen
   after 15 minutes. A tap that opens the session MUST dismiss it at once.
2. When the session's status kind becomes `failed`, the system MUST keep
   the card visible with the stop reason, and dismiss it from the Lock
   Screen after the same 15 minutes. A `failed` card MUST NOT dismiss
   because the user merely looked at it: only opening the session or
   unfollowing ends it sooner.
3. When the session is deleted, or the user loses access to it, the
   system MUST end the card immediately with no content.
4. Sign-out, an account change, an organization switch that leaves the
   card's scope, the app privacy lock, and the Live Activity switch turned
   off MUST end every session card immediately.
5. When iOS ends a card at its time limit, the server MUST drop the
   card's token on the next APNs rejection and the session MUST count as
   unfollowed again.
6. Every ended card MUST release its push token on the server. Token
   unregister MUST run before the device session is revoked, as it does
   for the aggregate card.

### Privacy

1. This spec changes the glanceable privacy rule for session cards only:
   a session card MAY show the session title on the Lock Screen, because
   the user started it with an explicit Follow.
2. A session card MAY also show the current step's verb and short target,
   the current plan step's name, and the trimmed command a permission
   request runs. These come from the session's own tool activity. The
   card MUST NOT show the agent's message text.
3. The aggregate card contract does not change. It MUST NOT carry a
   title, session id, repository, organization name, or generated text.
4. Session card data MUST NOT appear in the aggregate card's data, and
   aggregate card data MUST NOT carry the followed session ids.

### Card data contract

The session card data MUST hold exactly these facts, and nothing else:

| Fact | Meaning |
|---|---|
| session id | Routing and approval only. Never drawn. |
| title | Display title, already trimmed and capped in length. |
| status kind | `running`, `needsInput`, `idle`, `scheduled`, or `failed`. |
| status since | When the current status kind began. |
| started at | When the run started, for the finished duration. |
| scheduled at | Wake time, or none. |
| current step | The latest tool call's verb and short target, or none. |
| plan | Steps done, steps total, and the current step's name, or none. |
| permission command | The command the waiting request runs, trimmed, or none. |
| changes | Changed files, added lines, and removed lines, or none. |
| last activity at | When the session last did something, or none. |
| cost | The run's cost so far, or none. |
| outcome | A pull request opened, changes, or none. |
| failure | The stop class of a failed run, or none. |
| awaiting permission | True only when Approve can answer the request. |
| approval key | Key of the request the card shows, or none. |
| updated at | When the server confirmed this content. |

## Error Handling

1. When an APNs push for a session card fails with a retryable error, the
   system MUST retry within the existing glanceable retry bounds.
2. When APNs reports the card's token as gone, the system MUST drop the
   token and MUST count the session as unfollowed.
3. When Approve fails, the card MUST show the failure notice and keep the
   request open for the next try.
4. When the device cannot register the card's push token, the card MUST
   stay visible with local content, and the app MUST retry the
   registration at the next foreground.

## Android

The rules above hold on Android with the platform facts below. Where a rule
names APNs or ActivityKit it is the iOS mechanism; Android has its own, and the
observable behavior is the same.

### Android: the notification

1. The system MUST post one ongoing notification per followed session, in its
   own notification group, on a dedicated silent channel. The notification MUST
   NOT make a sound or vibrate, and it MUST use the platform's
   alert-once behavior, so an update never re-alerts.
   The dedicated channel MUST use default importance so the card appears on the
   Lock Screen with the system's default settings. The channel MUST disable
   sound and vibration explicitly; user changes to notification settings remain
   authoritative. An install with the old low-importance channel MUST migrate
   to a new channel id because Android keeps channel importance after creation.
2. The system MUST key the notification by the session id, through a stable
   notification id derived from it, so an update replaces that session's
   notification and never another session's.
3. The system MUST request the promoted-ongoing Live Update where the platform
   allows it (Android 16.1 or later, with the user's Live Updates setting on),
   and MUST fall back to an ordinary ongoing notification everywhere else. It
   MUST NOT draw a custom content view, colorize, or set the card as a group
   summary: the platform refuses to promote such a card.
4. The notification MUST show the session title, the status label, and the time
   in that state. A `running` card MUST show the elapsed time as the platform's
   own counting-up timer, so it stays right while no process runs; every other
   card MUST show the absolute time the rules above define in its text, and
   MUST clear the platform's timestamp and hide its header time in both the
   collapsed and expanded views, which otherwise draw a relative age.
5. The system MAY draw extra detail the platform can show, as the Content
   rules define it: the current step, plan progress, the permission command,
   the diff size, and the cost so far. The cost MUST appear only in the
   expanded part of the notification, never in its collapsed header. A
   promoted Live Update has no expanded text area, so it leaves the cost out.
6. The notification MUST use the platform's progress style for the plan bar.
   The card has one platform timer, so a quiet `running` card MUST name the
   quiet warning in its text and MUST count that timer from the last activity,
   which names the quiet time. The device MUST switch the card to the quiet form
   at the end of the quiet window with no push and no running app process.
7. The system MUST create the channel before the first post and MUST carry a
   translated channel name, as the other Android channels do.
8. A launch after a force-stop MUST re-post the stored cards of the current
   signed-in scope without waiting for the tray. Finished cards MUST NOT become
   followed cards again, and cards of another scope MUST NOT be re-posted.

### Android: actions

1. A tap on the card MUST open the session, as the rules above require.
2. Approve MUST appear only for a permission wait that carries an approval key,
   and it MUST run the same revalidating approval the iOS card runs, for the
   explicit session and the exact request the card shows.
3. A user dismissal of the notification MUST count as Unfollow: the app MUST
   stop following that session, MUST delete the session's server row, and MUST
   NOT re-post the notification for a later update of that session.

### Android: updates and ending

1. The server MUST reach a followed Android session through a high-priority
   data-only push that carries the same content contract as the iOS card, on
   the same transitions, with the same unchanged-content skip, and with the
   same priority rule: a change into `needsInput` or `failed`, and every
   ending, is urgent; a step-only or other change is not. The message MUST
   carry a schema version, so a client that does not know a later version
   ignores it instead of failing.
2. An Android follow MUST NOT expire on its own: the notification has no system
   time limit, so the follow lasts until the user unfollows or dismisses it, or
   the card ends. The iOS card's maximum-lifetime rule does not apply.
3. When the session finishes, the notification MUST show the Finished content
   and MUST leave the shade after the same 15 minutes as the iOS card.
4. Sign-out, an account change, an organization switch that leaves the card's
   scope, a privacy lock, and the in-app switch turned off MUST cancel every
   session notification and unregister every session row, exactly as they end
   the iOS cards.
5. A push for a session this device no longer follows MUST render nothing, and
   the app MUST delete that session's row for this device.

### Android: aggregate card coexistence

1. The Android aggregate ongoing notification MUST leave out the sessions this
   device follows, as the aggregate Live Activity does on iOS. The Android Home
   widget is unchanged: it keeps every session, as the iOS Home widget does.
2. The aggregate exclusion MUST count both platforms' session rows: a session
   followed on any of the user's devices counts as followed for the aggregate
   card on either platform.

### Android: privacy

1. A session notification MAY show the session title, for the reason a session
   card may: the user started it with Follow.
2. The notification MUST NOT show the organization name, the repository,
   generated text, the session id, or an account id. The session id travels in
   the notification's data for routing and approval only.

## Changelog

### 2026-10-12 -- Initial spec

- Created from the per-session Live Activity design decisions: start by
  Follow, show titles on followed cards, and count only unfollowed
  sessions on the aggregate card.

### 2026-10-12 -- Android

- Added the Android session card: one silent ongoing notification per followed
  session, promoted as a Live Update where the platform allows it, with the same
  content, actions, ending rules, privacy, and aggregate exclusion as iOS.
- The Android Home widget keeps every session, as the iOS one does; only the
  aggregate card excludes followed sessions.
- The server's aggregate exclusion counts both platforms' session rows.

### 2026-10-13 -- The Lock Screen content budget

- Split the content rules by surface: the compact Lock Screen card shows the
  plan count and the diff size on one merged row, while the plan bar, the plan
  step's name, and the cost stay in the expanded view.
- Added a Content budget section: three single-line rows on the Lock Screen, the
  state's own line first, the compact facts after it, and the expanded view
  carries the full set.
- A `failed` card gives its row to the stop reason alone, because a truncated
  reason names nothing.

### 2026-10-13 -- Device findings

- A self-updating date `Text` MUST NOT carry `fixedSize({ horizontal: true })`.
  It reports an infinite ideal width, which degenerates every frame in the card
  and leaves an empty platter (PR #7434).
- The card's cost is formatted with the app language's digits, decimal
  separator, currency layout, and thousands grouping.

### 2026-10-13 -- Richer content and the failed state

- The card now shows the current step, plan progress, the permission command,
  the diff size, the time since the last activity, the cost (expanded view and
  finished cards only), the finished duration and outcome, and a stop reason.
- Added the `failed` status kind, with no timer dismissal.
- Session cards may show the step name and the trimmed permission command; the
  agent's message text stays off the card.
- A quiet running session shows a warning after 5 minutes instead of the step.
- The status label and every number MUST NOT truncate.

### 2026-10-12 -- Android content fixes

- A failed Android card names its stop reason.
- A quiet Android Working card names the warning and counts its timer from
  the last activity; the device switches it at the end of the quiet window.
- Android cards other than Working show the absolute time in the text and hide
  the relative header time.
- The Android cost moved out of the collapsed header into the expanded text.

### 2026-10-13 -- Android restart and Lock Screen delivery

- Clear non-timed system timestamps, including the expanded notification header.
- Assign each session an explicit notification group.
- Move followed cards to a default-importance channel with sound and vibration
  disabled so they appear on the Lock Screen with the default system settings.
- Await a pushed end's own row release instead of superseding it with another.
- Re-post the current scope's stored followed cards after a force-stop.
