import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadWorkerVersions(directory) {
  const versions = {};
  for (const platform of ["linkedin", "indeed", "seek"]) {
    const script = await readFile(join(directory, platform, `${platform}-agent-worker.user.js`), "utf8");
    const version = /^\/\/\s*@version\s+(\S+)/m.exec(script)?.[1];
    const runtimeVersion = /const APP_VERSION = "([^"]+)"/.exec(script)?.[1];
    if (!version || version !== runtimeVersion) throw new Error(`Worker version mismatch: ${platform}`);
    versions[platform] = version;
  }
  return versions;
}

export function workerVersionStatus(versions, platform, reportedVersion) {
  const requiredVersion = versions[platform];
  const version = String(reportedVersion || "").slice(0, 40);
  return { platform, version: version || null, requiredVersion: requiredVersion || null,
    compatible: Boolean(requiredVersion && version === requiredVersion), checkedAt: new Date().toISOString() };
}
