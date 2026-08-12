import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "job-agent-smoke-"));
const port = await availablePort();
let serverOutput = "";
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    JOB_AGENT_DATA_DIRECTORY: directory,
    JOB_AGENT_AI_BASE_URL: "",
    JOB_AGENT_AI_MODEL: "",
    JOB_AGENT_AI_API_KEY: ""
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
child.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
child.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

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
  throw new Error("Local server did not start. " + serverOutput.trim());
}

async function request(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch("http://127.0.0.1:" + port + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.ok, true, json.error);
  return json;
}

async function validateRoutineTask(platform, postedWithinDays) {
  const pending = await request("/api/task-validations", {
    platform,
    keyword: "graduate software engineer",
    location: "Melbourne VIC",
    postedWithinDays
  });
  assert.equal(new URL(pending.preflightUrl).searchParams.get("jobAgentPreflight"), "1");
  const requested = await request("/api/worker/preflight?validationId=" + pending.validation.id + "&platform=" + platform);
  assert.equal(requested.validation.id, pending.validation.id);
  assert.equal(requested.validation.preflightAttempt, 1);
  const started = await request("/api/worker/preflight/started", {
    validationId: pending.validation.id,
    platform,
    preflightAttempt: requested.validation.preflightAttempt,
    workerId: platform + "-preflight-worker"
  });
  assert.ok(started.validation.workerStartedAt);
  const accepted = await request("/api/worker/preflight/result", {
    validationId: pending.validation.id,
    platform,
    preflightAttempt: requested.validation.preflightAttempt,
    status: "valid"
  });
  assert.equal(accepted.validation.status, "VALID");
  assert.ok(accepted.routineTask);
  return accepted;
}

try {
  await waitForServer();
  const workerResponse = await fetch("http://127.0.0.1:" + port + "/workers/seek/seek-agent-worker.user.js");
  const workerScript = await workerResponse.text();
  assert.equal(workerResponse.ok, true);
  assert.match(workerResponse.headers.get("content-type") || "", /^text\/javascript/);
  assert.match(workerScript, /Job Agent Worker - SEEK/);
  assert.match(workerScript, /@version\s+2\.2\.2/);
  assert.match(workerScript, /@namespace\s+https:\/\/routine\.local\/job-agent-worker/);
  assert.match(workerScript, /@updateURL\s+http:\/\/127\.0\.0\.1:4317\/workers\/seek\/seek-agent-worker\.user\.js/);
  assert.match(workerScript, /@downloadURL\s+http:\/\/127\.0\.0\.1:4317\/workers\/seek\/seek-agent-worker\.user\.js/);
  assert.match(workerScript, /preflight\/pending/);
  assert.match(workerScript, /agentWaitAndClickText/);
  assert.match(workerScript, /agentSeekKeywordForSearch/);
  assert.match(workerScript, /agentSearchKeyword/);
  assert.match(workerScript, /agentIncludeKeywordText/);
  assert.match(workerScript, /agentNormalizeSeekKeyword/);
  assert.match(workerScript, /\^graduate\$/i);
  assert.match(workerScript, /agentWaitForSeekSearchMatch/);
  assert.match(workerScript, /toggleDateListedPanel/);
  assert.match(workerScript, /30:\s*31/);
  assert.match(workerScript, /https:\/\/www\.seek\.com\.au\/jobs/);
  assert.match(workerScript, /job-agent-preflight-finished/);
  assert.match(workerScript, /agentContinuePreflightQueue/);
  assert.match(workerScript, /preflight\/next-launch/);
  assert.match(workerScript, /worker\/next-platform-launch/);
  assert.match(workerScript, /worker\/progress/);
  assert.match(workerScript, /taskAttempt/);
  assert.match(workerScript, /job-agent-operation-overlay/);
  assert.match(workerScript, /agentAssertSearchResults/);
  assert.match(workerScript, /jobAgentReset/);
  assert.match(workerScript, /agentRunHistoryReset/);
  assert.match(workerScript, /job-agent-reset-progress/);
  assert.match(workerScript, /job-agent-reset-finished/);
  const indeedWorkerResponse = await fetch("http://127.0.0.1:" + port + "/workers/indeed/indeed-agent-worker.user.js");
  const indeedWorkerScript = await indeedWorkerResponse.text();
  assert.equal(indeedWorkerResponse.ok, true);
  assert.match(indeedWorkerResponse.headers.get("content-type") || "", /^text\/javascript/);
  assert.match(indeedWorkerScript, /@name\s+Job Agent Worker - Indeed/);
  assert.match(indeedWorkerScript, /@namespace\s+https:\/\/routine\.local\/job-agent-worker/);
  assert.match(indeedWorkerScript, /@version\s+2\.2\.3/);
  assert.match(indeedWorkerScript, /preflight\/next-launch/);
  assert.match(indeedWorkerScript, /agentSearchKeyword/);
  assert.match(indeedWorkerScript, /agentIncludeKeywordText/);
  assert.match(indeedWorkerScript, /worker\/next-platform-launch/);
  assert.match(indeedWorkerScript, /@updateURL\s+http:\/\/127\.0\.0\.1:4317\/workers\/indeed\/indeed-agent-worker\.user\.js/);
  assert.match(indeedWorkerScript, /@downloadURL\s+http:\/\/127\.0\.0\.1:4317\/workers\/indeed\/indeed-agent-worker\.user\.js/);
  assert.match(indeedWorkerScript, /agentWaitAndClickText\(\/\^update\$\/i/);
  assert.match(indeedWorkerScript, /agentWaitForIndeedDateOption/);
  assert.match(indeedWorkerScript, /agentFindIndeedDateUpdateButton/);
  assert.match(indeedWorkerScript, /agentWaitForIndeedDateParameter/);
  assert.match(indeedWorkerScript, /Date posted options/);
  assert.match(indeedWorkerScript, /directUrl\.searchParams\.set\("fromage"/);
  assert.match(indeedWorkerScript, /window\.location\.assign\(searchUrl\.href\)/);
  assert.match(indeedWorkerScript, /current\.get\("fromage"\)/);
  assert.match(indeedWorkerScript, /worker\/progress/);
  assert.match(indeedWorkerScript, /job-agent-operation-overlay/);
  assert.match(indeedWorkerScript, /agentAssertSearchResults/);
  assert.match(indeedWorkerScript, /agentRunHistoryReset/);
  assert.match(indeedWorkerScript, /https:\/\/www\.seek\.com\.au\/jobs\?jobAgentReset=1&jobAgentResetAll=1/);
  assert.match(indeedWorkerScript, /job-agent-reset-progress/);
  const linkedInWorkerResponse = await fetch("http://127.0.0.1:" + port + "/workers/linkedin/linkedin-agent-worker.user.js");
  const linkedInWorkerScript = await linkedInWorkerResponse.text();
  assert.equal(linkedInWorkerResponse.ok, true);
  assert.match(linkedInWorkerResponse.headers.get("content-type") || "", /^text\/javascript/);
  assert.match(linkedInWorkerScript, /@name\s+Job Agent Worker - LinkedIn/);
  assert.match(linkedInWorkerScript, /@namespace\s+https:\/\/routine\.local\/job-agent-worker/);
  assert.match(linkedInWorkerScript, /@version\s+2\.2\.2/);
  assert.match(linkedInWorkerScript, /agentSearchKeyword/);
  assert.match(linkedInWorkerScript, /agentIncludeKeywordText/);
  assert.match(linkedInWorkerScript, /preflight\/next-launch/);
  assert.match(linkedInWorkerScript, /worker\/next-platform-launch/);
  assert.match(linkedInWorkerScript, /@updateURL\s+http:\/\/127\.0\.0\.1:4317\/workers\/linkedin\/linkedin-agent-worker\.user\.js/);
  assert.match(linkedInWorkerScript, /@downloadURL\s+http:\/\/127\.0\.0\.1:4317\/workers\/linkedin\/linkedin-agent-worker\.user\.js/);
  assert.match(linkedInWorkerScript, /agentWaitAndClickText\(labels\[days\]\)/);
  assert.match(linkedInWorkerScript, /searchFilter_timePostedRange/);
  assert.match(linkedInWorkerScript, /Apply current filter to show/);
  assert.match(linkedInWorkerScript, /input\[role='combobox'\]\[aria-label='Search by title, skill, or company'\]/);
  assert.match(linkedInWorkerScript, /input\._valueTracker\?\.setValue/);
  assert.match(linkedInWorkerScript, /window\.location\.assign\(searchUrl\.href\)/);
  assert.match(linkedInWorkerScript, /worker\/progress/);
  assert.match(linkedInWorkerScript, /job-agent-operation-overlay/);
  assert.match(linkedInWorkerScript, /agentAssertSearchResults/);
  assert.match(linkedInWorkerScript, /agentRunHistoryReset/);
  assert.match(linkedInWorkerScript, /https:\/\/au\.indeed\.com\/jobs\?jobAgentReset=1&jobAgentResetAll=1/);
  assert.match(linkedInWorkerScript, /job-agent-reset-progress/);
  const dashboardResponse = await fetch("http://127.0.0.1:" + port + "/");
  const dashboardHtml = await dashboardResponse.text();
  assert.equal(dashboardResponse.ok, true);
  assert.match(dashboardHtml, /id="view-setup"/);
  assert.match(dashboardHtml, /安装设置/);
  assert.match(dashboardHtml, /id="profile-upload-pane"/);
  assert.match(dashboardHtml, /data-profile-pane="editor"/);
  assert.match(dashboardHtml, /data-jobs-pane="current"/);
  assert.match(dashboardHtml, /data-jobs-pane="history"/);
  assert.match(dashboardHtml, /id="job-history-run"/);
  assert.match(dashboardHtml, /id="delete-selected-history-run"/);
  assert.match(dashboardHtml, /id="job-run-stats"/);
  assert.match(dashboardHtml, /id="review-learning"/);
  assert.match(dashboardHtml, /id="complete-run-review"/);
  assert.match(dashboardHtml, /id="feedback-dialog"/);
  assert.match(dashboardHtml, /value="CLASSIFICATION_WRONG"/);
  assert.match(dashboardHtml, /value="NOT_RELEVANT"/);
  assert.match(dashboardHtml, /明确不符合/);
  assert.match(dashboardHtml, /id="open-clear-all-history"/);
  assert.match(dashboardHtml, /id="clear-all-history-dialog"/);
  assert.match(dashboardHtml, /id="confirm-clear-all-history"/);
  assert.match(dashboardHtml, /内置预设、自定义任务类别/);
  assert.match(dashboardHtml, /id="task-category-list"/);
  assert.match(dashboardHtml, /id="preflight-selected-categories"/);
  assert.match(dashboardHtml, /id="import-selected-categories"/);
  assert.match(dashboardHtml, /id="task-category-dialog"/);
  assert.match(dashboardHtml, /多个备选词用逗号分隔/);
  const dashboardScriptResponse = await fetch("http://127.0.0.1:" + port + "/app.js");
  const dashboardScript = await dashboardScriptResponse.text();
  assert.match(dashboardScript, /data-install-worker/);
  assert.match(dashboardScript, /安装 \/ 更新/);
  assert.match(dashboardScript, /data-copy-worker/);
  assert.match(dashboardScript, /loadWorkerScripts/);
  assert.match(dashboardScript, /job-agent:view/);
  assert.match(dashboardScript, /\/api\/task-validations\/start/);
  assert.match(dashboardScript, /job-agent-preflight-batch/);
  assert.match(dashboardScript, /job-agent-worker-launch/);
  assert.match(dashboardScript, /finishProfileChipPointerDrag/);
  assert.match(dashboardScript, /acceptSuggestedGroup/);
  assert.match(dashboardScript, /candidateItems/);
  assert.match(dashboardScript, /function currentRunJobs\(\)/);
  assert.match(dashboardScript, /function historicalJobs\(\)/);
  assert.match(dashboardScript, /state\.jobsPane === "history"/);
  assert.match(dashboardScript, /data-run-routine-task/);
  assert.match(dashboardScript, /data-rerun-task/);
  assert.match(dashboardScript, /data-add-validation-task/);
  assert.match(dashboardScript, /ai-review-badge/);
  assert.match(dashboardScript, /job-agent-run-finished/);
  assert.match(dashboardScript, /renderCurrentRunStats/);
  assert.match(dashboardScript, /data-delete-job-stat-task/);
  assert.match(dashboardScript, /data-delete-run-history/);
  assert.match(dashboardScript, /function deleteJobStatTask/);
  assert.match(dashboardScript, /function deleteRunHistory/);
  assert.match(dashboardScript, /renderReviewLearning/);
  assert.match(dashboardScript, /saveJobFeedback/);
  assert.match(dashboardScript, /completeRunReview/);
  assert.match(dashboardScript, /const run = selectedReviewRun\(\)/);
  assert.match(dashboardScript, /\/api\/records/);
  assert.match(dashboardScript, /jobAgentResetAll/);
  assert.match(dashboardScript, /job-agent-reset-progress/);
  assert.match(dashboardScript, /job-agent-reset-finished/);
  assert.match(dashboardScript, /prepareSelectedCategories/);
  assert.match(dashboardScript, /\/api\/task-categories\/prepare/);
  assert.match(dashboardScript, /data-category-select/);

  const normalizedKeywordValidation = await request("/api/task-validations", {
    platform: "linkedin",
    keyword: "intern OR internship",
    location: "Melbourne, Victoria, Australia",
    postedWithinDays: 7
  });
  assert.equal(normalizedKeywordValidation.validation.keyword, "intern, internship");
  await request("/api/task-validations/" + normalizedKeywordValidation.validation.id, undefined, "DELETE");

  const keywordBootstrap = await request("/api/bootstrap");
  assert.ok(keywordBootstrap.taskCategories.flatMap((category) => category.tasks)
    .every((task) => !/\sOR\s/i.test(task.keyword)));

  const savedAiConfig = await request("/api/ai-config", {
    baseUrl: "https://example.invalid/v1",
    model: "test-model",
    wireApi: "responses",
    apiKey: "secret-test-key-1234"
  }, "PUT");
  assert.equal(savedAiConfig.ai.hasApiKey, true);
  assert.equal(savedAiConfig.ai.keyHint, "****1234");
  const aiBootstrap = await request("/api/bootstrap");
  assert.equal(aiBootstrap.ai.baseUrl, "https://example.invalid/v1");
  assert.equal(JSON.stringify(aiBootstrap).includes("secret-test-key-1234"), false);
  const clearedAiKey = await request("/api/ai-config/key", {}, "DELETE");
  assert.equal(clearedAiKey.ai.hasApiKey, false);
  await request("/api/ai-config", { baseUrl: "", model: "", wireApi: "chat_completions", apiKey: "" }, "PUT");
  const form = new FormData();
  form.append("resume", new Blob(["Graduate software developer with Python, SQL, JavaScript and cloud projects."], { type: "text/plain" }), "candidate.txt");
  const uploadResponse = await fetch("http://127.0.0.1:" + port + "/api/resumes/upload", { method: "POST", body: form });
  const uploaded = await uploadResponse.json();
  assert.equal(uploadResponse.ok, true, uploaded.error);
  assert.ok(uploaded.text.includes("Python"));

  const generated = await request("/api/profiles/generate", {
    sourceName: "candidate.txt",
    resumeText: uploaded.text + " React and data analytics projects at university.",
    externalProfileText: JSON.stringify({
      name: "Candidate",
      headline: "Graduate Software Developer",
      summary: "External GPT profile based on the attached resume.",
      targetRoles: ["Graduate Software Engineer"],
      focusAreas: ["software engineering", "data and analytics"],
      skills: ["Python", "SQL", "JavaScript"],
      education: ["University projects mentioned"],
      preferences: { locations: ["Melbourne VIC"], workTypes: [], exclusions: [] },
      candidateItems: ["Backend API projects", "Cloud coursework"]
    })
  });
  assert.equal(generated.profile.status, "draft");
  assert.equal(generated.profile.engine, "external-gpt");
  assert.equal(generated.profile.externalProfileUsed, true);
  assert.deepEqual(generated.profile.profile.candidateItems, ["Backend API projects", "Cloud coursework"]);

  await request("/api/profiles/" + generated.profile.id + "/activate", {});
  const replacement = await request("/api/profiles/generate", {
    sourceName: "candidate-update.txt",
    resumeText: uploaded.text + " React, data analytics, and backend API projects at university.",
    externalProfileText: JSON.stringify({
      name: "Candidate",
      headline: "Graduate Full-stack Developer",
      summary: "Updated external GPT profile based on the attached resume.",
      targetRoles: ["Graduate Full-stack Developer"],
      focusAreas: ["web development", "backend APIs"],
      skills: ["Python", "JavaScript", "React"],
      education: ["University projects mentioned"],
      preferences: { locations: ["Melbourne VIC"], workTypes: [], exclusions: [] }
    })
  });
  const confirmedReplacement = await request("/api/profiles/" + replacement.profile.id + "/activate", {});
  assert.equal(confirmedReplacement.deleted, 1);
  const afterConfirmation = await request("/api/bootstrap");
  assert.equal(afterConfirmation.profiles.length, 1);
  assert.equal(afterConfirmation.activeProfile.id, replacement.profile.id);

  const disposableDraft = await request("/api/profiles/generate", {
    sourceName: "candidate-draft.txt",
    resumeText: uploaded.text + " Extra text to create a disposable profile draft.",
    externalProfileText: JSON.stringify({
      name: "Candidate",
      headline: "Technology Graduate",
      summary: "Draft external GPT profile based on the attached resume.",
      targetRoles: ["Technology Graduate Program"],
      focusAreas: ["software engineering"],
      skills: ["Python"],
      education: ["University projects mentioned"],
      preferences: { locations: ["Melbourne VIC"], workTypes: [], exclusions: [] }
    })
  });
  assert.equal(disposableDraft.profile.status, "draft");
  assert.equal(disposableDraft.profile.version, replacement.profile.version + 1);
  const clearedOtherProfiles = await request("/api/profiles/other-versions", undefined, "DELETE");
  assert.equal(clearedOtherProfiles.deleted, 1);
  const waitingValidation = await request("/api/task-validations", {
    platform: "linkedin",
    keyword: "graduate software engineer",
    location: "Melbourne VIC",
    postedWithinDays: 7
  });
  assert.equal(waitingValidation.validation.status, "WAITING_FOR_WORKER");
  assert.equal(waitingValidation.validation.preflightQueuedAt, null);
  const batchSibling = await request("/api/task-validations", {
    platform: "linkedin",
    keyword: "software developer",
    location: "Melbourne VIC",
    postedWithinDays: 3
  });
  const batchOtherPlatform = await request("/api/task-validations", {
    platform: "indeed",
    keyword: "software developer",
    location: "Melbourne VIC",
    postedWithinDays: 1
  });
  const unavailableBeforeBatch = await request("/api/worker/preflight/pending?platform=linkedin");
  assert.equal(unavailableBeforeBatch.validation, null);
  const batch = await request("/api/task-validations/start", {});
  assert.equal(batch.count, 3);
  assert.equal(batch.launchUrls.length, 2);
  assert.equal(batch.launchUrls[0].platform, "linkedin");
  assert.equal(batch.launchUrls[1].platform, "indeed");
  const firstCrossPlatformLaunch = await request("/api/worker/preflight/next-launch");
  assert.equal(firstCrossPlatformLaunch.validation.id, batchSibling.validation.id);
  const firstInPlatformQueue = await request("/api/worker/preflight/pending?platform=linkedin");
  assert.equal(firstInPlatformQueue.validation.id, batchSibling.validation.id);
  await request("/api/worker/preflight/result", {
    validationId: batchSibling.validation.id,
    platform: "linkedin",
    preflightAttempt: batchSibling.validation.preflightAttempt,
    status: "failed",
    reason: "batch queue test"
  });
  const discoverablePreflight = await request("/api/worker/preflight/pending?platform=linkedin");
  assert.equal(discoverablePreflight.validation.id, waitingValidation.validation.id);
  assert.ok(discoverablePreflight.validation.preflightQueuedAt);
  const beforePreflight = await request("/api/bootstrap");
  assert.equal(beforePreflight.routineTasks.length, 0);
  await request("/api/worker/preflight/result", {
    validationId: waitingValidation.validation.id,
    platform: "linkedin",
    preflightAttempt: waitingValidation.validation.preflightAttempt,
    status: "failed",
    reason: "date option unavailable"
  });
  const nextPlatformLaunch = await request("/api/worker/preflight/next-launch");
  assert.equal(nextPlatformLaunch.validation.id, batchOtherPlatform.validation.id);
  assert.equal(new URL(nextPlatformLaunch.url).hostname, "au.indeed.com");
  await request("/api/worker/preflight/result", {
    validationId: batchOtherPlatform.validation.id,
    platform: "indeed",
    preflightAttempt: batchOtherPlatform.validation.preflightAttempt,
    status: "failed",
    reason: "cross-platform batch queue test"
  });
  const retry = await request("/api/task-validations/" + waitingValidation.validation.id + "/retry", {});
  assert.equal(retry.validation.status, "WAITING_FOR_WORKER");
  assert.equal(retry.validation.preflightAttempt, waitingValidation.validation.preflightAttempt + 1);
  const editedValidation = await request("/api/task-validations/" + waitingValidation.validation.id, {
    platform: "linkedin",
    keyword: "graduate developer",
    location: "Sydney NSW",
    postedWithinDays: 3
  }, "PUT");
  assert.equal(editedValidation.validation.keyword, "graduate developer");
  assert.equal(editedValidation.validation.location, "Sydney NSW");
  assert.equal(editedValidation.validation.postedWithinDays, 3);
  assert.equal(editedValidation.validation.preflightAttempt, retry.validation.preflightAttempt + 1);
  const failedPreflight = await request("/api/bootstrap");
  assert.equal(failedPreflight.routineTasks.length, 0);
  await validateRoutineTask("linkedin", 7);
  await validateRoutineTask("indeed", 3);
  await validateRoutineTask("seek", 14);
  const deletedDailyTask = await validateRoutineTask("linkedin", 1);
  const recheckedDailyTask = await request("/api/task-validations/" + deletedDailyTask.validation.id + "/retry", {});
  assert.equal(recheckedDailyTask.routineTaskRemoved, true);
  const revalidatedDailyTask = await request("/api/worker/preflight/result", {
    validationId: deletedDailyTask.validation.id,
    platform: "linkedin",
    preflightAttempt: recheckedDailyTask.validation.preflightAttempt,
    status: "valid"
  });
  assert.ok(revalidatedDailyTask.routineTask);
  await request("/api/routine-tasks/" + revalidatedDailyTask.routineTask.id, undefined, "DELETE");
  const restoredDailyTask = await request("/api/task-validations/" + deletedDailyTask.validation.id + "/add", {});
  assert.equal(restoredDailyTask.added, true);
  assert.equal(restoredDailyTask.routineTask.validationId, deletedDailyTask.validation.id);
  await request("/api/routine-tasks/" + restoredDailyTask.routineTask.id, undefined, "DELETE");
  const deletedValidation = await request("/api/task-validations/" + deletedDailyTask.validation.id, undefined, "DELETE");
  assert.equal(deletedValidation.routineTaskRetained, false);
  const afterDailyDelete = await request("/api/bootstrap");
  assert.equal(afterDailyDelete.routineTasks.length, 3);

  await validateRoutineTask("linkedin", 1);
  const run = await request("/api/runs", {});
  assert.equal(run.run.tasks.length, 4);
  assert.equal(run.launchUrls.length, 3);
  assert.ok(run.launchUrls.every((launch) => new URL(launch.url).searchParams.get("jobAgentWorker") === "1"));
  const indeedLaunch = new URL(run.launchUrls.find((launch) => launch.platform === "indeed").url);
  assert.equal(indeedLaunch.searchParams.get("q"), "job");
  assert.equal(indeedLaunch.searchParams.get("l"), "Australia");
  const runNextPlatformLaunch = await request("/api/worker/next-platform-launch?runId=" + run.run.id + "&platform=linkedin");
  assert.ok(["indeed", "seek"].includes(runNextPlatformLaunch.platform));
  assert.equal(new URL(runNextPlatformLaunch.url).searchParams.get("jobAgentRun"), run.run.id);
  const seekLaunch = run.launchUrls.find((launch) => launch.platform === "seek");
  assert.equal(new URL(seekLaunch.url).hostname, "www.seek.com.au");
  assert.equal(new URL(seekLaunch.url).searchParams.get("keywords"), "job");
  const activeLinkedInRun = await request("/api/worker/active-run?platform=linkedin");
  assert.equal(activeLinkedInRun.run.id, run.run.id);

  const deletedQueueTask = run.run.tasks.find((task) => task.platform === "linkedin" && task.postedWithinDays === 1);
  const queueDeleteResult = await request("/api/runs/" + run.run.id + "/tasks/" + deletedQueueTask.id, undefined, "DELETE");
  assert.equal(queueDeleteResult.cancelled, false);

  const linkedinBeforeTurn = await request("/api/worker/next?runId=" + run.run.id + "&platform=linkedin&workerId=linkedin-worker");
  const indeedBeforeTurn = await request("/api/worker/next?runId=" + run.run.id + "&platform=indeed&workerId=indeed-worker");
  const seekClaim = await request("/api/worker/next?runId=" + run.run.id + "&platform=seek&workerId=seek-worker");
  assert.equal(linkedinBeforeTurn.task, null);
  assert.equal(linkedinBeforeTurn.reason, "waiting_turn");
  assert.equal(indeedBeforeTurn.task, null);
  assert.equal(indeedBeforeTurn.reason, "waiting_turn");
  assert.ok(seekClaim.task, "the first queued platform can claim its task");
  assert.equal(seekClaim.task.attempt, 1);
  const seekProgress = await request("/api/worker/progress", {
    runId: run.run.id,
    taskId: seekClaim.task.id,
    taskAttempt: seekClaim.task.attempt,
    workerId: "seek-worker",
    phase: "scanning",
    message: "SEEK is scanning result cards.",
    scanned: 42,
    found: 7
  });
  assert.equal(seekProgress.discarded, false);
  assert.equal(seekProgress.task.progress.scanned, 42);
  assert.equal(seekProgress.task.progress.found, 7);
  assert.ok(seekProgress.task.workerHeartbeatAt);
  const secondSeekWorker = await request("/api/worker/next?runId=" + run.run.id + "&platform=seek&workerId=other-seek-worker");
  assert.equal(secondSeekWorker.task, null);
  assert.equal(secondSeekWorker.reason, "platform_busy");

  const cancelledTask = await request("/api/runs/" + run.run.id + "/tasks/" + seekClaim.task.id, undefined, "DELETE");
  assert.equal(cancelledTask.cancelled, true);
  const discardedResult = await request("/api/worker/result", {
    runId: run.run.id,
    taskId: seekClaim.task.id,
    taskAttempt: seekClaim.task.attempt,
    workerId: "seek-worker",
    status: "completed",
    jobs: [{ source: "seek", sourceJobId: "cancelled-result", title: "Discarded result", location: "Melbourne VIC" }]
  });
  assert.equal(discardedResult.discarded, true);
  assert.equal(discardedResult.jobs.length, 0);

  const indeedClaim = await request("/api/worker/next?runId=" + run.run.id + "&platform=indeed&workerId=indeed-worker");
  assert.ok(indeedClaim.task, "the next platform runs after the previous task finishes or is cancelled");
  const pausedIndeedResult = await request("/api/worker/result", {
    runId: run.run.id,
    taskId: indeedClaim.task.id,
    taskAttempt: indeedClaim.task.attempt,
    workerId: "indeed-worker",
    status: "needs_user_action",
    reason: "manual verification required",
    jobs: [{
      source: "indeed",
      sourceJobId: "worker-attribution",
      title: "Software Engineer",
      company: "Worker Example",
      location: "Wrong raw location",
      searchKeyword: "wrong raw keyword",
      searchLocation: "wrong raw search location"
    }]
  });
  assert.equal(pausedIndeedResult.jobs[0].runTaskId, indeedClaim.task.id);
  assert.equal(pausedIndeedResult.jobs[0].routineTaskId, indeedClaim.task.routineTaskId);
  assert.equal(pausedIndeedResult.jobs[0].searchKeyword, indeedClaim.task.keyword);
  assert.equal(pausedIndeedResult.jobs[0].searchLocation, indeedClaim.task.location);
  assert.equal(pausedIndeedResult.jobs[0].searchPostedWithinDays, indeedClaim.task.postedWithinDays);
  const pausedIndeed = await request("/api/worker/next?runId=" + run.run.id + "&platform=indeed&workerId=indeed-worker");
  assert.equal(pausedIndeed.task, null);
  assert.equal(pausedIndeed.reason, "needs_user_action");
  const activeLinkedInRunWhileIndeedPaused = await request("/api/worker/active-run?platform=linkedin");
  assert.equal(activeLinkedInRunWhileIndeedPaused.run.id, run.run.id);
  await request("/api/tasks/" + indeedClaim.task.id + "/resume", {});
  const resumedIndeed = await request("/api/worker/next?runId=" + run.run.id + "&platform=indeed&workerId=indeed-worker");
  assert.equal(resumedIndeed.task.id, indeedClaim.task.id);

  const clearedQueue = await request("/api/runs/" + run.run.id + "/tasks", undefined, "DELETE");
  assert.equal(clearedQueue.cleared.removed, 1);
  assert.equal(clearedQueue.cleared.cancelled, 1);

  const retriedTask = await request("/api/runs/" + run.run.id + "/tasks/" + seekClaim.task.id + "/retry", {});
  assert.equal(retriedTask.task.status, "queued");
  assert.equal(retriedTask.task.attempt, seekClaim.task.attempt + 1);
  assert.equal(new URL(retriedTask.launchUrl).searchParams.get("jobAgentRun"), run.run.id);
  const staleAttemptResult = await request("/api/worker/result", {
    runId: run.run.id,
    taskId: seekClaim.task.id,
    taskAttempt: seekClaim.task.attempt,
    workerId: "seek-worker",
    status: "completed",
    jobs: [{ source: "seek", sourceJobId: "stale-attempt", title: "Stale attempt", location: "Melbourne VIC" }]
  });
  assert.equal(staleAttemptResult.discarded, true);
  assert.equal(staleAttemptResult.staleAttempt, true);
  await request("/api/runs/" + run.run.id + "/tasks/" + seekClaim.task.id, undefined, "DELETE");

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

  const feedback = await request("/api/jobs/" + imported.jobs[0].id + "/feedback", {
    notHelpful: true,
    reason: "CLASSIFICATION_WRONG",
    note: "The analyst title is not the software role I need."
  }, "PUT");
  assert.equal(feedback.job.feedback.helpfulness, "NOT_HELPFUL");
  assert.equal(feedback.job.feedback.reason, "CLASSIFICATION_WRONG");

  const reflection = await request("/api/runs/" + run.run.id + "/reflection", {});
  assert.equal(reflection.reflection.feedbackCount, 1);
  assert.equal(reflection.reflection.engine, "local-rules");
  assert.equal(reflection.preferenceModel.version, 1);
  assert.ok(reflection.preferenceModel.titleExclusions.includes("Graduate Analyst"));

  const learnedImport = await request("/api/jobs/import", {
    runId: run.run.id,
    jobs: [{
      source: "seek",
      sourceJobId: "smoke-learned-1",
      title: "Graduate Analyst",
      company: "Another Example",
      location: "Melbourne VIC"
    }]
  });
  assert.equal(learnedImport.jobs[0].screening.category, "REJECTED");
  assert.equal(learnedImport.jobs[0].screening.engine, "local-rules+feedback");

  const bootstrap = await request("/api/bootstrap");
  assert.equal(bootstrap.activeProfile.id, replacement.profile.id);
  assert.equal(bootstrap.profiles.length, 1);
  assert.equal(bootstrap.jobs.length, 3);
  assert.equal(bootstrap.reviewReflections.length, 1);
  assert.equal(bootstrap.preferenceModel.feedbackCount, 1);
  assert.equal(bootstrap.routineTasks.length, 4);

  const singleTaskId = bootstrap.routineTasks[0].id;
  const nextRun = await request("/api/runs", { routineTaskIds: [singleTaskId] });
  assert.equal(nextRun.run.tasks.length, 1);
  assert.equal(nextRun.run.tasks[0].routineTaskId, singleTaskId);
  const afterNextRun = await request("/api/bootstrap");
  assert.equal(afterNextRun.runs[0].id, nextRun.run.id);
  assert.equal(afterNextRun.jobs.length, 3);
  assert.ok(afterNextRun.jobs.every((job) => job.runId === run.run.id));
  assert.ok(afterNextRun.jobs.every((job) => job.runId !== afterNextRun.runs[0].id));

  const clearedDailyTasks = await request("/api/routine-tasks", undefined, "DELETE");
  assert.equal(clearedDailyTasks.cleared.count, 4);
  const afterDailyClear = await request("/api/bootstrap");
  assert.equal(afterDailyClear.routineTasks.length, 0);
  assert.equal(afterDailyClear.runs.find((item) => item.id === run.run.id).tasks.filter((task) => task.status === "cancelled").length, 1);

  const clearedRecords = await request("/api/records", undefined, "DELETE");
  assert.equal(clearedRecords.cleared.jobs, 3);
  assert.equal(clearedRecords.cleared.reviewReflections, 1);
  assert.ok(clearedRecords.cleared.runs >= 2);
  assert.ok(clearedRecords.cleared.validations > 0);
  assert.equal(clearedRecords.preserved.taskCategories, 10);
  assert.equal(clearedRecords.preserved.builtinTaskCategories, 10);
  assert.equal(clearedRecords.preserved.customTaskCategories, 0);
  const afterRecordClear = await request("/api/bootstrap");
  assert.equal(afterRecordClear.jobs.length, 0);
  assert.equal(afterRecordClear.runs.length, 0);
  assert.equal(afterRecordClear.routineTasks.length, 0);
  assert.equal(afterRecordClear.validations.length, 0);
  assert.equal(afterRecordClear.profiles.length, 1);
  assert.equal(afterRecordClear.activeProfile.id, replacement.profile.id);
  assert.equal(afterRecordClear.taskCategories.length, 10);
  assert.equal(afterRecordClear.taskCategories.flatMap((category) => category.tasks).length, 23);
  assert.ok(afterRecordClear.taskCategories.every((category) => category.builtin));
  assert.equal(afterRecordClear.reviewReflections.length, 0);
  assert.equal(afterRecordClear.preferenceModel, null);

  const removableDailyTask = await validateRoutineTask("seek", 3);
  const removableRun = await request("/api/runs", { routineTaskIds: [removableDailyTask.routineTask.id] });
  const removableClaim = await request("/api/worker/next?runId=" + removableRun.run.id + "&platform=seek&workerId=remove-test-worker");
  assert.equal(removableClaim.task.id, removableRun.run.tasks[0].id);
  const removableResult = await request("/api/worker/result", {
    runId: removableRun.run.id,
    taskId: removableClaim.task.id,
    taskAttempt: removableClaim.task.attempt,
    workerId: "remove-test-worker",
    status: "completed",
    jobs: [{ source: "seek", sourceJobId: "remove-test-job", title: "Museum Digitisation Coordinator", location: "Melbourne VIC" }]
  });
  assert.equal(removableResult.jobs.length, 1);
  const removedTaskResults = await request("/api/runs/" + removableRun.run.id + "/tasks/" + removableClaim.task.id + "/results", undefined, "DELETE");
  assert.equal(removedTaskResults.removed.tasks, 1);
  assert.equal(removedTaskResults.removed.jobs, 1);
  assert.equal(removedTaskResults.removed.importBatches, 1);
  assert.equal(removedTaskResults.run.tasks.length, 0);
  const removedRunHistory = await request("/api/runs/" + removableRun.run.id, undefined, "DELETE");
  assert.equal(removedRunHistory.removed.runs, 1);
  assert.equal(removedRunHistory.removed.jobs, 0);
  const afterTargetedDeletes = await request("/api/bootstrap");
  assert.equal(afterTargetedDeletes.jobs.length, 0);
  assert.equal(afterTargetedDeletes.runs.length, 0);
  assert.equal(afterTargetedDeletes.routineTasks.length, 1);
  await request("/api/routine-tasks", undefined, "DELETE");
  await request("/api/records", undefined, "DELETE");

  const customCategory = await request("/api/task-categories", {
    name: "Custom technology searches",
    tasks: [
      { platform: "linkedin", keyword: "technology consultant", location: "Sydney, New South Wales, Australia", postedWithinDays: 7 },
      { platform: "seek", keyword: "automation specialist", location: "All Brisbane QLD", postedWithinDays: 0 }
    ]
  });
  assert.equal(customCategory.category.builtin, false);
  assert.equal(customCategory.category.tasks.length, 2);
  const editedCategory = await request("/api/task-categories/" + customCategory.category.id, {
    name: "Custom technology roles",
    tasks: customCategory.category.tasks
  }, "PUT");
  assert.equal(editedCategory.category.name, "Custom technology roles");

  const preparedCategory = await request("/api/task-categories/prepare", {
    categoryIds: [customCategory.category.id],
    mode: "preflight"
  });
  assert.equal(preparedCategory.pending, 2);
  assert.equal(preparedCategory.added, 0);
  const categoryBatch = await request("/api/task-validations/start", { validationIds: preparedCategory.validationIds });
  assert.equal(categoryBatch.count, 2);
  for (const validationId of preparedCategory.validationIds) {
    const pendingCategoryValidation = await request("/api/worker/preflight?validationId=" + validationId + "&platform=" + (validationId === preparedCategory.validationIds[0] ? "linkedin" : "seek"));
    const validation = pendingCategoryValidation.validation;
    await request("/api/worker/preflight/started", {
      validationId,
      platform: validation.platform,
      preflightAttempt: validation.preflightAttempt,
      workerId: "category-worker-" + validation.platform
    });
    const categoryResult = await request("/api/worker/preflight/result", {
      validationId,
      platform: validation.platform,
      preflightAttempt: validation.preflightAttempt,
      status: "valid"
    });
    assert.equal(categoryResult.routineTask, null);
  }
  const afterCategoryPreflight = await request("/api/bootstrap");
  assert.equal(afterCategoryPreflight.routineTasks.length, 0);
  const importedCategory = await request("/api/task-categories/prepare", {
    categoryIds: [customCategory.category.id],
    mode: "import"
  });
  assert.equal(importedCategory.pending, 0);
  assert.equal(importedCategory.added, 2);
  const afterCategoryImport = await request("/api/bootstrap");
  assert.equal(afterCategoryImport.routineTasks.length, 2);
  assert.ok(afterCategoryImport.routineTasks.every((task) => task.categoryId === customCategory.category.id));
  await request("/api/routine-tasks", undefined, "DELETE");
  const clearedWithCustomCategory = await request("/api/records", undefined, "DELETE");
  assert.equal(clearedWithCustomCategory.preserved.taskCategories, 11);
  assert.equal(clearedWithCustomCategory.preserved.builtinTaskCategories, 10);
  assert.equal(clearedWithCustomCategory.preserved.customTaskCategories, 1);
  const afterCustomRecordClear = await request("/api/bootstrap");
  assert.equal(afterCustomRecordClear.taskCategories.length, 11);
  assert.ok(afterCustomRecordClear.taskCategories.some((category) => category.id === customCategory.category.id));
  assert.ok(afterCustomRecordClear.taskCategories.find((category) => category.id === customCategory.category.id)
    .tasks.every((task) => task.validationId === null));
  await request("/api/task-categories/" + customCategory.category.id, undefined, "DELETE");
  const afterCategoryCleanup = await request("/api/bootstrap");
  assert.equal(afterCategoryCleanup.taskCategories.length, 10);
  assert.equal(afterCategoryCleanup.validations.length, 0);
  console.log("API smoke test passed.");
} finally {
  child.kill();
  await rm(directory, { recursive: true, force: true });
}
