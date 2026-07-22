import {
  controllerMode,
  progress,
  safeText,
} from "../../assets/project/.autopilot/bin/lib/control-plane-ui.mjs";

export function renderFleet({
  projects = [],
  installedVersion = "unknown",
  update = null,
  selected = 0,
  message = "",
  busy = false,
  width = 100,
  height = 30,
} = {}) {
  const usable = Math.max(64, Math.min(140, Number(width) || 100));
  const line = "-".repeat(usable);
  const behind = projects.filter((item) => item.update_needed).length;
  const running = projects.filter((item) => item.mode?.id === "running").length;
  const attention = projects.filter((item) => !item.available || ["failed", "human_required", "interrupted"].includes(item.mode?.id)).length;
  const output = [
    "OpenCode Control Plane",
    fit("All projects. Zero-token monitoring and control.", usable),
    line,
    pair("Global version", installedVersion, usable),
    pair("Projects", `${projects.length} registered | ${running} running | ${attention} need attention`, usable),
    pair("Project updates", behind ? `${behind} behind the global version` : "All available projects are current", usable),
    pair("Release", releaseMessage(update), usable),
    line,
  ];
  if (projects.length === 0) {
    output.push("No initialized projects are registered yet.", "Finish /init-project, or press A to add an existing project.");
  } else {
    output.push(fit(`${" ".padEnd(2)}${"Project".padEnd(28)} ${"State".padEnd(18)} ${"Progress".padEnd(12)} ${"Blueprint".padEnd(10)} Version`, usable));
    output.push(fit(`${" ".padEnd(2)}${"-".repeat(27)}  ${"-".repeat(17)}  ${"-".repeat(11)}  ${"-".repeat(9)}  ${"-".repeat(10)}`, usable));
    const rows = Math.max(3, Math.min(projects.length, Number(height || 30) - 16));
    const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), Math.max(0, projects.length - rows)));
    for (let index = start; index < Math.min(projects.length, start + rows); index += 1) {
      const item = projects[index];
      const marker = index === selected ? ">" : " ";
      const state = item.available ? item.mode.label : "Unavailable";
      const taskProgress = item.available ? progress(item.status) : { done: 0, total: 0, percent: 0 };
      const progressText = item.available ? `${taskProgress.done}/${taskProgress.total} (${taskProgress.percent}%)` : "-";
      const blueprint = item.blueprint_version ? `v${item.blueprint_version}` : "-";
      const version = item.control_plane_version ?? (item.available ? "legacy" : "-");
      output.push(fit(`${marker} ${fitCell(item.name, 28)} ${fitCell(state, 18)} ${fitCell(progressText, 12)} ${fitCell(blueprint, 10)} ${version}`, usable));
    }
  }
  output.push(
    line,
    busy ? "Working..." : "Enter: open project   A: add   F: forget   U: update everything   C: check updates   R: refresh   Q: close",
  );
  if (message) output.push(line, fit(safeText(message, 1200), usable));
  output.push(line, "Closing this dashboard does not stop any worker.");
  return output.join("\n");
}

export function projectSummary(entry, data = {}) {
  if (!data.available) {
    return {
      ...entry,
      ...data,
      mode: { id: "unavailable", label: "Unavailable", detail: data.error ?? "Project cannot be read" },
    };
  }
  return { ...entry, ...data, mode: controllerMode(data.status) };
}

function releaseMessage(update) {
  if (!update) return "Checking...";
  if (update.update_available) return `v${update.latest_version} is available${update.stale ? " (cached)" : ""}`;
  if (update.error) return `Offline; v${update.installed_version} remains installed`;
  return `v${update.installed_version} is current`;
}

function pair(label, value, width) {
  return fit(`${label.padEnd(17)} ${safeText(value, 600)}`, width);
}

function fitCell(value, width) {
  const text = safeText(value, width);
  return (text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text).padEnd(width);
}

function fit(value, width) {
  const text = safeText(value, Math.max(width, 1));
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}
