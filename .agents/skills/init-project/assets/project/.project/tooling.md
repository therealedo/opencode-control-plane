# Tooling

Status: commands must be filled during `/init-project` before the queue becomes ready.

## Environment

- Runtime: {{RUNTIME_VERSION}}
- Package manager: {{PACKAGE_MANAGER_AND_LOCKFILE}}
- Local setup: {{LOCAL_SETUP}}
- Test services: {{TEST_SERVICES}}

## Commands

Define executable checks as fixed `argv` arrays in `.project/gates.json`; task specs refer only to gate IDs. Do not store shell fragments, secret values, or production endpoints in project documents.

## Connected tools

{{CONNECTED_TOOL_POLICY}}

Define only required MCP/custom tool implementations and servers in `opencode.jsonc`, with no credential values in the file. `.project/tools.json` sets each role's exact ceiling; every queue task grants only the smallest execute/repair/review subset it needs. Wildcards, built-in tools, and controller tools are invalid grants; every role catch-all denies anything unlisted. The finalizer generates the marked permission blocks in `.opencode/agents/`, so do not edit those blocks by hand.
