# Driving remote `/exit` on iOS via Maestro (remote-cli E2E)

Learned 2026-07-28 during plan 1.7 (Defect A) round r3 verification.

1. **`hideKeyboard` fails in the chat composer.** Maestro reports "Couldn't hide
   the keyboard... app uses a custom input". Omit `hideKeyboard`; the "Send
   message" button sits above the keyboard and the tap lands fine (contrast
   with `maestro-tap-swallowed-by-ios-keyboard.md`, which covers taps *under*
   the keyboard window).
2. **Exact-typed `/exit` does not exit immediately.** The app shows a native
   confirmation dialog "Exit session?" with buttons "Exit session" and
   "Keep session running" ("This stops the running session but keeps its
   history."). A flow must tap "Exit session" before asserting the
   "Session exited" success toast.
3. **`inputText: "/exit"` lands as `/exit ` (trailing space)** — the slash
   suggestion UI commits a trailing space. Harmless: the composer parser
   trims input before matching, so it still routes to `exit-session`.
4. **Selecting a remote CLI instance collapses the new-session form** to just
   "Run on" + "Start session" (`RemoteSpawnComposer`): model / mode / repo /
   prompt are hidden by design, so no model selection or prompt typing step
   exists for remote CLI spawns. The session composer later shows the CLI's
   own model (observed "Auto Efficient").
5. **Instance row label format**: the Run-on sheet rows are
   `<Host> on <worktree>` (e.g. `Igor-MacBook.local on remote-cli-69f6`)
   while the collapsed form value is `Run on: <Host> · <worktree>` (`·`
   separator). Maestro `text:` matching is full-string — match the exact
   label including the separator.
6. After a successful exit the app routes to the Agents tab; the exited
   session stays listed ("... from CLI" row). Assert "New session" visible +
   `assertNotVisible` "Session owner changed" and "Try again" to prove the
   Defect-A regression is gone.
