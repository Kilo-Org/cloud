# mobile: kill -STOP nextjs to hold loading skeletons — only after the app is past splash

Symptom: using the `kill -STOP <nextjs-pid>` suspend trick to freeze API responses (holding loading skeletons indefinitely for screenshots/assertions) hangs the app at the splash screen instead.

Cause: a cold app start needs nextjs to answer its initial requests; suspending before the app is past splash blocks startup itself, not just the screen under test.

Fix: launch and settle the app first, navigate to the screen under test, then `kill -STOP` the nextjs process; `kill -CONT` it as soon as the assertion is done. Treat the suspend window as strictly scoped to an already-running app.
