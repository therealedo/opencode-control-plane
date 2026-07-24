import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateUsage,
  aggregateEvaluationTelemetry,
  collectStrictOpenCodeUsage,
  collectEvaluationTelemetry,
  emptyUsage,
  formatEvaluationTelemetryMarkdown,
  MODEL_USAGE_FIELDS,
  renderUsageColumns,
} from "../scripts/lib/evaluation-telemetry.mjs";

function event(sessionID, partID, {
  timestamp = 1_787_000_000_000,
  input = 100,
  output = 20,
  reasoning = 5,
  cacheRead = 50,
  cacheWrite = 10,
  cost = 0.125,
  total,
  messageID = `msg-${sessionID}`,
} = {}) {
  return {
    type: "step_finish",
    timestamp,
    sessionID,
    part: {
      id: partID,
      sessionID,
      messageID,
      type: "step-finish",
      reason: "stop",
      cost,
      tokens: {
        ...(total === undefined ? {} : { total }),
        input,
        output,
        reasoning,
        cache: { read: cacheRead, write: cacheWrite },
      },
    },
  };
}

function ndjson(...events) {
  return `${events.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

test("strict collector aggregates expected sessions and deduplicates exact step IDs", () => {
  const first = event("ses-a", "prt-a1");
  const result = collectEvaluationTelemetry(ndjson(
    { type: "step_start", timestamp: 1_787_000_000_000, sessionID: "ses-a", part: {} },
    first,
    first,
    event("ses-a", "prt-a2", {
      input: 30, output: 4, reasoning: 1, cacheRead: 20, cacheWrite: 0, cost: 0.375,
    }),
    event("ses-b", "prt-b1", {
      input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
    }),
  ), { expectedSessionIds: ["ses-a", "ses-b"] });

  assert.equal(result.status, "complete");
  assert.equal(result.comparable, true);
  assert.equal(result.step_count, 3);
  assert.equal(result.duplicate_step_events, 1);
  assert.deepEqual(result.usage, {
    input_tokens: 130,
    output_tokens: 24,
    reasoning_tokens: 6,
    cache_read_tokens: 70,
    cache_write_tokens: 10,
    provider_cost: 0.5,
  });
  assert.equal(result.sessions["ses-b"].usage.input_tokens, 0, "observed zero remains zero");
  assert.equal(Object.hasOwn(result.usage, "total_tokens"), false);
  assert.deepEqual(MODEL_USAGE_FIELDS, [
    "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens",
  ]);
});

test("missing expected usage is non-comparable and uses null dimensions", () => {
  const partial = collectEvaluationTelemetry(ndjson(event("ses-a", "prt-a1")), {
    expectedSessionIds: ["ses-a", "ses-b"],
  });
  assert.equal(partial.status, "partial");
  assert.equal(partial.comparable, false);
  assert.equal(partial.usage.input_tokens, null);
  assert.equal(partial.sessions["ses-a"].usage.input_tokens, 100);
  assert.equal(partial.sessions["ses-b"].usage.input_tokens, null);
  assert.ok(partial.diagnostics.some((item) => item.code === "MISSING_USAGE"));

  const unavailable = collectEvaluationTelemetry("", { expectedSessionIds: ["ses-a"] });
  assert.equal(unavailable.status, "unavailable");
  assert.deepEqual(Object.values(unavailable.usage), [null, null, null, null, null, null]);
});

test("malformed, unexpected, and conflicting events invalidate comparison", () => {
  const malformed = collectEvaluationTelemetry("{not-json\n", { expectedSessionIds: ["ses-a"] });
  assert.equal(malformed.status, "invalid");
  assert.equal(malformed.usage.input_tokens, null);
  assert.ok(malformed.diagnostics.some((item) => item.code === "NDJSON_INVALID"));

  const unexpected = collectEvaluationTelemetry(ndjson(event("ses-other", "prt-1")), {
    expectedSessionIds: ["ses-a"],
  });
  assert.equal(unexpected.status, "invalid");
  assert.ok(unexpected.diagnostics.some((item) => item.code === "UNEXPECTED_SESSION"));

  const original = event("ses-a", "prt-a1");
  const conflict = event("ses-a", "prt-a1", { input: 101 });
  const conflicting = collectEvaluationTelemetry(ndjson(original, conflict), {
    expectedSessionIds: ["ses-a"],
  });
  assert.equal(conflicting.status, "invalid");
  assert.ok(conflicting.diagnostics.some((item) => item.code === "STEP_ID_CONFLICT"));
});

test("invalid usage and truncated output never expose partial totals", () => {
  const invalidEvent = event("ses-a", "prt-a1", { reasoning: -1 });
  const invalid = collectEvaluationTelemetry(ndjson(invalidEvent), { expectedSessionIds: ["ses-a"] });
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.usage.reasoning_tokens, null);
  assert.ok(invalid.diagnostics.some((item) => item.code === "STEP_USAGE_INVALID"));

  const truncated = collectEvaluationTelemetry(ndjson(event("ses-a", "prt-a1")), {
    expectedSessionIds: ["ses-a"],
    truncated: true,
  });
  assert.equal(truncated.status, "invalid");
  assert.deepEqual(Object.values(truncated.usage), [null, null, null, null, null, null]);
  assert.ok(truncated.diagnostics.some((item) => item.code === "OUTPUT_TRUNCATED"));
});

test("collector validates session and part identity boundaries", () => {
  assert.throws(
    () => collectEvaluationTelemetry("", { expectedSessionIds: [] }),
    /at least one session ID/,
  );
  assert.throws(
    () => collectEvaluationTelemetry("", { expectedSessionIds: ["ses-a", "ses-a"] }),
    /must not contain duplicates/,
  );

  const mismatch = event("ses-a", "prt-a1");
  mismatch.part.sessionID = "ses-b";
  const result = collectEvaluationTelemetry(ndjson(mismatch), { expectedSessionIds: ["ses-a"] });
  assert.equal(result.status, "invalid");
  assert.ok(result.diagnostics.some((item) => item.code === "STEP_SESSION_CONFLICT"));
});

test("aggregate helper sums only complete runs and keeps all dimensions separate", () => {
  const first = collectEvaluationTelemetry(ndjson(event("ses-a", "prt-a1")), {
    expectedSessionIds: ["ses-a"],
  });
  const second = collectEvaluationTelemetry(ndjson(event("ses-b", "prt-b1", {
    input: 7, output: 3, reasoning: 2, cacheRead: 5, cacheWrite: 1, cost: 0.25,
  })), { expectedSessionIds: ["ses-b"] });
  const aggregate = aggregateEvaluationTelemetry([first, second]);

  assert.equal(aggregate.status, "complete");
  assert.deepEqual(aggregate.usage, {
    input_tokens: 107,
    output_tokens: 23,
    reasoning_tokens: 7,
    cache_read_tokens: 55,
    cache_write_tokens: 11,
    provider_cost: 0.375,
  });
  assert.equal(Object.hasOwn(aggregate.usage, "total_tokens"), false);
});

test("aggregate helper withholds usage when any run is incomplete or overflows", () => {
  const complete = collectEvaluationTelemetry(ndjson(event("ses-a", "prt-a1")), {
    expectedSessionIds: ["ses-a"],
  });
  const partial = collectEvaluationTelemetry("", { expectedSessionIds: ["ses-b"] });
  const withheld = aggregateEvaluationTelemetry([complete, partial]);
  assert.equal(withheld.status, "partial");
  assert.equal(withheld.comparable, false);
  assert.equal(withheld.usage.input_tokens, null);

  const huge = structuredClone(complete);
  huge.usage.input_tokens = Number.MAX_SAFE_INTEGER;
  const overflow = aggregateEvaluationTelemetry([huge, complete]);
  assert.equal(overflow.status, "invalid");
  assert.equal(overflow.usage.input_tokens, null);
});

test("Markdown formatter is stable and does not invent a token total", () => {
  const result = collectEvaluationTelemetry(ndjson(event("ses-a", "prt-a1")), {
    expectedSessionIds: ["ses-a"],
  });
  const markdown = formatEvaluationTelemetryMarkdown(result);
  assert.match(markdown, /^### Evaluation telemetry\n\n\| Metric \| Value \|/);
  assert.match(markdown, /\| Cache-read tokens \| 50 \|/);
  assert.match(markdown, /\| Reasoning tokens \| 5 \|/);
  assert.doesNotMatch(markdown, /total tokens/i);
  assert.equal(markdown.endsWith("\n"), true);
});

test("stable runner API discovers sessions, aggregates usage, and renders fixed columns", () => {
  const first = collectStrictOpenCodeUsage(ndjson(event("ses-a", "prt-a1")));
  const second = collectStrictOpenCodeUsage(ndjson(event("ses-b", "prt-b1", {
    input: 2, output: 3, reasoning: 4, cacheRead: 5, cacheWrite: 6, cost: 0.25,
  })));
  assert.deepEqual(first.expected_sessions, ["ses-a"]);

  const aggregate = aggregateUsage([first, second]);
  assert.deepEqual(aggregate, {
    status: "complete",
    input_tokens: 102,
    output_tokens: 23,
    reasoning_tokens: 9,
    cache_read_tokens: 55,
    cache_write_tokens: 16,
    provider_cost: 0.375,
  });
  assert.deepEqual(emptyUsage(), {
    status: "unavailable",
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    provider_cost: null,
  });
  const columns = renderUsageColumns(aggregate);
  assert.deepEqual(columns.map((column) => column.key), [
    "input_tokens", "cache_read_tokens", "cache_write_tokens",
    "reasoning_tokens", "output_tokens", "provider_cost",
  ]);
  assert.equal(columns.some((column) => /total/i.test(column.label)), false);

  const empty = collectStrictOpenCodeUsage("");
  assert.equal(empty.status, "unavailable");
  assert.equal(empty.usage.input_tokens, null);
});
