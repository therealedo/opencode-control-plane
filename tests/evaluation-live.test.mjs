import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { preflightLiveEvaluation, runLiveTrial } from "../scripts/lib/evaluation-live.mjs";

const testsRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testsRoot, "..");

async function fixture(t, caseId, { emitUsage = true } = {}) {
  const runRoot = await mkdtemp(path.join(os.tmpdir(), "ocp-live-evaluation-"));
  t.after(async () => rm(runRoot, { recursive: true, force: true }));
  const workspace = path.join(runRoot, "workspace");
  const candidate = path.join(workspace, `${caseId}-candidate`);
  const caseDirectory = path.join(repositoryRoot, "evaluation", "corpus", caseId);
  await mkdir(workspace, { recursive: true });
  await cp(path.join(caseDirectory, "seed"), candidate, { recursive: true });
  const fake = path.join(runRoot, "fake-opencode.mjs");
  await writeFile(fake, fakeSource(path.join(caseDirectory, "solution"), emitUsage), "utf8");
  const caseRecord = JSON.parse(await readFile(path.join(caseDirectory, "case.json"), "utf8"));
  const taskText = await readFile(path.join(caseDirectory, caseRecord.task_file), "utf8");
  const profile = {
    schema_version: 1,
    model: "test-provider/test-model",
    variant: "high",
    opencode_command: [process.execPath, fake],
    provider_auth_mode: "none",
    provider_environment: [],
    strategies: ["direct", "fresh_loop", "control_plane"],
    attempt_limit: 3,
    timeout_seconds: 60,
    max_output_bytes: 1024 * 1024,
  };
  return { repositoryRoot, runRoot, workspace, candidate, caseDirectory, caseRecord, taskText, profile };
}

function fakeSource(solution, emitUsage) {
  return `import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";\nimport path from "node:path";\nconst argv=process.argv.slice(2);\nif(argv.includes("--version")){process.stdout.write("fake-opencode 1.0.0\\n");process.exit(0)}\nif(argv.includes("--help")){process.stdout.write("Usage: opencode run [message]\\n");process.exit(0)}\nconst index=argv.indexOf("--dir");\nconst launch=index>=0?path.resolve(argv[index+1]):process.cwd();\nlet root=launch;\ntry{const policy=JSON.parse(Buffer.from(process.env.AUTOPILOT_TOOL_POLICY??"","base64").toString("utf8"));if(path.isAbsolute(policy.root??""))root=path.resolve(policy.root)}catch{}\nconst prompt=argv.at(-1)??"";\nconst stage=/^Stage:\\s*(\\S+)/m.exec(prompt)?.[1]??"execute";\nconst task=/^Task:\\s*(\\S+)/m.exec(prompt)?.[1]??"M001";\nconst attempt=Number(/^Attempt:\\s*(\\d+)/m.exec(prompt)?.[1]??1);\nconst runtime=path.join(root,".autopilot","runtime");\nawait mkdir(runtime,{recursive:true});\nasync function files(directory,prefix=""){const output=[];for(const entry of await readdir(directory,{withFileTypes:true})){const relative=prefix?prefix+"/"+entry.name:entry.name;const location=path.join(directory,entry.name);if(entry.isDirectory())output.push(...await files(location,relative));else if(entry.isFile())output.push(relative)}return output}\nif(stage==="review"){await writeFile(path.join(runtime,"review.json"),JSON.stringify({schema_version:1,task_id:task,status:"approved",summary:"Independent fake review approved bounded evidence.",findings:[]},null,2)+"\\n","utf8")}else{const changed=await files(${JSON.stringify(solution)});await cp(${JSON.stringify(solution)},root,{recursive:true,force:true});await writeFile(path.join(runtime,"candidate.json"),JSON.stringify({schema_version:1,task_id:task,attempt,status:"complete",summary:"Fake live worker completed the bounded task.",changed_files:changed,environment_variables:[],blocker:null},null,2)+"\\n","utf8")}\nconst session="eval-"+stage+"-a"+attempt+"-p"+process.pid;\nconst timestamp=Date.now();\nprocess.stdout.write(JSON.stringify({type:"session",timestamp,sessionID:session})+"\\n");\n${emitUsage ? 'process.stdout.write(JSON.stringify({type:"step_finish",timestamp:timestamp+1,sessionID:session,part:{id:"part-"+session,messageID:"msg-"+session,sessionID:session,type:"step-finish",reason:"stop",cost:0.01,tokens:{total:19,input:10,output:5,reasoning:2,cache:{read:2,write:1}}}})+"\\n");' : ""}\n`;
}

function trial(fixtureValue, strategy, repetition = 1) {
  return runLiveTrial({ ...fixtureValue, strategy, repetition });
}

test("live preflight is zero-model and validates the fixed profile", async (t) => {
  const value = await fixture(t, "greenfield");
  const result = await preflightLiveEvaluation({ profile: value.profile });
  assert.equal(result.ok, true);
  assert.equal(result.zero_model, true);
  assert.equal(result.model, "test-provider/test-model");
  assert.equal(result.variant, "high");
  assert.equal(result.provider_auth_mode, "none");

  await assert.rejects(
    preflightLiveEvaluation({ profile: { ...value.profile, opencode_command: [process.execPath, "--session", "bad"] } }),
    /session-reuse flags are forbidden/,
  );
});

test("direct live trial uses one fresh session and exposes no raw model output", async (t) => {
  const value = await fixture(t, "greenfield");
  const result = await trial(value, "direct");
  assert.equal(result.status, "accepted", JSON.stringify(result, null, 2));
  assert.equal(result.accepted, true);
  assert.equal(result.comparable, true);
  assert.equal(result.attempt_count, 1);
  assert.equal(result.telemetry.usage.input_tokens, 10);
  assert.equal(result.telemetry.usage.cache_read_tokens, 2);
  assert.equal(result.telemetry.usage.reasoning_tokens, 2);
  assert.equal(result.held_out_gate.ok, true);
  assert.deepEqual(result.strategy_gates, {
    run_count: 1,
    failed_count: 0,
    failure_evidence: [],
  });
  assert.equal(JSON.stringify(result).includes("step_finish"), false);
  assert.equal(JSON.stringify(result).includes("Fake live worker completed"), false);
});

test("fresh loop consumes one forced failure then repairs in a new session", async (t) => {
  const value = await fixture(t, "failed-verification");
  const result = await trial(value, "fresh_loop");
  assert.equal(result.status, "accepted", JSON.stringify(result, null, 2));
  assert.equal(result.attempt_count, 2);
  assert.equal(result.attempts[0].session_ids.length, 1);
  assert.equal(result.attempts[1].session_ids.length, 1);
  assert.notEqual(result.attempts[0].session_ids[0], result.attempts[1].session_ids[0]);
  assert.equal(result.telemetry.usage.input_tokens, 20);
  assert.equal(result.held_out_gate.forced, false);
  assert.equal(result.held_out_gate.ok, true);
  assert.deepEqual(result.strategy_gates, {
    run_count: 2,
    failed_count: 1,
    failure_evidence: [{ attempt: 1, code: "forced_verification_failure" }],
  });
});

test("missing provider usage remains incomplete even when the held-out gate passes", async (t) => {
  const value = await fixture(t, "greenfield", { emitUsage: false });
  const result = await trial(value, "direct");
  assert.equal(result.accepted, true);
  assert.equal(result.status, "non_comparable");
  assert.equal(result.comparable, false);
  assert.equal(result.telemetry.status, "partial");
  assert.equal(result.telemetry.usage.input_tokens, null);
});

test("Control Plane live trial scaffolds the disposable candidate, repairs once, and reads receipt telemetry", async (t) => {
  const value = await fixture(t, "failed-verification");
  const result = await trial(value, "control_plane");
  assert.equal(result.status, "accepted", JSON.stringify(result, null, 2));
  assert.equal(result.accepted, true);
  assert.equal(result.comparable, true);
  assert.equal(result.receipt.task_id, "M001");
  assert.deepEqual(result.receipt.changed_files, ["src/commission.mjs"]);
  assert.equal(result.receipt.gate_success, true);
  assert.equal(result.receipt.review_status, "approved");
  assert.equal(result.repair_count, 1);
  assert.equal(result.attempt_count, 2);
  assert.deepEqual(result.strategy_gates, {
    run_count: 5,
    failed_count: 1,
    failure_evidence: [{ attempt: 1, code: "controller_gate_failed_then_repaired" }],
  });
  assert.ok(result.telemetry.session_count >= 3);
  assert.equal(result.held_out_gate.ok, true);
  assert.equal(await readFile(path.join(value.candidate, "src", "commission.mjs"), "utf8").then((text) => text.includes("commissionCents")), true);
});

test("Control Plane live trial resumes from its disposable crash boundary", async (t) => {
  const value = await fixture(t, "interruption-recovery");
  const result = await trial(value, "control_plane");
  assert.equal(result.status, "accepted", JSON.stringify(result, null, 2));
  assert.equal(result.interruption.attempted, true);
  assert.equal(result.interruption.boundary, "after_app_commit");
  assert.equal(result.interruption.observed_exit_code, 86);
  assert.equal(result.interruption.recovered, true);
  assert.equal(result.recovery_count, 1);
  assert.deepEqual(result.receipt.changed_files, ["src/call-log.mjs"]);
  assert.equal(result.held_out_gate.ok, true);
});

test("Control Plane receipt telemetry fails closed on malformed, conflicting, or truncated streams", async (t) => {
  for (const scenario of [
    {
      name: "malformed",
      append: 'process.stdout.write("not-json\\n");\n',
      code: "OPENCODE_USAGE_INVALID",
    },
    {
      name: "conflicting",
      append: 'process.stdout.write(JSON.stringify({type:"step_finish",timestamp:Date.now()+2,sessionID:session,part:{id:"part-"+session,messageID:"msg-"+session,sessionID:session,type:"step-finish",reason:"stop",cost:0.01,tokens:{total:20,input:11,output:5,reasoning:2,cache:{read:2,write:1}}}})+"\\n");\n',
      code: "OPENCODE_USAGE_INVALID",
    },
    {
      name: "truncated",
      append: 'process.stdout.write("x".repeat(8192));\n',
      code: "OPENCODE_OUTPUT_TRUNCATED",
      maxOutputBytes: 4096,
    },
  ]) {
    await t.test(scenario.name, async (nested) => {
      const value = await fixture(nested, "greenfield");
      const fakeFile = value.profile.opencode_command[1];
      await writeFile(fakeFile, `${await readFile(fakeFile, "utf8")}\n${scenario.append}`, "utf8");
      value.profile.attempt_limit = 1;
      if (scenario.maxOutputBytes) value.profile.max_output_bytes = scenario.maxOutputBytes;
      const result = await trial(value, "control_plane");
      assert.equal(result.status, "failed", JSON.stringify(result, null, 2));
      assert.equal(result.diagnostics[0].code, scenario.code, JSON.stringify(result, null, 2));
      assert.equal(result.receipt, undefined);
      assert.equal(result.telemetry.comparable, false);
      assert.deepEqual(result.strategy_gates, {
        run_count: 0,
        failed_count: 0,
        failure_evidence: [],
      });
    });
  }
});

test("live trial rejects any candidate outside its explicit disposable workspace", async (t) => {
  const value = await fixture(t, "greenfield");
  const outside = await mkdtemp(path.join(os.tmpdir(), "ocp-live-outside-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await assert.rejects(
    runLiveTrial({ ...value, candidate: outside, strategy: "direct", repetition: 1 }),
    /candidate must be a strict descendant/,
  );
});

test("unsafe evaluator runtime trees are retained and reported instead of recursively deleted", async (t) => {
  const value = await fixture(t, "greenfield");
  const fakeFile = value.profile.opencode_command[1];
  const original = await readFile(fakeFile, "utf8");
  const injection = 'await mkdir(runtime,{recursive:true});const runtimeRoot=path.dirname(process.env.HOME);const hardlinkSource=path.join(runtimeRoot,"unsafe-source");await writeFile(hardlinkSource,"retain","utf8");const {link}=await import("node:fs/promises");await link(hardlinkSource,path.join(runtimeRoot,"unsafe-hardlink"));';
  const tampered = original.replace('await mkdir(runtime,{recursive:true});', injection);
  assert.notEqual(tampered, original);
  await writeFile(fakeFile, tampered, "utf8");

  const result = await trial(value, "direct");
  assert.equal(result.status, "failed");
  assert.equal(result.diagnostics[0].code, "EVALUATION_RUNTIME_RETAINED_UNSAFE");
  const retained = await readdir(path.join(value.runRoot, ".evaluation-runtime"));
  assert.equal(retained.length, 1);
});
