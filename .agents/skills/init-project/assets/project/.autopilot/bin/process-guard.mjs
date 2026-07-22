#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [ownerText, command, ...args] = process.argv.slice(2);
const ownerPid = Number(ownerText);
if (!Number.isInteger(ownerPid) || ownerPid <= 0 || !command) process.exit(125);

if (process.platform === "win32") {
  const runner = fileURLToPath(new URL("./windows-job-guard.ps1", import.meta.url));
  const powerShell = path.join(
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const specification = Buffer.from(JSON.stringify({ command, args }), "utf8").toString("base64");
  const guarded = spawn(powerShell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    runner,
    "-OwnerPid",
    String(ownerPid),
    "-Specification",
    specification,
  ], {
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.stdin.pipe(guarded.stdin);
  guarded.stdout.pipe(process.stdout);
  guarded.stderr.pipe(process.stderr);
  guarded.once("error", () => process.exit(125));
  const [code] = await once(guarded, "close");
  process.exit(Number.isInteger(code) ? code : 125);
}

const target = spawn(command, args, {
  env: process.env,
  detached: process.platform !== "win32",
  shell: false,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});

process.stdin.pipe(target.stdin);
target.stdout.pipe(process.stdout);
target.stderr.pipe(process.stderr);

let stopping = false;
let targetClosed = false;
let targetResult = null;

target.once("close", (code, signal) => {
  targetClosed = true;
  targetResult = { code, signal };
});

function posixSignalGroup(signal) {
  if (!target.pid) return;
  try {
    process.kill(-target.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") target.kill(signal);
  }
}

async function stopTarget() {
  const wasClosed = targetClosed;
  posixSignalGroup("SIGTERM");
  if (!wasClosed) {
    await Promise.race([
      once(target, "close").catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1_500)),
    ]);
  }
  posixSignalGroup("SIGKILL");
}

async function stopAndExit(code = 124) {
  if (stopping) return;
  stopping = true;
  await stopTarget();
  process.exit(code);
}

process.on("SIGTERM", () => { void stopAndExit(124); });
process.on("SIGINT", () => { void stopAndExit(130); });

const ownerMonitor = setInterval(() => {
  try {
    process.kill(ownerPid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") void stopAndExit(124);
  }
}, 500);
ownerMonitor.unref();

try {
  if (!targetClosed) await once(target, "close");
  clearInterval(ownerMonitor);
  // A direct child can exit while a detached grandchild remains in its group.
  await stopTarget();
  const code = targetResult?.code;
  process.exit(Number.isInteger(code) ? code : 1);
} catch {
  await stopAndExit(125);
}
