import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkForUpdate,
  compareVersions,
  RELEASE_API,
} from "../.agents/skills/init-project/bin/lib/release-channel.mjs";

test("release checker reports newer stable tagged releases and caches the result", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocp-update-cache-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  let requests = 0;
  const fetchImpl = async (url, options) => {
    requests += 1;
    assert.equal(url, RELEASE_API);
    assert.equal(options.redirect, "error");
    return new Response(JSON.stringify({
      tag_name: "v2.10.0",
      draft: false,
      prerelease: false,
      html_url: "https://github.com/therealedo/opencode-control-plane/releases/tag/v2.10.0",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const first = await checkForUpdate({ installedVersion: "1.1.0", home, fetchImpl, now: Date.parse("2026-07-22T12:00:00Z") });
  const second = await checkForUpdate({ installedVersion: "1.1.0", home, fetchImpl, now: Date.parse("2026-07-22T12:01:00Z") });
  assert.equal(first.update_available, true);
  assert.equal(first.latest_version, "2.10.0");
  assert.equal(second.cached, true);
  assert.equal(requests, 1);
  assert.equal(compareVersions("2.10.0", "2.9.9"), 1);
});

test("release checker treats offline failures as nonfatal", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocp-update-offline-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const result = await checkForUpdate({
    installedVersion: "1.1.0",
    home,
    fetchImpl: async () => { throw new Error("offline"); },
    force: true,
  });
  assert.equal(result.update_available, false);
  assert.equal(result.stale, true);
  assert.match(result.error, /offline/);
});
