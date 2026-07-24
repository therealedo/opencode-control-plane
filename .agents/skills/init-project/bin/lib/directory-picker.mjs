import { opendir } from "node:fs/promises";
import path from "node:path";
import { safeText } from "../../assets/project/.autopilot/bin/lib/control-plane-ui.mjs";

const MAX_INPUT = 4096;
const MAX_SCAN = 10_000;
const MAX_SUGGESTIONS = 100;

export function parseDirectoryQuery(value, {
  cwd = process.cwd(),
  home,
  pathApi = path,
} = {}) {
  const raw = normalizeInput(value);
  const unquoted = matchingOuterQuotes(raw);
  const expanded = expandHome(unquoted, home, pathApi);
  const windows = pathApi.sep === "\\";
  if (windows && /^[A-Za-z]:(?![\\/])/.test(expanded)) {
    throw new Error("Use an absolute drive path, for example C:\\Projects");
  }
  const absolute = pathApi.isAbsolute(expanded || ".")
    ? pathApi.resolve(expanded || ".")
    : pathApi.resolve(cwd, expanded || ".");
  const trailingSeparator = expanded === "" || (windows ? /[\\/]$/.test(expanded) : expanded.endsWith("/"));
  return {
    raw,
    expanded,
    absolute,
    base: trailingSeparator ? absolute : pathApi.dirname(absolute),
    prefix: trailingSeparator ? "" : pathApi.basename(absolute),
    case_sensitive: !windows,
  };
}

export async function listDirectorySuggestions(value, options = {}) {
  throwIfAborted(options.signal);
  const query = parseDirectoryQuery(value, options);
  const prefix = query.case_sensitive ? query.prefix : query.prefix.toLocaleLowerCase("en-US");
  const matches = [];
  let scanned = 0;
  const directory = await opendir(query.base);
  try {
    while (true) {
      throwIfAborted(options.signal);
      const entry = await directory.read();
      throwIfAborted(options.signal);
      if (!entry) break;
      scanned += 1;
      if (scanned > MAX_SCAN) {
        throw new Error(`Folder is too large to browse safely; paste the exact project path and press Enter`);
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const name = query.case_sensitive ? entry.name : entry.name.toLocaleLowerCase("en-US");
        if (name.startsWith(prefix)) matches.push(entry);
      }
    }
  } finally {
    try { await directory.close(); }
    catch (error) { if (error?.code !== "ERR_DIR_CLOSED") throw error; }
  }
  matches.sort((left, right) => left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: query.case_sensitive ? "variant" : "base",
    }));
  return {
    query,
    suggestions: matches.slice(0, MAX_SUGGESTIONS).map((entry) => ({
      name: entry.name,
      path: options.pathApi?.join(query.base, entry.name) ?? path.join(query.base, entry.name),
    })),
    truncated: matches.length > MAX_SUGGESTIONS,
  };
}

export function completedDirectoryInput(suggestion, { pathApi = path } = {}) {
  if (!suggestion?.path) throw new Error("No folder is selected");
  return withTrailingSeparator(suggestion.path, pathApi);
}

export function parentDirectoryInput(value, options = {}) {
  const pathApi = options.pathApi ?? path;
  const query = parseDirectoryQuery(value, options);
  const parent = query.prefix ? query.base : pathApi.dirname(query.absolute);
  return withTrailingSeparator(parent, pathApi);
}

export function submittedDirectory(query, suggestions, selected) {
  const choice = selected > 0 ? suggestions?.[selected - 1] : null;
  return choice?.path ?? query?.absolute;
}

export function renderDirectoryPicker({
  input = "",
  suggestions = [],
  selected = 0,
  currentPath = "",
  error = "",
  busy = false,
  truncated = false,
  width = 100,
  height = 30,
} = {}) {
  const usable = Math.max(60, Math.min(140, Number(width) || 100));
  const choices = currentPath
    ? [{ name: `Use this folder: ${currentPath}`, current: true }, ...suggestions]
    : suggestions;
  const rows = Math.max(3, Math.min(choices.length, Number(height || 30) - 12));
  const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), Math.max(0, choices.length - rows)));
  const line = "-".repeat(usable);
  const output = [
    "OpenCode Control Plane - Add project",
    "Type a path and the next folders appear below.",
    line,
    fit(`Path: ${safeText(input, MAX_INPUT)}`, usable),
    line,
  ];
  for (let index = start; index < Math.min(choices.length, start + rows); index += 1) {
    const label = choices[index].current ? choices[index].name : `Open: ${choices[index].name}`;
    output.push(fit(`${index === selected ? ">" : " "} ${safeText(label, usable - 2)}`, usable));
  }
  if (choices.length === 0) output.push("  No matching child folders.");
  if (truncated) output.push(fit("  More matches exist; keep typing to narrow the list.", usable));
  output.push(line);
  if (busy) output.push("Checking project folder...", "Please wait while the folder is validated.");
  else output.push(
    "Up/Down: choose   Right/Tab: browse into selected   Enter: add selected",
    "Backspace: edit   Ctrl+U: clear path   Esc: cancel",
  );
  if (error) output.push(line, fit(`Notice: ${safeText(error, 1000)}`, usable));
  return output.join("\n");
}

export async function pickProjectDirectory({
  startDirectory,
  home,
  input = process.stdin,
  output = process.stdout,
  submit,
  signal,
  loadSuggestions = listDirectorySuggestions,
} = {}) {
  if (!input?.isTTY || !output?.isTTY) throw new Error("The folder picker requires an interactive terminal");
  if (typeof submit !== "function") throw new Error("The folder picker requires a submit callback");
  const state = {
    input: withTrailingSeparator(path.resolve(startDirectory ?? process.cwd()), path),
    query: null,
    suggestions: [],
    suggestionsInput: null,
    currentPath: "",
    selected: 0,
    truncated: false,
    error: "",
    busy: false,
    serial: 0,
    stopped: false,
  };

  const draw = () => {
    if (state.stopped) return;
    output.write(`\x1b[H\x1b[2J${renderDirectoryPicker({
      ...state,
      width: output.columns ?? 100,
      height: output.rows ?? 30,
    })}`);
  };
  const refresh = async () => {
    const serial = ++state.serial;
    const expectedInput = state.input;
    try {
      const result = await loadSuggestions(expectedInput, { cwd: process.cwd(), home, signal });
      if (state.stopped || serial !== state.serial || expectedInput !== state.input) return;
      state.query = result.query;
      state.suggestions = result.suggestions;
      state.suggestionsInput = expectedInput;
      state.currentPath = result.query.absolute;
      state.truncated = result.truncated;
      state.selected = result.query.prefix && result.suggestions.length
        ? 1
        : Math.min(state.selected, state.suggestions.length);
      state.error = "";
    } catch (error) {
      if (state.stopped || serial !== state.serial || expectedInput !== state.input) return;
      try { state.query = parseDirectoryQuery(expectedInput, { cwd: process.cwd(), home }); }
      catch { state.query = null; }
      state.suggestions = [];
      state.suggestionsInput = null;
      state.currentPath = state.query?.absolute ?? "";
      state.selected = 0;
      state.truncated = false;
      state.error = error.message;
    }
    draw();
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, error = null) => {
      if (settled) return;
      settled = true;
      state.stopped = true;
      state.serial += 1;
      input.off("keypress", onKey);
      output.off?.("resize", draw);
      signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(null);
    const changeInput = (value) => {
      state.input = value;
      state.query = null;
      state.suggestions = [];
      state.suggestionsInput = null;
      state.currentPath = "";
      state.selected = 0;
      state.truncated = false;
      state.error = "";
      state.serial += 1;
      void refresh().catch((error) => finish(null, error));
    };
    const submitCurrent = async () => {
      if (state.busy) return;
      try {
        const query = parseDirectoryQuery(state.input, { cwd: process.cwd(), home });
        const suggestions = state.suggestionsInput === state.input ? state.suggestions : [];
        const selected = state.suggestionsInput === state.input ? state.selected : 0;
        const candidate = submittedDirectory(query, suggestions, selected);
        state.busy = true;
        state.serial += 1;
        state.error = "";
        draw();
        const result = await submit(candidate);
        finish(result);
      } catch (error) {
        state.busy = false;
        state.error = error.message;
        draw();
      }
    };
    const onKey = (text, key = {}) => {
      if (state.busy) return;
      if (key.ctrl && key.name === "c") return finish(null);
      if (key.ctrl && key.name === "u") {
        changeInput("");
      } else if (key.name === "escape") finish(null);
      else if (key.name === "up" && state.query) {
        const choices = state.suggestions.length + 1;
        state.selected = (state.selected + choices - 1) % choices;
        draw();
      } else if (key.name === "down" && state.query) {
        const choices = state.suggestions.length + 1;
        state.selected = (state.selected + 1) % choices;
        draw();
      } else if (["right", "tab"].includes(key.name) && state.query) {
        const choice = state.selected === 0
          ? { path: state.query.absolute }
          : state.suggestions[state.selected - 1];
        if (choice) changeInput(completedDirectoryInput(choice));
      } else if (key.name === "left") {
        try { changeInput(parentDirectoryInput(state.input, { cwd: process.cwd(), home })); }
        catch (error) { state.error = error.message; return draw(); }
      } else if (key.name === "backspace") {
        changeInput([...state.input].slice(0, -1).join(""));
      } else if (key.name === "return") void submitCurrent();
      else {
        const printable = String(text ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
        if (printable && Buffer.byteLength(state.input + printable, "utf8") <= MAX_INPUT) {
          changeInput(state.input + printable);
        }
      }
    };
    if (signal?.aborted) return finish(null);
    input.on("keypress", onKey);
    output.on?.("resize", draw);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    void refresh().catch((error) => finish(null, error));
  });
}

function normalizeInput(value) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_INPUT) throw new Error(`Folder path exceeds ${MAX_INPUT} bytes`);
  if (/[\x00-\x1f\x7f-\x9f]/.test(text)) throw new Error("Folder path contains control characters");
  return text;
}

function matchingOuterQuotes(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function expandHome(value, home, pathApi) {
  const windows = pathApi.sep === "\\";
  const homePrefix = value.startsWith("~/") || (windows && value.startsWith("~\\"));
  if (value !== "~" && !homePrefix) return value;
  if (!home) throw new Error("Home-folder expansion is unavailable");
  return value === "~" ? home : pathApi.join(home, value.slice(2));
}

function withTrailingSeparator(value, pathApi) {
  const normalized = pathApi.normalize(value);
  return normalized.endsWith(pathApi.sep) ? normalized : `${normalized}${pathApi.sep}`;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Folder browsing was cancelled");
  error.name = "AbortError";
  throw error;
}

function fit(value, width) {
  const text = safeText(value, Math.max(width, 1));
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

export const directoryPickerLimits = Object.freeze({
  max_input_bytes: MAX_INPUT,
  max_scan_entries: MAX_SCAN,
  max_suggestions: MAX_SUGGESTIONS,
});
