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
  `glanceableStatusKind`: `needsInput`, `running`, `idle`, `scheduled`.

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
4. The timer MUST count on the device. The server MUST NOT push an update
   only to advance a clock.
5. The session card MUST NOT show the organization name, the repository,
   generated text, the session id, or an account id. The session id MAY
   travel in the card's data for routing and approval, but MUST NOT be
   drawn.
6. The card MUST follow the existing glanceable design rules: equal
   padding, the real logo, RTL mirroring, digits in the app language,
   labels that truncate at the end, and no repeated information.

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
   its session and on every change of the waiting permission request.
2. The server MUST NOT update a session card for a change that does not
   change what the card shows.
3. Updates that move a card into `needsInput` or `idle` MUST use APNs
   priority 10. All other session card updates MUST use APNs priority 5,
   which does not count toward the iOS update budget.
4. Each update MUST carry a revision time, so iOS drops an update that
   arrives after a newer one.
5. A session card MUST carry a stale date. If no update arrives before
   it, the card MUST keep its last-known content with an honest time. It
   MUST NOT show "Status expired" or "no longer current".

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
2. When the session is deleted, or the user loses access to it, the
   system MUST end the card immediately with no content.
3. Sign-out, an account change, an organization switch that leaves the
   card's scope, the app privacy lock, and the Live Activity switch turned
   off MUST end every session card immediately.
4. When iOS ends a card at its time limit, the server MUST drop the
   card's token on the next APNs rejection and the session MUST count as
   unfollowed again.
5. Every ended card MUST release its push token on the server. Token
   unregister MUST run before the device session is revoked, as it does
   for the aggregate card.

### Privacy

1. This spec changes the glanceable privacy rule for session cards only:
   a session card MAY show the session title on the Lock Screen, because
   the user started it with an explicit Follow.
2. The aggregate card contract does not change. It MUST NOT carry a
   title, session id, repository, organization name, or generated text.
3. Session card data MUST NOT appear in the aggregate card's data, and
   aggregate card data MUST NOT carry the followed session ids.

### Card data contract

The session card data MUST hold exactly these facts, and nothing else:

| Fact | Meaning |
|---|---|
| session id | Routing and approval only. Never drawn. |
| title | Display title, already trimmed and capped in length. |
| status kind | `running`, `needsInput`, `idle`, or `scheduled`. |
| status since | When the current status kind began. |
| scheduled at | Wake time, or none. |
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
   card MUST show the absolute time the rules above define.
5. The system MAY draw extra detail the platform can show: plan progress, the
   permission command, the diff size, and the cost so far. The cost MUST appear
   only in the expanded part of the notification.
6. The system MUST create the channel before the first post and MUST carry a
   translated channel name, as the other Android channels do.

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
   the same transitions, with the same unchanged-content skip. The message MUST
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
