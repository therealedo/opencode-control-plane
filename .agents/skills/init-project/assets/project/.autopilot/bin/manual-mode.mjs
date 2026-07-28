#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

let options = { json: false };
let root;
let marker;
let lock;

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, code: error.code ?? "ERROR" }, null, options.json ? 0 : 2)}\n`);
  process.exitCode = 1;
});

async function main() {
  options = parseArgs(process.argv.slice(2));
  root = path.resolve(options.root ?? process.cwd());
  marker = path.join(root, ".autopilot", "MANUAL_MODE");
  lock = path.join(root, ".git", "autopilot-controller.lock");
  await assertProject(root);
  let result;
  if (options.action === "on") result = await enable();
  else if (options.action === "off") result = await disable();
  else result = await inspect();
  process.stdout.write(`${JSON.stringify(result, null, options.json ? 0 : 2)}\n`);
}

async function enable() {
  const active = await liveController();
  if (active) fail(`The autonomous worker is still running with PID ${active.pid}. Stop it safely before enabling manual mode.`, "WORKER_RUNNING");
  const current = await safeMarker({ optional: true });
  if (current) return { ok: true, manual_mode: true, changed: false, marker };
  const stage = `${marker}.stage-${process.pid}-${randomBytes(5).toString("hex")}`;
  try {
    await writeFile(stage, `${JSON.stringify({ schema_version: 1, enabled_at: new Date().toISOString(), enabled_by_pid: process.pid })}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
    await rename(stage, marker);
  } finally {
    await rm(stage, { force: true }).catch(() => {});
  }
  return { ok: true, manual_mode: true, changed: true, marker };
}

async function disable() {
  const current = await safeMarker({ optional: true });
  if (!current) return { ok: true, manual_mode: false, changed: false, marker };
  await rm(marker);
  return { ok: true, manual_mode: false, changed: true, marker };
}

async function inspect() {
  const current = await safeMarker({ optional: true });
  return { ok: true, manual_mode: Boolean(current), marker };
}

async function liveController() {
  let info;
  try { info = await lstat(lock); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > 64 * 1024) {
    fail("The controller lock is unsafe or unreadable. Manual mode was not enabled.", "LOCK_UNSAFE");
  }
  let value;
  try { value = JSON.parse(await readFile(lock, "utf8")); }
  catch { fail("The controller lock is invalid. Manual mode was not enabled.", "LOCK_UNSAFE"); }
  if (!Number.isInteger(value?.pid) || value.pid <= 0) return null;
  try { process.kill(value.pid, 0); return value; }
  catch (error) { return error?.code === "EPERM" ? value : null; }
}

async function safeMarker({ optional = false } = {}) {
  try {
    const info = await lstat(marker);
    if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) > 1 || info.size > 64 * 1024) {
      fail("The manual-mode marker is unsafe.", "MANUAL_MODE_UNSAFE");
    }
    return info;
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertProject(projectRoot) {
  for (const relative of [".autopilot", ".autopilot/config.json", ".git"]) {
    const location = path.join(projectRoot, ...relative.split("/"));
    let info;
    try { info = await lstat(location); }
    catch (error) { if (error?.code === "ENOENT") fail(`Not an initialized Control Plane project: missing ${relative}`, "NOT_INITIALIZED"); throw error; }
    if (info.isSymbolicLink()) fail(`Unsafe project path: ${relative}`, "UNSAFE_PROJECT");
  }
}

function parseArgs(argv) {
  const result = { action: "status", root: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (["on", "off", "status"].includes(value)) result.action = value;
    else if (value === "--root") {
      const selected = argv[++index];
      if (!selected || selected.startsWith("--")) fail("--root requires a path", "USAGE");
      result.root = selected;
    } else if (value === "--json") result.json = true;
    else fail("Usage: manual-mode.mjs on|off|status [--root PATH] [--json]", "USAGE");
  }
  return result;
}

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
