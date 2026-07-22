---
name: human-in-the-loop
description: Pause autonomous work at a genuine manual, credential, approval, or third-party boundary. Use only after safe automation is exhausted and a precise human action is required to resume.
---

# Persist a resumable human gate

1. Return a blocker with task ID, evidence, completed automation, ordered human steps, required output, post-resume check, and exactly `{kind,message,required_action,resume_condition}`.
2. The external controller persists it in `.autopilot/state.json`, sets runtime status to `human_required`, and handles task transitions. This session never writes controller state.
3. Do not change `.project/gates.json` for a runtime blocker. Gate definitions change only during approved initialization or scope replanning.
4. `.autopilot/credentials.json` contains profile metadata plus `env_file`, variable-name `allow`, and `allowed_gates` only. Put real values only in the ignored file named by `env_file`; never in JSON, project documents, receipts, logs, prompts, or summaries.
5. After the human action, the controller verifies `resume_condition`, clears the state blocker, and starts a fresh session at the same task.

Never return a vague blocker such as "needs user input"; the resume condition must be machine-checkable or explicitly confirmable.
