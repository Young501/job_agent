import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "job-agent-smoke-"));
const port = 4400 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(port), JOB_AGENT_DATA_DIRECTORY: directory },
  stdio: "ignore",
  windowsHide: true
});

async function waitForServer() {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/api/health");
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
  throw new Error("Local server did not start.");
}

async function request(path, body) {
  const response = await fetch("http://127.0.0.1:" + port + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.ok, true, json.error);
  return json;
}

try {
  await waitForServer();
  const form = new FormData();
  form.append("resume", new Blob(["Graduate software developer with Python, SQL, JavaScript and cloud projects."], { type: "text/plain" }), "candidate.txt");
  const uploadResponse = await fetch("http://127.0.0.1:" + port + "/api/resumes/upload", { method: "POST", body: form });
  const uploaded = await uploadResponse.json();
  assert.equal(uploadResponse.ok, true, uploaded.error);
  assert.ok(uploaded.text.includes("Python"));

  const generated = await request("/api/profiles/generate", {
    sourceName: "candidate.txt",
    resumeText: uploaded.text + " React and data analytics projects at university."
  });
  assert.equal(generated.profile.status, "draft");

  await request("/api/profiles/" + generated.profile.id + "/activate", {});
  const run = await request("/api/runs", {});
  assert.ok(run.run.tasks.length > 0);

  const imported = await request("/api/jobs/import", {
    runId: run.run.id,
    jobs: [{
      source: "indeed",
      sourceJobId: "smoke-1",
      title: "Graduate Analyst",
      company: "Example",
      location: "Melbourne VIC",
      description: "Use Python and SQL for data analytics and cloud automation work."
    }]
  });
  assert.equal(imported.jobs[0].screening.screeningStatus, "NEEDS_JD_REVIEW");

  const reviewed = await request("/api/jobs/" + imported.jobs[0].id + "/review", {
    description: imported.jobs[0].description
  });
  assert.equal(reviewed.job.screening.screeningStatus, "JD_SCREENED");

  const bootstrap = await request("/api/bootstrap");
  assert.equal(bootstrap.activeProfile.id, generated.profile.id);
  assert.equal(bootstrap.jobs.length, 1);
  console.log("API smoke test passed.");
} finally {
  child.kill();
  await rm(directory, { recursive: true, force: true });
}
