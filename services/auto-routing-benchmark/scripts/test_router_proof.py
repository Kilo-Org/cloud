import copy
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT_DIRECTORY = Path(__file__).resolve().parent


def load_proof(path):
    spec = importlib.util.spec_from_file_location("router_proof_fixture", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def put(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return path


def json_put(path, value):
    return put(path, json.dumps(value, sort_keys=True))


class PreparedExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name).resolve()
        self.host = self.make_root("host")
        self.baseline = self.make_root("baseline")
        self.candidate = self.make_root("candidate")
        helper = self.host / "services/auto-routing-benchmark/scripts/router-proof.py"
        shutil.copyfile(SCRIPT_DIRECTORY / "router-proof.py", helper)
        self.proof = load_proof(helper)
        self.node = put(self.directory / "node", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\nprintf 'v24.0.0\\n'\nelse\nprintf '[\"events\"]\\n'\nfi\n")
        self.node.chmod(0o755)
        workerd = self.host / "node_modules/workerd/bin/workerd"
        packages = {}
        for key, name in {"miniflare": "miniflare", "workerd": "workerd", "tsx": "tsx",
                          "zod": "zod", "contracts": "@kilocode/auto-routing-contracts"}.items():
            packages[key] = {"root": str(self.host / "node_modules" / name), "version": "1.0.0"}
        self.descriptor = {
            "roots": {"host": str(self.host), "baseline": str(self.baseline), "candidate": str(self.candidate)},
            "node": str(self.node), "runtime_script": str(self.host / self.proof.SCRIPT),
            "tsx_esm_api": str(self.host / "node_modules/tsx/esm-api.mjs"),
            "node_builtin_modules": ["events"],
            "observed": {"node": "v24.0.0", "versions": {"node": "24.0.0"}, "packages": packages,
                         "workerd": {"path": str(workerd), "sha256": self.proof.file_sha256(workerd),
                                     "version": "workerd 1.0.0"}},
            "compatibility_date": "2026-05-15", "compatibility_flags": ["nodejs_compat"],
        }
        self.prepared = self.directory / "prepared"
        self.prepared.mkdir()
        for name, root in (("baseline", self.baseline), ("candidate", self.candidate)):
            directory = self.prepared / name
            put(directory / "bundle/router-isolated-worker.js", "export default { fetch() { return new Response('ok'); } };\n")
            put(directory / "bundle/router-isolated-worker.js.map", "{}\n")
            json_put(directory / "wrangler.jsonc", {"main": str(root / self.proof.WRAPPER)})
            inputs = [root / "services/auto-routing/src/index.ts", root / self.proof.WRAPPER,
                      root / "node_modules/fixture-worker/index.js"]
            json_put(directory / "bundle-meta.json", {"inputs": {
                os.path.relpath(path, directory): {"bytes": path.stat().st_size} for path in inputs
            }, "outputs": {}})
        self.inputs = json_put(self.directory / "inputs.json", self.proof.capture(self.descriptor))
        self.identity = self.proof.finalize(self.prepared, self.inputs)
        self.original_manifest = self.manifest()

    def make_root(self, name):
        root = self.directory / name
        root.mkdir()
        subprocess.run(["git", "init", "--quiet", str(root)], check=True, stdout=subprocess.DEVNULL)
        json_put(root / "package.json", {"name": "fixture", "version": "1.0.0"})
        put(root / "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
        put(root / "pnpm-workspace.yaml", "packages:\n  - services/*\n")
        json_put(root / "services/auto-routing/package.json", {
            "name": "auto-routing", "version": "1.0.0", "dependencies": {"fixture-worker": "1.0.0"}
        })
        json_put(root / "services/auto-routing-benchmark/package.json", {"name": "benchmark", "version": "1.0.0"})
        json_put(root / "services/auto-routing-benchmark/tsconfig.json", {})
        json_put(root / "services/auto-routing-benchmark/scripts/tsconfig.json", {"extends": "../tsconfig.json"})
        put(root / "services/auto-routing/src/index.ts", "export default {};\n")
        json_put(root / "services/auto-routing/wrangler.jsonc", {"compatibility_date": "2026-05-15"})
        put(root / "services/auto-routing-benchmark/scripts/router-runtime.ts", "export {};\n")
        put(root / "services/auto-routing-benchmark/scripts/router-isolated-worker.ts", "export {};\n")
        for package in ("wrangler", "fixture-worker", "miniflare", "workerd", "tsx", "zod", "jsonc-parser",
                        "@kilocode/auto-routing-contracts"):
            dependencies = {"workerd": "1.0.0"} if package == "miniflare" else {}
            metadata = {"name": package, "version": "1.0.0", "dependencies": dependencies}
            if package == "tsx":
                metadata["exports"] = {"./esm/api": {"import": {"default": "./esm-api.mjs"}}}
            json_put(root / "node_modules" / package / "package.json", metadata)
            put(root / "node_modules" / package / "index.js", "module.exports = {};\n")
        put(root / "node_modules/tsx/esm-api.mjs", "export function register() {};\n")
        binary = put(root / "node_modules/workerd/bin/workerd", "#!/bin/sh\nprintf 'workerd 1.0.0\\n'\n")
        binary.chmod(0o755)
        return root

    def manifest(self):
        return json.loads((self.prepared / "execution.json").read_text())

    def replace_manifest(self, manifest, rehash=True):
        if rehash:
            manifest["identity_sha256"] = self.proof.digest({
                key: value for key, value in manifest.items() if key != "identity_sha256"
            })
        json_put(self.prepared / "execution.json", manifest)

    def health(self):
        return {"status": "ok", "executionIdentity": copy.deepcopy(self.identity),
                "runtime": copy.deepcopy(self.identity["runtime"]["observed"]),
                "versions": {name: {key: self.identity[name][key]
                                    for key in ("workerRoot", "workerBundleSha256")}
                             for name in ("baseline", "candidate")}}

    def test_identity_is_deterministic_and_contains_both_compiled_bundles(self):
        self.assertEqual(self.identity, self.proof.execution_identity(self.prepared / "execution.json"))
        self.assertEqual(self.identity, self.proof.execution_identity(self.prepared))
        self.assertEqual(self.identity["baseline"]["workerBundleSha256"], self.identity["candidate"]["workerBundleSha256"])
        self.assertEqual(self.identity["baseline"]["executableSha256"], self.identity["candidate"]["executableSha256"])
        self.assertNotEqual(self.identity["baseline"]["workerRoot"], self.identity["candidate"]["workerRoot"])
        self.assertNotIn("timestamp", self.identity)

    def test_mutating_either_actual_compiled_bundle_is_rejected(self):
        for name in ("baseline", "candidate"):
            with self.subTest(name=name):
                entry = self.prepared / name / "bundle/router-isolated-worker.js"
                original = entry.read_bytes()
                entry.write_bytes(original + b"\nexport const mutated = true;\n")
                with self.assertRaisesRegex(ValueError, "compiled Worker bundle drift"):
                    self.proof.execution_identity(self.prepared)
                entry.write_bytes(original)

    def test_mutating_either_source_root_is_rejected(self):
        for root in (self.baseline, self.candidate):
            with self.subTest(root=root.name):
                entry = root / "services/auto-routing/src/index.ts"
                original = entry.read_text()
                entry.write_text(original + "export const changed = true;\n")
                with self.assertRaisesRegex(ValueError, "source_files drift"):
                    self.proof.execution_identity(self.prepared)
                entry.write_text(original)

    def test_mutating_actual_dependency_input_in_either_root_is_rejected(self):
        for root in (self.baseline, self.candidate):
            with self.subTest(root=root.name):
                entry = root / "node_modules/fixture-worker/index.js"
                original = entry.read_text()
                entry.write_text(original + "exports.changed = true;\n")
                with self.assertRaisesRegex(ValueError, "dependencies drift"):
                    self.proof.execution_identity(self.prepared)
                entry.write_text(original)

    def test_runtime_loader_and_dependency_drift_are_rejected(self):
        for relative in ("node_modules/tsx/esm-api.mjs", "node_modules/miniflare/index.js"):
            with self.subTest(relative=relative):
                entry = self.host / relative
                original = entry.read_text()
                entry.write_text(original + "\n// drift\n")
                with self.assertRaises(ValueError):
                    self.proof.execution_identity(self.prepared)
                entry.write_text(original)

    def test_bootstrap_is_frozen_and_preflights_before_loading_typescript(self):
        bootstrap = self.prepared / "bootstrap.mjs"
        source = bootstrap.read_text()
        self.assertEqual(self.identity["serving_argv"][:2], [str(self.node), str(bootstrap)])
        self.assertIn("register({ tsconfig: false })", source)
        self.assertIn("process.env.TSX_DISABLE_CACHE = '1'", source)
        self.assertIn("key.startsWith('MINIFLARE_')", source)
        self.assertLess(source.index("execFileSync("), source.index("await import(pathToFileURL("))
        bootstrap.write_text(source + "\nexport const changed = true;\n")
        with self.assertRaisesRegex(ValueError, "bootstrap drift"):
            self.proof.execution_identity(self.prepared)

    def test_a_forged_bootstrap_cannot_pass_by_rehashing_the_manifest(self):
        bootstrap = self.prepared / "bootstrap.mjs"
        bootstrap.write_text("throw new Error('unapproved loader');\n")
        manifest = self.manifest()
        manifest["runtime"]["bootstrap_sha256"] = self.proof.file_sha256(bootstrap)
        self.replace_manifest(manifest)
        with self.assertRaisesRegex(ValueError, "Unapproved prepared loader bootstrap"):
            self.proof.execution_identity(self.prepared)

    def test_unrelated_root_or_ancestor_tsconfigs_are_not_loader_inputs(self):
        for directory in (self.host, self.host.parent):
            json_put(directory / "tsconfig.json", {
                "compilerOptions": {"baseUrl": ".", "paths": {"miniflare": ["unbound.mjs"]}}
            })
        self.assertEqual(self.proof.execution_identity(self.prepared), self.identity)
        self.assertEqual(self.identity["runtime"]["tsx_options"], {"tsconfig": False, "cache": False})

    def test_prepare_launcher_disables_discovery_and_drops_execution_overrides(self):
        with patch.object(self.proof.shutil, "which", return_value=str(self.node)), \
             patch.object(self.proof.os, "execve") as execute, \
             patch.dict(os.environ, {"NODE_OPTIONS": "--import=unbound.mjs",
                                     "MINIFLARE_WORKERD_AUTOGATES": "unsafe",
                                     "MINIFLARE_WORKERD_CONFIG_DEBUG": "1"}):
            self.proof.prepare_execution(self.directory / "new-prepared", self.baseline, self.candidate)
        node, argv, environment = execute.call_args.args
        self.assertEqual(node, str(self.node))
        self.assertEqual(argv[1:3], ["--input-type=module", "--eval"])
        self.assertIn("register({tsconfig:false})", argv[3])
        self.assertNotIn("--import", argv)
        self.assertFalse(set(environment) - {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"})
        self.assertNotIn("NODE_OPTIONS", environment)
        self.assertNotIn("MINIFLARE_WORKERD_AUTOGATES", environment)
        self.assertNotIn("MINIFLARE_WORKERD_CONFIG_DEBUG", environment)

    def test_binary_drift_is_rejected(self):
        for binary in (self.node, self.host / "node_modules/workerd/bin/workerd"):
            with self.subTest(binary=binary):
                original = binary.read_bytes()
                binary.write_bytes(original + b"\n# drift\n")
                with self.assertRaisesRegex(ValueError, "executable drift|binary drift"):
                    self.proof.execution_identity(self.prepared)
                binary.write_bytes(original)

    def test_root_resolution_drift_is_rejected_even_with_same_contents(self):
        package = self.candidate / "node_modules/fixture-worker"
        moved = self.directory / "moved-package"
        shutil.move(package, moved)
        package.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "package root drift|dependencies drift"):
            self.proof.execution_identity(self.prepared)

    def test_manifest_hash_and_approved_argv_cannot_be_bypassed(self):
        manifest = self.manifest()
        changed = copy.deepcopy(manifest)
        changed["serving_argv"] = [sys.executable, "-c", "print('bypass')"]
        self.replace_manifest(changed, rehash=False)
        with self.assertRaisesRegex(ValueError, "identity digest mismatch"):
            self.proof.execution_identity(self.prepared)
        self.replace_manifest(changed)
        with self.assertRaisesRegex(ValueError, "Unapproved runtime serving argv"):
            self.proof.execution_identity(self.prepared)

    def test_old_and_one_sided_manifests_are_rejected(self):
        for change in (lambda value: value.update(schema_version=0),
                       lambda value: value["versions"].pop("baseline")):
            with self.subTest(change=change):
                manifest = self.manifest()
                change(manifest)
                self.replace_manifest(manifest)
                with self.assertRaises(ValueError):
                    self.proof.execution_identity(self.prepared)
                self.replace_manifest(self.original_manifest)

    def test_extra_bundle_module_and_bundle_symlink_are_rejected(self):
        extra = put(self.prepared / "baseline/bundle/extra.js", "export {};\n")
        with self.assertRaisesRegex(ValueError, "compiled Worker bundle drift"):
            self.proof.execution_identity(self.prepared)
        extra.unlink()
        extra.symlink_to(self.prepared / "candidate/bundle/router-isolated-worker.js")
        with self.assertRaisesRegex(ValueError, "symlinks"):
            self.proof.execution_identity(self.prepared)

    def test_compiler_input_outside_bound_roots_is_rejected(self):
        outsider = put(self.directory / "unbound.ts", "export {};\n")
        metadata = self.prepared / "baseline/bundle-meta.json"
        content = json.loads(metadata.read_text())
        content["inputs"][str(outsider)] = {"bytes": outsider.stat().st_size}
        json_put(metadata, content)
        with self.assertRaisesRegex(ValueError, "outside inventoried"):
            self.proof._compiler_inputs(self.prepared, "baseline", self.manifest()["versions"]["baseline"], self.identity["runtime"])

    def test_node_builtin_virtual_inputs_use_the_bound_runtime_whitelist(self):
        metadata = self.prepared / "baseline/bundle-meta.json"
        content = json.loads(metadata.read_text())
        content["inputs"]["node-built-in-modules:events"] = {"bytes": 0}
        json_put(metadata, content)
        source = self.manifest()["versions"]["baseline"]
        observed = self.proof._compiler_inputs(self.prepared, "baseline", source, self.identity["runtime"])
        self.assertEqual(observed["node-built-in-modules:events"], {"node_builtin": "events"})
        content["inputs"]["node-built-in-modules:not-a-real-builtin"] = {"bytes": 0}
        json_put(metadata, content)
        with self.assertRaisesRegex(ValueError, "Unrecognized Node builtin"):
            self.proof._compiler_inputs(self.prepared, "baseline", source, self.identity["runtime"])

    def test_node_builtin_whitelist_cannot_be_replaced_with_a_forged_manifest(self):
        manifest = self.manifest()
        manifest["runtime"]["node_builtin_modules"].append("not-a-real-builtin")
        self.replace_manifest(manifest)
        with self.assertRaisesRegex(ValueError, "Node builtin module identity drift"):
            self.proof.execution_identity(self.prepared)

    def test_adjacent_worker_compilation_config_is_bound_in_both_roots(self):
        for root in (self.baseline, self.candidate):
            with self.subTest(root=root.name):
                config = root / "services/auto-routing-benchmark/scripts/tsconfig.json"
                original = config.read_text()
                json_put(config, {"extends": "../tsconfig.json", "compilerOptions": {"target": "es2020"}})
                with self.assertRaisesRegex(ValueError, "source_files drift"):
                    self.proof.execution_identity(self.prepared)
                config.write_text(original)

    def test_preparation_detects_source_drift_during_compilation(self):
        put(self.candidate / "services/auto-routing/src/index.ts", "export default { changed: true };\n")
        with self.assertRaisesRegex(ValueError, "drift during bundle preparation"):
            self.proof.finalize(self.prepared, self.inputs)

    def test_credentials_and_unrelated_apps_are_not_opened_or_inventoried(self):
        for root in (self.host, self.baseline, self.candidate):
            for relative in ("services/auto-routing/.env.local", "services/auto-routing/.dev.vars.production",
                             "services/auto-routing/auth.json", "node_modules/fixture-worker/.env",
                             "apps/mobile/unrelated.ts", "node_modules/unrelated/unused.js"):
                put(root / relative, "excluded-private-or-unrelated\n")
        self.assertEqual(self.identity, self.proof.execution_identity(self.prepared))
        with self.assertRaisesRegex(ValueError, "Credential/environment"):
            self.proof.file_sha256(self.host / "services/auto-routing/.env.local")

    def test_runtime_health_requires_both_roots_bundle_hashes_and_actual_versions(self):
        self.assertIsNone(self.proof.verify_runtime_health(self.health(), self.identity))
        for version in ("baseline", "candidate"):
            for key in ("workerRoot", "workerBundleSha256"):
                with self.subTest(version=version, key=key):
                    health = self.health()
                    health["versions"][version][key] = "wrong"
                    with self.assertRaises(ValueError):
                        self.proof.verify_runtime_health(health, self.identity)
        for mutation in (lambda health: health.pop("runtime"),
                         lambda health: health["versions"].pop("baseline"),
                         lambda health: health["executionIdentity"].update(identity_sha256="0" * 64),
                         lambda health: health.update(status="failed")):
            health = self.health()
            mutation(health)
            with self.assertRaises(ValueError):
                self.proof.verify_runtime_health(health, self.identity)



if __name__ == "__main__":
    unittest.main()
