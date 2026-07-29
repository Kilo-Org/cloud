# mobile: iOS "Open in \"Kilo\"?" confirmation blocks login/launch flows

Symptom: `apps/mobile/e2e/login.sh` fails its settle assertion with the simulator stuck under a SpringBoard dialog `Open in "Kilo"?` (Cancel/Open), after preflight's `xcrun simctl openurl` or on a freshly installed dev client.

Cause: two wordings exist. iOS 26.5 reworded the custom-scheme confirmation from `Open this page in "Kilo"?` to `Open in "Kilo"?`, and after `associatedDomains` (universal links) landed in `app.config.ts`, `simctl openurl` surfaces a SpringBoard confirmation of its own. Flow matchers that only know one wording never tap it. The custom-scheme dialog appears once per install; a reinstall re-arms it.

Fix: `e2e/flows/settle-app.yaml` and `e2e/flows/open-app.yaml` now match both wordings (`Open in ["“”]Kilo["“”]\?` alongside the Safari string) and tap `Open` in the same bounded optional-prompt slot. If it still appears mid-run, tap `Open` once yourself (two-line temp Maestro flow with `appId: host.springboard`, `tapOn: { text: 'Open', optional: true }`) and re-run `login.sh` — it is idempotent. When updating the flows, add new wordings as regex alternatives; never replace the old text.
