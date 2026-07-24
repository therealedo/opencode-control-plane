const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/g;
const CONTROL_PATTERN = /[\x00-\x1f\x7f-\x9f]/g;

export const ACTION_IDS = Object.freeze([
  "run",
  "preflight",
  "reasoning",
  "change",
  "upgrade",
  "stop",
  "refresh",
  "quit",
]);

export function safeText(value, maxLength = 240) {
  const clean = String(value ?? "")
    .replace(ANSI_PATTERN, "")
    .replace(CONTROL_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length <= maxLength ? clean : `${clean.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function controllerMode(status = {}) {
  const live = Boolean(status.controller_lock);
  if (live) return { id: "running", label: "Running", detail: friendlyPhase(status.phase) };
  if (status.status === "complete") return { id: "complete", label: "Complete", detail: "All accepted work is complete" };
  if (status.status === "human_required") return { id: "human_required", label: "Waiting for you", detail: friendlyPhase(status.phase) };
  if (status.maintenance_requested || status.phase === "maintenance") {
    return { id: "maintenance", label: "Maintenance", detail: "Safe for blueprint or Control Plane changes" };
  }
  if (status.stop_requested || status.phase === "stopped") return { id: "stopped", label: "Stopped", detail: "Resume when you are ready" };
  if (status.pause_requested || status.status === "paused") return { id: "paused", label: "Paused", detail: "Resume when you are ready" };
  if (status.status === "running") return { id: "interrupted", label: "Interrupted", detail: "The worker is no longer running" };
  if (status.status === "failed") return { id: "failed", label: "Needs attention", detail: "Inspect the blocker, then resume" };
  return { id: "idle", label: "Ready", detail: "Start autonomous work" };
}

export function primaryAction(status = {}) {
  const mode = controllerMode(status);
  if (mode.id === "running") return { id: "pause", label: "Pause safely", enabled: true, confirm: false };
  if (mode.id === "complete") return { id: "run", label: "Project complete", enabled: false, confirm: false };
  if (["paused", "stopped", "maintenance", "human_required", "failed", "interrupted"].includes(mode.id)) {
    return {
      id: "resume",
      label: mode.id === "human_required" ? "Resume after resolving blocker" : "Resume worker",
      enabled: true,
      confirm: mode.id === "human_required",
    };
  }
  return { id: "start", label: "Start worker", enabled: true, confirm: false };
}

export function actionMenu(status = {}, metadata = {}) {
  const primary = primaryAction(status);
  const live = Boolean(status.controller_lock);
  const variant = safeText(metadata.runtime_variant ?? "default", 64);
  return [
    { menu_id: "run", ...primary },
    { menu_id: "preflight", id: "preflight", label: "Check readiness (zero tokens)", enabled: !live, confirm: false },
    { menu_id: "reasoning", id: "reasoning", label: `Worker reasoning: ${variant} (change)`, enabled: !live, confirm: false },
    { menu_id: "change", id: "change", label: "Change product blueprint", enabled: true, confirm: true },
    { menu_id: "upgrade", id: "upgrade", label: "Upgrade Control Plane", enabled: true, confirm: true },
    { menu_id: "stop", id: "stop", label: "Stop safely", enabled: live, confirm: true },
    { menu_id: "refresh", id: "refresh", label: "Refresh now", enabled: true, confirm: false },
    { menu_id: "quit", id: "quit", label: "Close dashboard only", enabled: true, confirm: false },
  ];
}

export function controllerArguments(action) {
  if (action === "start") return ["start", "--detach"];
  if (action === "resume") return ["resume", "--detach"];
  if (["pause", "stop", "maintenance"].includes(action)) return [action];
  if (action === "preflight") return ["preflight", "--json"];
  throw new Error(`Unsupported controller action: ${safeText(action, 40)}`);
}

export function friendlyPhase(value) {
  const phase = safeText(value, 80).replaceAll("_", " ");
  if (!phase || phase === "idle") return "Idle";
  return phase.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function progress(status = {}) {
  const counts = status.task_counts && typeof status.task_counts === "object" ? status.task_counts : {};
  const total = Number(status.total_tasks ?? Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0));
  const done = Number(counts.done ?? 0);
  return { total, done, percent: total > 0 ? Math.round((done / total) * 100) : 0 };
}

export function statusFingerprint(status = {}) {
  return JSON.stringify([
    Boolean(status.controller_lock),
    status.revision ?? 0,
    status.status ?? null,
    status.phase ?? null,
    status.active_task ?? null,
    status.pause_requested ?? false,
    status.stop_requested ?? false,
    status.maintenance_requested ?? false,
  ]);
}

export function renderDashboard({ status = {}, metadata = {}, activity = [], message = "", stale = false, selected = 0, confirm = null, busy = false, width = 88 } = {}) {
  const usable = Math.max(48, Math.min(120, Number(width) || 88));
  const mode = controllerMode(status);
  const taskProgress = progress(status);
  const menu = actionMenu(status, metadata);
  const line = "-".repeat(usable);
  const output = [
    "OpenCode Control Plane",
    fit("a high-efficiency, zero-token orchestrator that turns OpenCode into a sandboxed, self-verifying coding worker.", usable),
    fit("Keeping it lean, fast, and terminal-native is its superpower", usable),
    line,
    pair("Controller", stale ? `${mode.label} (status stale)` : mode.label, usable),
    pair("Stage", mode.detail, usable),
    pair("Task", status.active_task ? `${safeText(status.active_task, 48)}${status.active_task_title ? ` - ${safeText(status.active_task_title, 80)}` : ""}` : "None", usable),
    pair("Progress", `${taskProgress.done}/${taskProgress.total} tasks (${taskProgress.percent}%)`, usable),
    pair("Attempt", status.active_task ? `${Number(status.attempt ?? 0)}${status.active_task_attempt_limit ? `/${Number(status.active_task_attempt_limit)}` : ""}` : "-", usable),
    pair("Blueprint", metadata.blueprint_version ? `v${metadata.blueprint_version}` : "Not finalized", usable),
    pair("Reasoning", safeText(metadata.runtime_variant ?? "default", 64), usable),
    pair("Control Plane", `${safeText(metadata.installed_version ?? "legacy", 30)}${metadata.available_version && metadata.available_version !== metadata.installed_version ? ` -> ${safeText(metadata.available_version, 30)} available` : ""}`, usable),
  ];

  if (status.blocker) {
    output.push(line, "Needs your attention:");
    output.push(`  ${fit(safeText(status.blocker.message ?? status.blocker.kind ?? "A blocker requires review."), usable - 2)}`);
    if (status.blocker.required_action) output.push(`  Next: ${fit(safeText(status.blocker.required_action), usable - 8)}`);
  }

  output.push(line, busy ? "Actions (working...):" : "Actions (arrow keys + Enter, or the shown key):");
  for (const [index, action] of menu.entries()) {
    const marker = index === selected ? ">" : " ";
    const key = String(index + 1);
    const disabled = action.enabled && !busy ? "" : " [unavailable]";
    output.push(fit(`${marker} ${key}. ${action.label}${disabled}`, usable));
  }

  if (activity.length > 0) {
    output.push(line, "Recent activity:");
    for (const item of activity.slice(-5)) output.push(`  ${fit(safeText(item), usable - 2)}`);
  }
  if (message) output.push(line, fit(safeText(message, 1000), usable));
  if (confirm) {
    output.push(line, fit(safeText(confirm, 1000), usable), "Press Y to continue or N to cancel.");
  }
  output.push(line, "Closing this dashboard does not stop the worker.");
  return output.join("\n");
}

function pair(label, value, width) {
  return fit(`${label.padEnd(14)} ${safeText(value, 500)}`, width);
}

function fit(value, width) {
  const text = safeText(value, Math.max(width, 1));
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}
