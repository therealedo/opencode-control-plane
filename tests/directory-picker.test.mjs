import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  completedDirectoryInput,
  directoryPickerLimits,
  listDirectorySuggestions,
  parentDirectoryInput,
  parseDirectoryQuery,
  pickProjectDirectory,
  renderDirectoryPicker,
  submittedDirectory,
} from "../.agents/skills/init-project/bin/lib/directory-picker.mjs";

test("directory suggestions are bounded, directory-only, and prefix filtered", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocp-picker-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(path.join(root, "Producer Scribe")),
    mkdir(path.join(root, "Producer Tools")),
    mkdir(path.join(root, "Other")),
    writeFile(path.join(root, "Producer.txt"), "not a directory\n", "utf8"),
  ]);
  try { await symlink(path.join(root, "Other"), path.join(root, "Producer Link"), "junction"); }
  catch (error) { if (!["EPERM", "ENOTSUP", "EINVAL"].includes(error?.code)) throw error; }

  const result = await listDirectorySuggestions(`${root}${path.sep}Pro`);
  assert.deepEqual(result.suggestions.map((item) => item.name), ["Producer Scribe", "Producer Tools"]);
  assert.equal(result.truncated, false);
  assert.equal(result.query.base, path.resolve(root));
  assert.equal(result.query.prefix, "Pro");
});

test("directory query supports quoted paths, home expansion, completion, parent, and submission", () => {
  const home = path.resolve("home fixture");
  const quoted = parseDirectoryQuery(`"${path.join(home, "Projects", "Pro")}"`, { cwd: home, home });
  assert.equal(quoted.prefix, "Pro");
  assert.equal(quoted.base, path.join(home, "Projects"));

  const homeQuery = parseDirectoryQuery(`~${path.sep}Projects${path.sep}`, { cwd: home, home });
  assert.equal(homeQuery.absolute, path.join(home, "Projects"));
  const suggestion = { name: "Producer Scribe", path: path.join(home, "Projects", "Producer Scribe") };
  assert.equal(completedDirectoryInput(suggestion), `${suggestion.path}${path.sep}`);
  assert.equal(parentDirectoryInput(`${suggestion.path}${path.sep}`, { cwd: home, home }), `${path.join(home, "Projects")}${path.sep}`);
  assert.equal(submittedDirectory(quoted, [suggestion], 0), quoted.absolute);
  assert.equal(submittedDirectory(quoted, [suggestion], 1), suggestion.path);
  assert.equal(submittedDirectory(homeQuery, [suggestion], 0), homeQuery.absolute);
});

test("Windows and POSIX query parsing keep their path semantics", () => {
  const windows = parseDirectoryQuery("C:\\Users\\edo\\Pro", {
    cwd: "C:\\Users\\edo",
    home: "C:\\Users\\edo",
    pathApi: path.win32,
  });
  assert.equal(windows.base, "C:\\Users\\edo");
  assert.equal(windows.prefix, "Pro");
  assert.equal(windows.case_sensitive, false);
  assert.throws(() => parseDirectoryQuery("D:", {
    cwd: "C:\\Users\\edo",
    home: "C:\\Users\\edo",
    pathApi: path.win32,
  }), /absolute drive path/);
  assert.throws(() => parseDirectoryQuery("D:Projects", {
    cwd: "C:\\Users\\edo",
    home: "C:\\Users\\edo",
    pathApi: path.win32,
  }), /absolute drive path/);
  assert.equal(parentDirectoryInput("C:\\", {
    cwd: "C:\\Users\\edo",
    home: "C:\\Users\\edo",
    pathApi: path.win32,
  }), "C:\\");

  const posix = parseDirectoryQuery("/Users/edo/Pro", {
    cwd: "/Users/edo",
    home: "/Users/edo",
    pathApi: path.posix,
  });
  assert.equal(posix.base, "/Users/edo");
  assert.equal(posix.prefix, "Pro");
  assert.equal(posix.case_sensitive, true);
  const literalBackslash = parseDirectoryQuery("/Users/edo/Folder\\Name", {
    cwd: "/Users/edo",
    home: "/Users/edo",
    pathApi: path.posix,
  });
  assert.equal(literalBackslash.base, "/Users/edo");
  assert.equal(literalBackslash.prefix, "Folder\\Name");
});

test("directory picker rendering is bounded and strips terminal control input", () => {
  const rendered = renderDirectoryPicker({
    input: "C:\\Projects\x1b[2Jowned",
    suggestions: [{ name: "Producer\nScribe", path: "unused" }],
    selected: 0,
    currentPath: "C:\\Projects",
    error: "Denied\x07",
    width: 72,
    height: 20,
  });
  assert.match(rendered, /Add project/);
  assert.match(rendered, /> Use this folder: C:\\Projects/);
  assert.match(rendered, /Open: Producer Scribe/);
  assert.doesNotMatch(rendered, /\x1b|\x07/);
  assert.equal(directoryPickerLimits.max_suggestions, 100);
  const busy = renderDirectoryPicker({ input: "C:\\Projects", busy: true });
  assert.match(busy, /Please wait/);
  assert.doesNotMatch(busy, /Esc: cancel/);
});

test("directory suggestions cap large folders without reading files as candidates", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocp-picker-cap-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: directoryPickerLimits.max_suggestions + 5 }, (_item, index) =>
    mkdir(path.join(root, `project-${String(index).padStart(3, "0")}`))
  ));
  const result = await listDirectorySuggestions(`${root}${path.sep}project-`);
  assert.equal(result.suggestions.length, directoryPickerLimits.max_suggestions);
  assert.equal(result.truncated, true);
});

test("directory browsing honors cancellation before touching the filesystem", async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    listDirectorySuggestions("Z:\\this-path-must-not-be-read", { signal: abort.signal }),
    (error) => error?.name === "AbortError",
  );
});

test("interactive picker submits the selected child and keeps validation errors in-screen", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocp-picker-interactive-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "Producer Scribe");
  await mkdir(project);

  const terminal = () => {
    const input = new EventEmitter();
    input.isTTY = true;
    const output = new EventEmitter();
    output.isTTY = true;
    output.columns = 90;
    output.rows = 24;
    output.text = "";
    output.write = (value) => { output.text += String(value); return true; };
    return { input, output };
  };

  const acceptedTerminal = terminal();
  const accepted = pickProjectDirectory({
    startDirectory: root,
    input: acceptedTerminal.input,
    output: acceptedTerminal.output,
    submit: async (candidate) => ({ candidate }),
  });
  await waitFor(() => acceptedTerminal.output.text.includes("Open: Producer Scribe"));
  acceptedTerminal.input.emit("keypress", "", { name: "down" });
  acceptedTerminal.input.emit("keypress", "", { name: "return" });
  assert.deepEqual(await accepted, { candidate: project });

  const rejectedTerminal = terminal();
  const rejected = pickProjectDirectory({
    startDirectory: root,
    input: rejectedTerminal.input,
    output: rejectedTerminal.output,
    submit: async () => { throw new Error("not initialized"); },
  });
  await waitFor(() => rejectedTerminal.output.text.includes("Open: Producer Scribe"));
  rejectedTerminal.input.emit("keypress", "", { name: "down" });
  rejectedTerminal.input.emit("keypress", "", { name: "return" });
  await waitFor(() => rejectedTerminal.output.text.includes("Notice: not initialized"));
  rejectedTerminal.input.emit("keypress", "", { name: "escape" });
  assert.equal(await rejected, null);
});

test("rapid input cannot submit stale suggestions and cancellation prevents late redraws", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocp-picker-race-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "Producer Scribe");
  await mkdir(project);
  const input = new EventEmitter();
  input.isTTY = true;
  const output = new EventEmitter();
  output.isTTY = true;
  output.columns = 90;
  output.rows = 24;
  output.text = "";
  output.write = (value) => { output.text += String(value); return true; };

  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  let calls = 0;
  const loadSuggestions = async (value, options) => {
    calls += 1;
    if (calls > 1) await refreshGate;
    return listDirectorySuggestions(value, options);
  };
  let submitted;
  const picked = pickProjectDirectory({
    startDirectory: root,
    input,
    output,
    loadSuggestions,
    submit: async (candidate) => { submitted = candidate; return candidate; },
  });
  await waitFor(() => output.text.includes("Open: Producer Scribe"));
  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", "X", { name: "x" });
  input.emit("keypress", "", { name: "return" });
  assert.equal(await picked, `${root}${path.sep}X`);
  assert.equal(submitted, `${root}${path.sep}X`);
  const lengthAtFinish = output.text.length;
  releaseRefresh();
  await delay(25);
  assert.equal(output.text.length, lengthAtFinish);
  assert.equal(input.listenerCount("keypress"), 0);
});

test("an abort signal closes the picker and removes its listeners", async () => {
  const input = new EventEmitter();
  input.isTTY = true;
  const output = new EventEmitter();
  output.isTTY = true;
  output.columns = 80;
  output.rows = 20;
  output.write = () => true;
  const abort = new AbortController();
  const picked = pickProjectDirectory({
    input,
    output,
    signal: abort.signal,
    loadSuggestions: () => new Promise(() => {}),
    submit: async () => null,
  });
  abort.abort();
  assert.equal(await picked, null);
  assert.equal(input.listenerCount("keypress"), 0);
  assert.equal(output.listenerCount("resize"), 0);
});

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for terminal output");
    await delay(10);
  }
}
