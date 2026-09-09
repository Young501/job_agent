import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadWorkerVersions, workerVersionStatus } from "../src/worker-versions.mjs";

test("worker versions are sourced from installer metadata and require an exact match", async () => {
  const versions = await loadWorkerVersions(fileURLToPath(new URL("../workers/", import.meta.url)));
  for (const [platform, version] of Object.entries(versions)) {
    assert.equal(workerVersionStatus(versions, platform, version).compatible, true);
    for (const stale of [undefined, "", "1.0.0", "99.0.0", `${version}-modified`]) {
      assert.equal(workerVersionStatus(versions, platform, stale).compatible, false);
    }
    const script = await readFile(new URL(`../workers/${platform}/${platform}-agent-worker.user.js`, import.meta.url), "utf8");
    assert.match(script, /"x-job-agent-version": APP_VERSION/);
    assert.match(script, /"x-job-agent-platform": AGENT.platform/);
    assert.match(script, /body.code === "WORKER_UPDATE_REQUIRED"/);
  }
  assert.equal(workerVersionStatus(versions, "unknown", "1.0.0").compatible, false);
});
