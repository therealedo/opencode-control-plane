import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  ensureDependencyState,
  isPnpmManagedProject,
  probeDependencyManager,
} from "../.agents/skills/init-project/assets/project/.autopilot/bin/lib/dependency-manager.mjs";

const executeFile = promisify(execFile);
const runner = path.resolve(
  ".agents/skills/init-project/assets/project/.autopilot/bin/run-action.mjs",
);
const PINNED_VERSION = "11.14.0";
const VALID_INTEGRITY = "sha512-" + Buffer.alloc(64).toString("base64");

const successfulProcess = (overrides = {}) => ({
  code: 0,
  signal: null,
  timed_out: false,
  stdout: "",
  stderr: "",
  output_truncated: false,
  ...overrides,
});

function completeLockfile({ specifier = "1.3.0", version = "1.3.0" } = {}) {
  return [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "",
    "importers:",
    "  .:",
    "    dependencies:",
    "      left-pad:",
    "        specifier: " + specifier,
    "        version: " + version,
    "",
    "packages:",
    "  left-pad@" + version + ":",
    "    resolution: {integrity: " + VALID_INTEGRITY + "}",
    "",
    "snapshots:",
    "  left-pad@" + version + ": {}",
    "",
  ].join("\n");
}

function completeWorkspaceLockfile({ importer = "apps/web" } = {}) {
  return [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "  .: {}",
    "  " + importer + ":",
    "    dependencies:",
    "      left-pad:",
    "        specifier: 1.3.0",
    "        version: 1.3.0",
    "",
    "packages:",
    "  left-pad@1.3.0:",
    "    resolution: {integrity: " + VALID_INTEGRITY + "}",
    "",
    "snapshots:",
    "  left-pad@1.3.0: {}",
    "",
  ].join("\n");
}

function emptyWorkspaceLockfile(importers) {
  return [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    ...importers.map((importer) => "  " + importer + ": {}"),
    "",
  ].join("\n");
}

function isPinnedManagerCheck(argv) {
  return argv.length === 3 &&
    argv[0] === "corepack" &&
    argv[1] === "pnpm" &&
    argv[2] === "--version";
}

function pinnedManagerProcess() {
  return successfulProcess({ stdout: PINNED_VERSION + "\n" });
}

function pnpmFailure(code, message = "offline fixture failure") {
  return successfulProcess({
    code: 1,
    stderr: JSON.stringify({
      name: "pnpm:install",
      err: { code, message },
    }) + "\n",
  });
}

async function makeProject(t, manifest = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocp-dependency-action-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".autopilot"), { recursive: true });
  await writeFile(path.join(root, ".autopilot", "config.json"), "{}\n", "utf8");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      private: true,
      packageManager: "pnpm@" + PINNED_VERSION,
      ...manifest,
    }, null, 2) + "\n",
    "utf8",
  );
  const temporaryRoot = path.join(root, "private-runtime");
  await mkdir(temporaryRoot);
  return { root, temporaryRoot };
}

async function writeWorkspace(root, importer, manifest) {
  await writeFile(
    path.join(root, "pnpm-workspace.yaml"),
    "packages:\n  - 'apps/*'\n",
    "utf8",
  );
  const directory = path.join(root, ...importer.split("/"));
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
}

async function materializeLeftPad(root, {
  importer = ".",
  lockfile = completeLockfile(),
} = {}) {
  const virtualPackage = path.join(
    root,
    "node_modules",
    ".pnpm",
    "left-pad@1.3.0",
    "node_modules",
    "left-pad",
  );
  const importerRoot = importer === "."
    ? root
    : path.join(root, ...importer.split("/"));
  await mkdir(virtualPackage, { recursive: true });
  await mkdir(path.join(importerRoot, "node_modules", "left-pad"), { recursive: true });
  await writeFile(
    path.join(root, "node_modules", ".pnpm", "lock.yaml"),
    lockfile,
    "utf8",
  );
  await writeFile(
    path.join(root, "node_modules", ".modules.yaml"),
    "layoutVersion: 5\nvirtualStoreDir: .pnpm\n",
    "utf8",
  );
  await writeFile(
    path.join(virtualPackage, "index.js"),
    "module.exports = value => value;\n",
    "utf8",
  );
  await writeFile(
    path.join(importerRoot, "node_modules", "left-pad", "package.json"),
    JSON.stringify({ name: "left-pad", version: "1.3.0" }) + "\n",
    "utf8",
  );
}

async function assertMissing(file) {
  await assert.rejects(lstat(file), (error) => error?.code === "ENOENT");
}

test("dependency CLI returns a bounded typed task failure for credential-bearing npm config", async (t) => {
  const { root } = await makeProject(t);
  await writeFile(
    path.join(root, ".npmrc"),
    "//registry.npmjs.org/:_authToken=$" + "{NPM_TOKEN}\n",
    "utf8",
  );

  await assert.rejects(
    executeFile(process.execPath, [runner, "dependency-lock", "--root", root]),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stderr, "");
      assert.ok(Buffer.byteLength(error.stdout, "utf8") < 16 * 1024);
      const envelope = JSON.parse(error.stdout);
      assert.deepEqual({
        schema_version: envelope.schema_version,
        operation: envelope.operation,
        classification: envelope.classification,
        error_code: envelope.error_code,
        action: envelope.action,
        package_manager: envelope.package_manager,
        success: envelope.success,
      }, {
        schema_version: 1,
        operation: "dependency-lock",
        classification: "task_failure",
        error_code: "DEPENDENCY_CONFIG_CREDENTIALS",
        action: "dependency-lock",
        package_manager: "pnpm@" + PINNED_VERSION,
        success: false,
      });
      assert.match(envelope.diagnostic.stderr, /credential-bearing project \.npmrc/);
      return true;
    },
  );
});

test("dependency CLI returns a typed usage envelope instead of an uncaught exception", async () => {
  await assert.rejects(
    executeFile(process.execPath, [runner, "dependency-lock"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stderr, "");
      const envelope = JSON.parse(error.stdout);
      assert.equal(envelope.schema_version, 1);
      assert.equal(envelope.operation, "dependency-lock");
      assert.equal(envelope.classification, "task_failure");
      assert.equal(envelope.error_code, "DEPENDENCY_USAGE_INVALID");
      return true;
    },
  );
});

test("dependency CLI converts implementation import failures into typed controller output", async (t) => {
  const { root } = await makeProject(t);
  const isolatedBin = path.join(root, "isolated-bin");
  await mkdir(isolatedBin);
  const isolatedRunner = path.join(isolatedBin, "run-action.mjs");
  await copyFile(runner, isolatedRunner);

  await assert.rejects(
    executeFile(process.execPath, [isolatedRunner, "dependency-lock", "--root", root]),
    (error) => {
      assert.equal(error.code, 2);
      assert.equal(error.stderr, "");
      const envelope = JSON.parse(error.stdout);
      assert.equal(envelope.operation, "dependency-lock");
      assert.equal(envelope.classification, "controller_failure");
      assert.equal(envelope.error_code, "DEPENDENCY_RUNNER_IMPORT_FAILED");
      return true;
    },
  );
});

test("dependency sync proves the pin, installs twice in isolation, skips, and repairs corruption", async (t) => {
  const { root, temporaryRoot } = await makeProject(t, {
    dependencies: { "left-pad": "1.3.0" },
  });
  const invocations = [];
  const privateDirectories = new Set();
  const corepackHomes = new Set();
  let resolvingPasses = 0;
  let frozenPasses = 0;
  const fakeExecute = async (argv, options) => {
    invocations.push({ argv, options });
    const privateDirectory = path.dirname(options.env.HOME);
    privateDirectories.add(privateDirectory);
    corepackHomes.add(options.env.COREPACK_HOME);
    assert.equal(options.env.NPM_TOKEN, undefined);
    assert.equal(options.env.npm_config_userconfig, undefined);
    assert.notEqual(options.env.HOME, "ambient-home");
    assert.equal(options.env.NPM_CONFIG_IGNORE_SCRIPTS, "true");
    assert.ok(options.env.NPM_CONFIG_USERCONFIG.startsWith(privateDirectory));
    assert.ok(options.env.NPM_CONFIG_GLOBALCONFIG.startsWith(privateDirectory));
    assert.ok(options.env.NPM_CONFIG_CACHE.startsWith(privateDirectory));
    assert.equal(
      options.env.COREPACK_HOME,
      path.join(root, ".autopilot", "runtime", "dependency", "corepack"),
    );
    assert.ok(options.env.PNPM_HOME.startsWith(privateDirectory));
    assert.ok(options.env.GIT_CONFIG_GLOBAL.startsWith(privateDirectory));
    assert.equal(options.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
    if (isPinnedManagerCheck(argv)) return pinnedManagerProcess();

    assert.deepEqual(argv.slice(0, 3), ["corepack", "pnpm", "install"]);
    assert.ok(argv.includes("--ignore-scripts"));
    assert.ok(argv.includes("--ignore-pnpmfile"));
    assert.ok(argv.includes("--reporter=ndjson"));
    assert.ok(!argv.includes("--lockfile-only"));
    const storeIndex = argv.indexOf("--store-dir");
    assert.ok(storeIndex > 0);
    assert.ok(argv[storeIndex + 1].startsWith(privateDirectory));
    if (argv.includes("--frozen-lockfile=false")) {
      resolvingPasses += 1;
      assert.ok(!argv.includes("--frozen-lockfile"));
      assert.notEqual(options.cwd, root);
      await writeFile(path.join(options.cwd, "pnpm-lock.yaml"), completeLockfile(), "utf8");
      await materializeLeftPad(options.cwd);
    } else {
      frozenPasses += 1;
      assert.equal(options.cwd, root);
      assert.ok(argv.includes("--frozen-lockfile"));
      assert.ok(argv.includes("--offline"));
      assert.ok(argv.includes("--force"));
      await materializeLeftPad(root);
    }
    return successfulProcess();
  };

  const first = await ensureDependencyState(root, {
    mode: "if-needed",
    execute: fakeExecute,
    environment: {
      PATH: process.env.PATH ?? "",
      HOME: "ambient-home",
      USERPROFILE: "ambient-profile",
      NPM_TOKEN: "must-not-cross-boundary",
      npm_config_userconfig: "ambient-user-config",
    },
    temporaryRoot,
  });
  assert.equal(first.classification, "success", JSON.stringify(first));
  assert.equal(first.operation, "dependency-lock");
  assert.equal(first.package_manager, "pnpm@" + PINNED_VERSION);
  assert.equal(first.changed, true);
  assert.equal(first.skipped, false);
  assert.match(first.lockfile_sha256, /^[a-f0-9]{64}$/);
  assert.equal(invocations.length, 3);
  assert.equal(resolvingPasses, 1);
  assert.equal(frozenPasses, 1);
  assert.equal(corepackHomes.size, 1);
  for (const directory of privateDirectories) await assertMissing(directory);
  assert.equal((await lstat([...corepackHomes][0])).isDirectory(), true);

  const second = await ensureDependencyState(root, {
    mode: "if-needed",
    execute: async () => {
      throw new Error("a matching installation must not launch pnpm");
    },
    temporaryRoot,
  });
  assert.equal(second.classification, "success");
  assert.equal(second.changed, false);
  assert.equal(second.skipped, true);
  assert.equal(second.lockfile_sha256, first.lockfile_sha256);

  const installedRuntime = path.join(
    root,
    "node_modules",
    ".pnpm",
    "left-pad@1.3.0",
    "node_modules",
    "left-pad",
    "index.js",
  );
  const originalRuntime = await readFile(installedRuntime);
  const sameSizeCorruption = Buffer.from(originalRuntime);
  sameSizeCorruption[0] ^= 0xff;
  await writeFile(installedRuntime, sameSizeCorruption);
  const repaired = await ensureDependencyState(root, {
    mode: "if-needed",
    execute: fakeExecute,
    temporaryRoot,
  });
  assert.equal(repaired.classification, "success", JSON.stringify(repaired));
  assert.equal(repaired.changed, true);
  assert.equal(repaired.skipped, false);
  assert.equal(invocations.length, 6);
  assert.equal(resolvingPasses, 2);
  assert.equal(frozenPasses, 2);
});

test("dependency sync restores the exact prior lockfile after a structured task failure", async (t) => {
  const { root, temporaryRoot } = await makeProject(t, {
    dependencies: { "left-pad": "1.3.0" },
  });
  const prior = Buffer.from("prior lockfile bytes\r\n", "utf8");
  await writeFile(path.join(root, "pnpm-lock.yaml"), prior);
  let calls = 0;
  let privateDirectory = null;
  const result = await ensureDependencyState(root, {
    mode: "force",
    temporaryRoot,
    execute: async (argv, options) => {
      calls += 1;
      privateDirectory = path.dirname(options.env.HOME);
      if (isPinnedManagerCheck(argv)) return pinnedManagerProcess();
      assert.notEqual(options.cwd, root);
      await writeFile(path.join(options.cwd, "pnpm-lock.yaml"), "partially replaced\n", "utf8");
      return pnpmFailure("ERR_PNPM_NO_MATCHING_VERSION", "fixture has no matching version");
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.classification, "task_failure");
  assert.equal(result.error_code, "DEPENDENCY_RESOLUTION_FAILED");
  assert.equal(result.code, 1);
  assert.match(result.diagnostic.stderr, /ERR_PNPM_NO_MATCHING_VERSION/);
  assert.deepEqual(await readFile(path.join(root, "pnpm-lock.yaml")), prior);
  await assertMissing(privateDirectory);
});

test("dependency sync classifies structured registry failures as controller infrastructure failures", async (t) => {
  const { root, temporaryRoot } = await makeProject(t, {
    dependencies: { "left-pad": "1.3.0" },
  });
  let calls = 0;
  const result = await ensureDependencyState(root, {
    mode: "force",
    temporaryRoot,
    execute: async (argv, options) => {
      calls += 1;
      if (isPinnedManagerCheck(argv)) return pinnedManagerProcess();
      assert.notEqual(options.cwd, root);
      await writeFile(path.join(options.cwd, "pnpm-lock.yaml"), "partial\n", "utf8");
      return pnpmFailure("ERR_PNPM_META_FETCH_FAIL", "registry is unavailable");
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.classification, "controller_failure");
  assert.equal(result.error_code, "DEPENDENCY_NETWORK_UNAVAILABLE");
  assert.equal(result.code, 1);
  await assertMissing(path.join(root, "pnpm-lock.yaml"));
});

test("dependency sync classifies deterministic registry 404 as a task failure", async (t) => {
  const { root, temporaryRoot } = await makeProject(t, {
    dependencies: { missing: "1.0.0" },
  });
  let calls = 0;
  const result = await ensureDependencyState(root, {
    mode: "force",
    temporaryRoot,
    execute: async (argv) => {
      calls += 1;
      if (isPinnedManagerCheck(argv)) return pinnedManagerProcess();
      return pnpmFailure("ERR_PNPM_FETCH_404", "package does not exist");
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.classification, "task_failure");
  assert.equal(result.error_code, "DEPENDENCY_RESOLUTION_FAILED");
});

test("dependency sync and hydration classify an unsupported Node engine as an environment failure", async (t) => {
  for (const mode of ["force", "hydrate"]) {
    const { root, temporaryRoot } = await makeProject(t, {
      dependencies: { "left-pad": "1.3.0" },
      engines: { node: ">=24.18.0" },
    });
    const lockBefore = Buffer.from(completeLockfile(), "utf8");
    if (mode === "hydrate") await writeFile(path.join(root, "pnpm-lock.yaml"), lockBefore);
    let calls = 0;
    const result = await ensureDependencyState(root, {
      mode,
      temporaryRoot,
      execute: async (argv) => {
        calls += 1;
        if (isPinnedManagerCheck(argv)) return pinnedManagerProcess();
        return pnpmFailure(
          "ERR_PNPM_UNSUPPORTED_ENGINE",
          "Unsupported environment; token=must-not-escape",
        );
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.classification, "environment_failure");
    assert.equal(result.error_code, "DEPENDENCY_NODE_ENGINE_UNSUPPORTED");
    assert.equal(result.code, 1);
    assert.equal(result.success, false);
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 16 * 1024);
    assert.doesNotMatch(result.diagnostic.stderr, /must-not-escape/);
    if (mode === "hydrate") {
      assert.deepEqual(await readFile(path.join(root, "pnpm-lock.yaml")), lockBefore);
    } else {
      await assertMissing(path.join(root, "pnpm-lock.yaml"));
    }
  }
});

test("existing lockfile credentials and Git resolutions are rejected before pnpm executes", async (t) => {
  const cases = [
    {
      resolution: "    resolution: {integrity: " + VALID_INTEGRITY + ", tarball: 'https://registry.example/pkg.tgz?X-Amz-Credential=secret'}",
      errorCode: "DEPENDENCY_CONFIG_CREDENTIALS",
    },
    {
      resolution: "    resolution: {integrity: " + VALID_INTEGRITY + ", tarball: 'https://storage.example/pkg.tgz?api_key=secret&X-Goog-Signature=signed'}",
      errorCode: "DEPENDENCY_CONFIG_CREDENTIALS",
    },
    {
      resolution: "    resolution: {integrity: " + VALID_INTEGRITY + ", tarball: 'https://registry.example/$" + "{REGISTRY_TOKEN}/pkg.tgz'}",
      errorCode: "DEPENDENCY_CONFIG_CREDENTIALS",
    },
    {
      resolution: "    resolution: {commit: deadbeef, repo: 'git+ssh://git@example.test/private.git'}",
      errorCode: "DEPENDENCY_GIT_SOURCE_FORBIDDEN",
    },
    {
      resolution: "    resolution: {commit: deadbeef, repo: 'gist:0123456789abcdef'}",
      errorCode: "DEPENDENCY_GIT_SOURCE_FORBIDDEN",
    },
  ];
  for (const fixture of cases) {
    const { root, temporaryRoot } = await makeProject(t, {
      dependencies: { "left-pad": "1.3.0" },
    });
    const prior = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      left-pad:",
      "        specifier: 1.3.0",
      "        version: 1.3.0",
      "packages:",
      "  left-pad@1.3.0:",
      fixture.resolution,
      "snapshots:",
      "  left-pad@1.3.0: {}",
      "",
    ].join("\n");
    await writeFile(path.join(root, "pnpm-lock.yaml"), prior, "utf8");
    let executed = false;
    const result = await ensureDependencyState(root, {
      mode: "force",
      temporaryRoot,
      execute: async () => {
        executed = true;
        return successfulProcess();
      },
    });
    assert.equal(executed, false);
    assert.equal(result.classification, "task_failure");
    assert.equal(result.error_code, fixture.errorCode);
    assert.equal(await readFile(path.join(root, "pnpm-lock.yaml"), "utf8"), prior);
  }
});

test("fresh forbidden transitive resolution remains disposable and is never promoted", async (t) => {
  const { root, temporaryRoot } = await makeProject(t, {
    dependencies: { "left-pad": "1.3.0" },
  });
  let calls = 0;
  const result = await ensureDependencyState(root, {
    mode: "force",
    temporaryRoot,
    execute: async (argv, options) => {
      calls += 1;
      if (isPinnedManagerCheck(argv)) return pinnedManagerProcess();
      assert.notEqual(options.cwd, root);
      await assertMissing(path.join(root, "pnpm-lock.yaml"));
      await assertMissing(path.join(root, "node_modules"));
      await writeFile(path.join(options.cwd, "pnpm-lock.yaml"), [
        "lockfileVersion: '9.0'",
        "importers:",
        "  .:",
        "    dependencies:",
        "      left-pad:",
        "        specifier: 1.3.0",
        "        version: 1.3.0",
        "packages:",
        "  left-pad@1.3.0:",
        "    resolution: {integrity: " + VALID_INTEGRITY + "}",
        "  forbidden@1.0.0:",
        "    resolution: {commit: deadbeef, repo: 'git+ssh://git@example.test/private.git'}",
        "snapshots:",
        "  left-pad@1.3.0:",
        "    dependencies:",
        "      forbidden: 1.0.0",
        "  forbidden@1.0.0: {}",
        "",
      ].join("\n"), "utf8");
      return successfulProcess();
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.classification, "task_failure");
  assert.equal(result.error_code, "DEPENDENCY_GIT_SOURCE_FORBIDDEN");
  await assertMissing(path.join(root, "pnpm-lock.yaml"));
  await assertMissing(path.join(root, "node_modules"));
});

test("workspace manifests and installed child packages are part of readiness state", async (t) => {
  const { root, temporaryRoot } = await makeProject(t);
  const importer = "apps/web";
  const childManifest = {
    private: true,
    dependencies: { "left-pad": "1.3.0" },
  };
  await writeWorkspace(root, importer, childManifest);
  const lockfile = completeWorkspaceLockfile({ importer });
  let calls = 0;
  const fakeExecute = async (argv, options) => {
    calls += 1;
    if (isPinnedManagerCheck(argv)) return pinnedManagerProcess();
    if (argv.includes("--frozen-lockfile=false")) {
      assert.notEqual(options.cwd, root);
      await writeFile(path.join(options.cwd, "pnpm-lock.yaml"), lockfile, "utf8");
      await materializeLeftPad(options.cwd, { importer, lockfile });
    } else {
      assert.equal(options.cwd, root);
      await materializeLeftPad(root, { importer, lockfile });
    }
    return successfulProcess();
  };

  const first = await ensureDependencyState(root, {
    mode: "if-needed",
    temporaryRoot,
    execute: fakeExecute,
  });
  assert.equal(first.classification, "success", JSON.stringify(first));
  assert.equal(first.changed, true);
  assert.equal(calls, 3);

  const skipped = await ensureDependencyState(root, {
    mode: "if-needed",
    execute: async () => {
      throw new Error("matching workspace state must not relaunch pnpm");
    },
    temporaryRoot,
  });
  assert.equal(skipped.classification, "success");
  assert.equal(skipped.skipped, true);

  await writeWorkspace(root, importer, {
    ...childManifest,
    description: "policy-only manifest change",
  });
  let changeCalls = 0;
  const changed = await ensureDependencyState(root, {
    mode: "if-needed",
    temporaryRoot,
    execute: async (argv, options) => {
      changeCalls += 1;
      if (isPinnedManagerCheck(argv)) return pinnedManagerProcess();
      return pnpmFailure("ERR_PNPM_NO_MATCHING_VERSION");
    },
  });
  assert.equal(changeCalls, 2);
  assert.equal(changed.classification, "task_failure");
  assert.equal(changed.error_code, "DEPENDENCY_RESOLUTION_FAILED");
});

test("a dependency-free workspace child prevents a stale root-only lock from skipping", async (t) => {
  const { root, temporaryRoot } = await makeProject(t);
  await writeWorkspace(root, "apps/empty", { private: true });
  await writeFile(
    path.join(root, "pnpm-lock.yaml"),
    emptyWorkspaceLockfile(["."]),
    "utf8",
  );
  const corrected = emptyWorkspaceLockfile([".", "apps/empty"]);
  let calls = 0;
  const result = await ensureDependencyState(root, {
    mode: "if-needed",
    temporaryRoot,
    execute: async (argv, options) => {
      calls += 1;
      if (isPinnedManagerCheck(argv)) return pinnedManagerProcess();
      if (argv.includes("--frozen-lockfile=false")) {
        assert.notEqual(options.cwd, root);
        await writeFile(path.join(options.cwd, "pnpm-lock.yaml"), corrected, "utf8");
      }
      return successfulProcess();
    },
  });
  assert.equal(result.classification, "success", JSON.stringify(result));
  assert.equal(result.changed, true);
  assert.equal(result.skipped, false);
  assert.equal(calls, 3);

  const skipped = await ensureDependencyState(root, {
    mode: "if-needed",
    temporaryRoot,
    execute: async () => {
      throw new Error("corrected dependency-free workspace should skip");
    },
  });
  assert.equal(skipped.classification, "success");
  assert.equal(skipped.skipped, true);
});

test("a successful resolver cannot retain stale extra importer dependencies", async (t) => {
  const { root, temporaryRoot } = await makeProject(t, {
    dependencies: { "left-pad": "1.3.0" },
  });
  let calls = 0;
  const result = await ensureDependencyState(root, {
    mode: "force",
    temporaryRoot,
    execute: async (argv, options) => {
      calls += 1;
      if (isPinnedManagerCheck(argv)) return pinnedManagerProcess();
      assert.notEqual(options.cwd, root);
      await writeFile(path.join(options.cwd, "pnpm-lock.yaml"), [
        "lockfileVersion: '9.0'",
        "importers:",
        "  .:",
        "    dependencies:",
        "      left-pad:",
        "        specifier: 1.3.0",
        "        version: 1.3.0",
        "      is-number:",
        "        specifier: 1.0.0",
        "        version: 1.0.0",
        "packages:",
        "  is-number@1.0.0:",
        "    resolution: {integrity: " + VALID_INTEGRITY + "}",
        "snapshots:",
        "  is-number@1.0.0: {}",
        "",
      ].join("\n"), "utf8");
      return successfulProcess();
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.classification, "controller_failure");
  assert.equal(result.error_code, "DEPENDENCY_LOCKFILE_INCOMPLETE");
  await assertMissing(path.join(root, "pnpm-lock.yaml"));
});

test("every transitive snapshot edge must link to immutable package and snapshot data", async (t) => {
  const { root, temporaryRoot } = await makeProject(t, {
    dependencies: { "left-pad": "1.3.0" },
  });
  let calls = 0;
  const result = await ensureDependencyState(root, {
    mode: "force",
    temporaryRoot,
    execute: async (argv, options) => {
      calls += 1;
      if (isPinnedManagerCheck(argv)) return pinnedManagerProcess();
      assert.notEqual(options.cwd, root);
      await writeFile(path.join(options.cwd, "pnpm-lock.yaml"), [
        "lockfileVersion: '9.0'",
        "importers:",
        "  .:",
        "    dependencies:",
        "      left-pad:",
        "        specifier: 1.3.0",
        "        version: 1.3.0",
        "packages:",
        "  left-pad@1.3.0:",
        "    resolution: {integrity: " + VALID_INTEGRITY + "}",
        "snapshots:",
        "  left-pad@1.3.0:",
        "    dependencies:",
        "      missing-transitive: 2.0.0",
        "",
      ].join("\n"), "utf8");
      return successfulProcess();
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.classification, "controller_failure");
  assert.equal(result.error_code, "DEPENDENCY_LOCKFILE_INCOMPLETE");
  await assertMissing(path.join(root, "pnpm-lock.yaml"));
});

test("external package resolutions require valid cryptographic integrity", async (t) => {
  for (const resolution of [
    "    resolution: {integrity: sha512-not-a-valid-digest}",
    "    resolution: {directory: ../../outside}",
  ]) {
    const { root, temporaryRoot } = await makeProject(t, {
      dependencies: { "left-pad": "1.3.0" },
    });
    let calls = 0;
    const result = await ensureDependencyState(root, {
      mode: "force",
      temporaryRoot,
      execute: async (argv, options) => {
        calls += 1;
        if (isPinnedManagerCheck(argv)) return pinnedManagerProcess();
        await writeFile(path.join(options.cwd, "pnpm-lock.yaml"), [
          "lockfileVersion: '9.0'",
          "importers:",
          "  .:",
          "    dependencies:",
          "      left-pad:",
          "        specifier: 1.3.0",
          "        version: 1.3.0",
          "packages:",
          "  left-pad@1.3.0:",
          resolution,
          "snapshots:",
          "  left-pad@1.3.0: {}",
          "",
        ].join("\n"), "utf8");
        return successfulProcess();
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.classification, "controller_failure");
    assert.equal(result.error_code, "DEPENDENCY_LOCKFILE_INCOMPLETE");
    await assertMissing(path.join(root, "pnpm-lock.yaml"));
  }
});

test("the frozen pass must leave the resolved lockfile hash stable", async (t) => {
  const { root, temporaryRoot } = await makeProject(t, {
    dependencies: { "left-pad": "1.3.0" },
  });
  const prior = "preserve this prior lock\n";
  await writeFile(path.join(root, "pnpm-lock.yaml"), prior, "utf8");
  let installCalls = 0;
  let totalCalls = 0;
  const result = await ensureDependencyState(root, {
    mode: "force",
    temporaryRoot,
    execute: async (argv, options) => {
      totalCalls += 1;
      if (isPinnedManagerCheck(argv)) return pinnedManagerProcess();
      installCalls += 1;
      if (argv.includes("--frozen-lockfile=false")) {
        assert.notEqual(options.cwd, root);
        await writeFile(path.join(options.cwd, "pnpm-lock.yaml"), completeLockfile(), "utf8");
        await materializeLeftPad(options.cwd);
      } else {
        assert.equal(options.cwd, root);
        await materializeLeftPad(root);
        await writeFile(
          path.join(root, "pnpm-lock.yaml"),
          completeLockfile() + "# unexpected frozen mutation\n",
          "utf8",
        );
      }
      return successfulProcess();
    },
  });
  assert.equal(totalCalls, 3);
  assert.equal(installCalls, 2);
  assert.equal(result.classification, "controller_failure");
  assert.equal(result.error_code, "DEPENDENCY_LOCKFILE_UNSTABLE");
  assert.equal(await readFile(path.join(root, "pnpm-lock.yaml"), "utf8"), prior);
});

test("materialized package metadata and virtual-store lock must match the promoted lock", async (t) => {
  for (const corruption of ["package-version", "virtual-store-lock"]) {
    const { root, temporaryRoot } = await makeProject(t, {
      dependencies: { "left-pad": "1.3.0" },
    });
    let calls = 0;
    const result = await ensureDependencyState(root, {
      mode: "force",
      temporaryRoot,
      execute: async (argv, options) => {
        calls += 1;
        if (isPinnedManagerCheck(argv)) return pinnedManagerProcess();
        if (argv.includes("--frozen-lockfile=false")) {
          assert.notEqual(options.cwd, root);
          await writeFile(path.join(options.cwd, "pnpm-lock.yaml"), completeLockfile(), "utf8");
          await materializeLeftPad(options.cwd);
        } else {
          assert.equal(options.cwd, root);
          await materializeLeftPad(root);
          if (corruption === "package-version") {
            await writeFile(
              path.join(root, "node_modules", "left-pad", "package.json"),
              JSON.stringify({ name: "left-pad", version: "9.9.9" }) + "\n",
              "utf8",
            );
          } else {
            await writeFile(
              path.join(root, "node_modules", ".pnpm", "lock.yaml"),
              "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
              "utf8",
            );
          }
        }
        return successfulProcess();
      },
    });
    assert.equal(calls, 3);
    assert.equal(result.classification, "controller_failure");
    assert.equal(result.error_code, "DEPENDENCY_INSTALL_INCOMPLETE");
    await assertMissing(path.join(root, "pnpm-lock.yaml"));
  }
});

test("frozen-only hydration seeds persistent caches once and then proves offline reuse", async (t) => {
  const { root, temporaryRoot } = await makeProject(t, {
    dependencies: { "left-pad": "1.3.0" },
  });
  const manifestBefore = await readFile(path.join(root, "package.json"));
  const lockBefore = Buffer.from(completeLockfile(), "utf8");
  await writeFile(path.join(root, "pnpm-lock.yaml"), lockBefore);
  const privateDirectories = new Set();
  let managerCalls = 0;
  let installCalls = 0;
  const result = await ensureDependencyState(root, {
    mode: "hydrate",
    temporaryRoot,
    environment: {
      PATH: process.env.PATH ?? "",
      NPM_TOKEN: "must-not-cross-boundary",
    },
    execute: async (argv, options) => {
      privateDirectories.add(path.dirname(options.env.HOME));
      assert.equal(options.env.NPM_TOKEN, undefined);
      assert.equal(
        options.env.COREPACK_HOME,
        path.join(root, ".autopilot", "runtime", "dependency", "corepack"),
      );
      if (isPinnedManagerCheck(argv)) {
        managerCalls += 1;
        if (managerCalls === 1) {
          assert.equal(options.env.COREPACK_ENABLE_NETWORK, "0");
          return pnpmFailure("ENETUNREACH", "cold manager cache");
        }
        if (managerCalls === 2) {
          assert.equal(options.env.COREPACK_ENABLE_NETWORK, "1");
          await writeFile(path.join(options.env.COREPACK_HOME, "manager.fixture"), "ready\n", "utf8");
        } else {
          assert.equal(options.env.COREPACK_ENABLE_NETWORK, "0");
          assert.equal(await readFile(path.join(options.env.COREPACK_HOME, "manager.fixture"), "utf8"), "ready\n");
        }
        return pinnedManagerProcess();
      }

      installCalls += 1;
      assert.deepEqual(argv.slice(0, 3), ["corepack", "pnpm", "install"]);
      assert.ok(argv.includes("--frozen-lockfile"));
      assert.ok(argv.includes("--force"));
      assert.ok(argv.includes("--ignore-scripts"));
      assert.ok(argv.includes("--ignore-pnpmfile"));
      assert.ok(!argv.includes("--frozen-lockfile=false"));
      const store = argv[argv.indexOf("--store-dir") + 1];
      assert.equal(store, path.join(root, ".autopilot", "runtime", "dependency", "pnpm-store"));
      if (installCalls === 1) {
        assert.ok(argv.includes("--offline"));
        assert.equal(options.env.COREPACK_ENABLE_NETWORK, "0");
        return pnpmFailure("ERR_PNPM_NO_OFFLINE_TARBALL", "cold package store");
      }
      if (installCalls === 2) {
        assert.ok(!argv.includes("--offline"));
        assert.equal(options.env.COREPACK_ENABLE_NETWORK, "1");
        await writeFile(path.join(store, "package.fixture"), "cached\n", "utf8");
      } else {
        assert.ok(argv.includes("--offline"));
        assert.equal(options.env.COREPACK_ENABLE_NETWORK, "0");
        assert.equal(await readFile(path.join(store, "package.fixture"), "utf8"), "cached\n");
      }
      await materializeLeftPad(root);
      return successfulProcess();
    },
  });
  assert.equal(result.classification, "success", JSON.stringify(result));
  assert.equal(result.mode, "hydrate");
  assert.equal(result.changed, true);
  assert.equal(managerCalls, 3);
  assert.equal(installCalls, 3);
  assert.deepEqual(await readFile(path.join(root, "package.json")), manifestBefore);
  assert.deepEqual(await readFile(path.join(root, "pnpm-lock.yaml")), lockBefore);
  for (const directory of privateDirectories) await assertMissing(directory);

  const runtimeFile = path.join(
    root,
    "node_modules",
    ".pnpm",
    "left-pad@1.3.0",
    "node_modules",
    "left-pad",
    "index.js",
  );
  const runtimeBytes = await readFile(runtimeFile);
  const corrupted = Buffer.from(runtimeBytes);
  corrupted[0] ^= 0xff;
  await writeFile(runtimeFile, corrupted);
  let warmCalls = 0;
  const warm = await ensureDependencyState(root, {
    mode: "hydrate",
    temporaryRoot,
    execute: async (argv, options) => {
      warmCalls += 1;
      assert.equal(options.env.COREPACK_ENABLE_NETWORK, "0");
      if (isPinnedManagerCheck(argv)) {
        assert.equal(await readFile(path.join(options.env.COREPACK_HOME, "manager.fixture"), "utf8"), "ready\n");
        return pinnedManagerProcess();
      }
      assert.ok(argv.includes("--offline"));
      const store = argv[argv.indexOf("--store-dir") + 1];
      assert.equal(await readFile(path.join(store, "package.fixture"), "utf8"), "cached\n");
      await materializeLeftPad(root);
      return successfulProcess();
    },
  });
  assert.equal(warm.classification, "success", JSON.stringify(warm));
  assert.equal(warmCalls, 2);

  const skipped = await ensureDependencyState(root, {
    mode: "hydrate",
    temporaryRoot,
    execute: async () => {
      throw new Error("valid materialization must skip frozen hydration");
    },
  });
  assert.equal(skipped.classification, "success");
  assert.equal(skipped.skipped, true);
});

test("frozen-only hydration validates the existing lock before any process", async (t) => {
  for (const lockfile of [null, "lockfileVersion: '9.0'\nimporters:\n  .: {}\n"]) {
    const { root, temporaryRoot } = await makeProject(t, {
      dependencies: { "left-pad": "1.3.0" },
    });
    if (lockfile !== null) await writeFile(path.join(root, "pnpm-lock.yaml"), lockfile, "utf8");
    let executed = false;
    const result = await ensureDependencyState(root, {
      mode: "hydrate",
      temporaryRoot,
      execute: async () => {
        executed = true;
        return successfulProcess();
      },
    });
    assert.equal(executed, false);
    assert.equal(result.classification, "task_failure");
    assert.equal(result.error_code, "DEPENDENCY_LOCKFILE_INCOMPLETE");
  }
});

test("dependency readiness probe checks the exact pinned pnpm offline without installing", async (t) => {
  const { root, temporaryRoot } = await makeProject(t);
  const invocations = [];
  let privateDirectory = null;
  const result = await probeDependencyManager(root, {
    temporaryRoot,
    environment: {
      PATH: process.env.PATH ?? "",
      HOME: "ambient-home",
      NPM_TOKEN: "must-not-cross-boundary",
    },
    execute: async (argv, options) => {
      invocations.push(argv);
      privateDirectory = path.dirname(options.env.HOME);
      assert.equal(options.env.COREPACK_ENABLE_NETWORK, "0");
      assert.equal(options.env.NPM_CONFIG_OFFLINE, "true");
      assert.equal(options.env.NPM_TOKEN, undefined);
      assert.ok(!argv.includes("install"));
      if (isPinnedManagerCheck(argv)) return pinnedManagerProcess();
      return successfulProcess({ stdout: "fixture-version\n" });
    },
  });
  assert.equal(result.classification, "success", JSON.stringify(result));
  assert.equal(result.operation, "dependency-lock");
  assert.equal(result.mode, "probe");
  assert.equal(result.package_manager, "pnpm@" + PINNED_VERSION);
  assert.equal(invocations.length, 3);
  assert.equal(invocations[0][1], "--version");
  assert.deepEqual(invocations[1], ["corepack", "--version"]);
  assert.deepEqual(invocations[2], ["corepack", "pnpm", "--version"]);
  await assertMissing(privateDirectory);
  await assertMissing(path.join(root, "pnpm-lock.yaml"));
  await assertMissing(path.join(root, "node_modules"));
});

test("a cold readiness probe provisions once and then proves the pinned manager offline", async (t) => {
  const { root, temporaryRoot } = await makeProject(t);
  let pinnedCalls = 0;
  let controllerCache = null;
  const first = await probeDependencyManager(root, {
    temporaryRoot,
    execute: async (argv, options) => {
      if (!isPinnedManagerCheck(argv)) return successfulProcess({ stdout: "fixture-version\n" });
      pinnedCalls += 1;
      controllerCache = options.env.COREPACK_HOME;
      if (pinnedCalls === 1) {
        assert.equal(options.env.COREPACK_ENABLE_NETWORK, "0");
        assert.equal(options.env.NPM_CONFIG_OFFLINE, "true");
        return pnpmFailure("ENETUNREACH", "empty controller cache");
      }
      if (pinnedCalls === 2) {
        assert.equal(options.env.COREPACK_ENABLE_NETWORK, "1");
        assert.equal(options.env.NPM_CONFIG_OFFLINE, "false");
        await writeFile(path.join(controllerCache, "provisioned.fixture"), "ready\n", "utf8");
        return pinnedManagerProcess();
      }
      assert.equal(options.env.COREPACK_ENABLE_NETWORK, "0");
      assert.equal(options.env.NPM_CONFIG_OFFLINE, "true");
      assert.equal(await readFile(path.join(controllerCache, "provisioned.fixture"), "utf8"), "ready\n");
      return pinnedManagerProcess();
    },
  });
  assert.equal(first.classification, "success", JSON.stringify(first));
  assert.equal(pinnedCalls, 3);

  let warmCalls = 0;
  const second = await probeDependencyManager(root, {
    temporaryRoot,
    execute: async (argv, options) => {
      warmCalls += 1;
      assert.equal(options.env.COREPACK_ENABLE_NETWORK, "0");
      assert.equal(options.env.NPM_CONFIG_OFFLINE, "true");
      if (isPinnedManagerCheck(argv)) {
        assert.equal(options.env.COREPACK_HOME, controllerCache);
        assert.equal(await readFile(path.join(controllerCache, "provisioned.fixture"), "utf8"), "ready\n");
        return pinnedManagerProcess();
      }
      return successfulProcess({ stdout: "fixture-version\n" });
    },
  });
  assert.equal(second.classification, "success", JSON.stringify(second));
  assert.equal(warmCalls, 3);
});

test("dependency readiness probe reports an unavailable exact offline manager as infrastructure", async (t) => {
  const { root, temporaryRoot } = await makeProject(t);
  let calls = 0;
  const result = await probeDependencyManager(root, {
    temporaryRoot,
    execute: async (argv) => {
      calls += 1;
      if (isPinnedManagerCheck(argv)) {
        return pnpmFailure("ENETUNREACH", "offline Corepack cache miss");
      }
      return successfulProcess({ stdout: "fixture-version\n" });
    },
  });
  assert.equal(calls, 4);
  assert.equal(result.classification, "controller_failure");
  assert.equal(result.error_code, "DEPENDENCY_PINNED_MANAGER_UNAVAILABLE");
  assert.equal(result.mode, "probe");
});

test("pnpm applicability requires an exact root pin even when the lockfile is missing", async (t) => {
  const managed = await makeProject(t, {
    dependencies: { "left-pad": "1.3.0" },
  });
  assert.equal(await isPnpmManagedProject(managed.root), true);
  await writeFile(path.join(managed.root, "pnpm-lock.yaml"), completeLockfile(), "utf8");
  assert.equal(await isPnpmManagedProject(managed.root), true);

  const npmProject = await makeProject(t, { packageManager: "npm@11.0.0" });
  await writeFile(path.join(npmProject.root, "pnpm-lock.yaml"), "not applicable\n", "utf8");
  assert.equal(await isPnpmManagedProject(npmProject.root), false);
});

test("dependency policy rejects Git, SSH, and Gist dependency sources before execution", async (t) => {
  for (const specifier of [
    "git+ssh://git@github.com/example/private.git",
    "gist:0123456789abcdef",
  ]) {
    const { root, temporaryRoot } = await makeProject(t, {
      dependencies: { unsafe: specifier },
    });
    let executed = false;
    const result = await ensureDependencyState(root, {
      mode: "force",
      temporaryRoot,
      execute: async () => {
        executed = true;
        return successfulProcess();
      },
    });
    assert.equal(executed, false);
    assert.equal(result.classification, "task_failure");
    assert.equal(result.error_code, "DEPENDENCY_GIT_SOURCE_FORBIDDEN");
  }
});

test("dependency policy rejects untracked pnpm patchedDependencies before execution", async (t) => {
  const { root, temporaryRoot } = await makeProject(t, {
    dependencies: { "left-pad": "1.3.0" },
    pnpm: {
      patchedDependencies: {
        "left-pad@1.3.0": "../../outside.patch",
      },
    },
  });
  let executed = false;
  const result = await ensureDependencyState(root, {
    mode: "force",
    temporaryRoot,
    execute: async () => {
      executed = true;
      return successfulProcess();
    },
  });
  assert.equal(executed, false);
  assert.equal(result.classification, "task_failure");
  assert.equal(result.error_code, "DEPENDENCY_PATCHED_DEPENDENCIES_FORBIDDEN");
});

test("dependency policy rejects non-exact pnpm pins before any execution", async (t) => {
  const { root, temporaryRoot } = await makeProject(t, {
    packageManager: "pnpm@latest",
  });
  let executed = false;
  const result = await ensureDependencyState(root, {
    mode: "force",
    temporaryRoot,
    execute: async () => {
      executed = true;
      return successfulProcess();
    },
  });
  assert.equal(executed, false);
  assert.equal(result.classification, "task_failure");
  assert.equal(result.error_code, "DEPENDENCY_POLICY_INVALID");
});
