# mobile-ios-cold-build-shareextension-pods-root

Symptom: a genuinely cold `pnpm dev:mobile:ios build <udid>` (cache-busted) fails at
link with `(3 failures)` and one root error:
`error: unable to spawn process '/../../../../node_modules/.pnpm/react-native@0.86.0[_patch_hash=...]/node_modules/react-native/scripts/xcode/ccache-clang.sh' (No such file or directory) (in target 'ShareExtension' from project 'Kilo')`.

Cause: the generated `apps/mobile/ios/Kilo.xcodeproj` sets project-level
`REACT_NATIVE_PATH = "${PODS_ROOT}/../../../../node_modules/...react-native"` and
`CC/CXX/LD/LDPLUSPLUS = "$(REACT_NATIVE_PATH)/scripts/xcode/ccache-clang[++] .sh"`.
`PODS_ROOT` is defined only by Pods target xcconfigs, so for the ShareExtension
target (no Pods xcconfig) `PODS_ROOT` expands empty and the spawn path resolves to
`/node_modules/...`. Warm-cache iOS runs never hit this; the template is
tree-independent (present with or without the Hermes patch).

Workaround used in the round (temporary, in the gitignored generated project):
replace the project-level Debug `REACT_NATIVE_PATH` line with the absolute correct
path (delete duplicates — a later duplicate key wins). Build then succeeds.
Proper fix candidate for the repo: have the ShareExtension config plugin set an
absolute REACT_NATIVE_PATH (or stop overriding CC/LD) for that target.
