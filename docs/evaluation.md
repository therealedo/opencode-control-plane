# Evaluation harness

The v1.5 evaluator measures the complete worker lifecycle without using an existing project. It is a maintainer/research tool in this source repository; it is not installed into generated projects and adds nothing to their model context.

## Safe commands

Show the fixed 21-trial plan without creating anything:

```text
node scripts/evaluate.mjs --plan
```

Exercise every case, strategy, budget, resume, cleanup, and report path without OpenCode or model usage:

```text
node scripts/evaluate.mjs --simulate
```

Both commands leave registered projects, the global registry, installation, and running workers untouched.

## Live comparison

Copy `evaluation/profile.example.json` to the ignored `evaluation/profile.local.json`. Replace `provider/model`, select one reasoning variant or `null`, and set conservative per-dimension budgets. Then run:

```text
node scripts/evaluate.mjs --live --profile evaluation/profile.local.json --confirm LIVE_EVALUATION_USES_PROVIDER_CREDITS
```

The long confirmation is deliberate. Setup, upgrades, normal tests, and the dashboard never start this command.

One profile compares:

1. **Direct OpenCode (bounded):** one fresh pass with file tools only; shell, network, subagents, skills, and external-directory access are denied.
2. **Minimal fresh loop:** fresh bounded passes with the same task and deterministic gate feedback, up to the same attempt cap.
3. **Control Plane:** its normal fresh implementation, repair, independent-review, deterministic-gate, receipt, and recovery lifecycle.

All modes use the same bundled seed, finalized task, model, variant, attempt cap, and external held-out acceptance gate. The migration case gives every strategy the same finalized, active Blueprint v2 and approved migration plan; it measures only the code migration and rejects any blueprint change. Case code uses only Node.js, fake transports, and local data; it requires no application credentials, package installation, network calls, or production services. A live evaluator still needs the selected model provider's authentication.

## Disposable projects

Every candidate is created exclusively beneath the evaluator's marked operating-system temporary parent. The evaluator never accepts an existing repository path, reads the Control Plane project registry, or calls install/update/register code. Each trial receives a new seed copy and a private Control Plane home.

Only an exact marker-owned, link-free trial tree is removed. An unsafe tree is retained and reported instead of risking a broad delete. These are application-level controls, not container or VM containment of a malicious native program.

## Budgets and resume

Budgets cover trials, active elapsed minutes, provider-reported cost, and each reported token dimension independently. They are checked after an atomic trial result and before the next trial starts. A running trial can cross a soft limit because its final usage is unknowable in advance.

Resume accepts only the generated run ID:

```text
node scripts/evaluate.mjs --resume RUN_ID
```

For a live run, repeat the same explicit confirmation. If the evaluator was interrupted after a trial started but before its immutable result was written, resume records that trial as measurement-incomplete and does not rerun it, preventing unknown duplicate spend. If state says a trial completed but its immutable result is missing, resume fails closed instead of repeating it. A changed profile, corpus, Control Plane source revision, or OpenCode version cannot continue the old run; the same identities are rechecked before every live trial.

## Results

Each run keeps `report.json`, `report.md`, state, and immutable per-trial results below its temporary run directory. Reports include the sanitized OpenCode version and hashed Control Plane source revision needed to reproduce a comparison. They contain IDs and bounded measurements, not absolute personal paths, prompts, raw model output, credentials, or environment values.

Provider-reported input, cache-read, cache-write, reasoning, output, and cost remain separate because their accounting can overlap. Missing or malformed telemetry is unavailable/invalid, never zero. The evaluator also records attempts, repairs, reviews, recoveries, gate failures, false completion, unexpected files, dependency additions, elapsed time, and common acceptance. It does not estimate a Codex/ChatGPT subscription percentage.

OpenCode documents the programmatic JSON event mode used here in its [CLI reference](https://opencode.ai/docs/cli/), and its explicit deny rules remain active under `--auto` according to the [permissions reference](https://opencode.ai/docs/permissions).
