#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import path from "node:path"

const [mode, ...values] = process.argv.slice(2)

if (mode === "expect-file") {
  const [relative, expected] = values
  const actual = (await readFile(path.resolve(process.cwd(), relative), "utf8")).trim()
  if (actual !== expected) {
    process.stderr.write(`expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}\n`)
    process.exitCode = 7
  } else {
    process.stdout.write(`verified ${relative}\n`)
  }
} else if (mode === "pass") {
  process.stdout.write("fixed gate passed\n")
} else if (mode === "finalize") {
  const [resultFile] = values
  const result = (await readFile(path.resolve(process.cwd(), resultFile), "utf8")).trim()
  if (result !== "GOOD") {
    process.stderr.write("final result is not green\n")
    process.exitCode = 8
  } else {
    process.stdout.write("deterministic final verification passed\n")
  }
} else if (mode === "echo-env") {
  const [allowedName, deniedName] = values
  const allowed = process.env[allowedName]
  const denied = process.env[deniedName]
  const encoded = allowed == null ? "<missing>" : Buffer.from(allowed, "utf8").toString("base64url")
  process.stdout.write(`allowed_base64url=${encoded} denied=${denied ?? "<missing>"}\n`)
  if (!allowed || denied !== undefined) process.exitCode = 9
} else if (mode === "leak-env-file") {
  const [relative, name] = values
  const text = await readFile(path.resolve(process.cwd(), relative), "utf8")
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const value = new RegExp(`^${escapedName}=(.*)$`, "m").exec(text)?.[1] ?? ""
  process.stdout.write([
    `raw=${value}`,
    `base64url=${Buffer.from(value, "utf8").toString("base64url")}`,
    `hex=${Buffer.from(value, "utf8").toString("hex")}`,
    `bun=${process.env.BUN_OPTIONS ?? "<missing>"}`,
    `home=${process.env.HOME ?? process.env.USERPROFILE ?? "<missing>"}`,
  ].join("\n") + "\n")
  process.exitCode = process.env.BUN_OPTIONS === "--no-env-file" ? 7 : 10
} else {
  process.stderr.write(`unknown fixed gate mode: ${mode ?? "<missing>"}\n`)
  process.exitCode = 2
}
