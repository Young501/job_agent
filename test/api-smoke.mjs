import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "job-agent-smoke-"));
const port = await availablePort();
const aiPort = await availablePort();
let serverOutput = "";
let transientReviewFailures = 0;
let manualReviewFailures = 0;
const aiServer = createHttpServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body || "{}");
  if (String(payload.input || "").includes("Transient AI Review Failure") && transientReviewFailures === 0) {
    transientReviewFailures += 1;
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("Synthetic transient AI failure");
    return;
  }
  if (String(payload.input || "").includes("Manual AI Review Failure") && manualReviewFailures === 0) {
    manualReviewFailures += 1;
    response.writeHead(422, { "content-type": "text/plain" });
    response.end("Synthetic non-transient AI failure");
    return;
  }
  const isReflection = /Consolidate a candidate's job-screening preferences/i.test(payload.instructions || "");
  const isJobAssistant = /Answer questions about the supplied job-review context/i.test(payload.instructions || "");
  const reflectionInput = isReflection ? JSON.parse(payload.input || "{}") : null;
  const assistantInput = isJobAssistant ? JSON.parse(payload.input || "{}") : null;
  const hasConfirmedRejection = reflectionInput?.rejectedJobSignals?.some((item) => item.humanConfirmed
    && item.feedbackReason === "REJECTION_CORRECT");
  const output = isJobAssistant
    ? {
        answer: "当前列表中 Graduate Analyst 位于 Melbourne VIC，地点文字与画像所在地一致。",
        citedJobIds: assistantInput.jobCatalog.slice(0, 1).map((job) => job.id)
      }
    : isReflection
    ? hasConfirmedRejection ? {
        summary: "The mocked AI omitted confirmed negative evidence.",
        targetSignals: [],
        deprioritizeSignals: [],
        avoidSignals: [],
        titleExclusions: [],
        screeningGuidance: []
      } : {
        summary: "测试复盘已记录用户不需要 Graduate Analyst。",
        targetSignals: ["software engineering"],
        deprioritizeSignals: [],
        avoidSignals: ["Graduate Analyst"],
        titleExclusions: ["Graduate Analyst"],
        screeningGuidance: ["降低 Graduate Analyst 的评分。"]
      }
    : String(payload.input || "").includes("Commercial Rotation Graduate")
      ? {
          titleClassification: "CLEAR_REJECT",
          score: 12,
          reason: "The role focuses on retail merchandising rather than the candidate's target technology work.",
          matchedAreas: [],
          concerns: ["Retail merchandising focus"],
          jdReviewed: true,
          workRights: { assessment: "NOT_STATED", reason: "The JD does not state a work-rights requirement.", requirements: [] },
          preferenceSignals: {
            targetKeywords: [],
            exclusionKeywords: ["retail merchandising"],
            exclusionReason: "This phrase identifies the irrelevant retail function."
          }
        }
    : {
        titleClassification: "CLEAR_MATCH",
        score: 88,
        reason: "The complete JD aligns with the candidate's Python, SQL, cloud, and software automation profile.",
        matchedAreas: ["Python", "SQL", "cloud automation"],
        concerns: [],
        jdReviewed: true
      };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    output_text: JSON.stringify(output),
    usage: { input_tokens: 120, output_tokens: 45, total_tokens: 165 }
  }));
});
await new Promise((resolve, reject) => {
  aiServer.once("error", reject);
  aiServer.listen(aiPort, "127.0.0.1", resolve);
});
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    JOB_AGENT_DATA_DIRECTORY: directory,
    JOB_AGENT_AI_BASE_URL: "",
    JOB_AGENT_AI_MODEL: "",
    JOB_AGENT_AI_API_KEY: "",
    JOB_AGENT_AI_MAX_REQUEST_ATTEMPTS: "1",
    JOB_AGENT_AI_AUTO_RETRY_LIMIT: "1",
    JOB_AGENT_AI_AUTO_RETRY_COOLDOWN_MS: "1000"
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
child.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
child.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

async function availablePort() {
  const probe = createNetServer();
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
  const workerTimingResponse = await request("/api/worker/settings");
  assert.deepEqual(workerTimingResponse.workerTiming, {
    accessLimit: 20,
    cooldownMinutes: 5,
    actionDelaySeconds: 1,
    scrollDelaySeconds: 2,
    pageDelaySeconds: 10,
    jdIntervalSeconds: 1,
    jdRequestTimeoutSeconds: 5,
    jdPageTimeoutSeconds: 10
  });
  const workerResponse = await fetch("http://127.0.0.1:" + port + "/workers/seek/seek-agent-worker.user.js");
  const workerScript = await workerResponse.text();
  assert.equal(workerResponse.ok, true);
  assert.match(workerResponse.headers.get("content-type") || "", /^text\/javascript/);
  assert.match(workerScript, /Job Agent Worker - SEEK/);
  assert.match(workerScript, /@version\s+1\.0\.1/);
  assert.match(workerScript, /const APP_VERSION = "1\.0\.1"/);
  assert.match(workerScript, /function agentShowNaturalSeekKeyword/);
  assert.match(workerScript, /Do not dispatch an input event/);
  const naturalKeywordFunction = extractNamedFunction(workerScript, "agentShowNaturalSeekKeyword");
  const scheduledKeywordUpdates = [];
  const fakeSeekKeywordInput = { value: '"graduate"' };
  const showNaturalSeekKeyword = Function("agentFirst", "agentNormalizeSeekKeyword", "setTimeout",
    `${naturalKeywordFunction}; return agentShowNaturalSeekKeyword;`)(
    () => fakeSeekKeywordInput,
    (value) => String(value || "").trim().replace(/^["']|["']$/g, "").toLowerCase(),
    (callback) => scheduledKeywordUpdates.push(callback)
  );
  showNaturalSeekKeyword("graduate");
  assert.equal(fakeSeekKeywordInput.value, "graduate");
  assert.equal(scheduledKeywordUpdates.length, 4);
  assert.match(workerScript, /agentWaitForSearchResults/);
  const humanBlockFunction = extractNamedFunction(workerScript, "agentHumanBlockReason");
  const detectHumanBlock = (document, location, cards = [], visible = () => true) => Function(
    "document",
    "location",
    "SITE",
    "agentVisible",
    `${humanBlockFunction}; return agentHumanBlockReason();`
  )(document, location, { findCards: () => cards }, visible);
  const normalSeekDocument = {
    title: "graduate Jobs in All Australia",
    body: { innerText: "1,271 jobs. Learn about account security checks in our help centre." },
    querySelectorAll: () => []
  };
  assert.equal(detectHumanBlock(normalSeekDocument, { pathname: "/jobs/in-All-Australia" }, [{}]), null);
  const challengeSeekDocument = {
    title: "Verify your request",
    body: { innerText: "Please verify that you are human before continuing." },
    querySelectorAll: (selector) => selector.includes("h1") ? [{ innerText: "Verify that you are human" }] : []
  };
  assert.match(detectHumanBlock(challengeSeekDocument, { pathname: "/jobs" }), /检测到可见的安全验证/);
  const captchaSeekDocument = {
    title: "graduate Jobs in All Australia",
    body: { innerText: "1,271 jobs" },
    querySelectorAll: (selector) => selector.includes("iframe[src*='captcha'") ? [{ tagName: "IFRAME" }] : []
  };
  assert.match(detectHumanBlock(captchaSeekDocument, { pathname: "/jobs/in-All-Australia" }, [{}]), /检测到可见的安全验证/);
  assert.match(workerScript, /agentRefreshTiming\(runId = agentTask\?\.runId\)/);
  assert.match(workerScript, /workerTiming: \{ \.\.\.agentTiming \}/);
  assert.match(workerScript, /Job Agent 访问节奏/);
  assert.match(workerScript, /ui\.pageDelaySeconds\.value = String\(agentTiming\.pageDelaySeconds\)/);
  assert.match(workerScript, /agentEnrichJobs/);
  assert.match(workerScript, /\/api\/worker\/title-plan/);
  assert.match(workerScript, /\/api\/worker\/history\/import/);
  assert.match(workerScript, /jobAgentHistoryMigration/);
  assert.match(workerScript, /job-agent-history-migration-finished/);
  assert.match(workerScript, /window\.name === "job-agent-history-migration"/);
  assert.match(workerScript, /!agentTask && isSeen\(job\)/);
  assert.match(workerScript, /action === "skip_seen"/);
  assert.match(workerScript, /job\.agentJobId = planItem\.jobId/);
  assert.match(workerScript, /data-automation=\"jobAdDetails\"/);
  assert.match(workerScript, /@match\s+https:\/\/au\.seek\.com\/job\/\*/);
  assert.match(workerScript, /agentExtractDescriptionFromDocument\(document\)/);
  assert.match(workerScript, /agentRunJdChild/);
  assert.match(workerScript, /jobAgentJdRequest/);
  assert.match(workerScript, /Rendered fallback:/);
  assert.match(workerScript, /agentRunOnDemandJd/);
  assert.match(workerScript, /jobAgentOnDemandJd/);
  assert.match(workerScript, /agentContinueJdBatch/);
  assert.match(workerScript, /jobAgentJdBatch/);
  assert.match(workerScript, /DEFAULT_AGENT_TIMING/);
  assert.match(workerScript, /agentTiming\.jdRequestTimeoutSeconds/);
  assert.match(workerScript, /agentTiming\.jdPageTimeoutSeconds/);
  assert.match(workerScript, /agentTiming\.accessLimit/);
  assert.match(workerScript, /agentTiming\.cooldownMinutes/);
  assert.match(workerScript, /agentRefreshTiming/);
  assert.match(workerScript, /response\.stopRequested/);
  assert.match(workerScript, /agentStopRequested/);
  assert.match(workerScript, /agentBeforePlatformAccess/);
  assert.match(workerScript, /cooldownUntil/);
  assert.match(workerScript, /scanSessionKey/);
  assert.match(workerScript, /agentSaveScanSession/);
  assert.match(workerScript, /agentContinuationUrl/);
  assert.match(workerScript, /if \(!agentTask && state\.page > 1\)/);
  assert.match(workerScript, /SEEK 返回 429/);
  assert.match(workerScript, /agentRecoverRateLimitedPage/);
  assert.match(workerScript, /agentTask\.exclusionKeywords/);
  assert.match(workerScript, /active: true/);
  assert.doesNotMatch(workerScript, /45000|45 seconds/);
  assert.match(workerScript, /\/api\/worker\/job-jd/);
  assert.match(workerScript, /@namespace\s+https:\/\/routine\.local\/job-agent-worker/);
  assert.match(workerScript, /@updateURL\s+http:\/\/127\.0\.0\.1:4317\/workers\/seek\/seek-agent-worker\.user\.js/);
  assert.match(workerScript, /@downloadURL\s+http:\/\/127\.0\.0\.1:4317\/workers\/seek\/seek-agent-worker\.user\.js/);
  assert.match(workerScript, /preflight\/pending/);
  assert.match(workerScript, /agentWaitAndClickText/);
  assert.match(workerScript, /agentSeekKeywordForSearch/);
  const seekKeywordFunction = workerScript.match(/function agentSeekKeywordForSearch\(value\) \{[\s\S]*?\n    \}/)?.[0];
  assert.ok(seekKeywordFunction, "SEEK keyword normalizer should be present");
  const agentSeekKeywordForSearch = Function(`${seekKeywordFunction}; return agentSeekKeywordForSearch;`)();
  assert.equal(agentSeekKeywordForSearch("graduate"), '"graduate"');
  assert.equal(agentSeekKeywordForSearch('"graduate"'), '"graduate"');
  assert.equal(agentSeekKeywordForSearch("intern"), "intern");
  assert.match(workerScript, /function agentParam\(params, name\)/);
  assert.match(workerScript, /runId && !agentParam\(params, "jobAgentTask"\)/);
  assert.match(workerScript, /\[150, 600, 1800, 4000\]/);
  assert.match(workerScript, /agentSearchKeyword/);
  assert.match(workerScript, /agentIncludeKeywordText/);
  assert.match(workerScript, /agentNormalizeSeekKeyword/);
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
  assert.match(workerScript, /background:transparent/);
  assert.match(workerScript, /align-items:flex-end/);
  assert.match(workerScript, /pointer-events:none/);
  assert.match(workerScript, /脚本正在操作 · 请勿操作此窗口/);
  assert.match(workerScript, /ja-operation-float/);
  assert.doesNotMatch(workerScript, /backdrop-filter:blur/);
  assert.match(workerScript, /agentAssertSearchResults/);
  assert.match(workerScript, /jobAgentReset/);
  assert.match(workerScript, /agentRunHistoryReset/);
  assert.match(workerScript, /job-agent-reset-progress/);
  assert.match(workerScript, /job-agent-reset-finished/);
  assert.match(workerScript, /jobAgentClearHistoryDate/);
  assert.match(workerScript, /clearHistoryForDate/);
  const localDateKeyFunction = extractNamedFunction(workerScript, "localDateKey");
  const clearHistoryForDateFunction = extractNamedFunction(workerScript, "clearHistoryForDate");
  const todayStamp = new Date(2026, 7, 19, 10, 0, 0).toISOString();
  const olderStamp = new Date(2026, 7, 18, 10, 0, 0).toISOString();
  const historyHarness = Function("initialHistory", `${localDateKeyFunction}; let historyStore = initialHistory; const saveHistory = () => {}; const updateCounters = () => {}; ${clearHistoryForDateFunction}; return { clearHistoryForDate, history: () => historyStore };`)({
    entries: {
      "seek:job:today": { id: "today", firstSeenAt: todayStamp },
      "seek:url:today": { id: "today", firstSeenAt: todayStamp },
      "seek:job:older": { id: "older", firstSeenAt: olderStamp }
    }
  });
  const datedHistoryClear = historyHarness.clearHistoryForDate("2026-08-19");
  assert.deepEqual(datedHistoryClear, { jobs: 1, entries: 2 });
  assert.deepEqual(Object.keys(historyHarness.history().entries), ["seek:job:older"]);
  const indeedWorkerResponse = await fetch("http://127.0.0.1:" + port + "/workers/indeed/indeed-agent-worker.user.js");
  const indeedWorkerScript = await indeedWorkerResponse.text();
  assert.equal(indeedWorkerResponse.ok, true);
  assert.match(indeedWorkerResponse.headers.get("content-type") || "", /^text\/javascript/);
  assert.match(indeedWorkerScript, /@name\s+Job Agent Worker - Indeed/);
  assert.match(indeedWorkerScript, /@namespace\s+https:\/\/routine\.local\/job-agent-worker/);
  assert.match(indeedWorkerScript, /@version\s+1\.0\.1/);
  assert.match(indeedWorkerScript, /const APP_VERSION = "1\.0\.1"/);
  assert.match(indeedWorkerScript, /agentWaitForSearchResults/);
  assert.match(indeedWorkerScript, /agentRefreshTiming\(runId = agentTask\?\.runId\)/);
  assert.match(indeedWorkerScript, /workerTiming: \{ \.\.\.agentTiming \}/);
  assert.match(indeedWorkerScript, /Job Agent 访问节奏/);
  assert.match(indeedWorkerScript, /agentEnrichJobs/);
  assert.match(indeedWorkerScript, /\/api\/worker\/title-plan/);
  assert.match(indeedWorkerScript, /\/api\/worker\/history\/import/);
  assert.match(indeedWorkerScript, /!agentTask && isSeen\(job\)/);
  assert.match(indeedWorkerScript, /action === "skip_seen"/);
  assert.match(indeedWorkerScript, /jobDescriptionText/);
  assert.match(indeedWorkerScript, /agentRunJdChild/);
  assert.match(indeedWorkerScript, /jobAgentJdRequest/);
  assert.match(indeedWorkerScript, /agentExtractDescriptionFromDocument\(document\)/);
  assert.match(indeedWorkerScript, /Description panel:/);
  assert.match(indeedWorkerScript, /searchParams\.set\("vjk"/);
  assert.match(indeedWorkerScript, /需要进行其他验证/);
  assert.match(indeedWorkerScript, /agentRunOnDemandJd/);
  assert.match(indeedWorkerScript, /jobAgentOnDemandJd/);
  assert.match(indeedWorkerScript, /agentContinueJdBatch/);
  assert.match(indeedWorkerScript, /jobAgentJdBatch/);
  assert.match(indeedWorkerScript, /agentRequestJobPage\(detailUrl\.href\)/);
  assert.match(indeedWorkerScript, /DEFAULT_AGENT_TIMING/);
  assert.match(indeedWorkerScript, /agentTiming\.jdRequestTimeoutSeconds/);
  assert.match(indeedWorkerScript, /agentTiming\.jdPageTimeoutSeconds/);
  assert.match(indeedWorkerScript, /agentTiming\.accessLimit/);
  assert.match(indeedWorkerScript, /agentTiming\.cooldownMinutes/);
  assert.match(indeedWorkerScript, /agentRefreshTiming/);
  assert.match(indeedWorkerScript, /response\.stopRequested/);
  assert.match(indeedWorkerScript, /agentStopRequested/);
  assert.match(indeedWorkerScript, /agentBeforePlatformAccess/);
  assert.match(indeedWorkerScript, /cooldownUntil/);
  assert.match(indeedWorkerScript, /agentTask\.exclusionKeywords/);
  assert.match(indeedWorkerScript, /active: true/);
  assert.doesNotMatch(indeedWorkerScript, /45000|45 seconds/);
  assert.match(indeedWorkerScript, /\/api\/worker\/job-jd/);
  assert.match(indeedWorkerScript, /preflight\/next-launch/);
  assert.match(indeedWorkerScript, /agentSearchKeyword/);
  assert.match(indeedWorkerScript, /agentIncludeKeywordText/);
  assert.match(indeedWorkerScript, /worker\/next-platform-launch/);
  assert.match(indeedWorkerScript, /@updateURL\s+http:\/\/127\.0\.0\.1:4317\/workers\/indeed\/indeed-agent-worker\.user\.js/);
  assert.match(indeedWorkerScript, /@downloadURL\s+http:\/\/127\.0\.0\.1:4317\/workers\/indeed\/indeed-agent-worker\.user\.js/);
  assert.match(indeedWorkerScript, /agentWaitAndClickText\(\/\^update\$\/i/);
  assert.match(indeedWorkerScript, /agentWaitForIndeedDateOption/);
  assert.match(indeedWorkerScript, /agentWaitForIndeedDateSelection/);
  assert.match(indeedWorkerScript, /agentFindIndeedDateUpdateButton/);
  assert.match(indeedWorkerScript, /agentWaitForIndeedDateParameter/);
  assert.match(indeedWorkerScript, /Date posted options/);
  assert.match(indeedWorkerScript, /directUrl\.searchParams\.set\("fromage"/);
  assert.match(indeedWorkerScript, /window\.location\.assign\(searchUrl\.href\)/);
  assert.match(indeedWorkerScript, /current\.get\("fromage"\)/);
  assert.match(indeedWorkerScript, /worker\/progress/);
  assert.match(indeedWorkerScript, /job-agent-operation-overlay/);
  assert.match(indeedWorkerScript, /background:transparent/);
  assert.match(indeedWorkerScript, /align-items:flex-end/);
  assert.match(indeedWorkerScript, /pointer-events:none/);
  assert.match(indeedWorkerScript, /脚本正在操作 · 请勿操作此窗口/);
  assert.match(indeedWorkerScript, /ja-operation-float/);
  assert.match(indeedWorkerScript, /stage: "direct-verify"/);
  assert.doesNotMatch(indeedWorkerScript, /backdrop-filter:blur/);
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
  assert.match(linkedInWorkerScript, /@version\s+1\.0\.1/);
  assert.match(linkedInWorkerScript, /const APP_VERSION = "1\.0\.1"/);
  assert.match(linkedInWorkerScript, /agentRefreshTiming\(runId = agentTask\?\.runId\)/);
  assert.match(linkedInWorkerScript, /workerTiming: \{ \.\.\.agentTiming \}/);
  assert.match(linkedInWorkerScript, /Job Agent 访问节奏/);
  assert.match(linkedInWorkerScript, /agentEnrichJobs/);
  assert.match(linkedInWorkerScript, /\/api\/worker\/title-plan/);
  assert.match(linkedInWorkerScript, /\/api\/worker\/history\/import/);
  assert.match(linkedInWorkerScript, /!agentTask && isSeen\(candidate\)/);
  assert.match(linkedInWorkerScript, /action === "skip_seen"/);
  assert.match(linkedInWorkerScript, /jobs-description-content__text/);
  assert.match(linkedInWorkerScript, /@match\s+https:\/\/www\.linkedin\.com\/jobs\/view\/\*/);
  assert.match(linkedInWorkerScript, /@match\s+https:\/\/www\.linkedin\.com\/authwall\*/);
  assert.match(linkedInWorkerScript, /agentRunJdChild/);
  assert.match(linkedInWorkerScript, /jobAgentJdRequest/);
  assert.match(linkedInWorkerScript, /about the job/);
  assert.match(linkedInWorkerScript, /agentExpandJobDescription/);
  assert.match(linkedInWorkerScript, /agentExtractDescriptionFromDocument\(document\)/);
  assert.match(linkedInWorkerScript, /More control:/);
  assert.match(linkedInWorkerScript, /agentTiming\.jdPageTimeoutSeconds/);
  assert.match(linkedInWorkerScript, /agentRunOnDemandJd/);
  assert.match(linkedInWorkerScript, /jobAgentOnDemandJd/);
  assert.match(linkedInWorkerScript, /agentContinueJdBatch/);
  assert.match(linkedInWorkerScript, /jobAgentJdBatch/);
  assert.match(linkedInWorkerScript, /agentRequestJobPage\(job\.jobUrl\)/);
  assert.match(linkedInWorkerScript, /DEFAULT_AGENT_TIMING/);
  assert.match(linkedInWorkerScript, /agentTiming\.jdRequestTimeoutSeconds/);
  assert.match(linkedInWorkerScript, /agentTiming\.accessLimit/);
  assert.match(linkedInWorkerScript, /agentTiming\.cooldownMinutes/);
  assert.match(linkedInWorkerScript, /agentRefreshTiming/);
  assert.match(linkedInWorkerScript, /response\.stopRequested/);
  assert.match(linkedInWorkerScript, /agentStopRequested/);
  assert.match(linkedInWorkerScript, /agentBeforePlatformAccess/);
  assert.match(linkedInWorkerScript, /cooldownUntil/);
  assert.match(linkedInWorkerScript, /agentTask\.exclusionKeywords/);
  assert.match(linkedInWorkerScript, /active: true/);
  assert.doesNotMatch(linkedInWorkerScript, /45000|45 seconds/);
  assert.match(linkedInWorkerScript, /\/api\/worker\/job-jd/);
  assert.match(linkedInWorkerScript, /location\.pathname\.startsWith\("\/jobs\/search\/"\)/);
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
  assert.match(linkedInWorkerScript, /background:transparent/);
  assert.match(linkedInWorkerScript, /align-items:flex-end/);
  assert.match(linkedInWorkerScript, /pointer-events:none/);
  assert.match(linkedInWorkerScript, /脚本正在操作 · 请勿操作此窗口/);
  assert.match(linkedInWorkerScript, /ja-operation-float/);
  assert.doesNotMatch(linkedInWorkerScript, /backdrop-filter:blur/);
  assert.match(linkedInWorkerScript, /agentAssertSearchResults/);
  assert.match(linkedInWorkerScript, /agentRunHistoryReset/);
  assert.match(linkedInWorkerScript, /https:\/\/au\.indeed\.com\/jobs\?jobAgentReset=1&jobAgentResetAll=1/);
  assert.match(linkedInWorkerScript, /job-agent-reset-progress/);
  const dashboardResponse = await fetch("http://127.0.0.1:" + port + "/");
  const dashboardHtml = await dashboardResponse.text();
  assert.equal(dashboardResponse.ok, true);
  assert.match(dashboardHtml, /id="view-setup"/);
  assert.match(dashboardHtml, /安装设置/);
  assert.match(dashboardHtml, /id="migrate-worker-history"/);
  assert.match(dashboardHtml, /id="profile-upload-pane"/);
  assert.match(dashboardHtml, /data-profile-pane="editor"/);
  assert.match(dashboardHtml, /data-jobs-pane="current"/);
  assert.match(dashboardHtml, /data-jobs-pane="history"/);
  assert.match(dashboardHtml, /id="history-task-index"/);
  assert.match(dashboardHtml, /id="history-task-index-body"/);
  assert.match(dashboardHtml, /id="history-search"/);
  assert.match(dashboardHtml, /id="history-search-results"/);
  assert.match(dashboardHtml, /id="history-search-results-body"/);
  assert.match(dashboardHtml, /id="job-assistant"/);
  assert.match(dashboardHtml, /id="toggle-job-assistant"/);
  assert.match(dashboardHtml, /id="job-assistant-form"/);
  assert.match(dashboardHtml, /id="back-history-tasks"/);
  assert.doesNotMatch(dashboardHtml, /id="select-all-routine-tasks"/);
  assert.match(dashboardHtml, /id="run-selected-routine-tasks"/);
  assert.match(dashboardHtml, /id="retry-failed-jds"/);
  assert.match(dashboardHtml, /id="retry-failed-ai-reviews"/);
  assert.match(dashboardHtml, /id="delete-selected-history-run"/);
  assert.match(dashboardHtml, /id="job-run-stats"/);
  assert.match(dashboardHtml, /未审阅完成任务/);
  assert.match(dashboardHtml, /id="active-job-task-filter"/);
  assert.match(dashboardHtml, /id="job-viewed"/);
  assert.match(dashboardHtml, /value="priority"/);
  assert.match(dashboardHtml, /id="review-learning"/);
  assert.match(dashboardHtml, /id="complete-run-review"/);
  assert.doesNotMatch(dashboardHtml, /id="review-learning-content"/);
  assert.match(dashboardHtml, /id="settings-learning-content"/);
  assert.match(dashboardHtml, /id="timing-access-limit"/);
  assert.match(dashboardHtml, /id="timing-cooldown-minutes"/);
  assert.match(dashboardHtml, /id="timing-jd-page-timeout"/);
  assert.match(dashboardHtml, /id="feedback-dialog"/);
  assert.match(dashboardHtml, /id="score-dialog"/);
  assert.match(dashboardHtml, /id="score-dialog-content"/);
  assert.match(dashboardHtml, /value="ROLE_RELEVANT"/);
  assert.match(dashboardHtml, /value="WOULD_APPLY"/);
  assert.match(dashboardHtml, /value="CLASSIFICATION_WRONG"/);
  assert.match(dashboardHtml, /Rejected 判断不正确/);
  assert.match(dashboardHtml, /value="ROLE_NOT_INTERESTED"/);
  assert.match(dashboardHtml, /value="SKILL_MISMATCH"/);
  assert.match(dashboardHtml, /value="WOULD_NOT_APPLY"/);
  assert.match(dashboardHtml, /id="exclusion-suggestions"/);
  assert.match(dashboardHtml, /id="run-confirmation-dialog"/);
  assert.match(dashboardHtml, /明确不符合/);
  assert.match(dashboardHtml, /id="open-clear-all-history"/);
  assert.match(dashboardHtml, /id="clear-all-history-dialog"/);
  assert.match(dashboardHtml, /id="confirm-clear-all-history"/);
  assert.match(dashboardHtml, /内置预设、自定义任务组合/);
  assert.match(dashboardHtml, /任务组合/);
  assert.match(dashboardHtml, /unified-run-selection/);
  assert.match(dashboardHtml, /id="task-category-list"/);
  assert.match(dashboardHtml, /id="preflight-selected-categories"/);
  assert.match(dashboardHtml, /id="import-selected-categories"/);
  assert.match(dashboardHtml, /id="routine-platform-selectors"/);
  assert.match(dashboardHtml, /id="select-visible-routine-tasks"/);
  assert.match(dashboardHtml, /id="clear-routine-selection"/);
  assert.match(dashboardHtml, /id="task-category-dialog"/);
  assert.match(dashboardHtml, /id="category-verified-task-list"/);
  assert.match(dashboardHtml, /id="category-task-editor"/);
  assert.match(dashboardHtml, /多个备选词用逗号分隔/);
  assert.match(dashboardHtml, /统一职位历史/);
  assert.match(dashboardHtml, /id="unified-history-summary"/);
  const dashboardScriptResponse = await fetch("http://127.0.0.1:" + port + "/app.js");
  const dashboardScript = await dashboardScriptResponse.text();
  assert.match(dashboardScript, /data-install-worker/);
  assert.match(dashboardScript, /data-score-details/);
  assert.match(dashboardScript, /function retryFailedJds/);
  assert.match(dashboardScript, /\/api\/jobs\/retry-failed-jd/);
  assert.match(dashboardScript, /function retryFailedAiReviews/);
  assert.match(dashboardScript, /\/api\/jobs\/retry-failed-ai/);
  assert.match(dashboardScript, /setInterval\(autoReload, 2500\)/);
  assert.match(dashboardScript, /function openScoreDetails/);
  assert.match(dashboardScript, /AI 根据完整 JD 与职业画像进行语义综合评分/);
  assert.match(dashboardScript, /安装 \/ 更新/);
  assert.match(dashboardScript, /name: "Indeed", version: "v1\.0\.1"/);
  assert.match(dashboardScript, /name: "SEEK", version: "v1\.0\.1"/);
  assert.match(dashboardScript, /function selectRoutineTaskRange/);
  assert.match(dashboardScript, /data-routine-platform-select/);
  assert.match(dashboardScript, /\/workers\/install\//);
  assert.match(dashboardScript, /agent-worker-/);
  const installerResponse = await fetch("http://127.0.0.1:" + port + "/workers/install/indeed-agent-worker-v1.0.1.user.js");
  const installerScript = await installerResponse.text();
  assert.equal(installerResponse.ok, true);
  assert.match(installerResponse.headers.get("content-type") || "", /^text\/javascript/);
  assert.match(installerScript, /@name\s+Job Agent Worker - Indeed/);
  assert.match(installerScript, /@version\s+1\.0\.1/);
  assert.match(dashboardScript, /data-copy-worker/);
  assert.match(dashboardScript, /loadWorkerScripts/);
  assert.match(dashboardScript, /job-agent:view/);
  assert.match(dashboardScript, /\/api\/task-validations\/start/);
  assert.match(dashboardScript, /job-agent-preflight-batch/);
  assert.match(dashboardScript, /job-agent-worker-launch/);
  assert.match(dashboardScript, /finishProfileChipPointerDrag/);
  assert.match(dashboardScript, /acceptSuggestedGroup/);
  assert.match(dashboardScript, /candidateItems/);
  assert.match(dashboardScript, /basicInfo/);
  assert.match(dashboardScript, /workExperience/);
  assert.match(dashboardScript, /projectExperience/);
  assert.match(dashboardScript, /extracurricular/);
  assert.match(dashboardScript, /certifications/);
  assert.match(dashboardScript, /languages/);
  assert.match(dashboardScript, /honors/);
  assert.match(dashboardScript, /customSections/);
  assert.match(dashboardScript, /function profileEntryMarkup/);
  assert.match(dashboardScript, /function addCustomProfileSection/);
  assert.match(dashboardScript, /function currentRunJobs\(\)/);
  assert.match(dashboardScript, /function pendingReviewTaskEntries\(\)/);
  assert.match(dashboardScript, /function markRunTaskViewed\(runId, id, button\)/);
  assert.match(dashboardScript, /data-mark-task-viewed/);
  assert.match(dashboardScript, /标记已全部看完/);
  assert.match(dashboardScript, /selectedRoutineTaskIds: new Set\(\)/);
  assert.match(dashboardScript, /data-routine-task-select/);
  assert.match(dashboardScript, /function runSelectedRoutineTasks\(\)/);
  assert.match(dashboardScript, /function screeningMethodBadge\(job\)/);
  assert.match(dashboardScript, /data-filter-job-stat-task/);
  assert.match(dashboardScript, /data-toggle-viewed/);
  assert.match(dashboardScript, /STRONG_MATCH: 0/);
  assert.match(dashboardScript, /function historicalJobs\(\)/);
  assert.match(dashboardScript, /function historicalTaskEntries\(\)/);
  assert.match(dashboardScript, /job\.title, job\.company, job\.location/);
  assert.match(dashboardScript, /data-history-query/);
  assert.match(dashboardScript, /function jobAssistantReviewContext\(\)/);
  assert.match(dashboardScript, /function sendJobAssistant\(event\)/);
  assert.match(dashboardScript, /\/api\/jobs\/assistant/);
  assert.match(dashboardScript, /latest\?\.reviewCompletedAt \? null : latest/);
  assert.match(dashboardScript, /function runIsFinished\(run\)/);
  assert.match(dashboardScript, /function todayRoutineTaskRun\(routineTaskId\)/);
  assert.match(dashboardScript, /function todayRoutineTaskBadge\(runTask\)/);
  assert.match(dashboardScript, /今日已运行/);
  assert.match(dashboardScript, /today-run-badge/);
  assert.match(dashboardScript, /terminalTaskStatuses/);
  assert.match(dashboardScript, /archiveAfterReflection/);
  assert.match(dashboardScript, /job-review-meta/);
  assert.match(dashboardScript, /data-open-history-task/);
  assert.match(dashboardScript, /executedAt: task\.startedAt/);
  assert.match(dashboardScript, /state\.jobsPane === "history"/);
  assert.match(dashboardScript, /data-run-routine-task/);
  assert.match(dashboardScript, /data-stop-run-task/);
  assert.match(dashboardScript, /function stopRunTask\(id\)/);
  assert.match(dashboardScript, /data-rerun-task/);
  assert.match(dashboardScript, /data-launch-run-task/);
  assert.match(dashboardScript, /function openRunTaskWorker\(id\)/);
  assert.match(dashboardScript, /若窗口已关闭，请点击“打开 Worker”/);
  assert.match(dashboardScript, /state\.data\.unifiedHistory/);
  assert.match(dashboardScript, /data-add-validation-task/);
  assert.match(dashboardScript, /ai-review-badge/);
  assert.match(dashboardScript, /score-trigger/);
  assert.match(dashboardScript, /AI_REVIEWING/);
  assert.match(dashboardScript, /AI_RETRY_WAIT/);
  assert.match(dashboardScript, /data-rereview/);
  assert.match(dashboardScript, /function rereviewJob\(id, button\)/);
  assert.match(dashboardScript, /使用已保存的完整 JD 重新 AI 审阅/);
  assert.match(dashboardScript, /\/fetch-jd/);
  assert.match(dashboardScript, /获取完整 JD/);
  assert.doesNotMatch(dashboardHtml, /id="review-description"/);
  assert.match(dashboardScript, /job-agent-run-finished/);
  assert.match(dashboardScript, /renderPendingReviewTasks/);
  assert.match(dashboardScript, /data-delete-job-stat-task/);
  assert.match(dashboardScript, /data-delete-run-history/);
  assert.match(dashboardScript, /function deleteJobStatTask/);
  assert.match(dashboardScript, /function deleteRunHistory/);
  assert.match(dashboardScript, /renderReviewLearning/);
  assert.match(dashboardScript, /renderPreferenceLearningSettings/);
  assert.match(dashboardScript, /model\.deprioritizeSignals/);
  assert.doesNotMatch(dashboardScript, /learningChips\(\[\.\.\.\(model\.avoidSignals/);
  assert.match(dashboardScript, /saveJobFeedback/);
  assert.match(dashboardScript, /REJECTION_INCORRECT/);
  assert.match(dashboardScript, /REJECTION_CORRECT/);
  assert.match(dashboardHtml, /value="REJECTION_CORRECT"/);
  assert.match(dashboardScript, /function effectiveJobCategory/);
  assert.match(dashboardScript, /data-feedback-mode="negative"/);
  assert.match(dashboardScript, /completeRunReview/);
  assert.match(dashboardScript, /const run = selectedReviewRun\(\)/);
  assert.match(dashboardScript, /\/api\/records/);
  assert.match(dashboardScript, /jobAgentResetAll/);
  assert.match(dashboardScript, /job-agent-reset-progress/);
  assert.match(dashboardScript, /job-agent-reset-finished/);
  assert.match(dashboardScript, /prepareSelectedCategories/);
  assert.match(dashboardScript, /\/api\/task-categories\/prepare/);
  assert.match(dashboardScript, /data-category-select/);
  assert.match(dashboardScript, /data-category-verified-task/);
  assert.match(dashboardScript, /sourceValidationId/);
  assert.match(dashboardScript, /function requestRunConfirmation/);
  assert.match(dashboardScript, /settings\/exclusion-keywords/);
  assert.match(dashboardScript, /exclusion-suggestions/);

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
  assert.equal(generated.profile.profile.schemaVersion, 2);
  assert.equal(generated.profile.profile.basicInfo.name, "Candidate");
  assert.deepEqual(generated.profile.profile.customSections.at(-1).entries[0].highlights, ["Backend API projects", "Cloud coursework"]);

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

  const updatedExclusions = await request("/api/settings/exclusion-keywords", { keyword: "retail assistant" });
  assert.ok(updatedExclusions.settings.exclusionKeywords.includes("retail assistant"));
  await validateRoutineTask("linkedin", 1);
  const run = await request("/api/runs", {});
  assert.equal(run.run.tasks.length, 4);
  assert.deepEqual(run.run.tasks[0].workerTiming, run.run.settingsSnapshot.workerTiming);
  const runTimingResponse = await request("/api/worker/settings?runId=" + run.run.id);
  assert.deepEqual(runTimingResponse.workerTiming, run.run.settingsSnapshot.workerTiming);
  assert.equal(runTimingResponse.source, "run-snapshot");
  assert.equal(runTimingResponse.runId, run.run.id);
  assert.ok(run.run.tasks.every((task) => task.exclusionKeywords.includes("retail assistant")));
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

  const firstQueuedTask = run.run.tasks[0];
  const reopenedQueuedWorker = await request("/api/runs/" + run.run.id + "/tasks/" + firstQueuedTask.id + "/launch", {});
  assert.equal(reopenedQueuedWorker.task.id, firstQueuedTask.id);
  assert.equal(reopenedQueuedWorker.recovered, false);
  assert.equal(new URL(reopenedQueuedWorker.launchUrl).searchParams.get("jobAgentRun"), run.run.id);

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
  const migratedHistory = await request("/api/worker/history/import", {
    platform: "linkedin",
    records: [{
      jobId: "legacy-cross-platform",
      title: "Graduate Platform Reliability Specialist",
      company: "Unified History Example Pty Ltd",
      location: "Melbourne VIC",
      link: "https://www.linkedin.com/jobs/view/99887766/"
    }]
  });
  assert.equal(migratedHistory.clearLocalHistory, true);
  assert.equal(migratedHistory.migration.imported, 1);
  const opaqueHistory = await request("/api/worker/history/import", {
    platform: "linkedin",
    records: ["fp:legacy example|graduate software developer"]
  });
  assert.equal(opaqueHistory.clearLocalHistory, true);
  assert.equal(opaqueHistory.migration.imported, 1);
  assert.equal(opaqueHistory.migration.preservedOpaque, 1);
  const coveredOpaqueHistory = await request("/api/worker/history/import", {
    platform: "linkedin",
    records: [{ key: "fp:legacy example|graduate software developer" }]
  });
  assert.equal(coveredOpaqueHistory.migration.imported, 0);
  assert.equal(coveredOpaqueHistory.migration.covered, 1);
  const normalizedHistory = await request("/api/history/normalize", {});
  assert.equal(normalizedHistory.cleanup.mergedAliases, 0);
  assert.equal(normalizedHistory.cleanup.opaque, 1);
  const titlePlan = await request("/api/worker/title-plan", {
    runId: run.run.id,
    taskId: indeedClaim.task.id,
    jobs: [
      { source: "indeed", sourceJobId: "plan-reject", title: "Senior Civil Engineer" },
      { source: "indeed", sourceJobId: "plan-fetch", title: "Graduate Analyst" },
      {
        source: "indeed",
        sourceJobId: "cross-platform-copy",
        title: "Graduate Platform Reliability Specialist",
        company: "Unified History Example Limited",
        location: "Melbourne, Victoria"
      }
    ]
  });
  assert.equal(titlePlan.plan[0].action, "reject");
  assert.equal(titlePlan.plan[1].action, "fetch");
  assert.equal(titlePlan.plan[2].action, "skip_seen");
  assert.ok(titlePlan.plan.every((item) => item.jobId));
  assert.equal(titlePlan.counts.fetch, 1);
  assert.equal(titlePlan.counts.seen, 1);
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
    }, {
      source: "indeed",
      sourceJobId: "plan-fetch",
      agentJobId: titlePlan.plan[1].jobId,
      title: "Graduate Analyst",
      descriptionFetchStatus: "failed",
      descriptionFetchError: "Synthetic detail fetch failure"
    }]
  });
  const attributedWorkerJob = pausedIndeedResult.jobs.find((job) => job.sourceJobId === "worker-attribution");
  const mergedPlanJob = pausedIndeedResult.jobs.find((job) => job.sourceJobId === "plan-fetch");
  assert.equal(attributedWorkerJob.runTaskId, indeedClaim.task.id);
  assert.equal(attributedWorkerJob.routineTaskId, indeedClaim.task.routineTaskId);
  assert.equal(attributedWorkerJob.searchKeyword, indeedClaim.task.keyword);
  assert.equal(attributedWorkerJob.searchLocation, indeedClaim.task.location);
  assert.equal(attributedWorkerJob.searchPostedWithinDays, indeedClaim.task.postedWithinDays);
  assert.equal(mergedPlanJob.id, titlePlan.plan[1].jobId);
  const mergedPlanBootstrap = await request("/api/bootstrap");
  assert.equal(mergedPlanBootstrap.jobs.filter((job) => job.sourceJobId === "plan-fetch").length, 1);
  const pausedIndeed = await request("/api/worker/next?runId=" + run.run.id + "&platform=indeed&workerId=indeed-worker");
  assert.equal(pausedIndeed.task, null);
  assert.equal(pausedIndeed.reason, "needs_user_action");
  const activeLinkedInRunWhileIndeedPaused = await request("/api/worker/active-run?platform=linkedin");
  assert.equal(activeLinkedInRunWhileIndeedPaused.run.id, run.run.id);
  const resumedWorkerLaunch = await request("/api/tasks/" + indeedClaim.task.id + "/resume", {});
  assert.equal(new URL(resumedWorkerLaunch.launchUrl).searchParams.get("jobAgentRun"), run.run.id);
  const resumedIndeed = await request("/api/worker/next?runId=" + run.run.id + "&platform=indeed&workerId=indeed-worker");
  assert.equal(resumedIndeed.task.id, indeedClaim.task.id);

  const stopAndKeep = await request("/api/runs/" + run.run.id + "/tasks/" + resumedIndeed.task.id + "/stop", {});
  assert.equal(stopAndKeep.stopRequested, true);
  assert.ok(stopAndKeep.task.stopRequestedAt);
  const stopProgress = await request("/api/worker/progress", {
    runId: run.run.id,
    taskId: resumedIndeed.task.id,
    taskAttempt: resumedIndeed.task.attempt,
    workerId: "indeed-worker",
    phase: "scanning",
    message: "Indeed is checking for a stop request.",
    scanned: 8,
    found: 2
  });
  assert.equal(stopProgress.stopRequested, true);
  const keptPartialResult = await request("/api/worker/result", {
    runId: run.run.id,
    taskId: resumedIndeed.task.id,
    taskAttempt: resumedIndeed.task.attempt,
    workerId: "indeed-worker",
    status: "completed",
    reason: "Stopped early by user; partial results were kept.",
    jobs: [{ source: "indeed", sourceJobId: "kept-partial-result", title: "Graduate Software Developer", location: "Melbourne VIC" }]
  });
  assert.equal(keptPartialResult.discarded, undefined);
  assert.equal(keptPartialResult.jobs[0].sourceJobId, "kept-partial-result");
  const markIndeedTaskViewed = await request("/api/runs/" + run.run.id + "/tasks/" + resumedIndeed.task.id + "/viewed", {}, "PUT");
  assert.equal(markIndeedTaskViewed.total, 5);
  assert.equal(markIndeedTaskViewed.updated, 5);
  const afterMarkIndeedTaskViewed = await request("/api/bootstrap");
  assert.ok(afterMarkIndeedTaskViewed.jobs
    .filter((job) => job.runTaskId === resumedIndeed.task.id)
    .every((job) => Boolean(job.viewedAt)));

  const clearedQueue = await request("/api/runs/" + run.run.id + "/tasks", undefined, "DELETE");
  assert.equal(clearedQueue.cleared.removed, 2);
  assert.equal(clearedQueue.cleared.cancelled, 0);
  const finishedRunClaim = await request("/api/worker/next?runId=" + run.run.id + "&platform=indeed&workerId=indeed-worker");
  assert.equal(finishedRunClaim.task, null);
  assert.equal(finishedRunClaim.reason, undefined, "an empty sequential queue must finish instead of waiting forever");

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

  await request("/api/ai-config", {
    baseUrl: "http://127.0.0.1:" + aiPort,
    model: "fake-job-review-model",
    wireApi: "responses",
    apiKey: ""
  }, "PUT");
  const transientFailureImport = await request("/api/jobs/import", {
    runId: run.run.id,
    jobs: [{
      source: "indeed",
      sourceJobId: "transient-ai-failure",
      title: "Transient AI Review Failure",
      company: "Retry Example",
      location: "Melbourne VIC",
      description: "Build Python and SQL software automation services with cloud APIs, testing, deployment, and production monitoring.",
      descriptionSource: "detail-page",
      descriptionFetchStatus: "fetched"
    }]
  });
  const transientJobId = transientFailureImport.jobs[0].id;
  const retryWaitDeadline = Date.now() + 5_000;
  let transientJob;
  while (Date.now() < retryWaitDeadline) {
    const polled = await request("/api/bootstrap");
    transientJob = polled.jobs.find((job) => job.id === transientJobId);
    if (transientJob?.screening.screeningStatus === "AI_RETRY_WAIT") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(transientJob.screening.screeningStatus, "AI_RETRY_WAIT");
  assert.equal(transientJob.aiReview.status, "retry_wait");
  const automaticRetryDeadline = Date.now() + 7_000;
  while (Date.now() < automaticRetryDeadline) {
    const polled = await request("/api/bootstrap");
    transientJob = polled.jobs.find((job) => job.id === transientJobId);
    if (transientJob?.screening.screeningStatus === "JD_SCREENED") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(transientJob.screening.screeningStatus, "JD_SCREENED");
  assert.equal(transientJob.aiReview.status, "completed");
  assert.equal(transientReviewFailures, 1);

  const manualFailureImport = await request("/api/jobs/import", {
    runId: run.run.id,
    jobs: [{
      source: "indeed",
      sourceJobId: "manual-ai-failure",
      title: "Manual AI Review Failure",
      company: "Retry Example",
      location: "Melbourne VIC",
      description: "Build Python and SQL software automation services with cloud APIs, testing, deployment, and production monitoring.",
      descriptionSource: "detail-page",
      descriptionFetchStatus: "fetched"
    }]
  });
  const manualFailureJobId = manualFailureImport.jobs[0].id;
  const failureDeadline = Date.now() + 5_000;
  let manualFailureJob;
  while (Date.now() < failureDeadline) {
    const polled = await request("/api/bootstrap");
    manualFailureJob = polled.jobs.find((job) => job.id === manualFailureJobId);
    if (manualFailureJob?.screening.screeningStatus === "AI_ERROR") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(manualFailureJob.screening.screeningStatus, "AI_ERROR");
  const retriedAiReviews = await request("/api/jobs/retry-failed-ai", { jobIds: [manualFailureJobId] });
  assert.equal(retriedAiReviews.queued, 1);
  const retryReviewDeadline = Date.now() + 5_000;
  while (Date.now() < retryReviewDeadline) {
    const polled = await request("/api/bootstrap");
    manualFailureJob = polled.jobs.find((job) => job.id === manualFailureJobId);
    if (manualFailureJob?.screening.screeningStatus === "JD_SCREENED") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(manualFailureJob.screening.screeningStatus, "JD_SCREENED");
  assert.equal(manualFailureJob.aiReview.status, "completed");
  assert.equal(manualReviewFailures, 1);
  const imported = await request("/api/jobs/import", {
    runId: run.run.id,
    jobs: [{
      source: "indeed",
      sourceJobId: "smoke-1",
      title: "Graduate Analyst",
      company: "Example",
      location: "Melbourne VIC",
      description: "Use Python and SQL for data analytics and cloud automation work across production software systems, backend APIs, testing, deployment, stakeholder requirements, and monitored cloud services.",
      descriptionSource: "detail-page",
      descriptionFetchStatus: "fetched"
    }]
  });
  assert.equal(imported.jobs[0].screening.screeningStatus, "AI_QUEUED");
  const reviewDeadline = Date.now() + 5_000;
  let reviewedJob;
  while (Date.now() < reviewDeadline) {
    const polled = await request("/api/bootstrap");
    reviewedJob = polled.jobs.find((job) => job.id === imported.jobs[0].id);
    if (reviewedJob?.screening.screeningStatus === "JD_SCREENED") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(reviewedJob.screening.screeningStatus, "JD_SCREENED");
  assert.equal(reviewedJob.screening.engine, "ai");
  assert.equal(reviewedJob.screening.score, 88);

  const assistantResult = await request("/api/jobs/assistant", {
    question: "哪个工作地点离我的所在地更近？",
    conversation: [],
    jobIds: [reviewedJob.id],
    context: { pane: "current", label: "Graduate Analyst / Melbourne VIC" }
  });
  assert.match(assistantResult.answer, /Graduate Analyst/);
  assert.deepEqual(assistantResult.citedJobIds, [reviewedJob.id]);
  assert.equal(assistantResult.context.requestedJobCount, 1);
  assert.equal(assistantResult.context.includedJobCount, 1);

  const rereviewed = await request("/api/jobs/" + imported.jobs[0].id + "/review", {}, "POST");
  assert.equal(rereviewed.job.screening.screeningStatus, "JD_SCREENED");
  assert.equal(rereviewed.job.screening.engine, "ai");
  assert.equal(rereviewed.job.description, imported.jobs[0].description);
  const afterRereview = await request("/api/bootstrap");
  assert.equal(afterRereview.runs.find((item) => item.id === run.run.id).counters.ai.jdReviewed, 3);

  const legacyImport = await request("/api/jobs/import", {
    runId: run.run.id,
    jobs: [{
      source: "indeed",
      sourceJobId: "legacy-jd-1",
      title: "Technical Writer",
      company: "Example Documentation",
      location: "Australia",
      jobUrl: "https://au.indeed.com/viewjob?jk=legacy-jd-1",
      searchKeyword: "technical writer",
      searchLocation: "Australia",
      searchPostedWithinDays: 7
    }]
  });
  const legacyJob = legacyImport.jobs[0];
  assert.equal(legacyJob.screening.screeningStatus, "JD_FETCH_FAILED");
  const fetchLaunch = await request("/api/jobs/" + legacyJob.id + "/fetch-jd", {}, "POST");
  assert.equal(fetchLaunch.job.screening.screeningStatus, "JD_FETCHING");
  assert.match(fetchLaunch.launchUrl, /au\.indeed\.com\/jobs\?/);
  assert.match(fetchLaunch.launchUrl, /vjk=legacy-jd-1/);
  assert.match(fetchLaunch.launchUrl, /jobAgentOnDemandJd=/);
  const jdCallback = await request("/api/worker/job-jd", {
    jobId: legacyJob.id,
    platform: "indeed",
    description: "Create and maintain detailed software documentation for cloud APIs, Python automation services, SQL data workflows, testing procedures, deployment operations, and technical platform users across engineering teams."
  });
  assert.equal(jdCallback.autoReviewQueued, 1);
  const legacyReviewDeadline = Date.now() + 5_000;
  let legacyReviewedJob;
  while (Date.now() < legacyReviewDeadline) {
    const polled = await request("/api/bootstrap");
    legacyReviewedJob = polled.jobs.find((job) => job.id === legacyJob.id);
    if (legacyReviewedJob?.screening.screeningStatus === "JD_SCREENED") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(legacyReviewedJob.descriptionSource, "detail-page");
  assert.equal(legacyReviewedJob.screening.screeningStatus, "JD_SCREENED");
  assert.equal(legacyReviewedJob.screening.engine, "ai");

  const retryImports = await request("/api/jobs/import", {
    runId: run.run.id,
    jobs: [
      {
        source: "indeed",
        sourceJobId: "retry-jd-1",
        title: "Technology Operations Coordinator",
        company: "Retry Example One",
        location: "Australia",
        jobUrl: "https://au.indeed.com/viewjob?jk=retry-jd-1"
      },
      {
        source: "indeed",
        sourceJobId: "retry-jd-2",
        title: "Digital Systems Coordinator",
        company: "Retry Example Two",
        location: "Australia",
        jobUrl: "https://au.indeed.com/viewjob?jk=retry-jd-2"
      }
    ]
  });
  assert.ok(retryImports.jobs.every((job) => job.screening.screeningStatus === "JD_FETCH_FAILED"));
  const retryBatch = await request("/api/jobs/retry-failed-jd", {
    jobIds: retryImports.jobs.map((job) => job.id)
  });
  assert.equal(retryBatch.total, 2);
  assert.equal(retryBatch.completed, 0);
  const firstRetryHash = new URLSearchParams(new URL(retryBatch.launchUrl).hash.slice(1));
  assert.equal(firstRetryHash.get("jobAgentJdBatch"), retryBatch.batchId);
  await request("/api/worker/job-jd", {
    jobId: retryBatch.job.id,
    platform: "indeed",
    batchId: retryBatch.batchId,
    error: "Synthetic JD timeout"
  });
  const nextRetry = await request("/api/worker/jd-retry/" + retryBatch.batchId + "/next", {});
  assert.equal(nextRetry.done, false);
  assert.equal(nextRetry.completed, 1);
  assert.notEqual(nextRetry.job.id, retryBatch.job.id);
  await request("/api/worker/job-jd", {
    jobId: nextRetry.job.id,
    platform: "indeed",
    batchId: retryBatch.batchId,
    error: "Synthetic JD timeout"
  });
  const finishedRetry = await request("/api/worker/jd-retry/" + retryBatch.batchId + "/next", {});
  assert.equal(finishedRetry.done, true);
  assert.equal(finishedRetry.completed, 2);

  const viewed = await request("/api/jobs/" + imported.jobs[0].id + "/viewed", { viewed: true }, "PUT");
  assert.ok(viewed.job.viewedAt);
  const viewedBootstrap = await request("/api/bootstrap");
  assert.ok(viewedBootstrap.jobs.find((job) => job.id === imported.jobs[0].id).viewedAt);
  const restoredUnread = await request("/api/jobs/" + imported.jobs[0].id + "/viewed", { viewed: false }, "PUT");
  assert.equal(restoredUnread.job.viewedAt, null);

  const feedback = await request("/api/jobs/" + imported.jobs[0].id + "/feedback", {
    helpful: true,
    reason: "ROLE_RELEVANT",
    note: "The analyst role is relevant to my target direction."
  }, "PUT");
  assert.equal(feedback.job.feedback.helpfulness, "HELPFUL");
  assert.equal(feedback.job.feedback.reason, "ROLE_RELEVANT");
  assert.ok(feedback.job.viewedAt);

  const reflection = await request("/api/runs/" + run.run.id + "/reflection", {});
  assert.equal(reflection.reflection.feedbackCount, 1);
  assert.equal(reflection.reflection.engine, "ai");
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
  const correctedRejection = await request("/api/jobs/" + learnedImport.jobs[0].id + "/feedback", {
    helpfulness: "REJECTION_INCORRECT",
    reason: "CLASSIFICATION_WRONG",
    note: "This role should remain available for human review."
  }, "PUT");
  assert.equal(correctedRejection.job.feedback.helpfulness, "REJECTION_INCORRECT");
  assert.equal(correctedRejection.job.feedback.reason, "CLASSIFICATION_WRONG");
  assert.ok(correctedRejection.job.viewedAt);
  const dislikedRejection = await request("/api/jobs/" + learnedImport.jobs[0].id + "/feedback", {
    helpfulness: "NOT_HELPFUL",
    reason: "ROLE_NOT_INTERESTED",
    note: "This role is outside my preferred direction."
  }, "PUT");
  assert.equal(dislikedRejection.job.feedback.helpfulness, "NOT_HELPFUL");
  assert.equal(dislikedRejection.job.feedback.reason, "ROLE_NOT_INTERESTED");
  assert.ok(dislikedRejection.job.viewedAt);

  const rejectedImport = await request("/api/jobs/import", {
    runId: run.run.id,
    jobs: [{
      source: "indeed",
      sourceJobId: "rejected-correction-1",
      title: "Commercial Rotation Graduate",
      company: "Incorrect AI Example",
      location: "Melbourne VIC",
      description: "Support retail merchandising, store displays, product presentation, promotional campaigns, inventory coordination, customer research, reporting, and cross-functional planning across a national retail network.",
      descriptionSource: "detail-page",
      descriptionFetchStatus: "fetched"
    }]
  });
  const rejectedReviewDeadline = Date.now() + 5_000;
  let aiRejectedJob;
  while (Date.now() < rejectedReviewDeadline) {
    const polled = await request("/api/bootstrap");
    aiRejectedJob = polled.jobs.find((job) => job.id === rejectedImport.jobs[0].id);
    if (aiRejectedJob?.screening.screeningStatus === "JD_SCREENED") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(aiRejectedJob.screening.category, "REJECTED");
  const suggestionBootstrap = await request("/api/bootstrap");
  assert.ok(suggestionBootstrap.exclusionSuggestions.some((item) => item.keyword === "merchandising"));
  await request("/api/jobs/" + aiRejectedJob.id + "/feedback", {
    helpfulness: "REJECTION_INCORRECT",
    reason: "CLASSIFICATION_WRONG"
  }, "PUT");
  const correctedSuggestionBootstrap = await request("/api/bootstrap");
  assert.ok(!correctedSuggestionBootstrap.exclusionSuggestions.some((item) => item.keyword === "merchandising"));
  const confirmedRejection = await request("/api/jobs/" + aiRejectedJob.id + "/feedback", {
    helpfulness: "HELPFUL",
    reason: "REJECTION_CORRECT"
  }, "PUT");
  assert.equal(confirmedRejection.job.feedback.helpfulness, "HELPFUL");
  assert.equal(confirmedRejection.job.feedback.reason, "REJECTION_CORRECT");
  const confirmedSuggestionBootstrap = await request("/api/bootstrap");
  assert.ok(confirmedSuggestionBootstrap.exclusionSuggestions.some((item) => item.keyword === "merchandising"));
  const confirmedReflection = await request("/api/runs/" + run.run.id + "/reflection", {});
  assert.equal(confirmedReflection.preferenceModel.version, 2);
  assert.ok(confirmedReflection.preferenceModel.titleExclusions.includes("Commercial Rotation Graduate"));
  const confirmedReflectionBootstrap = await request("/api/bootstrap");
  assert.ok(confirmedReflectionBootstrap.exclusionSuggestions.some((item) => item.keyword === "merchandising"));
  await request("/api/jobs/" + aiRejectedJob.id + "/feedback", {
    helpfulness: "NOT_HELPFUL",
    reason: "NOT_RELEVANT"
  }, "PUT");
  const dislikedSuggestionBootstrap = await request("/api/bootstrap");
  assert.ok(dislikedSuggestionBootstrap.exclusionSuggestions.some((item) => item.keyword === "merchandising"));
  const coveredExclusions = await request("/api/settings/exclusion-keywords", { keyword: "merchandising" });
  assert.ok(coveredExclusions.settings.exclusionKeywords.includes("merchandising"));
  const coveredSuggestionBootstrap = await request("/api/bootstrap");
  assert.ok(!coveredSuggestionBootstrap.exclusionSuggestions.some((item) => item.status === "pending"
    && item.keyword.toLowerCase() === "merchandising"));
  await request("/api/settings/exclusion-keywords/merchandising", undefined, "DELETE");

  const bootstrap = await request("/api/bootstrap");
  assert.equal(bootstrap.activeProfile.id, replacement.profile.id);
  assert.equal(bootstrap.profiles.length, 1);
  assert.equal(bootstrap.jobs.length, 13);
  assert.equal(bootstrap.reviewReflections.length, 2);
  assert.equal(bootstrap.preferenceModel.feedbackCount, 3);
  assert.equal(bootstrap.routineTasks.length, 4);

  const selectedTaskIds = bootstrap.routineTasks.slice(0, 2).map((task) => task.id);
  const nextRun = await request("/api/runs", { routineTaskIds: selectedTaskIds });
  assert.equal(nextRun.run.tasks.length, 2);
  assert.deepEqual(nextRun.run.tasks.map((task) => task.routineTaskId), selectedTaskIds);
  const afterNextRun = await request("/api/bootstrap");
  assert.equal(afterNextRun.runs[0].id, nextRun.run.id);
  assert.equal(afterNextRun.jobs.length, 13);
  assert.ok(afterNextRun.jobs.every((job) => job.runId === run.run.id));
  assert.ok(afterNextRun.jobs.every((job) => job.runId !== afterNextRun.runs[0].id));

  const clearedDailyTasks = await request("/api/routine-tasks", undefined, "DELETE");
  assert.equal(clearedDailyTasks.cleared.count, 4);
  const afterDailyClear = await request("/api/bootstrap");
  assert.equal(afterDailyClear.routineTasks.length, 0);
  assert.equal(afterDailyClear.runs.find((item) => item.id === run.run.id).tasks.filter((task) => task.status === "cancelled").length, 0);

  const clearedRecords = await request("/api/records", undefined, "DELETE");
  assert.equal(clearedRecords.cleared.jobs, 13);
  assert.equal(clearedRecords.cleared.legacyWorkerHistory, 2);
  assert.equal(clearedRecords.cleared.workerHistoryMigrations, 3);
  assert.equal(clearedRecords.cleared.reviewReflections, 2);
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
  assert.equal(afterRecordClear.unifiedHistory.migratedWorkerRecords, 0);
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
  const duplicateRun = await request("/api/runs", { routineTaskIds: [removableDailyTask.routineTask.id] });
  const duplicateClaim = await request("/api/worker/next?runId=" + duplicateRun.run.id + "&platform=seek&workerId=duplicate-test-worker");
  const duplicateResult = await request("/api/worker/result", {
    runId: duplicateRun.run.id,
    taskId: duplicateClaim.task.id,
    taskAttempt: duplicateClaim.task.attempt,
    workerId: "duplicate-test-worker",
    status: "completed",
    jobs: [{ source: "seek", sourceJobId: "remove-test-job", title: "Museum Digitisation Coordinator", location: "Melbourne VIC" }]
  });
  assert.equal(duplicateResult.jobs[0].duplicateOf, removableResult.jobs[0].id);
  const removedCanonicalRun = await request("/api/runs/" + removableRun.run.id, undefined, "DELETE");
  assert.equal(removedCanonicalRun.removed.runs, 1);
  assert.equal(removedCanonicalRun.removed.jobs, 1);
  const afterRollback = await request("/api/bootstrap");
  const restoredOccurrence = afterRollback.jobs.find((job) => job.id === duplicateResult.jobs[0].id);
  const restoredRun = afterRollback.runs.find((item) => item.id === duplicateRun.run.id);
  assert.equal(restoredOccurrence.duplicateOf, null);
  assert.equal(restoredRun.counters.seek.newJobs, 1);
  assert.equal(restoredRun.counters.seek.repeatedImports, 0);
  const removedTaskResults = await request("/api/runs/" + duplicateRun.run.id + "/tasks/" + duplicateClaim.task.id + "/results", undefined, "DELETE");
  assert.equal(removedTaskResults.removed.tasks, 1);
  assert.equal(removedTaskResults.removed.jobs, 1);
  assert.equal(removedTaskResults.removed.importBatches, 1);
  assert.equal(removedTaskResults.run.tasks.length, 0);
  const removedRunHistory = await request("/api/runs/" + duplicateRun.run.id, undefined, "DELETE");
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
  const reusableTask = afterCategoryImport.routineTasks[0];
  const mixedSourceCategory = await request("/api/task-categories", {
    name: "Mixed verified and new tasks",
    tasks: [
      {
        platform: reusableTask.platform,
        keyword: reusableTask.keyword,
        location: reusableTask.location,
        postedWithinDays: reusableTask.postedWithinDays,
        sourceValidationId: reusableTask.validationId
      },
      { platform: "indeed", keyword: "quality assurance", location: "Adelaide SA", postedWithinDays: 3 }
    ]
  });
  assert.equal(mixedSourceCategory.category.tasks.length, 2);
  assert.equal(mixedSourceCategory.category.tasks[0].validationId, reusableTask.validationId);
  assert.equal(mixedSourceCategory.category.tasks[1].validationId, null);
  await request("/api/task-categories/" + mixedSourceCategory.category.id, undefined, "DELETE");
  const sharedTaskCategory = await request("/api/task-categories", {
    name: "Shared verified task",
    tasks: [{
      platform: reusableTask.platform,
      keyword: reusableTask.keyword,
      location: reusableTask.location,
      postedWithinDays: reusableTask.postedWithinDays
    }]
  });
  const preparedSharedTask = await request("/api/task-categories/prepare", {
    categoryIds: [sharedTaskCategory.category.id],
    mode: "preflight"
  });
  assert.equal(preparedSharedTask.valid, 1);
  assert.equal(preparedSharedTask.pending, 0);
  await request("/api/task-categories/" + sharedTaskCategory.category.id, undefined, "DELETE");
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
  await new Promise((resolve) => aiServer.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

function extractNamedFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} is incomplete`);
}
