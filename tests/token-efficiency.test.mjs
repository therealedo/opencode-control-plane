import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { repositoryRoot, run, scaffoldScript } from "./runtime-helpers.mjs";

const templateRoot = path.join(repositoryRoot, ".agents", "skills", "init-project", "assets", "project");
const renderer = path.join(repositoryRoot, ".agents", "skills", "init-project", "bin", "render-blueprint.mjs");
const fixture = path.join(repositoryRoot, "tests", "fixtures", "insurance-blueprint-v1.json");
const baselineFile = path.join(repositoryRoot, "tests", "fixtures", "token-footprint-v1.1.json");

function bodyBytes(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(text);
  assert.ok(match, "role file must contain frontmatter and a body");
  return Buffer.byteLength(match[1], "utf8");
}

test("context compiler removes only known controller duplication and preserves protected content", async () => {
  const modulePath = path.join(templateRoot, ".autopilot", "bin", "lib", "context-compiler.mjs");
  const { compileContextReference } = await import(pathToFileURL(modulePath).href);
  const protectedBlock = [
    "```text",
    "Never commit, read into prompts, log, or echo secret values.",
    "",
    "",
    "https://example.test/v1 src/auth.ts API_VERSION=2",
    "```",
  ].join("\n");
  const source = [
    "# Security and credentials",
    "",
    "## Project requirements",
    "",
    "- Keep provider-neutral contracts.",
    "- Never commit, read into prompts, log, or echo secret values.",
    "",
    protectedBlock,
    "",
  ].join("\n");
  const compiled = compileContextReference(".project/security.md", source);
  assert.match(compiled.text, /Keep provider-neutral contracts/);
  assert.equal(compiled.text.includes("- Never commit, read into prompts"), false);
  assert.ok(compiled.text.includes(protectedBlock));
  assert.ok(compiled.compiled_bytes < compiled.source_bytes);

  const application = compileContextReference("src/notes.md", source);
  assert.equal(application.text, source);
  assert.equal(application.compiled_bytes, application.source_bytes);
});

test("compact phase-contract limits are identical in deterministic validation", async () => {
  const modulePath = path.join(templateRoot, ".autopilot", "bin", "lib", "contracts.mjs");
  const { validateCandidate, validateReview } = await import(pathToFileURL(modulePath).href);
  const findings = Array.from({ length: 17 }, (_item, index) => ({
    severity: "low",
    file: `src/file-${index}.mjs`,
    message: "Bounded finding.",
  }));
  const reviewIssues = validateReview({
    schema_version: 1,
    task_id: "M001",
    status: "changes_requested",
    summary: "x".repeat(513),
    findings,
  }, "M001");
  assert.ok(reviewIssues.some((issue) => issue.location === "review.summary"));
  assert.ok(reviewIssues.some((issue) => issue.location === "review.findings" && /16/.test(issue.message)));

  const candidateIssues = validateCandidate({
    schema_version: 1,
    task_id: "M001",
    attempt: 1,
    status: "blocked",
    summary: "Bounded candidate.",
    changed_files: [],
    environment_variables: [],
    blocker: {
      kind: "k".repeat(129),
      message: "Needs input.",
      required_action: "Provide input.",
      resume_condition: "Input exists.",
    },
  }, "M001", 1);
  assert.ok(candidateIssues.some((issue) => issue.location === "candidate.blocker.kind"));
});

test("v1.2 cuts at least 45 percent of framework-owned fixed phase context", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocp-token-footprint-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let result = await run([process.execPath, scaffoldScript, "--target", root, "--json"], { cwd: repositoryRoot });
  assert.equal(result.code, 0, result.stderr);
  await copyFile(fixture, path.join(root, ".autopilot", "init", "blueprint.json"));
  result = await run([process.execPath, renderer, "--target", root, "--json"], { cwd: repositoryRoot });
  assert.equal(result.code, 0, result.stderr);

  const contextScript = path.join(root, ".autopilot", "bin", "context-pack.mjs");
  result = await run([process.execPath, contextScript, "--root", root, "--report", "--json"], { cwd: root });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout).tasks.M001;
  const roleRoot = path.join(root, ".opencode", "agents");
  const roleBytes = {
    execute: bodyBytes(await readFile(path.join(roleRoot, "autopilot-worker.md"), "utf8")),
    repair: bodyBytes(await readFile(path.join(roleRoot, "autopilot-recovery.md"), "utf8")),
    review: bodyBytes(await readFile(path.join(roleRoot, "autopilot-reviewer.md"), "utf8")),
  };
  // Isolated phases deliberately use a sterile --dir, so project AGENTS.md is
  // manual-session context and contributes zero bytes here.
  const phases = {
    execute: report.execute.static_bytes + roleBytes.execute,
    repair: report.repair.static_bytes + roleBytes.repair,
    review: report.review.static_bytes + roleBytes.review,
  };
  const total = phases.execute + phases.repair + phases.review;
  const baseline = JSON.parse(await readFile(baselineFile, "utf8"));
  const savedRatio = 1 - total / baseline.total_bytes;

  assert.deepEqual(phases, { execute: 5455, repair: 5162, review: 3051 });
  assert.equal(total, 13668);
  assert.ok(savedRatio >= 0.45, `fixed context reduction was only ${(savedRatio * 100).toFixed(1)}%`);
  for (const phase of Object.values(report)) {
    assert.ok(phase.projected_max_bytes <= 10240);
    assert.ok(phase.compiled_reference_bytes <= phase.source_reference_bytes);
  }

  const contextLibrary = await import(pathToFileURL(path.join(
    root,
    ".autopilot",
    "bin",
    "lib",
    "context-pack.mjs",
  )).href);
  const findings = Array.from({ length: 16 }, (_item, index) => ({
    severity: index === 15 ? "critical" : "low",
    file: `src/area-${index}.mjs`,
    message: `${index === 15 ? "Critical" : "Low"} repair finding ${index}: ${"detail ".repeat(90)}`,
  }));
  const repairPack = await contextLibrary.buildContextPack(root, "M001", {
    stage: "repair",
    extra: {
      schema_version: 1,
      failure: { code: "REVIEW_CHANGES_REQUESTED", message: "Review requested changes." },
      review: { status: "changes_requested", summary: "Address every finding.", findings },
    },
  });
  const evidenceText = repairPack.text.split("## Controller evidence (bounded)\n").at(-1);
  const parsedEvidence = JSON.parse(evidenceText);
  assert.equal(parsedEvidence.review.findings.length, 16);
  assert.equal(parsedEvidence.review.findings[0].severity, "critical");
  assert.ok(repairPack.bytes <= 10240);

  const escapedEvidence = contextLibrary.serializeRepairEvidence({
    schema_version: 1,
    failure: { code: "REVIEW_CHANGES_REQUESTED", message: '"\\'.repeat(800) },
    review: {
      status: "changes_requested",
      summary: '"\\'.repeat(800),
      findings: findings.map((finding) => ({
        ...finding,
        message: '"\\'.repeat(800),
      })),
    },
  }, contextLibrary.MIN_REPAIR_EVIDENCE_BYTES);
  assert.ok(Buffer.byteLength(escapedEvidence, "utf8") <= contextLibrary.MIN_REPAIR_EVIDENCE_BYTES);
  assert.equal(JSON.parse(escapedEvidence).review.findings.length, 16);

  const manifestFile = path.join(root, ".project", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const headingBytes = Buffer.byteLength(contextLibrary.CONTEXT_EVIDENCE_HEADINGS.repair, "utf8");
  manifest.max_context_bytes = report.repair.static_bytes + headingBytes +
    contextLibrary.MIN_REPAIR_EVIDENCE_BYTES - 1;
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await assert.rejects(
    contextLibrary.buildContextPack(root, "M001", { stage: "repair" }),
    (error) => error?.code === "REPAIR_RESERVE_EXCEEDS_CAP",
  );
});
