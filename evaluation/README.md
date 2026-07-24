# Evaluation harness

This folder is a disposable benchmark for OpenCode Control Plane. It never opens, registers, upgrades, pauses, or removes an existing project.

## Start safely

Show the plan without creating anything:

```powershell
node scripts/evaluate.mjs --plan
```

Run the deterministic local simulation:

```powershell
node scripts/evaluate.mjs --simulate
```

The simulation creates 21 fresh test projects: seven cases for each of `direct`, `fresh_loop`, and `control_plane`. It copies a small seed, applies the bundled solution when the simulated strategy reaches it, and runs the real held-out gate. It does not start OpenCode, use the network, read the project registry, or consume provider credits.

The command returns a run ID. If a run is interrupted, resume by ID only:

```powershell
node scripts/evaluate.mjs --resume eval-00000000-0000-4000-8000-000000000000
```

The evaluator commits `active_trial` before starting any strategy. If a process dies after that point but before its immutable receipt is committed, resume records that trial once as `measurement_incomplete_after_interruption` with unknown usage. It never repeats the trial, avoiding the risk of counting provider spend twice. A state-recorded completion with a missing receipt fails closed.

Run data stays under a marked OpenCode Control Plane folder in the operating system temporary directory. Every trial has an immutable JSON receipt. State and JSON/Markdown reports are replaced atomically. Normal test workspaces are removed only after their evaluator marker and link-free contents are verified.

## What is measured

The report keeps provider-reported input, output, reasoning, cache-read, cache-write, and cost dimensions separate. Missing provider usage is `null`/`unavailable`, including in simulation. It is never changed to zero and no universal token sum is invented.

Budgets are soft boundaries checked between trials. A single live trial may cross a limit; the evaluator then refuses to start the next trial. Trial count, active elapsed time, each token dimension, and provider-reported cost have independent checks.

Quality reporting also keeps attempts, repairs, recoveries, reviews, review rejections, false completions, unexpected changed files, dependency additions, and the common final gate visible for every trial.

## Live runs

Live evaluation uses the fixed model and variant in an explicit local profile. First copy `evaluation/profile.example.json` to the ignored `evaluation/profile.local.json`, replace the `provider/model` placeholder, and select a variant or `null`. It then performs a zero-model capability and credential preflight and runs only after this exact acknowledgement:

```powershell
node scripts/evaluate.mjs --live --profile evaluation/profile.local.json --confirm LIVE_EVALUATION_USES_PROVIDER_CREDITS
```

Resume an interrupted live run with the acknowledgement again:

```powershell
node scripts/evaluate.mjs --resume eval-00000000-0000-4000-8000-000000000000 --confirm LIVE_EVALUATION_USES_PROVIDER_CREDITS
```

The live adapter exports `preflightLiveEvaluation` and `runLiveTrial` from `scripts/lib/evaluation-live.mjs`. The core evaluator still owns disposable workspaces, final held-out verification, budget decisions, durable receipts, and sanitized reports. It pins and rechecks the corpus, Control Plane source revision, and zero-model OpenCode version before every trial. A live resume requires the same acknowledgement so it cannot silently spend credits.

## Bundled cases

- Greenfield implementation
- Feature addition
- Bug repair
- External integration
- Finalized Blueprint v2 migration implementation
- Interruption recovery
- Failed verification and repair

The two recovery cases intentionally distinguish the strategies: simulated `direct` stops at interruption or gate failure, while `fresh_loop` and `control_plane` recover and pass the final held-out gate.
