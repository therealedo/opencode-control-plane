const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PART_ID_PATTERN = SESSION_ID_PATTERN;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const MODEL_USAGE_FIELDS = Object.freeze([
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
]);

const ALL_USAGE_FIELDS = Object.freeze([...MODEL_USAGE_FIELDS, "provider_cost"]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nullUsage() {
  return Object.fromEntries(ALL_USAGE_FIELDS.map((field) => [field, null]));
}

function zeroUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    provider_cost: 0,
  };
}

export function emptyUsage(status = "unavailable") {
  if (!["complete", "partial", "unavailable", "invalid"].includes(status)) {
    throw new TypeError("usage status must be complete, partial, unavailable, or invalid");
  }
  return {
    status,
    ...(status === "complete" ? zeroUsage() : nullUsage()),
  };
}

function diagnostic(code, message, details = {}) {
  return { code, message, ...details };
}

function normalizeExpectedSessions(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("expectedSessionIds must contain at least one session ID");
  }
  const sessions = [];
  const seen = new Set();
  for (const sessionId of value) {
    if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new TypeError("expectedSessionIds contains an invalid session ID");
    }
    if (seen.has(sessionId)) throw new TypeError("expectedSessionIds must not contain duplicates");
    seen.add(sessionId);
    sessions.push(sessionId);
  }
  return sessions;
}

function normalizedOutput(value) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  throw new TypeError("OpenCode NDJSON output must be a string or Uint8Array");
}

function validToken(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validCost(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function addUsage(target, source) {
  for (const field of MODEL_USAGE_FIELDS) {
    const next = target[field] + source[field];
    if (!Number.isSafeInteger(next)) return false;
    target[field] = next;
  }
  const nextCost = target.provider_cost + source.provider_cost;
  if (!Number.isFinite(nextCost) || nextCost < 0) return false;
  target.provider_cost = nextCost;
  return true;
}

function stepUsage(event, line) {
  const part = event.part;
  if (
    !plainObject(part) ||
    part.type !== "step-finish" ||
    typeof part.id !== "string" ||
    !PART_ID_PATTERN.test(part.id) ||
    typeof part.messageID !== "string" ||
    !PART_ID_PATTERN.test(part.messageID) ||
    typeof part.sessionID !== "string" ||
    !SESSION_ID_PATTERN.test(part.sessionID) ||
    !plainObject(part.tokens) ||
    !plainObject(part.tokens.cache)
  ) {
    return {
      error: diagnostic(
        "STEP_FINISH_INVALID",
        "step_finish must contain safe part identity and a documented token object",
        { line },
      ),
    };
  }
  if (part.sessionID !== event.sessionID) {
    return {
      error: diagnostic(
        "STEP_SESSION_CONFLICT",
        "step_finish part session does not match its top-level event session",
        { line, session_id: event.sessionID },
      ),
    };
  }
  const usage = {
    input_tokens: part.tokens.input,
    output_tokens: part.tokens.output,
    reasoning_tokens: part.tokens.reasoning,
    cache_read_tokens: part.tokens.cache.read,
    cache_write_tokens: part.tokens.cache.write,
    provider_cost: part.cost,
  };
  if (
    MODEL_USAGE_FIELDS.some((field) => !validToken(usage[field])) ||
    !validCost(usage.provider_cost) ||
    (part.tokens.total !== undefined && !validToken(part.tokens.total))
  ) {
    return {
      error: diagnostic(
        "STEP_USAGE_INVALID",
        "step_finish token dimensions must be non-negative safe integers and cost must be finite",
        { line, session_id: event.sessionID, part_id: part.id },
      ),
    };
  }
  const identity = {
    session_id: event.sessionID,
    part_id: part.id,
    message_id: part.messageID,
    usage,
    reported_total: part.tokens.total ?? null,
  };
  return { identity, fingerprint: JSON.stringify(identity) };
}

function sessionProjection(sessionId, state) {
  if (state.steps.size === 0) {
    return {
      session_id: sessionId,
      status: "unavailable",
      step_count: 0,
      duplicate_step_events: state.duplicates,
      usage: nullUsage(),
    };
  }
  const usage = zeroUsage();
  for (const step of state.steps.values()) {
    if (!addUsage(usage, step.identity.usage)) {
      return {
        session_id: sessionId,
        status: "invalid",
        step_count: state.steps.size,
        duplicate_step_events: state.duplicates,
        usage: nullUsage(),
      };
    }
  }
  return {
    session_id: sessionId,
    status: "complete",
    step_count: state.steps.size,
    duplicate_step_events: state.duplicates,
    usage,
  };
}

/**
 * Strictly collect provider-reported usage from one or more OpenCode
 * `run --format json` streams. Missing or invalid telemetry is represented as
 * non-comparable with null usage dimensions; it is never converted to zero.
 */
export function collectEvaluationTelemetry(output, {
  expectedSessionIds,
  truncated = false,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  const expected = normalizeExpectedSessions(expectedSessionIds);
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 64 * 1024 * 1024) {
    throw new RangeError("maxOutputBytes must be between 1 and 67108864");
  }
  const text = normalizedOutput(output);
  const states = new Map(expected.map((sessionId) => [sessionId, {
    eventCount: 0,
    duplicates: 0,
    steps: new Map(),
  }]));
  const expectedSet = new Set(expected);
  const globalParts = new Map();
  const diagnostics = [];
  let invalid = false;

  if (truncated) {
    diagnostics.push(diagnostic("OUTPUT_TRUNCATED", "OpenCode output was truncated before evaluation"));
    invalid = true;
  }
  if (Buffer.byteLength(text, "utf8") > maxOutputBytes) {
    diagnostics.push(diagnostic("OUTPUT_TOO_LARGE", "OpenCode output exceeded the evaluation byte cap"));
    invalid = true;
  }

  if (!invalid) {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index];
      if (!raw.trim()) continue;
      const line = index + 1;
      let event;
      try { event = JSON.parse(raw); }
      catch {
        diagnostics.push(diagnostic("NDJSON_INVALID", "OpenCode output contains malformed JSON", { line }));
        invalid = true;
        continue;
      }
      if (
        !plainObject(event) ||
        typeof event.type !== "string" ||
        !event.type ||
        !Number.isSafeInteger(event.timestamp) ||
        event.timestamp < 0 ||
        typeof event.sessionID !== "string" ||
        !SESSION_ID_PATTERN.test(event.sessionID)
      ) {
        diagnostics.push(diagnostic("EVENT_INVALID", "OpenCode JSON event has an invalid envelope", { line }));
        invalid = true;
        continue;
      }
      if (!expectedSet.has(event.sessionID)) {
        diagnostics.push(diagnostic(
          "UNEXPECTED_SESSION",
          "OpenCode output contains an event for an unexpected session",
          { line, session_id: event.sessionID },
        ));
        invalid = true;
        continue;
      }
      const state = states.get(event.sessionID);
      state.eventCount += 1;
      if (event.type !== "step_finish") continue;

      const parsed = stepUsage(event, line);
      if (parsed.error) {
        diagnostics.push(parsed.error);
        invalid = true;
        continue;
      }
      const previous = globalParts.get(parsed.identity.part_id);
      if (previous) {
        if (previous.fingerprint !== parsed.fingerprint) {
          diagnostics.push(diagnostic(
            "STEP_ID_CONFLICT",
            "A step-finish part ID was reused with different telemetry",
            { line, session_id: event.sessionID, part_id: parsed.identity.part_id },
          ));
          invalid = true;
        } else {
          state.duplicates += 1;
        }
        continue;
      }
      globalParts.set(parsed.identity.part_id, parsed);
      state.steps.set(parsed.identity.part_id, parsed);
    }
  }

  const sessions = Object.fromEntries(expected.map((sessionId) => {
    const projection = sessionProjection(sessionId, states.get(sessionId));
    if (projection.status === "invalid") {
      diagnostics.push(diagnostic(
        "USAGE_OVERFLOW",
        "Session usage exceeds safe numeric aggregation limits",
        { session_id: sessionId },
      ));
      invalid = true;
    } else if (projection.status === "unavailable") {
      diagnostics.push(diagnostic(
        "MISSING_USAGE",
        "Expected session has no valid step_finish usage",
        { session_id: sessionId },
      ));
    }
    return [sessionId, projection];
  }));
  const completeSessions = Object.values(sessions).filter((session) => session.status === "complete");
  let status;
  if (invalid) status = "invalid";
  else if (completeSessions.length === expected.length) status = "complete";
  else if (completeSessions.length === 0) status = "unavailable";
  else status = "partial";

  const usage = status === "complete" ? zeroUsage() : nullUsage();
  if (status === "complete") {
    for (const session of completeSessions) {
      if (!addUsage(usage, session.usage)) {
        status = "invalid";
        Object.assign(usage, nullUsage());
        diagnostics.push(diagnostic("USAGE_OVERFLOW", "Combined session usage exceeds safe numeric limits"));
        break;
      }
    }
  }

  return {
    schema_version: 1,
    status,
    comparable: status === "complete",
    expected_sessions: expected,
    observed_sessions: expected.filter((sessionId) => states.get(sessionId).eventCount > 0),
    session_count: expected.length,
    step_count: Object.values(sessions).reduce((total, session) => total + session.step_count, 0),
    duplicate_step_events: Object.values(sessions)
      .reduce((total, session) => total + session.duplicate_step_events, 0),
    usage,
    sessions,
    diagnostics,
  };
}

function discoverSessionIds(output) {
  const text = normalizedOutput(output);
  const sessions = [];
  const seen = new Set();
  let malformed = false;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let event;
    try { event = JSON.parse(raw); }
    catch { malformed = true; continue; }
    if (!plainObject(event) || typeof event.sessionID !== "string" || !SESSION_ID_PATTERN.test(event.sessionID)) {
      malformed = true;
      continue;
    }
    if (!seen.has(event.sessionID)) {
      seen.add(event.sessionID);
      sessions.push(event.sessionID);
    }
  }
  return { sessions, malformed, text };
}

/** Stable runner-facing collector. When expectedSessionIds is omitted, the
 * bounded stream is self-scoped to every safe top-level session it contains. */
export function collectStrictOpenCodeUsage(output, options = {}) {
  if (!plainObject(options)) throw new TypeError("collector options must be an object");
  if (options.expectedSessionIds !== undefined) {
    return collectEvaluationTelemetry(output, options);
  }
  const discovered = discoverSessionIds(output);
  if (discovered.sessions.length > 0) {
    return collectEvaluationTelemetry(discovered.text, {
      ...options,
      expectedSessionIds: discovered.sessions,
    });
  }
  const invalid = options.truncated === true || discovered.malformed;
  return {
    schema_version: 1,
    status: invalid ? "invalid" : "unavailable",
    comparable: false,
    expected_sessions: [],
    observed_sessions: [],
    session_count: 0,
    step_count: 0,
    duplicate_step_events: 0,
    usage: nullUsage(),
    sessions: {},
    diagnostics: [diagnostic(
      invalid ? (options.truncated === true ? "OUTPUT_TRUNCATED" : "NDJSON_INVALID") : "MISSING_USAGE",
      invalid ? "OpenCode output cannot provide a complete telemetry stream" : "OpenCode output contains no usage session",
    )],
  };
}

/** Aggregate only complete collectors. Any incomplete input makes aggregate
 * usage unavailable instead of presenting a misleading partial sum. */
export function aggregateEvaluationTelemetry(results) {
  if (!Array.isArray(results)) throw new TypeError("results must be an array");
  if (results.length === 0) {
    return {
      schema_version: 1,
      status: "unavailable",
      comparable: false,
      run_count: 0,
      comparable_run_count: 0,
      session_count: 0,
      step_count: 0,
      usage: nullUsage(),
      diagnostics: [diagnostic("NO_RUNS", "No evaluation telemetry runs were supplied")],
    };
  }
  for (const result of results) {
    if (!plainObject(result) || result.schema_version !== 1 || !plainObject(result.usage)) {
      throw new TypeError("results contains an invalid evaluation telemetry object");
    }
  }
  const comparable = results.filter((result) => result.comparable === true && result.status === "complete");
  const base = {
    schema_version: 1,
    run_count: results.length,
    comparable_run_count: comparable.length,
    session_count: results.reduce((total, result) => total + Number(result.session_count ?? 0), 0),
    step_count: results.reduce((total, result) => total + Number(result.step_count ?? 0), 0),
  };
  if (comparable.length !== results.length) {
    const status = results.some((result) => result.status === "invalid") ? "invalid" : "partial";
    return {
      ...base,
      status,
      comparable: false,
      usage: nullUsage(),
      diagnostics: [diagnostic(
        "INCOMPLETE_RUNS",
        "At least one run lacks complete comparable telemetry; aggregate usage is unavailable",
        { incomplete_runs: results.length - comparable.length },
      )],
    };
  }

  const usage = zeroUsage();
  let overflow = false;
  for (const result of comparable) {
    if (
      MODEL_USAGE_FIELDS.some((field) => !validToken(result.usage[field])) ||
      !validCost(result.usage.provider_cost) ||
      !addUsage(usage, result.usage)
    ) {
      overflow = true;
      break;
    }
  }
  if (overflow) {
    return {
      ...base,
      status: "invalid",
      comparable: false,
      usage: nullUsage(),
      diagnostics: [diagnostic("USAGE_OVERFLOW", "Aggregate usage exceeds safe numeric limits")],
    };
  }
  return {
    ...base,
    status: "complete",
    comparable: true,
    usage,
    diagnostics: [],
  };
}

function usageRecord(value) {
  if (!plainObject(value)) throw new TypeError("usage entry must be an object");
  if (plainObject(value.usage)) {
    return { status: value.status, usage: value.usage };
  }
  const inferred = MODEL_USAGE_FIELDS.every((field) => validToken(value[field])) &&
    validCost(value.provider_cost);
  return { status: value.status ?? (inferred ? "complete" : "unavailable"), usage: value };
}

/** Stable runner-facing aggregation of usage objects or collector results. */
export function aggregateUsage(usages) {
  if (!Array.isArray(usages)) throw new TypeError("usages must be an array");
  if (usages.length === 0) return emptyUsage();
  const records = usages.map(usageRecord);
  if (records.some((record) => record.status !== "complete")) {
    return emptyUsage(records.some((record) => record.status === "invalid") ? "invalid" : "partial");
  }
  const aggregate = zeroUsage();
  for (const record of records) {
    if (
      MODEL_USAGE_FIELDS.some((field) => !validToken(record.usage[field])) ||
      !validCost(record.usage.provider_cost) ||
      !addUsage(aggregate, record.usage)
    ) return emptyUsage("invalid");
  }
  return { status: "complete", ...aggregate };
}

const USAGE_COLUMNS = Object.freeze([
  ["input_tokens", "Input tokens"],
  ["cache_read_tokens", "Cache-read tokens"],
  ["cache_write_tokens", "Cache-write tokens"],
  ["reasoning_tokens", "Reasoning tokens"],
  ["output_tokens", "Output tokens"],
  ["provider_cost", "Provider-reported cost"],
]);

/** Stable ordered reporting columns. There is deliberately no universal
 * total-token column because provider dimensions can overlap. */
export function renderUsageColumns(value) {
  if (!plainObject(value)) throw new TypeError("usage must be an object");
  const usage = plainObject(value.usage) ? value.usage : value;
  return USAGE_COLUMNS.map(([key, label]) => ({
    key,
    label,
    value: usage[key] ?? null,
    display: displayValue(usage[key]),
  }));
}

function displayValue(value) {
  if (value === null || value === undefined) return "unavailable";
  return typeof value === "number" ? String(value) : String(value).replace(/[\r\n|]/g, " ");
}

/** Render fixed, Markdown-safe usage dimensions without a synthetic total. */
export function formatEvaluationTelemetryMarkdown(result) {
  if (!plainObject(result) || !plainObject(result.usage)) {
    throw new TypeError("result must be an evaluation telemetry object");
  }
  const rows = [
    ["Status", result.status],
    ["Comparable", result.comparable === true ? "yes" : "no"],
    ...renderUsageColumns(result.usage).map((column) => [column.label, column.value]),
    ["Sessions", result.session_count],
    ["Steps", result.step_count],
  ];
  return [
    "### Evaluation telemetry",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    ...rows.map(([name, value]) => `| ${name} | ${displayValue(value)} |`),
    "",
  ].join("\n");
}
