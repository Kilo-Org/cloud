import argparse
import hashlib
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from string import Template


SCHEMA_VERSION = 1
SCRIPT = "services/auto-routing-benchmark/scripts/router-runtime.ts"
WRAPPER = "services/auto-routing-benchmark/scripts/router-isolated-worker.ts"
REQUIRED_SOURCE = ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", SCRIPT,
                   "services/auto-routing-benchmark/package.json",
                   "services/auto-routing-benchmark/tsconfig.json",
                   "services/auto-routing-benchmark/scripts/tsconfig.json",
                   WRAPPER, "services/auto-routing/src/index.ts",
                   "services/auto-routing/wrangler.jsonc")
HOST_PACKAGES = ("miniflare", "tsx", "zod", "jsonc-parser", "@kilocode/auto-routing-contracts")
SKIP_DIRECTORIES = {"node_modules", ".git", ".wrangler", "__pycache__", ".aws", ".ssh", ".config"}
PRIVATE_FILES = {".npmrc", ".netrc", ".pypirc", ".git-credentials", "auth.json", "credentials.json",
                 "application_default_credentials.json", "id_rsa", "id_ed25519"}


def excluded(path):
    return any(part in PRIVATE_FILES or part in {".aws", ".ssh", ".config"} or
               part.startswith((".env", ".dev.vars")) for part in Path(path).parts)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def file_sha256(path):
    if excluded(path):
        raise ValueError(f"Credential/environment inputs are forbidden: {path}")
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _load(path):
    if excluded(path):
        raise ValueError("Credential/environment JSON inputs are forbidden")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Duplicate JSON key: {key}")
            result[key] = value
        return result
    return json.loads(Path(path).read_text(), object_pairs_hook=unique)


def _resolved(raw):
    path = Path(raw)
    if not path.is_absolute() or str(path.resolve(strict=True)) != str(path):
        raise ValueError(f"Expected canonical absolute path: {raw}")
    return path


def _record(path):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        target = path.resolve(strict=True)
        return {"kind": "link", "target": str(target),
                "sha256": file_sha256(target) if target.is_file() else None}
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"Not a regular input file: {path}")
    return {"kind": "file", "sha256": file_sha256(path),
            "executable": bool(info.st_mode & 0o111)}


def _package_tree(root):
    files = {}
    for base, directories, filenames in os.walk(root, followlinks=False):
        base = Path(base)
        directories[:] = sorted(name for name in directories if name not in SKIP_DIRECTORIES and not excluded(name))
        for name in sorted(directories + filenames):
            item = base / name
            if excluded(item.relative_to(root)):
                continue
            if item.is_symlink():
                if item.resolve(strict=True).is_dir():
                    raise ValueError(f"Unexpected package directory symlink: {item}")
                files[str(item.relative_to(root))] = _record(item)
            elif item.is_file():
                files[str(item.relative_to(root))] = _record(item)
            elif not item.is_dir():
                raise ValueError(f"Unsupported executable input: {item}")
    return dict(sorted(files.items()))


def _resolve_package(name, directory, optional=False):
    if name.startswith((".", "/")) or ".." in Path(name).parts:
        raise ValueError("Invalid dependency package name")
    directory = Path(directory).resolve(strict=True)
    while True:
        package = directory / "node_modules" / name / "package.json"
        if package.is_file():
            return package.parent.resolve(strict=True)
        if directory.parent == directory:
            if optional:
                return None
            raise ValueError(f"Missing installed dependency {name}")
        directory = directory.parent


def _selected_tree(package, selection):
    if str(package) not in selection:
        raise ValueError("Resolved dependency package root drift")
    files = {}
    for name in selection[str(package)]:
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts or "node_modules" in relative.parts or excluded(relative):
            raise ValueError("Invalid selected dependency input")
        files[name] = _record(package / relative)
    return dict(sorted(files.items()))


def _dependencies(root, host=False, selected=None):
    root = _resolved(root)
    start = root / "services/auto-routing-benchmark/scripts"
    if host:
        pending = [_resolve_package(name, start) for name in HOST_PACKAGES]
    else:
        pending = [root / "services/auto-routing", _resolve_package("wrangler", start)]
    packages = {}
    resolution = {}
    while pending:
        package = pending.pop()
        key = str(package)
        if key in packages:
            continue
        metadata = _load(package / "package.json")
        packages[key] = _package_tree(package) if selected is None else _selected_tree(package, selected)
        resolved = {}
        dependencies = {**metadata.get("dependencies", {}), **metadata.get("optionalDependencies", {})}
        for name in sorted(dependencies):
            target = _resolve_package(name, package, optional=name in metadata.get("optionalDependencies", {}))
            resolved[name] = str(target) if target else None
            if target:
                pending.append(target)
        resolution[key] = resolved
    return {"packages": dict(sorted(packages.items())), "resolution": dict(sorted(resolution.items()))}


def _source(root, dependencies, host=False, selected=None):
    root = _resolved(root)
    top = subprocess.check_output(["git", "-C", str(root), "rev-parse", "--show-toplevel"], text=True).strip()
    if Path(top).resolve() != root:
        raise ValueError(f"Source root is not a repository root: {root}")
    if selected is not None:
        if not set(REQUIRED_SOURCE).issubset(selected):
            raise ValueError("Required source/config identity is missing")
        files = {}
        for name in selected:
            relative = Path(name)
            if relative.is_absolute() or ".." in relative.parts or excluded(relative):
                raise ValueError("Invalid selected source input")
            files[name] = _record(root / relative)
        return dict(sorted(files.items()))
    files = {}
    for name in REQUIRED_SOURCE:
        files[name] = _record(root / name)
    helper = root / SCRIPT.replace("runtime.ts", "proof.py")
    if helper.is_file():
        files[str(helper.relative_to(root))] = _record(helper)
    directories = list(map(Path, dependencies["packages"]))
    if not host:
        directories.append(root / "services/auto-routing")
    for directory in directories:
        if directory.is_relative_to(root) and "node_modules" not in directory.relative_to(root).parts:
            for name, record in _package_tree(directory).items():
                files[str((directory / name).relative_to(root))] = record
    return dict(sorted(files.items()))


def _version_inputs(root, host=False, selected=None, selected_source=None):
    dependencies = _dependencies(root, host, selected)
    return {"workerRoot": str(_resolved(root)), "source_files": _source(root, dependencies, host, selected_source),
            "dependency_roots": sorted(dependencies["packages"]), "dependencies": dependencies}


def _binary(path):
    path = _resolved(path)
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError(f"Runtime executable unavailable: {path}")
    return {"path": str(path), "sha256": file_sha256(path)}


def capture(descriptor):
    roots = descriptor["roots"]
    if set(roots) != {"baseline", "candidate", "host"}:
        raise ValueError("Both Worker roots and the host root are required")
    versions = {}
    checked = {}
    for version, root in roots.items():
        key = (root, version == "host")
        if key not in checked:
            checked[key] = _version_inputs(root, version == "host")
        versions[version] = checked[key]
    node = _binary(descriptor["node"])
    node["version"] = subprocess.check_output([node["path"], "--version"], text=True, env={"PATH": os.defpath}).strip()
    python = _binary(str(Path(sys.executable).resolve(strict=True)))
    python["version"] = platform.python_version()
    runtime = {"node": node, "python": python, "observed": descriptor["observed"],
               "node_builtin_modules": descriptor["node_builtin_modules"],
               "tsx_esm_api": str(_resolved(descriptor["tsx_esm_api"])),
               "tsx_options": {"tsconfig": False, "cache": False},
               "runtime_script": str(_resolved(descriptor["runtime_script"])),
               "proof_script": str(Path(__file__).resolve(strict=True)),
               "compatibility_date": descriptor["compatibility_date"],
               "compatibility_flags": descriptor["compatibility_flags"]}
    if runtime["runtime_script"] != str(Path(roots["host"]) / SCRIPT):
        raise ValueError("Serving script must be the inventoried host runtime")
    if runtime["proof_script"] != str(Path(roots["host"]) / SCRIPT.replace("runtime.ts", "proof.py")):
        raise ValueError("Proof helper must be the inventoried host helper")
    for key in ("tsx_esm_api", "runtime_script", "proof_script"):
        runtime[key + "_sha256"] = file_sha256(runtime[key])
    return {"descriptor": descriptor, "versions": versions, "runtime": runtime}


def _bundle(directory):
    directory = _resolved(str(directory))
    files = {}
    for base, directories, filenames in os.walk(directory, followlinks=False):
        base = Path(base)
        for name in directories + filenames:
            item = base / name
            if item.is_symlink():
                raise ValueError("Prepared bundles cannot contain symlinks")
            if item.is_file():
                files[str(item.relative_to(directory))] = {"sha256": file_sha256(item)}
            elif not item.is_dir():
                raise ValueError("Prepared bundle contains a non-regular file")
    if "router-isolated-worker.js" not in files:
        raise ValueError("Compiled Worker entry is missing")
    return dict(sorted(files.items()))


def _compiler_inputs(prepared, name, source, runtime):
    known = {}
    root = Path(source["workerRoot"])
    for relative, record in source["source_files"].items():
        known[str((root / relative).resolve(strict=True))] = record.get("sha256")
    for package, files in source["dependencies"]["packages"].items():
        for relative, record in files.items():
            known[str((Path(package) / relative).resolve(strict=True))] = record.get("sha256")
    directory = prepared / name
    metadata = _load(directory / "bundle-meta.json")
    if not isinstance(metadata.get("inputs"), dict) or not metadata["inputs"]:
        raise ValueError("Compiler input evidence is missing")
    observed = {}
    for raw in metadata["inputs"]:
        if excluded(raw):
            raise ValueError("Compiler attempted a credential/environment input")
        if raw.startswith("node-built-in-modules:"):
            builtin = raw.removeprefix("node-built-in-modules:")
            if builtin not in runtime["node_builtin_modules"]:
                raise ValueError(f"Unrecognized Node builtin compiler input: {builtin}")
            observed[raw] = {"node_builtin": builtin}
            continue
        if raw.startswith(("node:", "cloudflare:", "nodejs-compat:", "unenv:", "virtual:", "wrangler:", "<")):
            observed[raw] = {"virtual": True}
            continue
        filename = (directory / raw).resolve()
        if str(filename) in known:
            observed[raw] = {"path": str(filename), "sha256": known[str(filename)]}
        elif filename.is_relative_to(directory) and ".wrangler" in filename.parts:
            observed[raw] = {"generated_by_inventoried_wrangler": True}
        else:
            raise ValueError(f"Compiler input is outside inventoried source/dependencies: {filename}")
    return observed


def _compiled_dependencies(source, compiler_inputs):
    inputs = {row["path"] for row in compiler_inputs.values() if "path" in row}
    packages = {}
    for package, files in source["dependencies"]["packages"].items():
        packages[package] = {
            name: record for name, record in files.items()
            if name == "package.json" or str((Path(package) / name).resolve(strict=True)) in inputs
        }
    return {"packages": packages, "resolution": source["dependencies"]["resolution"]}


def _compiled_source(source, compiler_inputs):
    inputs = {row["path"] for row in compiler_inputs.values() if "path" in row}
    root = Path(source["workerRoot"])
    required = set(REQUIRED_SOURCE) | {"services/auto-routing/tsconfig.json", "services/auto-routing/package.json"}
    return {name: record for name, record in source["source_files"].items()
            if name in required or str((root / name).resolve(strict=True)) in inputs}

def bootstrap_source(runtime):
    return Template("""import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

if (process.execArgv.length !== 0) throw new Error('Node execution overrides are forbidden');
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MINIFLARE_') || key.startsWith('WORKERD_') ||
      key.startsWith('TSX_') || key.startsWith('ESBUILD_') ||
      key.startsWith('LD_') || key.startsWith('DYLD_') ||
      ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS'].includes(key)) {
    throw new Error(key + ' overrides are forbidden in prepared execution');
  }
}
const { values } = parseArgs({ options: {
  'prepared-execution': { type: 'string' }, snapshot: { type: 'string' },
  'broker-url': { type: 'string' }, port: { type: 'string' },
}, strict: true });
if (!values['prepared-execution']) throw new Error('Missing prepared execution');
const env = {};
for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
for (const key of Object.keys(process.env)) {
  if (!Object.hasOwn(env, key)) delete process.env[key];
}
const identity = JSON.parse(execFileSync($python, ['-I', $proof, 'identity', values['prepared-execution']], {
  env, encoding: 'utf8', maxBuffer: 256 * 1000 * 1000,
}));
const self = fileURLToPath(import.meta.url);
if (realpathSync(process.execPath) !== identity.runtime.node.path ||
    self !== identity.runtime.bootstrap ||
    createHash('sha256').update(readFileSync(self)).digest('hex') !== identity.runtime.bootstrap_sha256 ||
    identity.runtime.tsx_esm_api !== $api || identity.runtime.runtime_script !== $runtime) {
  throw new Error('Prepared loader bootstrap identity mismatch');
}
process.env.TSX_DISABLE_CACHE = '1';
const { register } = await import(pathToFileURL($api).href);
register({ tsconfig: false });
const { run } = await import(pathToFileURL($runtime).href);
await run(identity);
""").substitute(python=json.dumps(runtime["python"]["path"]),
                proof=json.dumps(runtime["proof_script"]),
                api=json.dumps(runtime["tsx_esm_api"]),
                runtime=json.dumps(runtime["runtime_script"]))


def _tsx_api(package):
    metadata = _load(Path(package) / "package.json")
    relative = metadata["exports"]["./esm/api"]["import"]["default"]
    if not isinstance(relative, str) or not relative.startswith("./") or ".." in Path(relative).parts:
        raise ValueError("Unapproved tsx ESM registration API export")
    return (Path(package) / relative).resolve(strict=True)


def prepare_execution(directory, baseline_root, candidate_root):
    host = Path(__file__).resolve(strict=True).parents[3]
    node = shutil.which("node")
    if node is None:
        raise ValueError("Node is not installed")
    node = str(Path(node).resolve(strict=True))
    api = _tsx_api(_resolve_package("tsx", Path(__file__).parent))
    script = host / SCRIPT
    program = ("process.env.TSX_DISABLE_CACHE='1';"
               f"const {{register}}=await import({json.dumps(api.as_uri())});"
               "register({tsconfig:false});"
               f"const {{run}}=await import({json.dumps(script.as_uri())}); await run();")
    argv = [node, "--input-type=module", "--eval", program, "router-proof-prepare",
            "--prepare-only", str(Path(directory).resolve()),
            "--baseline-root", str(Path(baseline_root or host).resolve(strict=True)),
            "--candidate-root", str(Path(candidate_root or host).resolve(strict=True)),
            "--python", str(Path(sys.executable).resolve(strict=True))]
    environment = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL")
                   if key in os.environ}
    os.execve(node, argv, environment)



def approved_serving_argv(runtime):
    return [runtime["node"]["path"], runtime["bootstrap"],
            "--prepared-execution", "{prepared_execution}",
            "--snapshot", "{snapshot}", "--broker-url", "{broker_url}", "--port", "{port}"]


def finalize(prepared, inputs):
    prepared = _resolved(str(prepared))
    before = _load(inputs)
    after = capture(before["descriptor"])
    if before != after:
        raise ValueError("Source, dependency, or runtime drift during bundle preparation")
    versions = {}
    for version in ("baseline", "candidate"):
        source = before["versions"][version]
        bundle_dir = prepared / version / "bundle"
        compiler_inputs = _compiler_inputs(prepared, version, source, before["runtime"])
        versions[version] = {**source, "bundle_directory": f"{version}/bundle",
                             "bundle_entry": "router-isolated-worker.js",
                             "bundle_files": _bundle(bundle_dir),
                             "compiler_inputs": compiler_inputs,
                             "dependencies": _compiled_dependencies(source, compiler_inputs),
                             "source_files": _compiled_source(source, compiler_inputs),
                             "build_files": {name: _record(prepared / version / name)
                                             for name in ("wrangler.jsonc", "bundle-meta.json")}}
    runtime = {**before["runtime"], "bootstrap": str(prepared / "bootstrap.mjs")}
    with (prepared / "bootstrap.mjs").open("x") as stream:
        stream.write(bootstrap_source(runtime))
    runtime["bootstrap_sha256"] = file_sha256(prepared / "bootstrap.mjs")
    manifest = {"schema_version": SCHEMA_VERSION, "versions": versions,
                "host": before["versions"]["host"], "runtime": runtime,
                "serving_argv": approved_serving_argv(runtime)}
    manifest["identity_sha256"] = digest(manifest)
    target = prepared / "execution.json"
    with target.open("x") as stream:
        json.dump(manifest, stream, indent=2, sort_keys=True)
        stream.write("\n")
    return execution_identity(target)



def _runtime_inputs(runtime, host):
    observed = runtime["observed"]
    if observed["node"] != runtime["node"]["version"] or observed["versions"]["node"] != observed["node"].removeprefix("v"):
        raise ValueError("Unbound observed Node version")
    builtins = json.loads(subprocess.check_output([
        runtime["node"]["path"], "--input-type=module", "-e",
        "import { builtinModules } from 'node:module'; console.log(JSON.stringify(builtinModules))"
    ], text=True, env={"PATH": os.defpath}))
    if builtins != runtime["node_builtin_modules"]:
        raise ValueError("Node builtin module identity drift")
    workerd = observed["workerd"]
    if _binary(workerd["path"]) != {key: workerd[key] for key in ("path", "sha256")}:
        raise ValueError("workerd binary drift")
    version = subprocess.check_output([workerd["path"], "--version"], text=True, env={"PATH": os.defpath}).strip()
    if not version or version != workerd["version"]:
        raise ValueError("workerd version drift")
    packages = host["dependencies"]["packages"]
    covered = {str((Path(root) / name).resolve(strict=True))
               for root, files in packages.items() for name in files}
    for filename in (workerd["path"], runtime["tsx_esm_api"]):
        if filename not in covered:
            raise ValueError("Runtime loader/binary is outside dependency inventory")
    if runtime["tsx_options"] != {"tsconfig": False, "cache": False}:
        raise ValueError("Automatic tsconfig discovery and TSX caches are forbidden")
    if str(_tsx_api(observed["packages"]["tsx"]["root"])) != runtime["tsx_esm_api"]:
        raise ValueError("Unbound tsx ESM registration API")
    names = {"miniflare": "miniflare", "workerd": "workerd", "tsx": "tsx",
             "zod": "zod", "contracts": "@kilocode/auto-routing-contracts"}
    if set(observed["packages"]) != set(names):
        raise ValueError("Required runtime package identities are missing")
    for key, name in names.items():
        package = observed["packages"][key]
        if package["root"] not in packages:
            raise ValueError("Observed package is outside dependency inventory")
        metadata = _load(Path(package["root"]) / "package.json")
        if metadata["name"] != name or metadata["version"] != package["version"]:
            raise ValueError("Observed runtime package version drift")

def execution_identity(path):
    manifest_path = Path(path).resolve(strict=True)
    if manifest_path.is_dir():
        manifest_path /= "execution.json"
    if manifest_path.name != "execution.json":
        raise ValueError("Prepared execution manifest must be named execution.json")
    manifest = _load(manifest_path)
    if not isinstance(manifest, dict) or type(manifest.get("schema_version")) is not int or manifest["schema_version"] != SCHEMA_VERSION:
        raise ValueError("Unsupported prepared execution manifest")
    if set(manifest) != {"schema_version", "versions", "host", "runtime", "serving_argv", "identity_sha256"}:
        raise ValueError("Prepared execution manifest fields are invalid")
    unsigned = {key: value for key, value in manifest.items() if key != "identity_sha256"}
    if digest(unsigned) != manifest["identity_sha256"]:
        raise ValueError("Prepared manifest identity digest mismatch")
    if set(manifest["versions"]) != {"baseline", "candidate"}:
        raise ValueError("Both prepared Worker versions are required")
    runtime = manifest["runtime"]
    if manifest["serving_argv"] != approved_serving_argv(runtime):
        raise ValueError("Unapproved runtime serving argv")
    for name in ("node", "python"):
        binary = runtime[name]
        if _binary(binary["path"]) != {key: binary[key] for key in ("path", "sha256")}:
            raise ValueError(f"{name} executable drift")
    node_version = subprocess.check_output([runtime["node"]["path"], "--version"], text=True, env={"PATH": os.defpath}).strip()
    if node_version != runtime["node"]["version"]:
        raise ValueError("Node version drift")
    python_version = subprocess.check_output([
        runtime["python"]["path"], "-I", "-c", "import platform; print(platform.python_version())"
    ], text=True, env={"PATH": os.defpath}).strip()
    if python_version != runtime["python"]["version"]:
        raise ValueError("Python runtime drift")
    for key in ("tsx_esm_api", "runtime_script", "proof_script"):
        if file_sha256(_resolved(runtime[key])) != runtime[key + "_sha256"]:
            raise ValueError(f"{key} drift")
    bootstrap = manifest_path.parent / "bootstrap.mjs"
    if runtime["bootstrap"] != str(bootstrap) or file_sha256(bootstrap) != runtime["bootstrap_sha256"]:
        raise ValueError("Prepared loader bootstrap drift")
    if bootstrap.read_text() != bootstrap_source(runtime):
        raise ValueError("Unapproved prepared loader bootstrap")
    host = manifest["host"]
    if runtime["runtime_script"] != str(Path(host["workerRoot"]) / SCRIPT):
        raise ValueError("Unbound serving runtime source")
    if runtime["proof_script"] != str(Path(host["workerRoot"]) / SCRIPT.replace("runtime.ts", "proof.py")):
        raise ValueError("Unbound proof helper source")
    _runtime_inputs(runtime, host)
    identity = {"schema_version": SCHEMA_VERSION, "identity_sha256": manifest["identity_sha256"],
                "runtime": runtime, "serving_argv": manifest["serving_argv"]}
    checked = {}
    for name, version in [("host", host), *manifest["versions"].items()]:
        root = _resolved(version["workerRoot"])
        selected = None if name == "host" else version["dependencies"]["packages"]
        selected_source = None if name == "host" else version["source_files"]
        cache_key = (str(root), name == "host", digest(selected), digest(selected_source))
        if cache_key not in checked:
            checked[cache_key] = _version_inputs(str(root), name == "host", selected, selected_source)
        current = checked[cache_key]
        for key in ("source_files", "dependency_roots", "dependencies"):
            if current[key] != version[key]:
                raise ValueError(f"{name} {key} drift")
        summary = {"workerRoot": str(root), "sourceSha256": digest(version["source_files"]),
                   "dependencyRoots": version["dependency_roots"],
                   "dependencySha256": digest(version["dependencies"])}
        if name != "host":
            if version["bundle_directory"] != f"{name}/bundle" or version["bundle_entry"] != "router-isolated-worker.js":
                raise ValueError("Unexpected prepared bundle layout")
            directory = manifest_path.parent / version["bundle_directory"]
            if directory.resolve(strict=True) != directory:
                raise ValueError("Prepared bundle escaped its immutable directory")
            observed = _bundle(directory)
            if observed != version["bundle_files"]:
                raise ValueError(f"{name} compiled Worker bundle drift")
            for filename in ("wrangler.jsonc", "bundle-meta.json"):
                if _record(manifest_path.parent / name / filename) != version["build_files"][filename]:
                    raise ValueError(f"{name} build evidence drift")
            if _compiler_inputs(manifest_path.parent, name, version, runtime) != version["compiler_inputs"]:
                raise ValueError(f"{name} compiler input provenance drift")
            executable_files = {key: value for key, value in observed.items() if not key.endswith(".map")}
            summary.update(workerBundleSha256=observed[version["bundle_entry"]]["sha256"],
                           bundleFilesSha256=digest(observed),
                           executableSha256=digest({"bundle_files": executable_files,
                                                    "compatibility_date": runtime["compatibility_date"],
                                                    "compatibility_flags": runtime["compatibility_flags"]}),
                           bundleEntry=f"{name}/bundle/{version['bundle_entry']}")
        identity[name] = summary
    return identity


def verify_runtime_health(health, expected_identity):
    if not isinstance(health, dict) or health.get("status") != "ok":
        raise ValueError("Runtime health is not ok")
    if health.get("executionIdentity") != expected_identity:
        raise ValueError("Runtime prepared execution identity mismatch")
    if health.get("runtime") != expected_identity["runtime"]["observed"]:
        raise ValueError("Runtime versions mismatch")
    versions = health.get("versions")
    if not isinstance(versions, dict) or set(versions) != {"baseline", "candidate"}:
        raise ValueError("Runtime must report both Worker versions")
    for name in ("baseline", "candidate"):
        row = versions[name]
        if not isinstance(row, dict):
            raise ValueError(f"Invalid {name} runtime health")
        for key in ("workerRoot", "workerBundleSha256"):
            if row.get(key) != expected_identity[name][key]:
                raise ValueError(f"Runtime {name} {key} mismatch")
    return None


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("prepare")
    command.add_argument("--prepare-only", required=True)
    command.add_argument("--baseline-root")
    command.add_argument("--candidate-root")
    command = commands.add_parser("capture")
    command.add_argument("--descriptor", required=True)
    command.add_argument("--output", required=True)
    command = commands.add_parser("finalize")
    command.add_argument("--prepared", required=True)
    command.add_argument("--inputs", required=True)
    command = commands.add_parser("identity")
    command.add_argument("path")
    args = parser.parse_args()
    if args.command == "prepare":
        prepare_execution(args.prepare_only, args.baseline_root, args.candidate_root)
    elif args.command == "capture":
        result = capture(_load(args.descriptor))
        with Path(args.output).open("x") as stream:
            json.dump(result, stream, sort_keys=True)
    elif args.command == "finalize":
        print(json.dumps(finalize(args.prepared, args.inputs), sort_keys=True))
    else:
        print(json.dumps(execution_identity(args.path), sort_keys=True))


if __name__ == "__main__":
    main()
