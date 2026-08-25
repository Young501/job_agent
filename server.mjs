import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, join, resolve, sep } from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

import {
  aiPrivateConfig,
  aiStatus,
  answerJobQuestions,
  configureAi,
  evaluateJdWithAi,
  generateProfile,
  isTransientAiError,
  reflectOnJobFeedback,
  testAiConnection
} from "./src/ai.mjs";
import {
  localJdScreen,
  normalizeJob,
  validateProfileDraft
} from "./src/screening.mjs";
import {
  compactExclusionKeyword,
  ensurePreferenceModelNegativeCoverage,
  localPreferenceReflection,
  validatePreferenceModel
} from "./src/learning.mjs";
import { normalizeKeywordAlternatives, primarySearchKeyword } from "./src/task-keywords.mjs";
import { createStorage, newId } from "./src/storage.mjs";
import { findDuplicate, strongIdentityKeys } from "./src/job-identity.mjs";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL(".", import.meta.url));
const publicDirectory = join(root, "public");
const workerDirectory = join(root, "workers");
const dataDirectory = process.env.JOB_AGENT_DATA_DIRECTORY
  ? resolve(process.env.JOB_AGENT_DATA_DIRECTORY)
  : join(root, "data");
const uploadDirectory = join(dataDirectory, "uploads");
const aiConfigPath = join(dataDirectory, "ai-config.json");
const defaultSettings = JSON.parse(await readFile(join(root, "config", "job-search-routine.json"), "utf8"));
const defaultTaskCategories = JSON.parse(await readFile(join(root, "config", "task-categories.json"), "utf8"));
const platformOrder = ["linkedin", "indeed", "seek"];
const allowedPlatforms = new Set(platformOrder);

await loadDotEnv(join(root, ".env"));
await loadSavedAiConfig();
const storage = createStorage({ dataDirectory, defaultSettings, defaultTaskCategories });
const autoReviewQueue = [];
const queuedAutoReviewIds = new Set();
const jdRetryBatches = new Map();
let autoReviewRunning = false;
let autoReviewCooldownTimer = null;
await storage.ensureState();
await storage.update((state) => {
  state.settings = safeSettings(state.settings);
  state.exclusionSuggestions = (state.exclusionSuggestions ?? []).map(safeExclusionSuggestion).filter(Boolean);
  for (const record of state.profiles) record.profile = validateProfileDraft(record.profile);
  if (state.preferenceModel) state.preferenceModel = validatePreferenceModel(state.preferenceModel);
  migrateKeywordAlternatives(state);
  backfillPreferenceExclusionSuggestions(state);
  compactPendingExclusionSuggestions(state);
  removeCoveredPendingExclusionSuggestions(state);
  state.legacyWorkerHistory ??= [];
  state.workerHistoryMigrations ??= [];
  normalizeUnifiedHistory(state);
});

const maxBodyBytes = 7 * 1024 * 1024;
const preflightPickupWindowMs = 30 * 60 * 1000;
const preflightWorkerLeaseMs = 90 * 1000;
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

async function loadDotEnv(path) {
  try {
    const contents = await readFile(path, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function loadSavedAiConfig() {
  try {
    configureAi(JSON.parse(await readFile(aiConfigPath, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function mergedAiConfig(input = {}, clearApiKey = false) {
  const current = aiPrivateConfig();
  const suppliedKey = String(input.apiKey ?? "").trim();
  return {
    baseUrl: input.baseUrl ?? current.baseUrl,
    model: input.model ?? current.model,
    wireApi: input.wireApi ?? current.wireApi,
    apiKey: clearApiKey ? "" : suppliedKey || current.apiKey
  };
}

async function saveAiConfig(config) {
  configureAi(config);
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(aiConfigPath, JSON.stringify(aiPrivateConfig(), null, 2) + "\n", { mode: 0o600 });
  return aiStatus();
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function apiError(response, status, message) {
  sendJson(response, status, { error: message });
}

function publicProfile(profile) {
  const { sourceText, ...safe } = profile;
  return { ...safe, profile: validateProfileDraft(safe.profile) };
}

function buildBootstrap(state) {
  const retryCutoff = Date.now() - 20 * 60 * 1000;
  for (const [id, batch] of jdRetryBatches) {
    if (Date.parse(batch.createdAt) < retryCutoff) jdRetryBatches.delete(id);
  }
  const activeProfile = state.profiles.find((profile) => profile.id === state.activeProfileId) ?? null;
  state.runs.forEach(ensureRunCounterShape);
  return {
    settings: state.settings,
    profiles: state.profiles.map(publicProfile),
    activeProfile: activeProfile ? publicProfile(activeProfile) : null,
    jobs: state.jobs,
    runs: state.runs,
    routineTasks: state.routineTasks,
    validations: state.validations,
    taskCategories: state.taskCategories,
    reviewReflections: state.reviewReflections,
    preferenceModel: state.preferenceModel,
    exclusionSuggestions: state.exclusionSuggestions,
    unifiedHistory: {
      agentJobs: state.jobs.length,
      migratedWorkerRecords: (state.legacyWorkerHistory ?? []).length,
      totalKnownJobs: state.jobs.filter((job) => !job.duplicateOf).length + (state.legacyWorkerHistory ?? []).length,
      migrations: (state.workerHistoryMigrations ?? []).slice(0, 10)
    },
    jdRetryBatches: [...jdRetryBatches.values()].map((batch) => ({
      id: batch.id,
      total: batch.jobIds.length,
      completed: batch.completed,
      currentJobId: batch.currentJobId,
      jobIds: batch.jobIds,
      createdAt: batch.createdAt
    })),
    ai: aiStatus()
  };
}

async function readBody(request) {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > maxBodyBytes) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const body = await readBody(request);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? "");
  if (!boundaryMatch) throw new Error("Upload boundary is missing.");
  const boundary = `--${boundaryMatch[1] ?? boundaryMatch[2]}`;
  const sections = buffer.toString("latin1").split(boundary);
  const fields = {};

  for (const section of sections.slice(1, -1)) {
    const trimmed = section.replace(/^\r?\n/, "");
    const splitAt = trimmed.indexOf("\r\n\r\n");
    if (splitAt < 0) continue;
    const rawHeaders = trimmed.slice(0, splitAt);
    let rawValue = trimmed.slice(splitAt + 4);
    rawValue = rawValue.replace(/\r\n$/, "");
    const disposition = /content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(rawHeaders);
    if (!disposition) continue;
    const contentTypeMatch = /content-type:\s*([^\r\n]+)/i.exec(rawHeaders);
    const value = Buffer.from(rawValue, "latin1");
    fields[disposition[1]] = disposition[2] !== undefined
      ? { filename: disposition[2], mimeType: contentTypeMatch?.[1] ?? "application/octet-stream", buffer: value }
      : value.toString("utf8");
  }
  return fields;
}

function safeFilename(filename) {
  return String(filename ?? "resume").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "resume";
}

async function extractResume(file) {
  const filename = safeFilename(file.filename);
  const extension = extname(filename).toLowerCase();
  if (![".txt", ".md", ".docx", ".pdf"].includes(extension)) {
    throw new Error("Resume must be a .txt, .md, .docx, or .pdf file.");
  }
  if (extension === ".txt" || extension === ".md") {
    return { sourceName: filename, text: file.buffer.toString("utf8").trim() };
  }

  await mkdir(uploadDirectory, { recursive: true });
  const temporaryPath = join(uploadDirectory, `${randomUUID()}${extension}`);
  try {
    await writeFile(temporaryPath, file.buffer);
    const python = process.env.JOB_AGENT_PYTHON_PATH?.trim() || "python";
    const { stdout } = await execFileAsync(python, [join(root, "tools", "extract_resume.py"), temporaryPath], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    });
    const parsed = JSON.parse(stdout);
    const text = String(parsed.text ?? "").trim();
    if (!text) throw new Error("No text could be extracted from this resume.");
    return { sourceName: filename, text };
  } catch (error) {
    if (error.code === "ENOENT" || /Python was not found/i.test(String(error.message))) {
      throw new Error("Resume extraction needs Python with pypdf. Install Python 3 or set JOB_AGENT_PYTHON_PATH to its python.exe path.");
    }
    throw new Error(`Could not extract resume text: ${error.message}`);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

function safeSettings(input) {
  const locations = (Array.isArray(input.locations) ? input.locations : [])
    .map((location) => ({
      id: String(location.id || newId("location")).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80),
      name: String(location.name ?? "").trim().slice(0, 120),
      enabled: Boolean(location.enabled)
    }))
    .filter((location) => location.name);
  const searches = (Array.isArray(input.searches) ? input.searches : [])
    .map((search) => ({
      id: String(search.id || newId("search")).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80),
      keyword: String(search.keyword ?? "").trim().slice(0, 160),
      enabled: Boolean(search.enabled),
      priority: Math.max(0, Math.min(1000, Number(search.priority) || 0))
    }))
    .filter((search) => search.keyword);
  const thresholds = {
    strongMatch: Number(input.thresholds?.strongMatch ?? defaultSettings.thresholds.strongMatch),
    goodMatch: Number(input.thresholds?.goodMatch ?? defaultSettings.thresholds.goodMatch),
    maybe: Number(input.thresholds?.maybe ?? defaultSettings.thresholds.maybe),
    lowMatch: Number(input.thresholds?.lowMatch ?? defaultSettings.thresholds.lowMatch)
  };
  const postedWithinDays = Number(input.postedWithinDays ?? defaultSettings.postedWithinDays ?? 0);
  const defaultWorkerTiming = defaultSettings.workerTiming ?? {};
  const timingNumber = (key, minimum, maximum) => {
    const fallback = Number(defaultWorkerTiming[key]);
    const value = Number(input.workerTiming?.[key]);
    return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : fallback));
  };
  const workerTiming = {
    accessLimit: Math.round(timingNumber("accessLimit", 1, 100)),
    cooldownMinutes: timingNumber("cooldownMinutes", 0.5, 120),
    actionDelaySeconds: timingNumber("actionDelaySeconds", 0.3, 10),
    scrollDelaySeconds: timingNumber("scrollDelaySeconds", 0.5, 20),
    pageDelaySeconds: timingNumber("pageDelaySeconds", 1, 120),
    jdIntervalSeconds: timingNumber("jdIntervalSeconds", 0.2, 30),
    jdRequestTimeoutSeconds: timingNumber("jdRequestTimeoutSeconds", 2, 30),
    jdPageTimeoutSeconds: timingNumber("jdPageTimeoutSeconds", 3, 60)
  };
  const exclusionKeywords = [...new Set((Array.isArray(input.exclusionKeywords) ? input.exclusionKeywords : defaultSettings.exclusionKeywords ?? [])
    .map((keyword) => String(keyword ?? "").replace(/\s+/g, " ").trim())
    .filter((keyword) => keyword.length >= 2 && keyword.length <= 80))].slice(0, 100);
  if (![0, 1, 3, 7, 14, 30].includes(postedWithinDays)) {
    throw new Error("Posted-within filter must be one of 0, 1, 3, 7, 14, or 30 days.");
  }
  if (![thresholds.strongMatch, thresholds.goodMatch, thresholds.maybe, thresholds.lowMatch]
    .every((value) => Number.isFinite(value) && value >= 0 && value <= 100)
    || !(thresholds.strongMatch >= thresholds.goodMatch && thresholds.goodMatch >= thresholds.maybe && thresholds.maybe >= thresholds.lowMatch)) {
    throw new Error("Match thresholds must be descending values between 0 and 100.");
  }
  return {
    enabled: Boolean(input.enabled),
    executionMode: "sequential",
    postedWithinDays,
    platforms: [...new Set((Array.isArray(input.platforms) ? input.platforms : [])
      .map((platform) => String(platform).toLowerCase())
      .filter((platform) => allowedPlatforms.has(platform)))],
    locations,
    searches,
    exclusionKeywords,
    workerTiming,
    thresholds
  };
}

const supportedPostedWithinDays = new Set([0, 1, 3, 7, 14, 30]);

function safeRoutineTaskInput(input) {
  const platform = String(input.platform ?? "").toLowerCase();
  const keyword = normalizeKeywordAlternatives(String(input.keyword ?? "").slice(0, 160));
  const location = String(input.location ?? "").trim().slice(0, 120);
  const postedWithinDays = Number(input.postedWithinDays ?? 0);
  if (!allowedPlatforms.has(platform)) throw new Error("Choose LinkedIn, Indeed, or SEEK.");
  if (!keyword) throw new Error("Enter a job keyword.");
  if (!location) throw new Error("Enter a location.");
  if (!supportedPostedWithinDays.has(postedWithinDays)) throw new Error("Choose a supported posted-within value.");
  return { platform, keyword, location, postedWithinDays };
}

function migrateKeywordAlternatives(state) {
  const changedValidationIds = new Set();
  for (const validation of state.validations) {
    const normalized = normalizeKeywordAlternatives(validation.keyword);
    if (!normalized || normalized === validation.keyword) continue;
    validation.keyword = normalized;
    validation.status = "WAITING_FOR_WORKER";
    validation.reason = "关键词备选规则已更新，请重新预检。";
    validation.preflightAttempt = Math.max(1, Number(validation.preflightAttempt) || 1) + 1;
    validation.workerStartedAt = null;
    validation.workerHeartbeatAt = null;
    validation.completedAt = null;
    changedValidationIds.add(validation.id);
  }
  for (const category of state.taskCategories) {
    for (const task of category.tasks ?? []) task.keyword = normalizeKeywordAlternatives(task.keyword);
  }
  state.routineTasks = state.routineTasks
    .map((task) => ({ ...task, keyword: normalizeKeywordAlternatives(task.keyword) }))
    .filter((task) => !changedValidationIds.has(task.validationId));
}

function sameRoutineTask(left, right) {
  return left?.platform === right?.platform
    && left?.keyword === right?.keyword
    && left?.location === right?.location
    && Number(left?.postedWithinDays) === Number(right?.postedWithinDays);
}

const helpfulFeedbackReasons = new Set(["ROLE_RELEVANT", "SKILL_MATCH", "WOULD_APPLY", "REJECTION_CORRECT"]);
const legacyFeedbackReasons = new Set(["CLASSIFICATION_WRONG", "NOT_RELEVANT", "ROLE_NOT_INTERESTED", "SKILL_MISMATCH", "WOULD_NOT_APPLY"]);

function safeJobFeedback(input) {
  if (input?.helpful === false || input?.notHelpful === false || input?.helpfulness === null) return null;
  const requestedHelpfulness = String(input?.helpfulness ?? "");
  const correction = requestedHelpfulness === "REJECTION_INCORRECT";
  const legacy = !correction && (input?.notHelpful === true || requestedHelpfulness === "NOT_HELPFUL");
  const reasons = legacy ? legacyFeedbackReasons : helpfulFeedbackReasons;
  const reason = correction
    ? "CLASSIFICATION_WRONG"
    : reasons.has(String(input?.reason ?? "")) ? String(input.reason) : null;
  return {
    helpfulness: correction ? "REJECTION_INCORRECT" : legacy ? "NOT_HELPFUL" : "HELPFUL",
    reason,
    note: String(input?.note ?? "").trim().slice(0, 500) || null,
    updatedAt: new Date().toISOString(),
    reflectedAt: null,
    reflectionId: null
  };
}

function isPositiveJobFeedback(job) {
  return (job.feedback?.helpfulness === "HELPFUL" && job.feedback?.reason !== "REJECTION_CORRECT")
    || job.feedback?.helpfulness === "REJECTION_INCORRECT"
    || (job.feedback?.helpfulness === "NOT_HELPFUL" && job.feedback?.reason === "CLASSIFICATION_WRONG");
}

function isConfirmedRejection(job) {
  return job.feedback?.helpfulness === "HELPFUL" && job.feedback?.reason === "REJECTION_CORRECT";
}

function isLegacyNegativeJobFeedback(job) {
  return job.feedback?.helpfulness === "NOT_HELPFUL" && job.feedback?.reason !== "CLASSIFICATION_WRONG";
}

function isStrictExclusionFeedback(job) {
  return isConfirmedRejection(job)
    || (job.feedback?.helpfulness === "NOT_HELPFUL" && job.feedback?.reason === "NOT_RELEVANT");
}

function safeExclusionSuggestion(input) {
  const keyword = String(input?.keyword ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (keyword.length < 3) return null;
  return {
    id: String(input?.id || newId("exclusion_suggestion")).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100),
    keyword,
    reason: String(input?.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 240) || null,
    sourceJobIds: [...new Set(Array.isArray(input?.sourceJobIds) ? input.sourceJobIds.map(String) : input?.sourceJobId ? [String(input.sourceJobId)] : [])].slice(0, 30),
    sourceTitles: [...new Set(Array.isArray(input?.sourceTitles) ? input.sourceTitles.map((value) => String(value).trim()).filter(Boolean) : input?.sourceTitle ? [String(input.sourceTitle).trim()] : [])].slice(0, 12),
    sourceRunId: input?.sourceRunId ? String(input.sourceRunId) : null,
    sourceType: input?.sourceType === "review-reflection" ? "review-reflection" : "job-review",
    status: input?.status === "approved" ? "approved" : "pending",
    createdAt: input?.createdAt || new Date().toISOString(),
    approvedAt: input?.approvedAt || null
  };
}

function normalizeExclusionPhrase(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function exclusionKeywordCovered(keyword, enabledKeywords = []) {
  const candidate = normalizeExclusionPhrase(keyword);
  if (!candidate) return false;
  const paddedCandidate = ` ${candidate} `;
  return enabledKeywords.some((value) => {
    const enabled = normalizeExclusionPhrase(value);
    return enabled && paddedCandidate.includes(` ${enabled} `);
  });
}

function removeCoveredPendingExclusionSuggestions(state) {
  const enabledKeywords = state.settings.exclusionKeywords ?? [];
  state.exclusionSuggestions = state.exclusionSuggestions.filter((suggestion) => suggestion.status !== "pending"
    || !exclusionKeywordCovered(suggestion.keyword, enabledKeywords));
}

function compactPendingExclusionSuggestions(state) {
  const compacted = [];
  for (const suggestion of state.exclusionSuggestions) {
    if (suggestion.status !== "pending") {
      compacted.push(suggestion);
      continue;
    }
    const keyword = compactExclusionKeyword(suggestion.keyword);
    if (!keyword) continue;
    const existing = compacted.find((item) => item.status === "pending" && item.keyword.toLowerCase() === keyword);
    if (existing) {
      existing.sourceJobIds = [...new Set([...(existing.sourceJobIds ?? []), ...(suggestion.sourceJobIds ?? [])])].slice(0, 30);
      existing.sourceTitles = [...new Set([...(existing.sourceTitles ?? []), ...(suggestion.sourceTitles ?? [])])].slice(0, 12);
      existing.reason ||= suggestion.reason;
      continue;
    }
    compacted.push({ ...suggestion, keyword });
  }
  state.exclusionSuggestions = compacted;
}

function addExclusionSuggestions(state, job, signals) {
  if (isPositiveJobFeedback(job)) return;
  const active = state.settings.exclusionKeywords ?? [];
  for (const rawKeyword of signals?.exclusionKeywords ?? []) {
    const keyword = compactExclusionKeyword(rawKeyword);
    if (!keyword) continue;
    const normalized = keyword.toLowerCase();
    if (exclusionKeywordCovered(keyword, active)) continue;
    const existing = state.exclusionSuggestions.find((item) => item.keyword.toLowerCase() === normalized);
    if (existing) {
      existing.sourceJobIds = [...new Set([...(existing.sourceJobIds ?? []), job.id])].slice(0, 30);
      existing.sourceTitles = [...new Set([...(existing.sourceTitles ?? []), job.title])].slice(0, 12);
      existing.reason ||= signals.exclusionReason || job.screening?.reason || null;
      continue;
    }
    const suggestion = safeExclusionSuggestion({
      keyword,
      reason: signals.exclusionReason || job.screening?.reason,
      sourceJobId: job.id,
      sourceTitle: job.title,
      sourceRunId: job.runId,
      sourceType: "job-review"
    });
    if (suggestion) state.exclusionSuggestions.unshift(suggestion);
  }
  compactPendingExclusionSuggestions(state);
  state.exclusionSuggestions = state.exclusionSuggestions.slice(0, 300);
}

function removeJobFromPendingExclusionSuggestions(state, jobId) {
  state.exclusionSuggestions = state.exclusionSuggestions.filter((suggestion) => {
    if (suggestion.status !== "pending" || !(suggestion.sourceJobIds ?? []).includes(jobId)) return true;
    suggestion.sourceJobIds = suggestion.sourceJobIds.filter((id) => id !== jobId);
    suggestion.sourceTitles = [...new Set(suggestion.sourceJobIds
      .map((id) => state.jobs.find((job) => job.id === id)?.title)
      .filter(Boolean))].slice(0, 12);
    return suggestion.sourceJobIds.length > 0;
  });
}

function addReflectionExclusionSuggestions(state, evidenceJobs, preferenceModel, runId) {
  const jobs = evidenceJobs.filter(isStrictExclusionFeedback);
  if (!jobs.length) return;
  const evidenceIds = new Set(jobs.map((job) => job.id));
  const legacyReflectionReasons = new Set([
    "人工确认 Rejected 判断正确后，由审阅复盘整理。",
    "根据人工确认的不相关职位，由审阅复盘整理为待审核建议。"
  ]);
  state.exclusionSuggestions = state.exclusionSuggestions.filter((suggestion) => suggestion.status !== "pending"
    || !(suggestion.sourceType === "review-reflection" || legacyReflectionReasons.has(suggestion.reason))
    || !(suggestion.sourceJobIds ?? []).some((id) => evidenceIds.has(id)));
  const active = state.settings.exclusionKeywords ?? [];
  const candidates = [...new Set([
    ...(preferenceModel?.avoidSignals ?? []),
    ...(preferenceModel?.titleExclusions ?? [])
  ].map(compactExclusionKeyword).filter(Boolean))];
  const coveredJobIds = new Set();
  for (const keyword of candidates) {
    const normalized = String(keyword).toLowerCase().trim();
    if (normalized.length < 3 || exclusionKeywordCovered(keyword, active)) continue;
    const sources = jobs.filter((job) => {
      const title = String(job.title || "").toLowerCase();
      return title.includes(normalized) || normalized.includes(title);
    }).filter((job) => !coveredJobIds.has(job.id));
    if (!sources.length) continue;
    const existing = state.exclusionSuggestions.find((item) => item.keyword.toLowerCase() === normalized);
    if (existing) {
      existing.sourceJobIds = [...new Set([...(existing.sourceJobIds ?? []), ...sources.map((job) => job.id)])].slice(0, 30);
      existing.sourceTitles = [...new Set([...(existing.sourceTitles ?? []), ...sources.map((job) => job.title)])].slice(0, 12);
      existing.reason ||= "根据人工确认的不相关职位，由审阅复盘整理为待审核建议。";
      existing.sourceType = "review-reflection";
      sources.forEach((job) => coveredJobIds.add(job.id));
      continue;
    }
    const suggestion = safeExclusionSuggestion({
      keyword,
      reason: "根据人工确认的不相关职位，由审阅复盘整理为待审核建议。",
      sourceJobIds: sources.map((job) => job.id),
      sourceTitles: sources.map((job) => job.title),
      sourceRunId: runId,
      sourceType: "review-reflection"
    });
    if (suggestion) state.exclusionSuggestions.unshift(suggestion);
    sources.forEach((job) => coveredJobIds.add(job.id));
  }
  compactPendingExclusionSuggestions(state);
  removeCoveredPendingExclusionSuggestions(state);
  state.exclusionSuggestions = state.exclusionSuggestions.slice(0, 300);
}

function backfillPreferenceExclusionSuggestions(state) {
  if (!state.preferenceModel) return;
  const evidenceJobs = state.jobs.filter(isStrictExclusionFeedback);
  state.preferenceModel = ensurePreferenceModelNegativeCoverage(state.preferenceModel, evidenceJobs);
  const reflection = state.reviewReflections.find((item) => item.id === state.runs
    .find((run) => run.id === state.preferenceModel.sourceRunId)?.reviewReflectionId)
    ?? state.reviewReflections.find((item) => item.runId === state.preferenceModel.sourceRunId);
  if (reflection && reflection.version === state.preferenceModel.version) {
    reflection.modelSnapshot = state.preferenceModel;
  }
  addReflectionExclusionSuggestions(state, evidenceJobs, state.preferenceModel, state.preferenceModel.sourceRunId);
}

function feedbackFingerprint(jobs) {
  const source = jobs
    .map((job) => `${job.id}:${job.feedback?.updatedAt ?? ""}:${job.feedback?.reason ?? ""}:${job.feedback?.note ?? ""}:${job.learningSignals?.generatedAt ?? ""}:${(job.learningSignals?.exclusionKeywords ?? []).join(",")}`)
    .sort()
    .join("|");
  return createHash("sha256").update(source).digest("hex");
}

function uniqueJobsById(jobs) {
  return [...new Map(jobs.map((job) => [job.id, job])).values()];
}

function feedbackForAi(job) {
  return {
    jobId: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    source: job.source,
    searchKeyword: job.searchKeyword,
    previousClassification: job.screening?.titleClassification,
    previousCategory: job.screening?.category,
    previousScore: job.screening?.score,
    previousReason: job.screening?.reason,
    helpfulness: job.feedback?.helpfulness,
    feedbackReason: job.feedback?.reason,
    userNote: job.feedback?.note,
    targetKeywords: job.learningSignals?.targetKeywords ?? []
  };
}

function rejectedSignalForAi(job) {
  return {
    jobId: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    source: job.source,
    searchKeyword: job.searchKeyword,
    score: job.screening?.score,
    reason: job.screening?.reason,
    concerns: job.screening?.concerns ?? [],
    exclusionKeywords: job.learningSignals?.exclusionKeywords ?? [],
    exclusionReason: job.learningSignals?.exclusionReason ?? null,
    humanConfirmed: isConfirmedRejection(job),
    feedbackReason: job.feedback?.reason ?? null,
    userNote: job.feedback?.note ?? null
  };
}

function isAiRoleRejectedSignal(job) {
  const rejected = job.screening?.category === "REJECTED" || job.screening?.titleClassification === "CLEAR_REJECT";
  return rejected
    && job.screening?.workRights?.assessment !== "INELIGIBLE"
    && (isConfirmedRejection(job) || Boolean(hasAiJdReview(job)
      && !isPositiveJobFeedback(job)
      && job.learningSignals?.exclusionKeywords?.length));
}

function safeTaskCategoryInput(input, existing = null, state = null) {
  const name = String(input.name ?? "").trim().slice(0, 80);
  const incomingTasks = Array.isArray(input.tasks) ? input.tasks.slice(0, 80) : [];
  if (!name) throw new Error("Enter a category name.");
  if (!incomingTasks.length) throw new Error("Add at least one task to the category.");
  const existingTasks = new Map((existing?.tasks ?? []).map((task) => [task.id, task]));
  const usedIds = new Set();
  const usedTaskKeys = new Set();
  const tasks = incomingTasks.map((task) => {
    const taskInput = safeRoutineTaskInput(task);
    const taskKey = [taskInput.platform, taskInput.keyword, taskInput.location.toLowerCase(), taskInput.postedWithinDays].join("\u0000");
    if (usedTaskKeys.has(taskKey)) throw new Error("The same task cannot be added to a combination twice.");
    usedTaskKeys.add(taskKey);
    const requestedId = String(task.id ?? "");
    const previous = existingTasks.get(requestedId);
    const id = previous && !usedIds.has(requestedId) ? requestedId : newId("category_task");
    const sourceValidationId = String(task.sourceValidationId ?? "");
    const sourceValidation = sourceValidationId
      ? state?.validations.find((validation) => validation.id === sourceValidationId)
      : null;
    if (sourceValidationId && (!sourceValidation || sourceValidation.status !== "VALID" || !sameRoutineTask(sourceValidation, taskInput))) {
      throw new Error("The selected preflighted task is no longer valid. Refresh and select it again.");
    }
    usedIds.add(id);
    return {
      id,
      ...taskInput,
      validationId: previous && sameRoutineTask(previous, taskInput)
        ? previous.validationId ?? sourceValidation?.id ?? null
        : sourceValidation?.id ?? null
    };
  });
  return { name, tasks };
}

function createValidationRecord(taskInput, metadata = {}) {
  return {
    id: newId("validation"),
    ...taskInput,
    categoryId: metadata.categoryId ?? null,
    categoryTaskId: metadata.categoryTaskId ?? null,
    autoAddToRoutine: metadata.autoAddToRoutine !== false,
    status: "WAITING_FOR_WORKER",
    preflightAttempt: 1,
    reason: null,
    createdAt: new Date().toISOString(),
    checkedAt: null,
    workerStartedAt: null,
    workerId: null,
    preflightQueuedAt: null,
    routineTaskId: null
  };
}

function createRoutineTask(validation) {
  return {
    id: newId("routine_task"),
    validationId: validation.id,
    categoryId: validation.categoryId ?? null,
    categoryTaskId: validation.categoryTaskId ?? null,
    platform: validation.platform,
    keyword: validation.keyword,
    location: validation.location,
    postedWithinDays: validation.postedWithinDays,
    enabled: true,
    status: "READY",
    createdAt: new Date().toISOString()
  };
}

function resetValidationForPreflight(state, validation, taskInput = {}) {
  const previousRoutineTaskId = validation.routineTaskId;
  const routineTaskRemoved = Boolean(previousRoutineTaskId && state.routineTasks.some((task) => task.id === previousRoutineTaskId));
  if (previousRoutineTaskId) {
    state.routineTasks = state.routineTasks.filter((task) => task.id !== previousRoutineTaskId);
  }
  Object.assign(validation, taskInput, {
    preflightAttempt: (Number(validation.preflightAttempt) || 0) + 1,
    status: "WAITING_FOR_WORKER",
    reason: null,
    checkedAt: null,
    workerStartedAt: null,
    workerId: null,
    preflightQueuedAt: null,
    routineTaskId: null,
    updatedAt: new Date().toISOString()
  });
  return routineTaskRemoved;
}

function categoryTaskValidation(state, category, task) {
  const candidates = [
    state.validations.find((record) => record.id === task.validationId),
    state.validations.find((record) => record.categoryId === category.id && record.categoryTaskId === task.id),
    state.validations.find((record) => record.status === "VALID" && sameRoutineTask(record, task))
  ].filter(Boolean);
  return candidates.find((record) => sameRoutineTask(record, task)) ?? null;
}

function ensureCategoryTaskValidation(state, category, task, autoAddToRoutine) {
  let validation = categoryTaskValidation(state, category, task);
  if (!validation) {
    validation = createValidationRecord(safeRoutineTaskInput(task), {
      categoryId: category.id,
      categoryTaskId: task.id,
      autoAddToRoutine
    });
    state.validations.unshift(validation);
  } else {
    validation.categoryId = category.id;
    validation.categoryTaskId = task.id;
    if (autoAddToRoutine) validation.autoAddToRoutine = true;
    if (["FAILED", "NEEDS_USER_ACTION"].includes(validation.status)) {
      resetValidationForPreflight(state, validation, { autoAddToRoutine: Boolean(autoAddToRoutine) });
    }
  }
  task.validationId = validation.id;
  return validation;
}

function addCategoryValidationToRoutine(state, validation) {
  const existing = state.routineTasks.find((task) => task.id === validation.routineTaskId)
    ?? state.routineTasks.find((task) => task.categoryTaskId && task.categoryTaskId === validation.categoryTaskId)
    ?? state.routineTasks.find((task) => task.validationId === validation.id);
  if (existing) {
    validation.routineTaskId = existing.id;
    return { task: existing, added: false };
  }
  const task = createRoutineTask(validation);
  state.routineTasks.push(task);
  validation.routineTaskId = task.id;
  validation.autoAddToRoutine = true;
  return { task, added: true };
}

function runCounters() {
  return {
    linkedin: { tasks: 0, newJobs: 0, repeatedImports: 0, failed: 0 },
    indeed: { tasks: 0, newJobs: 0, repeatedImports: 0, failed: 0 },
    seek: { tasks: 0, newJobs: 0, repeatedImports: 0, failed: 0 },
    ai: {
      titleScreened: 0,
      jdReviewed: 0,
      clearMatches: 0,
      rejected: 0,
      errors: 0,
      reflections: 0,
      calls: 0,
      budgetSkipped: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    }
  };
}

function ensureRunCounterShape(run) {
  const defaults = runCounters();
  run.counters = { ...defaults, ...(run.counters ?? {}) };
  for (const platform of ["linkedin", "indeed", "seek"]) {
    run.counters[platform] = { ...defaults[platform], ...(run.counters[platform] ?? {}) };
  }
  run.counters.ai = { ...defaults.ai, ...(run.counters.ai ?? {}) };
  for (const task of run.tasks ?? []) {
    task.attempt = Math.max(1, Number(task.attempt) || 1);
    task.progress ??= null;
    task.workerHeartbeatAt ??= null;
  }
  return run;
}

function recordScreeningCounters(run, screening) {
  if (!run || !screening) return;
  run.counters.ai.titleScreened += 1;
  if (screening.titleClassification === "CLEAR_MATCH") run.counters.ai.clearMatches += 1;
  if (screening.titleClassification === "CLEAR_REJECT") run.counters.ai.rejected += 1;
}

function canUseAiForRun(run) {
  if (!run) return true;
  ensureRunCounterShape(run);
  const budget = aiStatus().budget;
  return run.counters.ai.calls < budget.maxAiCallsPerRun
    && run.counters.ai.jdReviewed < budget.maxJdReviewsPerRun;
}

function recordAiUsage(run, usage) {
  if (!run || !usage) return;
  run.counters.ai.inputTokens += usage.inputTokens;
  run.counters.ai.outputTokens += usage.outputTokens;
  run.counters.ai.totalTokens += usage.totalTokens;
}

function addJobsToState(state, rawJobs, { runId = null, label = "manual import", task = null } = {}) {
  if (!Array.isArray(rawJobs) || !rawJobs.length) throw new Error("Provide at least one job.");
  if (rawJobs.length > 1000) throw new Error("Import at most 1000 jobs at a time.");
  const run = runId ? state.runs.find((item) => item.id === runId) : null;
  if (runId && !run) throw new Error("Run was not found.");
  if (run) ensureRunCounterShape(run);
  const existingPool = [...(state.legacyWorkerHistory ?? []), ...state.jobs];
  const jobs = [];
  let addedCount = 0;

  for (const rawJob of rawJobs) {
    const candidate = normalizeJob(task ? {
      ...rawJob,
      runTaskId: task.id,
      routineTaskId: task.routineTaskId,
      searchKeyword: task.keyword,
      searchLocation: task.location,
      searchPostedWithinDays: task.postedWithinDays
    } : rawJob, { thresholds: state.settings.thresholds, runId, preferenceModel: state.preferenceModel });
    const candidateKeys = strongIdentityKeys(candidate);
    const existingInTask = task && candidateKeys.length
      ? state.jobs.find((job) => job.runId === runId && job.runTaskId === task.id
        && strongIdentityKeys(job).some((key) => candidateKeys.includes(key)))
      : null;
    if (existingInTask) {
      jobs.push(existingInTask);
      continue;
    }
    const duplicate = findDuplicate(candidate, existingPool);
    const existing = duplicate?.existing ?? null;
    if (existing) {
      candidate.duplicateOf = existing.id;
      candidate.deduplication = {
        type: duplicate.type,
        confidence: duplicate.confidence,
        matchedJobId: existing.id,
        matchedSource: existing.source,
        decidedAt: new Date().toISOString()
      };
      if (!candidate.description && existing.description) {
        candidate.description = existing.description;
        candidate.descriptionSource = existing.descriptionSource;
        candidate.descriptionFetchStatus = existing.descriptionFetchStatus;
        candidate.descriptionFetchedAt = existing.descriptionFetchedAt;
      }
      if (existing.screening?.jdReviewed && /^ai(?:$|-)/i.test(existing.screening.engine || "")) {
        candidate.description = existing.description;
        candidate.descriptionSource = existing.descriptionSource;
        candidate.descriptionFetchStatus = existing.descriptionFetchStatus;
        candidate.descriptionFetchError = null;
        candidate.descriptionFetchedAt = existing.descriptionFetchedAt;
        candidate.screening = {
          ...JSON.parse(JSON.stringify(existing.screening)),
          reusedFromJobId: existing.id
        };
        candidate.reviewedAt = existing.reviewedAt;
        candidate.aiReview = {
          status: "reused",
          reusedFromJobId: existing.id,
          completedAt: existing.reviewedAt || new Date().toISOString()
        };
      }
    }
    state.jobs.push(candidate);
    existingPool.push(candidate);
    jobs.push(candidate);
    addedCount += 1;
    if (run) {
      const counters = run.counters[candidate.source];
      if (counters) {
        if (candidate.duplicateOf) counters.repeatedImports += 1;
        else counters.newJobs += 1;
      }
      recordScreeningCounters(run, candidate.screening);
    }
  }

  if (addedCount) {
    state.importBatches.unshift({
      id: newId("import"),
      label: String(label).slice(0, 120),
      runId,
      taskId: task?.id ?? null,
      importedAt: new Date().toISOString(),
      count: addedCount
    });
    state.importBatches = state.importBatches.slice(0, 100);
  }
  return jobs;
}

function mergeWorkerResultJobs(state, rawJobs, { run, task }) {
  const merged = [];
  const missing = [];
  for (const rawJob of rawJobs) {
    const agentJobId = String(rawJob?.agentJobId || "").trim();
    const existing = agentJobId
      ? state.jobs.find((job) => job.id === agentJobId && job.runId === run.id && job.runTaskId === task.id)
      : null;
    if (!existing) {
      missing.push(rawJob);
      continue;
    }
    const fetched = rawJob.descriptionFetchStatus === "fetched" || rawJob.descriptionSource === "detail-page";
    if (fetched) {
      existing.description = String(rawJob.description || "").replace(/\s+/g, " ").trim() || existing.description;
      existing.descriptionSource = "detail-page";
      existing.descriptionFetchStatus = "fetched";
      existing.descriptionFetchError = null;
      existing.descriptionFetchedAt = rawJob.descriptionFetchedAt || new Date().toISOString();
    } else if (!existing.aiReview || existing.aiReview.status !== "reused") {
      existing.descriptionFetchStatus = rawJob.descriptionFetchStatus || existing.descriptionFetchStatus;
      existing.descriptionFetchError = rawJob.descriptionFetchError || null;
    }
    merged.push(existing);
  }
  if (missing.length) merged.push(...addJobsToState(state, missing, {
    runId: run.id,
    label: `${task.platform} worker result fallback`,
    task
  }));
  return merged;
}

function isRejectedBeforeJd(job) {
  return !job.screening?.jdReviewed
    && (job.screening?.category === "REJECTED" || job.screening?.titleClassification === "CLEAR_REJECT");
}

function hasAiJdReview(job) {
  return Boolean(job.screening?.jdReviewed && /^ai(?:$|-)/i.test(job.screening?.engine || ""));
}

function hasCompleteDescription(job) {
  if (!job.description || job.descriptionFetchStatus === "failed") return false;
  return job.descriptionFetchStatus === "fetched"
    || job.descriptionSource === "detail-page"
    || job.source === "manual"
    || !job.runTaskId;
}

function prepareAutoReviewJobs(state, jobs, { force = false } = {}) {
  const jobIds = [];
  const profile = state.profiles.find((item) => item.id === state.activeProfileId);
  const aiConfigured = aiStatus().configured;
  for (const job of jobs) {
    if (job.duplicateOf) {
      if (!hasAiJdReview(job)) {
        job.screening = { ...job.screening, screeningStatus: "DUPLICATE_SKIPPED" };
        job.aiReview = { status: "skipped", reason: "unified_history_duplicate", duplicateOf: job.duplicateOf };
      }
      continue;
    }
    if (isRejectedBeforeJd(job)) {
      job.aiReview = { status: "skipped", reason: "title_rejected" };
      continue;
    }
    if (hasAiJdReview(job) && !force) continue;
    if (!hasCompleteDescription(job)) {
      job.screening.screeningStatus = "JD_FETCH_FAILED";
      job.aiReview = {
        status: "blocked",
        reason: job.descriptionFetchError || "The complete job description could not be fetched."
      };
      continue;
    }
    if (!profile) {
      job.screening.screeningStatus = "PROFILE_REQUIRED";
      job.aiReview = { status: "blocked", reason: "Activate a career profile before automatic AI review." };
      continue;
    }
    if (!aiConfigured) {
      job.screening.screeningStatus = "AI_NOT_CONFIGURED";
      job.aiReview = { status: "blocked", reason: "Configure AI before automatic JD review." };
      continue;
    }
    job.screening = {
      ...job.screening,
      jdReviewed: false,
      screeningStatus: "AI_QUEUED",
      engine: "ai-pending"
    };
    job.aiReview = { status: "queued", queuedAt: new Date().toISOString() };
    jobIds.push(job.id);
  }
  return jobIds;
}

function automaticAiRetryLimit() {
  const parsed = Number.parseInt(process.env.JOB_AGENT_AI_AUTO_RETRY_LIMIT || "1", 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 5 ? parsed : 1;
}

function automaticAiCooldownMs() {
  const parsed = Number.parseInt(process.env.JOB_AGENT_AI_AUTO_RETRY_COOLDOWN_MS || "60000", 10);
  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 10 * 60_000 ? parsed : 60_000;
}

function buildOnDemandJdUrl(job, batchId = null) {
  const marker = new URLSearchParams({ jobAgentOnDemandJd: job.id });
  if (batchId) marker.set("jobAgentJdBatch", batchId);
  if (job.source === "indeed") {
    let sourceUrl = null;
    try { sourceUrl = new URL(job.jobUrl); } catch {}
    const jobId = job.sourceJobId || sourceUrl?.searchParams.get("jk") || sourceUrl?.searchParams.get("vjk");
    if (!jobId) throw new Error("Indeed job ID is missing, so the JD page cannot be opened.");
    const url = new URL("https://au.indeed.com/jobs");
    url.searchParams.set("q", primarySearchKeyword(job.searchKeyword) || job.title);
    url.searchParams.set("l", job.searchLocation || job.location || "Australia");
    if (Number(job.searchPostedWithinDays) > 0) url.searchParams.set("fromage", String(job.searchPostedWithinDays));
    url.searchParams.set("vjk", jobId);
    url.hash = marker.toString();
    return url.href;
  }
  if (!job.jobUrl) throw new Error("The original job link is missing.");
  const url = new URL(job.jobUrl);
  const host = url.hostname.toLowerCase();
  if (job.source === "linkedin" && !host.endsWith("linkedin.com")) throw new Error("The LinkedIn job link is invalid.");
  if (job.source === "seek" && !host.endsWith("seek.com.au")) throw new Error("The SEEK job link is invalid.");
  if (!["linkedin", "seek"].includes(job.source)) throw new Error("This platform does not support automatic JD retrieval.");
  url.hash = marker.toString();
  return url.href;
}

function markJobJdFetching(job) {
  job.descriptionFetchStatus = "fetching";
  job.descriptionFetchError = null;
  job.screening = { ...job.screening, jdReviewed: false, screeningStatus: "JD_FETCHING" };
  job.aiReview = { status: "fetching_jd", startedAt: new Date().toISOString() };
}

function retryableFailedJd(job) {
  const staleFetch = job?.screening?.screeningStatus === "JD_FETCHING"
    && Date.now() - Date.parse(job.aiReview?.startedAt || 0) > 30_000;
  return Boolean(job
    && !isRejectedBeforeJd(job)
    && ["linkedin", "indeed", "seek"].includes(job.source)
    && (job.descriptionFetchStatus === "failed" || job.screening?.screeningStatus === "JD_FETCH_FAILED" || staleFetch));
}

function retryableFailedAiReview(job) {
  return Boolean(job
    && job.screening?.screeningStatus === "AI_ERROR"
    && !isRejectedBeforeJd(job)
    && hasCompleteDescription(job)
    && !queuedAutoReviewIds.has(job.id));
}

async function advanceJdRetryBatch(batchId) {
  const batch = jdRetryBatches.get(batchId);
  if (!batch) return { done: true, batchId, total: 0, completed: 0, remaining: 0 };
  if (batch.currentJobId) {
    batch.completed += 1;
    batch.currentJobId = null;
  }
  while (batch.cursor < batch.jobIds.length) {
    const jobId = batch.jobIds[batch.cursor];
    batch.cursor += 1;
    const prepared = await storage.update((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (!retryableFailedJd(job)) return null;
      let launchUrl;
      try {
        launchUrl = buildOnDemandJdUrl(job, batch.id);
      } catch (error) {
        job.descriptionFetchStatus = "failed";
        job.descriptionFetchError = String(error.message || error).slice(0, 500);
        job.screening = { ...job.screening, jdReviewed: false, screeningStatus: "JD_FETCH_FAILED" };
        return { skipped: true };
      }
      markJobJdFetching(job);
      return { job, launchUrl };
    });
    if (!prepared || prepared.skipped) {
      batch.completed += 1;
      continue;
    }
    batch.currentJobId = jobId;
    return {
      ...prepared,
      done: false,
      batchId: batch.id,
      total: batch.jobIds.length,
      completed: batch.completed,
      remaining: batch.jobIds.length - batch.completed
    };
  }
  batch.completed = batch.jobIds.length;
  jdRetryBatches.delete(batch.id);
  return {
    done: true,
    batchId: batch.id,
    total: batch.jobIds.length,
    completed: batch.jobIds.length,
    remaining: 0
  };
}

function enqueueAutoReviews(jobIds) {
  for (const jobId of jobIds) {
    if (!jobId || queuedAutoReviewIds.has(jobId)) continue;
    queuedAutoReviewIds.add(jobId);
    autoReviewQueue.push(jobId);
  }
  if (!autoReviewRunning && !autoReviewCooldownTimer && autoReviewQueue.length) void drainAutoReviewQueue();
}

function scheduleAutoReviewDrain(delayMs) {
  if (autoReviewCooldownTimer || !autoReviewQueue.length) return;
  autoReviewCooldownTimer = setTimeout(() => {
    autoReviewCooldownTimer = null;
    if (!autoReviewRunning && autoReviewQueue.length) void drainAutoReviewQueue();
  }, delayMs);
}

async function prepareAutoReview(jobId) {
  return storage.update((state) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job || hasAiJdReview(job) || isRejectedBeforeJd(job)) return null;
    const transientAttempts = Math.max(0, Number(job.aiReview?.transientAttempts || 0));
    const retryRequested = job.aiReview?.retryRequested === true;
    const profile = state.profiles.find((item) => item.id === state.activeProfileId);
    const run = job.runId ? state.runs.find((item) => item.id === job.runId) : null;
    if (run) ensureRunCounterShape(run);
    if (!hasCompleteDescription(job)) {
      job.screening.screeningStatus = "JD_FETCH_FAILED";
      job.aiReview = { status: "blocked", reason: job.descriptionFetchError || "Complete JD unavailable." };
      return null;
    }
    if (!profile) {
      job.screening.screeningStatus = "PROFILE_REQUIRED";
      job.aiReview = { status: "blocked", reason: "No active career profile." };
      return null;
    }
    if (!aiStatus().configured) {
      job.screening.screeningStatus = "AI_NOT_CONFIGURED";
      job.aiReview = { status: "blocked", reason: "AI is not configured." };
      return null;
    }
    if (!canUseAiForRun(run) && !retryRequested) {
      if (run) run.counters.ai.budgetSkipped += 1;
      job.screening.screeningStatus = "AI_BUDGET_SKIPPED";
      job.aiReview = { status: "blocked", reason: "The automatic AI review limit for this run was reached." };
      return null;
    }
    if (run) run.counters.ai.calls += 1;
    const startedAt = new Date().toISOString();
    job.screening = { ...job.screening, screeningStatus: "AI_REVIEWING", engine: "ai-pending" };
    job.aiReview = { status: "reviewing", startedAt, retryRequested, transientAttempts };
    return {
      job: JSON.parse(JSON.stringify(job)),
      profile: JSON.parse(JSON.stringify(profile.profile)),
      thresholds: JSON.parse(JSON.stringify(state.settings.thresholds)),
      preferenceModel: state.preferenceModel ? JSON.parse(JSON.stringify(state.preferenceModel)) : null,
      retryRequested,
      transientAttempts
    };
  });
}

async function processAutoReview(jobId) {
  const prepared = await prepareAutoReview(jobId);
  if (!prepared) return;
  try {
    const evaluated = await evaluateJdWithAi(
      prepared.job,
      prepared.profile,
      prepared.thresholds,
      prepared.preferenceModel
    );
    await storage.update((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job) return;
      const completedAt = new Date().toISOString();
      job.screening = evaluated.screening;
      job.reviewedAt = completedAt;
      job.aiReview = { status: "completed", completedAt, usage: evaluated.usage };
      const roleRejected = job.screening.category === "REJECTED" && job.screening.workRights?.assessment !== "INELIGIBLE";
      job.learningSignals = {
        targetKeywords: evaluated.preferenceSignals.targetKeywords,
        exclusionKeywords: roleRejected ? evaluated.preferenceSignals.exclusionKeywords : [],
        exclusionReason: roleRejected ? evaluated.preferenceSignals.exclusionReason : "",
        generatedAt: completedAt,
        engine: "ai"
      };
      if (roleRejected) addExclusionSuggestions(state, job, job.learningSignals);
      const run = job.runId ? state.runs.find((item) => item.id === job.runId) : null;
      if (run) {
        ensureRunCounterShape(run);
        run.counters.ai.jdReviewed += 1;
        recordAiUsage(run, evaluated.usage);
        if (prepared.retryRequested) recalculateRunCounters(state, run);
      }
    });
    return { completed: true };
  } catch (error) {
    const transientError = isTransientAiError(error);
    const transientAttempts = prepared.transientAttempts + 1;
    const retryAt = new Date(Date.now() + automaticAiCooldownMs()).toISOString();
    const willRetry = transientError && transientAttempts <= automaticAiRetryLimit();
    await storage.update((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job) return;
      job.screening = {
        ...job.screening,
        jdReviewed: false,
        screeningStatus: willRetry ? "AI_RETRY_WAIT" : "AI_ERROR",
        engine: willRetry ? "ai-pending" : "ai-error",
        reason: willRetry
          ? `AI service is temporarily unavailable. Automatic retry scheduled after ${retryAt}.`
          : `AI JD review failed: ${error.message}`,
        concerns: [...(job.screening?.concerns ?? []), "automatic AI review needs another attempt"]
      };
      job.aiReview = willRetry
        ? {
            status: "retry_wait",
            retryAt,
            transientAttempts,
            retryRequested: true,
            reason: error.message
          }
        : {
            status: "failed",
            failedAt: new Date().toISOString(),
            transientAttempts,
            reason: error.message
          };
      const run = job.runId ? state.runs.find((item) => item.id === job.runId) : null;
      if (run) {
        ensureRunCounterShape(run);
        if (prepared.retryRequested) recalculateRunCounters(state, run);
        else if (!willRetry) run.counters.ai.errors += 1;
      }
    });
    return { transientError, willRetry, retryAt };
  }
}

async function drainAutoReviewQueue() {
  if (autoReviewRunning) return;
  autoReviewRunning = true;
  let cooldownMs = 0;
  try {
    while (autoReviewQueue.length) {
      const jobId = autoReviewQueue.shift();
      queuedAutoReviewIds.delete(jobId);
      const result = await processAutoReview(jobId);
      if (result?.transientError) {
        if (result.willRetry) {
          queuedAutoReviewIds.add(jobId);
          autoReviewQueue.unshift(jobId);
        }
        cooldownMs = automaticAiCooldownMs();
        break;
      }
    }
  } finally {
    autoReviewRunning = false;
    if (autoReviewQueue.length) {
      if (cooldownMs) scheduleAutoReviewDrain(cooldownMs);
      else void drainAutoReviewQueue();
    }
  }
}

async function resumeAutoReviews() {
  const ids = await storage.update((state) => {
    const pending = [];
    for (const job of state.jobs) {
      if (!["AI_QUEUED", "AI_REVIEWING", "AI_RETRY_WAIT"].includes(job.screening?.screeningStatus)) continue;
      const transientAttempts = Math.max(0, Number(job.aiReview?.transientAttempts || 0));
      job.screening.screeningStatus = "AI_QUEUED";
      job.screening.engine = "ai-pending";
      job.aiReview = { status: "queued", queuedAt: new Date().toISOString(), resumed: true, transientAttempts };
      pending.push(job.id);
    }
    return pending;
  });
  enqueueAutoReviews(ids);
}

function jobBelongsToRunTask(job, task, run) {
  if (job.runTaskId) return job.runTaskId === task.id;
  const normalized = (value) => String(value ?? "").trim().toLowerCase();
  const candidates = run.tasks.filter((candidate) => job.source === candidate.platform
    && normalized(job.searchKeyword) === normalized(candidate.keyword)
    && normalized(job.searchLocation) === normalized(candidate.location)
    && (job.searchPostedWithinDays === null || job.searchPostedWithinDays === undefined
      || Number(job.searchPostedWithinDays) === Number(candidate.postedWithinDays)));
  return candidates.length === 1 && candidates[0].id === task.id;
}

function reconcileLearningAfterJobDeletion(state, removedJobs) {
  const removedIds = new Set(removedJobs.map((job) => job.id));
  const removedFeedback = removedJobs.some((job) => job.feedback || job.learningSignals);
  const invalidReflectionRunIds = new Set(state.reviewReflections
    .filter((reflection) => (reflection.feedbackJobIds ?? []).some((id) => removedIds.has(id)))
    .map((reflection) => reflection.runId));
  if (invalidReflectionRunIds.size) {
    state.reviewReflections = state.reviewReflections.filter((reflection) => !invalidReflectionRunIds.has(reflection.runId));
    for (const run of state.runs.filter((item) => invalidReflectionRunIds.has(item.id))) {
      run.reviewReflectionId = null;
      run.reviewCompletedAt = null;
    }
  }
  if (!removedFeedback) return;
  state.exclusionSuggestions = state.exclusionSuggestions.filter((suggestion) => {
    suggestion.sourceJobIds = (suggestion.sourceJobIds ?? []).filter((id) => !removedIds.has(id));
    return suggestion.status === "approved" || suggestion.sourceJobIds.length;
  });
  const helpfulJobs = state.jobs
    .filter(isPositiveJobFeedback)
    .sort((left, right) => String(right.feedback.updatedAt).localeCompare(String(left.feedback.updatedAt)))
    .slice(0, 120);
  const legacyNotHelpfulJobs = state.jobs
    .filter(isLegacyNegativeJobFeedback)
    .sort((left, right) => String(right.feedback.updatedAt).localeCompare(String(left.feedback.updatedAt)))
    .slice(0, 120);
  const rejectedJobs = state.jobs.filter(isAiRoleRejectedSignal).slice(0, 120);
  if (!helpfulJobs.length && !legacyNotHelpfulJobs.length && !rejectedJobs.length) {
    state.preferenceModel = null;
    return;
  }
  const now = new Date().toISOString();
  state.preferenceModel = validatePreferenceModel(localPreferenceReflection({ helpfulJobs, rejectedJobs, legacyNotHelpfulJobs }), {
    version: (Number(state.preferenceModel?.version) || 0) + 1,
    feedbackCount: helpfulJobs.length + legacyNotHelpfulJobs.length + rejectedJobs.length,
    positiveFeedbackCount: helpfulJobs.length,
    rejectedSignalCount: rejectedJobs.length,
    sourceRunId: null,
    engine: "local-rules-after-deletion",
    updatedAt: now
  });
}

function applyDuplicate(candidate, duplicate) {
  candidate.duplicateOf = duplicate?.existing?.id ?? null;
  candidate.deduplication = duplicate ? {
    type: duplicate.type,
    confidence: duplicate.confidence,
    matchedJobId: duplicate.existing.id,
    matchedSource: duplicate.existing.source,
    decidedAt: new Date().toISOString()
  } : null;
  return candidate;
}

function rebuildDuplicateLinks(state) {
  const previous = [...(state.legacyWorkerHistory ?? [])];
  for (const job of state.jobs) {
    applyDuplicate(job, findDuplicate(job, previous));
    previous.push(job);
  }
}

function legacyHistoryRecord(platform, input) {
  const raw = input && typeof input === "object" ? input : { key: input };
  const source = String(platform || raw.source || raw.site || "").toLowerCase();
  if (!allowedPlatforms.has(source)) return null;
  const key = String(raw.key || raw.legacyKey || "").replace(/\s+/g, " ").trim();
  const keyJobId = key.match(/^(?:job|(?:linkedin|indeed|seek):job):(.+)$/i)?.[1] || "";
  const inputId = /^(?:job|legacy_history)_/i.test(String(raw.id || "")) ? "" : raw.id;
  const sourceJobId = String(raw.sourceJobId || raw.jobId || inputId || keyJobId).trim() || null;
  const keyUrl = key.match(/^(?:url|(?:linkedin|indeed|seek):url):(.+)$/i)?.[1] || "";
  const jobUrl = String(raw.jobUrl || raw.link || keyUrl).trim() || null;
  const fpParts = key.match(/^fp:(.+?)\|(.+)$/i);
  const explicitTitle = String(raw.title || "").replace(/\s+/g, " ").trim();
  const explicitCompany = String(raw.company || "").replace(/\s+/g, " ").trim();
  const title = explicitTitle || (fpParts?.[2] ? String(fpParts[2]).trim() : "");
  const company = explicitCompany || (fpParts?.[1] ? String(fpParts[1]).trim() : "");
  const opaque = !sourceJobId && !jobUrl;
  if (!sourceJobId && !jobUrl && !title && !key) return null;
  const identity = [source, sourceJobId, jobUrl, key, title, company, raw.location].map((value) => String(value || "")).join("|");
  return {
    id: `legacy_history_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`,
    source,
    sourceJobId,
    jobUrl,
    title,
    company: company || null,
    location: String(raw.location || "").replace(/\s+/g, " ").trim() || null,
    firstSeenAt: String(raw.firstSeenAt || raw.firstSeen || raw.createdAt || "").trim() || null,
    lastSeenAt: String(raw.lastSeenAt || raw.lastSeen || raw.updatedAt || "").trim() || null,
    legacyKey: key || null,
    opaque,
    importedAt: new Date().toISOString(),
    origin: "tampermonkey-history-migration"
  };
}

function normalizeUnifiedHistory(state) {
  state.legacyWorkerHistory ??= [];
  const before = state.legacyWorkerHistory.length;
  const compacted = [];
  let mergedAliases = 0;
  let ignored = 0;
  for (const input of state.legacyWorkerHistory) {
    const record = legacyHistoryRecord(input?.source, input);
    if (!record) {
      ignored += 1;
      continue;
    }
    record.id = input.id || record.id;
    record.importedAt = input.importedAt || record.importedAt;
    const duplicate = findDuplicate(record, compacted);
    if (duplicate) {
      mergedAliases += 1;
      continue;
    }
    compacted.push(record);
  }
  state.legacyWorkerHistory = compacted;
  rebuildDuplicateLinks(state);
  for (const run of state.runs) recalculateRunCounters(state, run);
  return {
    before,
    after: compacted.length,
    mergedAliases,
    ignored,
    opaque: compacted.filter((record) => record.opaque).length,
    agentOccurrences: state.jobs.length,
    duplicateOccurrences: state.jobs.filter((job) => job.duplicateOf).length,
    totalKnownJobs: state.jobs.filter((job) => !job.duplicateOf).length + compacted.length
  };
}

function importLegacyWorkerHistory(state, platform, records) {
  state.legacyWorkerHistory ??= [];
  state.workerHistoryMigrations ??= [];
  const pool = [...state.legacyWorkerHistory, ...state.jobs];
  let imported = 0;
  let covered = 0;
  let ignored = 0;
  let preservedOpaque = 0;
  for (const input of records.slice(0, 20_000)) {
    const record = legacyHistoryRecord(platform, input);
    if (!record) {
      ignored += 1;
      continue;
    }
    if (findDuplicate(record, pool)) {
      covered += 1;
      continue;
    }
    state.legacyWorkerHistory.push(record);
    pool.push(record);
    imported += 1;
    if (record.opaque) preservedOpaque += 1;
  }
  const migration = {
    id: newId("history_migration"),
    platform,
    received: records.length,
    imported,
    covered,
    ignored,
    preservedOpaque,
    importedAt: new Date().toISOString()
  };
  state.workerHistoryMigrations.unshift(migration);
  state.workerHistoryMigrations = state.workerHistoryMigrations.slice(0, 30);
  const cleanup = normalizeUnifiedHistory(state);
  return { migration, cleanup };
}

function removeJobs(state, predicate) {
  const removedJobs = state.jobs.filter(predicate);
  if (!removedJobs.length) return [];
  const removedIds = new Set(removedJobs.map((job) => job.id));
  state.jobs = state.jobs.filter((job) => !removedIds.has(job.id));
  rebuildDuplicateLinks(state);
  for (const run of state.runs) recalculateRunCounters(state, run);
  reconcileLearningAfterJobDeletion(state, removedJobs);
  return removedJobs;
}

function recalculateRunCounters(state, run) {
  ensureRunCounterShape(run);
  const jobs = state.jobs.filter((job) => job.runId === run.id);
  for (const platform of ["linkedin", "indeed", "seek"]) {
    const platformJobs = jobs.filter((job) => job.source === platform);
    run.counters[platform].tasks = run.tasks.filter((task) => task.platform === platform).length;
    run.counters[platform].newJobs = platformJobs.filter((job) => !job.duplicateOf).length;
    run.counters[platform].repeatedImports = platformJobs.filter((job) => job.duplicateOf).length;
    run.counters[platform].failed = run.tasks.filter((task) => task.platform === platform && task.status === "failed").length;
  }
  run.counters.ai.titleScreened = jobs.length;
  run.counters.ai.jdReviewed = jobs.filter((job) => job.screening?.jdReviewed).length;
  run.counters.ai.clearMatches = jobs.filter((job) => job.screening?.titleClassification === "CLEAR_MATCH").length;
  run.counters.ai.rejected = jobs.filter((job) => job.screening?.titleClassification === "CLEAR_REJECT").length;
  run.counters.ai.errors = jobs.filter((job) => job.screening?.screeningStatus === "AI_ERROR").length;
  run.counters.ai.reflections = state.reviewReflections.filter((reflection) => reflection.runId === run.id).length;
}

function createRun(settings, routineTasks, routineTaskIds = null) {
  const requestedIds = Array.isArray(routineTaskIds) && routineTaskIds.length
    ? new Set(routineTaskIds.map((id) => String(id)))
    : null;
  const selectedTasks = routineTasks.filter((task) => (!requestedIds || requestedIds.has(task.id)) && task.enabled && task.status === "READY");
  if (requestedIds && selectedTasks.length !== requestedIds.size) {
    throw new Error("One or more selected tasks are missing, disabled, or no longer validated.");
  }
  const tasks = selectedTasks.map((task, index) => ({
    id: newId("task"),
    routineTaskId: task.id,
    platform: task.platform,
    keyword: task.keyword,
    location: task.location,
    priority: index + 1,
    postedWithinDays: task.postedWithinDays,
    exclusionKeywords: [...(settings.exclusionKeywords ?? [])],
    workerTiming: { ...(settings.workerTiming ?? {}) },
    attempt: 1,
    status: "queued",
    reason: null,
    startedAt: null,
    completedAt: null,
    workerId: null,
    workerHeartbeatAt: null,
    stopRequestedAt: null,
    progress: null
  }));
  if (!tasks.length) throw new Error("Add and validate at least one daily task before starting a run.");
  const counters = runCounters();
  for (const task of tasks) counters[task.platform].tasks += 1;
  return {
    id: newId("run"),
    state: "WAITING_FOR_WORKERS",
    startedAt: new Date().toISOString(),
    completedAt: null,
    settingsSnapshot: settings,
    tasks,
    counters
  };
}

function updateRunState(run) {
  const statuses = run.tasks.map((task) => task.status);
  if (statuses.some((status) => status === "needs_user_action")) {
    run.state = "NEEDS_USER_ACTION";
    return;
  }
  if (statuses.some((status) => status === "queued" || status === "running")) {
    run.state = "WAITING_FOR_WORKERS";
    return;
  }
  run.state = statuses.some((status) => status === "failed") ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
  run.completedAt ??= new Date().toISOString();
}

function runTaskWorkerIsStale(task, timeoutMs = 30_000) {
  if (task?.status !== "running") return false;
  const heartbeat = Date.parse(task.workerHeartbeatAt || task.progress?.updatedAt || task.startedAt || "");
  return Number.isFinite(heartbeat) && Date.now() - heartbeat > timeoutMs;
}

function workerLandingUrl(platform, runId) {
  const landing = {
    linkedin: "https://www.linkedin.com/jobs/search/",
    indeed: "https://au.indeed.com/jobs",
    seek: "https://www.seek.com.au/jobs"
  }[platform];
  if (!landing) return null;
  const url = new URL(landing);
  url.searchParams.set("jobAgentWorker", "1");
  url.searchParams.set("jobAgentRun", runId);
  if (platform === "indeed") {
    url.searchParams.set("q", "job");
    url.searchParams.set("l", "Australia");
  }
  if (platform === "seek") {
    url.searchParams.set("keywords", "job");
    url.searchParams.set("where", "Australia");
  }
  return url.href;
}

function workerPreflightUrl(validation) {
  const query = new URLSearchParams({ jobAgentPreflight: "1", jobAgentValidation: validation.id }).toString();
  const landing = {
    linkedin: "https://www.linkedin.com/jobs/search/",
    indeed: "https://au.indeed.com/jobs",
    seek: "https://www.seek.com.au/jobs"
  }[validation.platform];
  if (!landing) return null;
  const url = new URL(landing + "?" + query);
  if (validation.platform === "indeed") {
    url.searchParams.set("q", "job");
    url.searchParams.set("l", "Australia");
  }
  if (validation.platform === "seek") {
    url.searchParams.set("keywords", "job");
    url.searchParams.set("where", "Australia");
  }
  return url.href;
}

function workerLaunchUrls(run) {
  return [...new Set(run.tasks.map((task) => task.platform))]
    .map((platform) => ({ platform, url: workerLandingUrl(platform, run.id) }))
    .filter((item) => item.url);
}

async function handleApi(request, response, url) {
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/health") {
    return sendJson(response, 200, { ok: true, ai: aiStatus() });
  }
  if (request.method === "GET" && path === "/api/bootstrap") {
    return sendJson(response, 200, buildBootstrap(await storage.ensureState()));
  }
  if (request.method === "POST" && path === "/api/jobs/assistant") {
    const body = await readJson(request);
    if (!aiStatus().configured) throw new Error("Configure AI before using the job review assistant.");
    const question = String(body.question || "").trim();
    if (question.length < 2) throw new Error("Enter a question about the current jobs.");
    const requestedIds = [...new Set((Array.isArray(body.jobIds) ? body.jobIds : [])
      .map((id) => String(id || "").trim()).filter(Boolean))].slice(0, 2_000);
    const state = await storage.ensureState();
    const jobsById = new Map(state.jobs.map((job) => [job.id, job]));
    const jobs = requestedIds.map((id) => jobsById.get(id)).filter(Boolean);
    if (!jobs.length) throw new Error("The current review view does not contain any jobs for the assistant.");
    const profile = state.profiles.find((item) => item.id === state.activeProfileId)?.profile ?? null;
    const result = await answerJobQuestions({
      question,
      conversation: body.conversation,
      profile,
      jobs,
      context: body.context
    });
    return sendJson(response, 200, result);
  }
  if (request.method === "PUT" && path === "/api/ai-config") {
    const body = await readJson(request);
    const ai = await saveAiConfig(mergedAiConfig(body));
    if (ai.configured) {
      const ids = await storage.update((state) => prepareAutoReviewJobs(
        state,
        state.jobs.filter((job) => ["AI_NOT_CONFIGURED", "AI_ERROR"].includes(job.screening?.screeningStatus))
      ));
      enqueueAutoReviews(ids);
    }
    return sendJson(response, 200, { ai });
  }
  if (request.method === "POST" && path === "/api/ai-config/test") {
    const body = await readJson(request);
    const result = await testAiConnection(mergedAiConfig(body));
    return sendJson(response, 200, { ...result, ai: aiStatus() });
  }
  if (request.method === "DELETE" && path === "/api/ai-config/key") {
    return sendJson(response, 200, { ai: await saveAiConfig(mergedAiConfig({}, true)) });
  }
  if (request.method === "DELETE" && path === "/api/records") {
    const result = await storage.update((state) => {
      const counts = {
        jobs: state.jobs.length,
        runs: state.runs.length,
        routineTasks: state.routineTasks.length,
        validations: state.validations.length,
        importBatches: state.importBatches.length,
        reviewReflections: state.reviewReflections.length,
        preferenceModel: state.preferenceModel ? 1 : 0,
        exclusionSuggestions: state.exclusionSuggestions.length,
        legacyWorkerHistory: (state.legacyWorkerHistory ?? []).length,
        workerHistoryMigrations: (state.workerHistoryMigrations ?? []).length
      };
      state.jobs = [];
      state.runs = [];
      state.routineTasks = [];
      state.validations = [];
      for (const category of state.taskCategories) {
        for (const task of category.tasks) task.validationId = null;
      }
      state.importBatches = [];
      state.reviewReflections = [];
      state.preferenceModel = null;
      state.exclusionSuggestions = [];
      state.legacyWorkerHistory = [];
      state.workerHistoryMigrations = [];
      return {
        cleared: counts,
        preserved: {
          taskCategories: state.taskCategories.length,
          builtinTaskCategories: state.taskCategories.filter((category) => category.builtin).length,
          customTaskCategories: state.taskCategories.filter((category) => !category.builtin).length,
          profiles: state.profiles.length,
          settings: 1,
          aiConfig: 1
        }
      };
    });
    return sendJson(response, 200, result);
  }
  if (request.method === "PUT" && path === "/api/settings") {
    const body = await readJson(request);
    const settings = safeSettings(body);
    await storage.update((state) => {
      state.settings = settings;
      removeCoveredPendingExclusionSuggestions(state);
    });
    return sendJson(response, 200, { settings });
  }
  if (request.method === "GET" && path === "/api/worker/settings") {
    const state = await storage.ensureState();
    const runId = String(url.searchParams.get("runId") ?? "");
    const run = runId ? state.runs.find((item) => item.id === runId) : null;
    return sendJson(response, 200, {
      workerTiming: run?.settingsSnapshot?.workerTiming ?? state.settings.workerTiming,
      source: run ? "run-snapshot" : "current-settings",
      runId: run?.id ?? null
    });
  }
  if (request.method === "POST" && path === "/api/settings/exclusion-keywords") {
    const body = await readJson(request);
    const keyword = String(body.keyword ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (keyword.length < 2) throw new Error("Enter an exclusion keyword with at least two characters.");
    const settings = await storage.update((state) => {
      const existing = state.settings.exclusionKeywords ?? [];
      if (!exclusionKeywordCovered(keyword, existing)) state.settings.exclusionKeywords.push(keyword);
      removeCoveredPendingExclusionSuggestions(state);
      return state.settings;
    });
    return sendJson(response, 201, { settings });
  }
  const exclusionKeywordMatch = /^\/api\/settings\/exclusion-keywords\/([^/]+)$/.exec(path);
  if (request.method === "DELETE" && exclusionKeywordMatch) {
    const keyword = decodeURIComponent(exclusionKeywordMatch[1]);
    const settings = await storage.update((state) => {
      state.settings.exclusionKeywords = (state.settings.exclusionKeywords ?? []).filter((value) => value.toLowerCase() !== keyword.toLowerCase());
      const suggestion = state.exclusionSuggestions.find((item) => item.keyword.toLowerCase() === keyword.toLowerCase());
      if (suggestion) {
        suggestion.status = "pending";
        suggestion.approvedAt = null;
      }
      return state.settings;
    });
    return sendJson(response, 200, { settings });
  }
  const exclusionSuggestionMatch = /^\/api\/exclusion-suggestions\/([^/]+)$/.exec(path);
  if (request.method === "POST" && exclusionSuggestionMatch) {
    const result = await storage.update((state) => {
      const suggestion = state.exclusionSuggestions.find((item) => item.id === exclusionSuggestionMatch[1]);
      if (!suggestion) throw new Error("Exclusion suggestion was not found.");
      suggestion.status = "approved";
      suggestion.approvedAt = new Date().toISOString();
      const existing = state.settings.exclusionKeywords ?? [];
      if (!exclusionKeywordCovered(suggestion.keyword, existing)) state.settings.exclusionKeywords.push(suggestion.keyword);
      removeCoveredPendingExclusionSuggestions(state);
      return { suggestion, settings: state.settings };
    });
    return sendJson(response, 200, result);
  }
  if (request.method === "DELETE" && exclusionSuggestionMatch) {
    const deleted = await storage.update((state) => {
      const index = state.exclusionSuggestions.findIndex((item) => item.id === exclusionSuggestionMatch[1]);
      if (index < 0) throw new Error("Exclusion suggestion was not found.");
      return state.exclusionSuggestions.splice(index, 1)[0];
    });
    return sendJson(response, 200, { deleted });
  }
  if (request.method === "POST" && path === "/api/resumes/upload") {
    const buffer = await readBody(request);
    const fields = parseMultipart(buffer, request.headers["content-type"]);
    if (!fields.resume || typeof fields.resume === "string") return apiError(response, 400, "Choose a resume file.");
    return sendJson(response, 200, await extractResume(fields.resume));
  }
  if (request.method === "POST" && path === "/api/profiles/generate") {
    const body = await readJson(request);
    const resumeText = String(body.resumeText ?? "").trim();
    if (resumeText.length < 80) return apiError(response, 400, "Resume text is too short to build a profile.");
    const externalProfileText = String(body.externalProfileText ?? "").trim();
    const generated = await generateProfile(resumeText, body.sourceName || "resume", externalProfileText);
    const profile = await storage.update((state) => {
      const version = Math.max(
        0,
        Number(state.profileVersionCounter) || 0,
        ...state.profiles.map((item) => Number(item.version) || 0)
      ) + 1;
      const record = {
        id: newId("profile"),
        version,
        status: "draft",
        createdAt: new Date().toISOString(),
        activatedAt: null,
        sourceName: String(body.sourceName || "resume").slice(0, 120),
        sourceText: resumeText,
        sourceTextLength: resumeText.length,
        externalProfileUsed: Boolean(externalProfileText),
        externalProfileLength: externalProfileText.length,
        engine: generated.engine,
        aiError: generated.aiError,
        aiUsage: generated.usage,
        profile: generated.profile
      };
      state.profileVersionCounter = version;
      state.profiles.unshift(record);
      return record;
    });
    return sendJson(response, 201, { profile: publicProfile(profile) });
  }

  const profileMatch = /^\/api\/profiles\/([^/]+)$/.exec(path);
  if (request.method === "PUT" && profileMatch) {
    const body = await readJson(request);
    const profile = await storage.update((state) => {
      const record = state.profiles.find((item) => item.id === profileMatch[1]);
      if (!record) throw new Error("Profile was not found.");
      record.profile = validateProfileDraft(body.profile);
      record.updatedAt = new Date().toISOString();
      return record;
    });
    return sendJson(response, 200, { profile: publicProfile(profile) });
  }
  const activateMatch = /^\/api\/profiles\/([^/]+)\/activate$/.exec(path);
  if (request.method === "POST" && activateMatch) {
    const result = await storage.update((state) => {
      const record = state.profiles.find((item) => item.id === activateMatch[1]);
      if (!record) throw new Error("Profile was not found.");
      state.activeProfileId = record.id;
      record.status = "approved";
      record.activatedAt = new Date().toISOString();
      const deleted = state.profiles.length - 1;
      state.profiles = [record];
      return { profile: record, deleted };
    });
    const ids = await storage.update((state) => prepareAutoReviewJobs(
      state,
      state.jobs.filter((job) => job.screening?.screeningStatus === "PROFILE_REQUIRED")
    ));
    enqueueAutoReviews(ids);
    return sendJson(response, 200, { profile: publicProfile(result.profile), deleted: result.deleted });
  }
  if (request.method === "DELETE" && path === "/api/profiles/other-versions") {
    const result = await storage.update((state) => {
      const active = state.profiles.find((item) => item.id === state.activeProfileId);
      if (!active) throw new Error("Confirm a career profile before clearing other versions.");
      const deleted = state.profiles.length - 1;
      state.profiles = [active];
      return { active, deleted };
    });
    return sendJson(response, 200, { profile: publicProfile(result.active), deleted: result.deleted });
  }

  if (request.method === "POST" && path === "/api/task-categories/prepare") {
    const body = await readJson(request);
    const categoryIds = Array.isArray(body.categoryIds) ? [...new Set(body.categoryIds.map((id) => String(id)))].slice(0, 40) : [];
    const mode = body.mode === "import" ? "import" : "preflight";
    if (!categoryIds.length) return apiError(response, 400, "Select at least one task category.");
    const result = await storage.update((state) => {
      const selected = categoryIds.map((id) => state.taskCategories.find((category) => category.id === id));
      if (selected.some((category) => !category)) throw new Error("One or more task categories no longer exist.");
      const validations = [];
      let valid = 0;
      let pending = 0;
      let added = 0;
      let alreadyAdded = 0;
      for (const category of selected) {
        for (const task of category.tasks) {
          const validation = ensureCategoryTaskValidation(state, category, task, mode === "import");
          validations.push(validation);
          if (validation.status === "VALID") {
            valid += 1;
            if (mode === "import") {
              const imported = addCategoryValidationToRoutine(state, validation);
              if (imported.added) added += 1;
              else alreadyAdded += 1;
            }
          } else {
            pending += 1;
          }
        }
      }
      state.validations = state.validations.slice(0, 300);
      return {
        categoryIds,
        validationIds: validations.map((validation) => validation.id),
        valid,
        pending,
        added,
        alreadyAdded
      };
    });
    return sendJson(response, 200, result);
  }

  if (request.method === "POST" && path === "/api/task-categories") {
    const body = await readJson(request);
    const category = await storage.update((state) => {
      const input = safeTaskCategoryInput(body, null, state);
      const now = new Date().toISOString();
      const record = {
        id: newId("task_category"),
        name: input.name,
        builtin: false,
        tasks: input.tasks,
        createdAt: now,
        updatedAt: now
      };
      state.taskCategories.push(record);
      return record;
    });
    return sendJson(response, 201, { category });
  }

  const taskCategoryMatch = /^\/api\/task-categories\/([^/]+)$/.exec(path);
  if (request.method === "PUT" && taskCategoryMatch) {
    const body = await readJson(request);
    const category = await storage.update((state) => {
      const record = state.taskCategories.find((item) => item.id === taskCategoryMatch[1]);
      if (!record) throw new Error("Task category was not found.");
      if (record.builtin) throw new Error("Built-in task categories cannot be edited.");
      const input = safeTaskCategoryInput(body, record, state);
      record.name = input.name;
      record.tasks = input.tasks;
      record.updatedAt = new Date().toISOString();
      return record;
    });
    return sendJson(response, 200, { category });
  }
  if (request.method === "DELETE" && taskCategoryMatch) {
    const category = await storage.update((state) => {
      const index = state.taskCategories.findIndex((item) => item.id === taskCategoryMatch[1]);
      if (index < 0) throw new Error("Task category was not found.");
      if (state.taskCategories[index].builtin) throw new Error("Built-in task categories cannot be deleted.");
      return state.taskCategories.splice(index, 1)[0];
    });
    return sendJson(response, 200, { category });
  }

  if (request.method === "POST" && path === "/api/task-validations") {
    const body = await readJson(request);
    const taskInput = safeRoutineTaskInput(body);
    const validation = await storage.update((state) => {
      const record = createValidationRecord(taskInput);
      state.validations.unshift(record);
      state.validations = state.validations.slice(0, 300);
      return record;
    });
    return sendJson(response, 201, { validation, preflightUrl: workerPreflightUrl(validation) });
  }

  if (request.method === "POST" && path === "/api/task-validations/start") {
    const body = await readJson(request);
    const requestedIds = Array.isArray(body.validationIds) && body.validationIds.length
      ? new Set(body.validationIds.map((id) => String(id)))
      : null;
    const result = await storage.update((state) => {
      const now = new Date();
      const nowIso = now.toISOString();
      const waiting = state.validations.filter((record) => record.status === "WAITING_FOR_WORKER" && (!requestedIds || requestedIds.has(record.id)));
      for (const record of waiting) {
        if (!record.preflightQueuedAt) {
          record.preflightQueuedAt = nowIso;
          record.updatedAt = nowIso;
        }
      }
      const launchable = waiting.filter((record) => {
        const workerStartedAt = Date.parse(record.workerStartedAt || "");
        return !Number.isFinite(workerStartedAt) || now.getTime() - workerStartedAt >= preflightWorkerLeaseMs;
      });
      const firstByPlatform = new Map();
      for (const record of launchable) {
        if (!firstByPlatform.has(record.platform)) firstByPlatform.set(record.platform, record);
      }
      return {
        count: waiting.length,
        launchUrls: platformOrder
          .map((platform) => firstByPlatform.get(platform))
          .filter(Boolean)
          .map((record) => ({ platform: record.platform, url: workerPreflightUrl(record) }))
      };
    });
    return sendJson(response, 200, result);
  }

  if (request.method === "GET" && path === "/api/worker/preflight/next-launch") {
    const now = Date.now();
    const state = await storage.ensureState();
    const validation = platformOrder
      .map((platform) => state.validations.find((record) => {
        if (record.platform !== platform || record.status !== "WAITING_FOR_WORKER" || !record.preflightQueuedAt) return false;
        const updatedAt = Date.parse(record.updatedAt || record.createdAt || "");
        if (!Number.isFinite(updatedAt) || now - updatedAt > preflightPickupWindowMs) return false;
        const workerStartedAt = Date.parse(record.workerStartedAt || "");
        return !Number.isFinite(workerStartedAt) || now - workerStartedAt >= preflightWorkerLeaseMs;
      }))
      .find(Boolean) ?? null;
    return sendJson(response, 200, {
      validation,
      url: validation ? workerPreflightUrl(validation) : null
    });
  }

  if (request.method === "GET" && path === "/api/worker/preflight") {
    const validationId = String(url.searchParams.get("validationId") ?? "");
    const platform = String(url.searchParams.get("platform") ?? "").toLowerCase();
    if (!validationId || !allowedPlatforms.has(platform)) return apiError(response, 400, "Validation id and platform are required.");
    const validation = (await storage.ensureState()).validations.find((item) => item.id === validationId);
    if (!validation || validation.platform !== platform) return apiError(response, 404, "Validation was not found.");
    return sendJson(response, 200, { validation });
  }

  if (request.method === "GET" && path === "/api/worker/preflight/pending") {
    const platform = String(url.searchParams.get("platform") ?? "").toLowerCase();
    if (!allowedPlatforms.has(platform)) return apiError(response, 400, "A valid platform is required.");
    const now = Date.now();
    const validation = (await storage.ensureState()).validations.find((record) => {
      if (record.platform !== platform || record.status !== "WAITING_FOR_WORKER" || !record.preflightQueuedAt) return false;
      const updatedAt = Date.parse(record.updatedAt || record.createdAt || "");
      if (!Number.isFinite(updatedAt) || now - updatedAt > preflightPickupWindowMs) return false;
      const workerStartedAt = Date.parse(record.workerStartedAt || "");
      return !Number.isFinite(workerStartedAt) || now - workerStartedAt >= preflightWorkerLeaseMs;
    }) ?? null;
    return sendJson(response, 200, { validation });
  }

  if (request.method === "GET" && path === "/api/worker/active-run") {
    const platform = String(url.searchParams.get("platform") ?? "").toLowerCase();
    if (!allowedPlatforms.has(platform)) return apiError(response, 400, "A valid platform is required.");
    const run = (await storage.ensureState()).runs.find((item) =>
      ["WAITING_FOR_WORKERS", "NEEDS_USER_ACTION"].includes(item.state)
      && item.tasks.some((task) => task.platform === platform && ["queued", "running", "needs_user_action"].includes(task.status))
    ) ?? null;
    return sendJson(response, 200, { run });
  }

  if (request.method === "POST" && path === "/api/worker/preflight/started") {
    const body = await readJson(request);
    const validation = await storage.update((state) => {
      const record = state.validations.find((item) => item.id === body.validationId);
      if (!record) throw new Error("Validation was not found.");
      if (record.platform !== String(body.platform ?? "").toLowerCase()) throw new Error("Validation belongs to another platform.");
      const reportedAttempt = Number(body.preflightAttempt);
      if (Number.isInteger(reportedAttempt) && reportedAttempt !== (Number(record.preflightAttempt) || 1)) {
        throw new Error("This preflight start belongs to an older attempt.");
      }
      const existingStartedAt = Date.parse(record.workerStartedAt || "");
      const workerId = String(body.workerId ?? "").slice(0, 120) || null;
      if (record.status !== "WAITING_FOR_WORKER") throw new Error("This preflight is no longer waiting for a worker.");
      if (Number.isFinite(existingStartedAt) && Date.now() - existingStartedAt < preflightWorkerLeaseMs && record.workerId && record.workerId !== workerId) {
        throw new Error("This preflight is already being checked by another worker.");
      }
      record.workerStartedAt = new Date().toISOString();
      record.workerId = workerId;
      record.updatedAt = new Date().toISOString();
      return record;
    });
    return sendJson(response, 200, { validation });
  }

  if (request.method === "POST" && path === "/api/worker/preflight/result") {
    const body = await readJson(request);
    const result = await storage.update((state) => {
      const validation = state.validations.find((item) => item.id === body.validationId);
      if (!validation) throw new Error("Validation was not found.");
      if (validation.platform !== String(body.platform ?? "").toLowerCase()) throw new Error("Validation belongs to another platform.");
      const reportedAttempt = Number(body.preflightAttempt);
      if (Number.isInteger(reportedAttempt) && reportedAttempt !== (Number(validation.preflightAttempt) || 1)) {
        throw new Error("This preflight result belongs to an older attempt.");
      }
      const status = body.status === "valid"
        ? "VALID"
        : body.status === "needs_user_action" ? "NEEDS_USER_ACTION" : "FAILED";
      validation.status = status;
      validation.reason = String(body.reason ?? "").slice(0, 500) || null;
      validation.checkedAt = new Date().toISOString();
      validation.updatedAt = validation.checkedAt;
      if (status === "VALID" && !validation.routineTaskId) {
        if (validation.autoAddToRoutine !== false) {
          const routineTask = createRoutineTask(validation);
          state.routineTasks.unshift(routineTask);
          validation.routineTaskId = routineTask.id;
          return { validation, routineTask };
        }
      }
      return { validation, routineTask: state.routineTasks.find((task) => task.id === validation.routineTaskId) ?? null };
    });
    return sendJson(response, 200, result);
  }

  const retryValidationMatch = /^\/api\/task-validations\/([^/]+)\/retry$/.exec(path);
  if (request.method === "POST" && retryValidationMatch) {
    const result = await storage.update((state) => {
      const record = state.validations.find((item) => item.id === retryValidationMatch[1]);
      if (!record) throw new Error("Validation was not found.");
      const routineTaskRemoved = resetValidationForPreflight(state, record);
      return { validation: record, routineTaskRemoved };
    });
    return sendJson(response, 200, {
      validation: result.validation,
      routineTaskRemoved: result.routineTaskRemoved,
      preflightUrl: workerPreflightUrl(result.validation)
    });
  }

  const addValidationTaskMatch = /^\/api\/task-validations\/([^/]+)\/add$/.exec(path);
  if (request.method === "POST" && addValidationTaskMatch) {
    const result = await storage.update((state) => {
      const validation = state.validations.find((item) => item.id === addValidationTaskMatch[1]);
      if (!validation) throw new Error("Validation was not found.");
      if (validation.status !== "VALID") throw new Error("Only a valid preflight can be added to daily tasks.");
      const existing = state.routineTasks.find((task) => task.id === validation.routineTaskId)
        ?? state.routineTasks.find((task) => task.validationId === validation.id);
      if (existing) {
        validation.routineTaskId = existing.id;
        return { validation, routineTask: existing, added: false };
      }
      const routineTask = createRoutineTask(validation);
      state.routineTasks.unshift(routineTask);
      validation.routineTaskId = routineTask.id;
      validation.updatedAt = new Date().toISOString();
      return { validation, routineTask, added: true };
    });
    return sendJson(response, 200, result);
  }

  const validationMatch = /^\/api\/task-validations\/([^/]+)$/.exec(path);
  if (request.method === "PUT" && validationMatch) {
    const body = await readJson(request);
    const taskInput = safeRoutineTaskInput(body);
    const result = await storage.update((state) => {
      const record = state.validations.find((item) => item.id === validationMatch[1]);
      if (!record) throw new Error("Validation was not found.");
      const routineTaskRemoved = resetValidationForPreflight(state, record, taskInput);
      return { validation: record, routineTaskRemoved };
    });
    return sendJson(response, 200, {
      validation: result.validation,
      routineTaskRemoved: result.routineTaskRemoved,
      preflightUrl: workerPreflightUrl(result.validation)
    });
  }
  if (request.method === "DELETE" && validationMatch) {
    const result = await storage.update((state) => {
      const index = state.validations.findIndex((item) => item.id === validationMatch[1]);
      if (index < 0) throw new Error("Validation was not found.");
      const deleted = state.validations.splice(index, 1)[0];
      const routineTaskRetained = Boolean(deleted.routineTaskId && state.routineTasks.some((task) => task.id === deleted.routineTaskId));
      return { deleted, routineTaskRetained };
    });
    return sendJson(response, 200, result);
  }

  if (request.method === "DELETE" && path === "/api/routine-tasks") {
    const cleared = await storage.update((state) => {
      const count = state.routineTasks.length;
      state.routineTasks = [];
      return { count };
    });
    return sendJson(response, 200, { cleared });
  }

  const routineTaskMatch = /^\/api\/routine-tasks\/([^/]+)$/.exec(path);
  if (request.method === "DELETE" && routineTaskMatch) {
    const deleted = await storage.update((state) => {
      const index = state.routineTasks.findIndex((item) => item.id === routineTaskMatch[1]);
      if (index < 0) throw new Error("Daily task was not found.");
      return state.routineTasks.splice(index, 1)[0];
    });
    return sendJson(response, 200, { deleted });
  }

  if (request.method === "POST" && path === "/api/runs") {
    const body = await readJson(request);
    const run = await storage.update((state) => {
      const active = state.runs.find((item) => ["WAITING_FOR_WORKERS", "NEEDS_USER_ACTION"].includes(item.state));
      if (active) throw new Error("A run is already active. Finish or clear it before starting another run.");
      const run = createRun(state.settings, state.routineTasks, body.routineTaskIds);
      state.runs.unshift(run);
      state.runs = state.runs.slice(0, 60);
      return run;
    });
    return sendJson(response, 201, { run, launchUrls: workerLaunchUrls(run) });
  }

  const runHistoryMatch = /^\/api\/runs\/([^/]+)$/.exec(path);
  if (request.method === "DELETE" && runHistoryMatch) {
    const result = await storage.update((state) => {
      const index = state.runs.findIndex((item) => item.id === runHistoryMatch[1]);
      if (index < 0) throw new Error("Run was not found.");
      const run = state.runs[index];
      if (!["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(run.state)) {
        throw new Error("Only completed run history can be deleted. Finish or clear its queue first.");
      }
      const reflectionCount = state.reviewReflections.filter((reflection) => reflection.runId === run.id).length;
      const jobs = removeJobs(state, (job) => job.runId === run.id);
      const importBatchCount = state.importBatches.filter((batch) => batch.runId === run.id).length;
      state.importBatches = state.importBatches.filter((batch) => batch.runId !== run.id);
      state.reviewReflections = state.reviewReflections.filter((reflection) => reflection.runId !== run.id);
      state.runs.splice(index, 1);
      return {
        run,
        removed: { runs: 1, tasks: run.tasks.length, jobs: jobs.length, importBatches: importBatchCount, reviewReflections: reflectionCount }
      };
    });
    return sendJson(response, 200, result);
  }

  if (request.method === "GET" && path === "/api/worker/next-platform-launch") {
    const runId = String(url.searchParams.get("runId") ?? "");
    const currentPlatform = String(url.searchParams.get("platform") ?? "").toLowerCase();
    const run = (await storage.ensureState()).runs.find((item) => item.id === runId);
    if (!run) return apiError(response, 404, "Run was not found.");
    const nextTask = run.tasks.find((task) => task.platform !== currentPlatform && task.status === "queued") ?? null;
    return sendJson(response, 200, {
      platform: nextTask?.platform ?? null,
      url: nextTask ? workerLandingUrl(nextTask.platform, run.id) : null
    });
  }
  if (request.method === "GET" && path === "/api/worker/next") {
    const runId = url.searchParams.get("runId");
    const platform = String(url.searchParams.get("platform") ?? "").toLowerCase();
    const workerId = String(url.searchParams.get("workerId") ?? "").slice(0, 160);
    if (!allowedPlatforms.has(platform) || !workerId) {
      return apiError(response, 400, "Worker platform and workerId are required.");
    }
    const task = await storage.update((state) => {
      const run = runId
        ? state.runs.find((item) => item.id === runId)
        : state.runs.find((item) => item.state === "WAITING_FOR_WORKERS");
      if (!run) return { run: null, task: null };
      ensureRunCounterShape(run);
      const activeForPlatform = run.tasks.find((item) => item.platform === platform && item.status === "running");
      if (activeForPlatform) {
        if (activeForPlatform.workerId === workerId) return { run, task: activeForPlatform, reason: "already_claimed" };
        return { run, task: null, reason: "platform_busy" };
      }
      const pausedForPlatform = run.tasks.find((item) => item.platform === platform && item.status === "needs_user_action");
      if (pausedForPlatform) return { run, task: null, reason: "needs_user_action" };
      const nextInSequence = run.tasks.find((item) => ["queued", "running", "needs_user_action"].includes(item.status));
      if (run.settingsSnapshot.executionMode === "sequential" && nextInSequence && nextInSequence.platform !== platform) {
        return { run, task: null, reason: "waiting_turn" };
      }
      if (nextInSequence?.status === "needs_user_action" && run.settingsSnapshot.executionMode === "sequential") {
        return { run, task: null, reason: "needs_user_action" };
      }
      const next = run.tasks.find((item) => item.platform === platform && item.status === "queued");
      if (!next) {
        updateRunState(run);
        return { run, task: null };
      }
      next.status = "running";
      next.workerId = workerId;
      next.startedAt = new Date().toISOString();
      next.workerHeartbeatAt = next.startedAt;
      next.progress = { phase: "claimed", message: "Worker 已领取任务，正在打开搜索页面。", updatedAt: next.startedAt };
      return { run, task: next };
    });
    return sendJson(response, 200, task);
  }
  if (request.method === "POST" && path === "/api/worker/progress") {
    const body = await readJson(request);
    const result = await storage.update((state) => {
      const run = state.runs.find((item) => item.id === body.runId);
      const task = run?.tasks.find((item) => item.id === body.taskId);
      if (!run || !task) throw new Error("Run task was not found.");
      ensureRunCounterShape(run);
      if (Number(body.taskAttempt || 1) !== task.attempt || task.status !== "running") {
        return { run, task, discarded: true };
      }
      if (task.workerId && body.workerId !== task.workerId) throw new Error("Task is held by another worker.");
      const now = new Date().toISOString();
      task.workerHeartbeatAt = now;
      task.progress = {
        phase: String(body.phase || "working").slice(0, 40),
        message: String(body.message || "Worker 正在处理任务。").slice(0, 240),
        scanned: Math.max(0, Number(body.scanned) || 0),
        found: Math.max(0, Number(body.found) || 0),
        accessCount: Math.max(0, Number(body.accessCount) || 0),
        accessLimit: Math.max(0, Number(body.accessLimit) || 0),
        cooldownUntil: body.cooldownUntil ? String(body.cooldownUntil).slice(0, 40) : null,
        cooldownReason: body.cooldownReason ? String(body.cooldownReason).slice(0, 240) : null,
        updatedAt: now
      };
      return { run, task, discarded: false, stopRequested: Boolean(task.stopRequestedAt) };
    });
    return sendJson(response, 200, result);
  }
  if (request.method === "POST" && path === "/api/worker/history/import") {
    const body = await readJson(request);
    const platform = String(body.platform || "").toLowerCase();
    if (!allowedPlatforms.has(platform)) return apiError(response, 400, "A valid Worker platform is required.");
    if (!Array.isArray(body.records)) return apiError(response, 400, "Worker history records must be an array.");
    if (body.records.length > 20_000) return apiError(response, 400, "Import at most 20,000 Worker history records at a time.");
    const result = await storage.update((state) => importLegacyWorkerHistory(state, platform, body.records));
    return sendJson(response, 200, {
      ...result,
      clearLocalHistory: result.migration.ignored === 0
    });
  }
  if (request.method === "POST" && path === "/api/history/normalize") {
    const cleanup = await storage.update((state) => normalizeUnifiedHistory(state));
    return sendJson(response, 200, { cleanup });
  }
  if (request.method === "POST" && path === "/api/worker/title-plan") {
    const body = await readJson(request);
    const rawJobs = Array.isArray(body.jobs) ? body.jobs.slice(0, 1000) : [];
    const result = await storage.update((state) => {
      const run = state.runs.find((item) => item.id === body.runId);
      const task = run?.tasks.find((item) => item.id === body.taskId);
      if (!run || !task) throw new Error("Run task was not found.");
      if (task.status !== "running") throw new Error("Only a running task can submit discovered jobs.");
      const jobs = rawJobs.length ? addJobsToState(state, rawJobs, {
        runId: run.id,
        label: `${task.platform} discovered candidates`,
        task
      }) : [];
      const plan = jobs.map((job, index) => {
        if (job.duplicateOf) {
          return hasAiJdReview(job) && job.description
            ? { index, jobId: job.id, action: "reuse", existingJobId: job.duplicateOf, reason: "Unified Agent history already has a completed AI review." }
            : { index, jobId: job.id, action: "skip_seen", existingJobId: job.duplicateOf, reason: "Unified Agent history already contains this job." };
        }
        if (isRejectedBeforeJd(job)) {
          return { index, jobId: job.id, action: "reject", reason: job.screening.reason };
        }
        return { index, jobId: job.id, action: "fetch" };
      });
      const counts = {
        total: plan.length,
        fetch: plan.filter((item) => item.action === "fetch").length,
        reuse: plan.filter((item) => item.action === "reuse").length,
        seen: plan.filter((item) => item.action === "skip_seen").length,
        rejected: plan.filter((item) => item.action === "reject").length
      };
      task.pipelineStats = {
        discovered: counts.total,
        duplicateHistory: counts.seen + counts.reuse,
        reusedReviews: counts.reuse,
        localRejected: counts.rejected,
        jdPlanned: counts.fetch,
        updatedAt: new Date().toISOString()
      };
      recalculateRunCounters(state, run);
      return { plan, counts };
    });
    return sendJson(response, 200, result);
  }
  if (request.method === "POST" && path === "/api/worker/job-jd") {
    const body = await readJson(request);
    const result = await storage.update((state) => {
      const job = state.jobs.find((item) => item.id === body.jobId);
      if (!job) throw new Error("Job was not found.");
      if (job.source !== body.platform) throw new Error("The JD result came from the wrong platform Worker.");
      const description = String(body.description || "").replace(/\s+/g, " ").trim();
      const failureReason = String(body.humanReason || body.error || "").trim();
      if (failureReason || description.length < 120) {
        const reason = failureReason || "The page did not contain a complete job description.";
        job.descriptionFetchStatus = "failed";
        job.descriptionFetchError = reason.slice(0, 500);
        job.screening = { ...job.screening, jdReviewed: false, screeningStatus: "JD_FETCH_FAILED" };
        job.aiReview = {
          status: body.humanReason ? "needs_user_action" : "failed",
          reason: job.descriptionFetchError,
          failedAt: new Date().toISOString()
        };
        const run = job.runId ? state.runs.find((item) => item.id === job.runId) : null;
        if (run) recalculateRunCounters(state, run);
        return { job, autoReviewJobIds: [] };
      }
      job.description = description;
      job.descriptionSource = "detail-page";
      job.descriptionFetchStatus = "fetched";
      job.descriptionFetchError = null;
      job.descriptionFetchedAt = new Date().toISOString();
      const autoReviewJobIds = prepareAutoReviewJobs(state, [job], { force: true });
      const run = job.runId ? state.runs.find((item) => item.id === job.runId) : null;
      if (run) recalculateRunCounters(state, run);
      return { job, autoReviewJobIds };
    });
    if (body.humanReason && body.batchId) jdRetryBatches.delete(String(body.batchId));
    enqueueAutoReviews(result.autoReviewJobIds);
    return sendJson(response, 200, {
      job: result.job,
      autoReviewQueued: result.autoReviewJobIds.length
    });
  }

  const nextJdRetryMatch = /^\/api\/worker\/jd-retry\/([^/]+)\/next$/.exec(path);
  if (request.method === "POST" && nextJdRetryMatch) {
    return sendJson(response, 200, await advanceJdRetryBatch(nextJdRetryMatch[1]));
  }
  if (request.method === "POST" && path === "/api/worker/result") {
    const body = await readJson(request);
    const result = await storage.update((state) => {
      const run = state.runs.find((item) => item.id === body.runId);
      if (!run) throw new Error("Run was not found.");
      const task = run.tasks.find((item) => item.id === body.taskId);
      if (!task) throw new Error("Task was not found.");
      ensureRunCounterShape(run);
      if (Number(body.taskAttempt || 1) !== task.attempt) {
        return { run, task, jobs: [], discarded: true, staleAttempt: true };
      }
      if (task.workerId && body.workerId !== task.workerId) throw new Error("Task is held by another worker.");
      if (task.status === "cancelled") {
        return { run, task, jobs: [], discarded: true };
      }
      const status = ["completed", "failed", "needs_user_action"].includes(body.status) ? body.status : "completed";
      task.status = status;
      task.reason = String(body.reason ?? "").slice(0, 500) || null;
      task.completedAt = status === "completed" || status === "failed" ? new Date().toISOString() : null;
      task.workerHeartbeatAt = new Date().toISOString();
      task.progress = {
        phase: status,
        message: status === "completed" ? "职位已上传，任务完成。" : status === "failed" ? "任务执行失败。" : "等待人工处理。",
        found: Array.isArray(body.jobs) ? body.jobs.length : 0,
        updatedAt: task.workerHeartbeatAt
      };
      if (status === "failed") run.counters[task.platform].failed += 1;
      // Persist partial discoveries even when the worker needs help or fails.
      // Retrying can create marked duplicates, but it must never silently lose jobs.
      const jobs = Array.isArray(body.jobs) && body.jobs.length
        ? mergeWorkerResultJobs(state, body.jobs, { run, task })
        : [];
      const autoReviewJobIds = prepareAutoReviewJobs(state, jobs);
      task.pipelineStats = {
        ...(task.pipelineStats || {}),
        aiQueued: autoReviewJobIds.length,
        completedAt: new Date().toISOString()
      };
      if (autoReviewJobIds.length) {
        task.progress = {
          phase: "ai_queued",
          message: `${autoReviewJobIds.length} job descriptions are queued for automatic AI review.`,
          found: jobs.length,
          updatedAt: new Date().toISOString()
        };
      }
      updateRunState(run);
      return { run, task, jobs, autoReviewJobIds };
    });
    enqueueAutoReviews(result.autoReviewJobIds || []);
    return sendJson(response, 200, {
      ...result,
      autoReviewQueued: result.autoReviewJobIds?.length || 0,
      autoReviewJobIds: undefined
    });
  }

  const retryRunTaskMatch = /^\/api\/runs\/([^/]+)\/tasks\/([^/]+)\/retry$/.exec(path);
  if (request.method === "POST" && retryRunTaskMatch) {
    const result = await storage.update((state) => {
      const run = state.runs.find((item) => item.id === retryRunTaskMatch[1]);
      const task = run?.tasks.find((item) => item.id === retryRunTaskMatch[2]);
      if (!run || !task) throw new Error("Run task was not found.");
      ensureRunCounterShape(run);
      if (["queued", "running"].includes(task.status)) throw new Error("This task is already queued or running.");
      task.attempt += 1;
      task.status = "queued";
      task.reason = null;
      task.workerId = null;
      task.workerHeartbeatAt = null;
      task.stopRequestedAt = null;
      task.progress = null;
      task.startedAt = null;
      task.completedAt = null;
      run.completedAt = null;
      updateRunState(run);
      return { run, task, launchUrl: workerLandingUrl(task.platform, run.id) };
    });
    return sendJson(response, 200, result);
  }

  const launchRunTaskMatch = /^\/api\/runs\/([^/]+)\/tasks\/([^/]+)\/launch$/.exec(path);
  if (request.method === "POST" && launchRunTaskMatch) {
    const result = await storage.update((state) => {
      const run = state.runs.find((item) => item.id === launchRunTaskMatch[1]);
      const task = run?.tasks.find((item) => item.id === launchRunTaskMatch[2]);
      if (!run || !task) throw new Error("Run task was not found.");
      ensureRunCounterShape(run);
      const nextInSequence = run.tasks.find((item) => ["queued", "running", "needs_user_action"].includes(item.status));
      if (run.settingsSnapshot.executionMode === "sequential" && nextInSequence?.id !== task.id) {
        throw new Error("An earlier task must finish before this worker can be opened.");
      }
      let recovered = false;
      if (task.status === "running") {
        if (!runTaskWorkerIsStale(task)) throw new Error("This task still has an active worker.");
        task.attempt += 1;
        task.status = "queued";
        task.reason = null;
        task.workerId = null;
        task.workerHeartbeatAt = null;
        task.stopRequestedAt = null;
        task.startedAt = null;
        task.completedAt = null;
        task.progress = { phase: "queued", message: "Worker 窗口已重新打开，等待领取任务。", updatedAt: new Date().toISOString() };
        run.completedAt = null;
        recovered = true;
      } else if (task.status !== "queued") {
        throw new Error("Only a queued or disconnected running task can reopen its worker.");
      }
      updateRunState(run);
      return { run, task, recovered, launchUrl: workerLandingUrl(task.platform, run.id) };
    });
    return sendJson(response, 200, result);
  }

  const runTaskResultsMatch = /^\/api\/runs\/([^/]+)\/tasks\/([^/]+)\/results$/.exec(path);
  if (request.method === "DELETE" && runTaskResultsMatch) {
    const result = await storage.update((state) => {
      const run = state.runs.find((item) => item.id === runTaskResultsMatch[1]);
      const index = run?.tasks.findIndex((item) => item.id === runTaskResultsMatch[2]) ?? -1;
      if (!run) throw new Error("Run was not found.");
      if (index < 0) throw new Error("Run task was not found.");
      const task = run.tasks[index];
      if (["queued", "running", "needs_user_action"].includes(task.status)) {
        throw new Error("An active task cannot be deleted from review statistics. Finish or remove it from the run queue first.");
      }
      const jobs = removeJobs(state, (job) => job.runId === run.id && jobBelongsToRunTask(job, task, run));
      const importBatchCount = state.importBatches
        .filter((batch) => batch.runId === run.id && batch.taskId === task.id).length;
      state.importBatches = state.importBatches
        .filter((batch) => batch.runId !== run.id || batch.taskId !== task.id);
      run.tasks.splice(index, 1);
      recalculateRunCounters(state, run);
      updateRunState(run);
      return { run, task, removed: { tasks: 1, jobs: jobs.length, importBatches: importBatchCount } };
    });
    return sendJson(response, 200, result);
  }

  const runTaskMatch = /^\/api\/runs\/([^/]+)\/tasks\/([^/]+)$/.exec(path);
  const stopRunTaskMatch = /^\/api\/runs\/([^/]+)\/tasks\/([^/]+)\/stop$/.exec(path);
  if (request.method === "POST" && stopRunTaskMatch) {
    const result = await storage.update((state) => {
      const run = state.runs.find((item) => item.id === stopRunTaskMatch[1]);
      const task = run?.tasks.find((item) => item.id === stopRunTaskMatch[2]);
      if (!run || !task) throw new Error("Run task was not found.");
      if (task.status !== "running") throw new Error("Only a running task can be stopped while keeping its results.");
      const now = new Date().toISOString();
      task.stopRequestedAt ||= now;
      task.progress = {
        ...(task.progress || {}),
        phase: "stopping",
        message: "已请求停止，等待 Worker 上传当前结果。",
        updatedAt: now
      };
      return { run, task, stopRequested: true };
    });
    return sendJson(response, 200, result);
  }

  if (request.method === "DELETE" && runTaskMatch) {
    const result = await storage.update((state) => {
      const run = state.runs.find((item) => item.id === runTaskMatch[1]);
      if (!run) throw new Error("Run was not found.");
      const index = run.tasks.findIndex((item) => item.id === runTaskMatch[2]);
      if (index < 0) throw new Error("Run task was not found.");
      const task = run.tasks[index];
      if (task.status === "running") {
        task.status = "cancelled";
        task.reason = "Cancelled by user; worker results will be discarded.";
        task.completedAt = new Date().toISOString();
        updateRunState(run);
        return { run, task, cancelled: true };
      }
      run.tasks.splice(index, 1);
      updateRunState(run);
      return { run, task, cancelled: false };
    });
    return sendJson(response, 200, result);
  }

  const clearRunQueueMatch = /^\/api\/runs\/([^/]+)\/tasks$/.exec(path);
  if (request.method === "DELETE" && clearRunQueueMatch) {
    const cleared = await storage.update((state) => {
      const run = state.runs.find((item) => item.id === clearRunQueueMatch[1]);
      if (!run) throw new Error("Run was not found.");
      let removed = 0;
      let cancelled = 0;
      run.tasks = run.tasks.filter((task) => {
        if (task.status === "running") {
          task.status = "cancelled";
          task.reason = "Cancelled by user; worker results will be discarded.";
          task.completedAt = new Date().toISOString();
          cancelled += 1;
          return true;
        }
        if (task.status !== "cancelled") removed += 1;
        return task.status === "cancelled";
      });
      updateRunState(run);
      return { run, removed, cancelled };
    });
    return sendJson(response, 200, { cleared });
  }

  const resumeTaskMatch = /^\/api\/tasks\/([^/]+)\/resume$/.exec(path);
  if (request.method === "POST" && resumeTaskMatch) {
    const task = await storage.update((state) => {
      const run = state.runs.find((item) => item.tasks.some((task) => task.id === resumeTaskMatch[1]));
      const task = run?.tasks.find((item) => item.id === resumeTaskMatch[1]);
      if (!task) throw new Error("Task was not found.");
      if (task.status !== "needs_user_action") throw new Error("Only a paused task can be resumed.");
      task.status = "queued";
      task.reason = null;
      task.workerId = null;
      task.stopRequestedAt = null;
      task.startedAt = null;
      task.completedAt = null;
      updateRunState(run);
      return { run, task, launchUrl: workerLandingUrl(task.platform, run.id) };
    });
    return sendJson(response, 200, task);
  }

  if (request.method === "POST" && path === "/api/jobs/import") {
    const body = await readJson(request);
    const result = await storage.update((state) => {
      const jobs = addJobsToState(state, body.jobs, { runId: body.runId || null, label: body.label || "manual import" });
      return { jobs, autoReviewJobIds: prepareAutoReviewJobs(state, jobs) };
    });
    enqueueAutoReviews(result.autoReviewJobIds);
    return sendJson(response, 201, { jobs: result.jobs, autoReviewQueued: result.autoReviewJobIds.length });
  }

  const viewedMatch = /^\/api\/jobs\/([^/]+)\/viewed$/.exec(path);
  if (request.method === "PUT" && viewedMatch) {
    const body = await readJson(request);
    const job = await storage.update((state) => {
      const job = state.jobs.find((item) => item.id === viewedMatch[1]);
      if (!job) throw new Error("Job was not found.");
      job.viewedAt = body.viewed === false ? null : new Date().toISOString();
      return job;
    });
    return sendJson(response, 200, { job });
  }

  const runTaskViewedMatch = /^\/api\/runs\/([^/]+)\/tasks\/([^/]+)\/viewed$/.exec(path);
  if (request.method === "PUT" && runTaskViewedMatch) {
    const result = await storage.update((state) => {
      const run = state.runs.find((item) => item.id === runTaskViewedMatch[1]);
      const task = run?.tasks.find((item) => item.id === runTaskViewedMatch[2]);
      if (!run || !task) throw new Error("Run task was not found.");
      if (["queued", "running", "needs_user_action"].includes(task.status)) {
        throw new Error("Finish the task before marking all of its jobs as viewed.");
      }
      const jobs = state.jobs.filter((job) => job.runId === run.id && jobBelongsToRunTask(job, task, run));
      const viewedAt = new Date().toISOString();
      let updated = 0;
      for (const job of jobs) {
        if (job.viewedAt) continue;
        job.viewedAt = viewedAt;
        updated += 1;
      }
      return { run, task, total: jobs.length, updated, viewedAt };
    });
    return sendJson(response, 200, result);
  }

  const feedbackMatch = /^\/api\/jobs\/([^/]+)\/feedback$/.exec(path);
  if (request.method === "PUT" && feedbackMatch) {
    const body = await readJson(request);
    const job = await storage.update((state) => {
      const job = state.jobs.find((item) => item.id === feedbackMatch[1]);
      if (!job) throw new Error("Job was not found.");
      const clearing = body.helpful === false || body.notHelpful === false || body.helpfulness === null;
      const feedback = clearing ? null : safeJobFeedback(body);
      const rejectedJob = job.screening?.category === "REJECTED" || job.screening?.titleClassification === "CLEAR_REJECT";
      const correctingRejection = feedback?.helpfulness === "REJECTION_INCORRECT"
        && rejectedJob;
      const confirmingRejection = feedback?.helpfulness === "HELPFUL"
        && feedback?.reason === "REJECTION_CORRECT"
        && rejectedJob;
      if (!clearing && !hasAiJdReview(job) && !rejectedJob) {
        throw new Error("Wait for the automatic AI JD review before rating whether its result was helpful.");
      }
      if (feedback?.helpfulness === "REJECTION_INCORRECT" && !correctingRejection) {
        throw new Error("Only a rejected job can be marked as an incorrect rejection.");
      }
      if (feedback?.reason === "REJECTION_CORRECT" && !confirmingRejection) {
        throw new Error("Only a rejected job can be marked as a correct rejection.");
      }
      job.feedback = feedback;
      if (feedback && !job.viewedAt) job.viewedAt = feedback.updatedAt;
      if (clearing || isPositiveJobFeedback(job)) removeJobFromPendingExclusionSuggestions(state, job.id);
      if (rejectedJob && isStrictExclusionFeedback(job)) addExclusionSuggestions(state, job, job.learningSignals);
      return job;
    });
    return sendJson(response, 200, { job });
  }

  const reflectionMatch = /^\/api\/runs\/([^/]+)\/reflection$/.exec(path);
  if (request.method === "POST" && reflectionMatch) {
    const result = await storage.update(async (state) => {
      const run = state.runs.find((item) => item.id === reflectionMatch[1]);
      if (!run) throw new Error("Run was not found.");
      if (!["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(run.state)) {
        throw new Error("Finish the run before completing its review reflection.");
      }
      const pendingAiReviews = state.jobs.filter((job) => job.runId === run.id
        && ["AI_QUEUED", "AI_REVIEWING"].includes(job.screening?.screeningStatus));
      if (pendingAiReviews.length) {
        throw new Error(`Wait for ${pendingAiReviews.length} automatic AI JD reviews to finish before completing the reflection.`);
      }
      ensureRunCounterShape(run);
      const runHelpful = state.jobs.filter((job) => job.runId === run.id && isPositiveJobFeedback(job));
      const runRejected = state.jobs.filter((job) => job.runId === run.id
        && isAiRoleRejectedSignal(job));
      const runLegacy = state.jobs.filter((job) => job.runId === run.id && isLegacyNegativeJobFeedback(job));
      const runEvidence = uniqueJobsById([...runHelpful, ...runRejected, ...runLegacy]);
      const previousReflection = state.reviewReflections.find((item) => item.runId === run.id) ?? null;
      if (!runEvidence.length && !previousReflection) throw new Error("Review at least one AI-screened job before completing the reflection.");

      const activeHelpful = state.jobs
        .filter(isPositiveJobFeedback)
        .sort((left, right) => String(right.feedback.updatedAt).localeCompare(String(left.feedback.updatedAt)))
        .slice(0, 120);
      const activeRejected = state.jobs
        .filter(isAiRoleRejectedSignal)
        .slice(0, 120);
      const activeLegacy = state.jobs
        .filter(isLegacyNegativeJobFeedback)
        .sort((left, right) => String(right.feedback.updatedAt).localeCompare(String(left.feedback.updatedAt)))
        .slice(0, 120);
      const helpfulFeedback = activeHelpful.map(feedbackForAi);
      const rejectedJobSignals = activeRejected.map(rejectedSignalForAi);
      const legacyNotHelpfulFeedback = activeLegacy.map(feedbackForAi);
      const profile = state.profiles.find((item) => item.id === state.activeProfileId)?.profile ?? null;
      const ai = aiStatus();
      const canUseAi = ai.configured && run.counters.ai.calls < ai.budget.maxAiCallsPerRun;
      let generated;
      let engine = "local-rules";
      let aiError = null;
      let usage = null;
      if (canUseAi) {
        run.counters.ai.calls += 1;
        try {
          const evaluated = await reflectOnJobFeedback({ helpfulFeedback, rejectedJobSignals, legacyNotHelpfulFeedback, previousModel: state.preferenceModel, profile });
          generated = evaluated.preferenceModel;
          usage = evaluated.usage;
          recordAiUsage(run, usage);
          engine = "ai";
        } catch (error) {
          aiError = error.message;
          generated = localPreferenceReflection({ helpfulJobs: activeHelpful, rejectedJobs: activeRejected, legacyNotHelpfulJobs: activeLegacy });
          engine = "local-rules-fallback";
        }
      } else {
        generated = localPreferenceReflection({ helpfulJobs: activeHelpful, rejectedJobs: activeRejected, legacyNotHelpfulJobs: activeLegacy });
        if (ai.configured) aiError = "AI call budget reached; local reflection used.";
      }
      const now = new Date().toISOString();
      const version = (Number(state.preferenceModel?.version) || 0) + 1;
      let preferenceModel = validatePreferenceModel(generated, {
        version,
        feedbackCount: activeHelpful.length + activeRejected.length + activeLegacy.length,
        positiveFeedbackCount: activeHelpful.length,
        rejectedSignalCount: activeRejected.length,
        sourceRunId: run.id,
        engine,
        updatedAt: now
      });
      preferenceModel = ensurePreferenceModelNegativeCoverage(preferenceModel, state.jobs);
      const reflection = {
        id: newId("reflection"),
        runId: run.id,
        version,
        createdAt: now,
        feedbackCount: runEvidence.length,
        positiveFeedbackCount: runHelpful.length,
        rejectedSignalCount: runRejected.length,
        totalActiveFeedback: activeHelpful.length + activeRejected.length + activeLegacy.length,
        feedbackJobIds: runEvidence.map((job) => job.id),
        feedbackFingerprint: feedbackFingerprint(runEvidence),
        engine,
        aiError,
        usage,
        modelSnapshot: preferenceModel
      };
      state.preferenceModel = preferenceModel;
      addReflectionExclusionSuggestions(state, [...activeRejected, ...activeLegacy], preferenceModel, run.id);
      state.reviewReflections.unshift(reflection);
      state.reviewReflections = state.reviewReflections.slice(0, 100);
      run.reviewReflectionId = reflection.id;
      run.reviewCompletedAt = now;
      run.counters.ai.reflections += 1;
      for (const job of runEvidence) {
        if (!job.feedback) continue;
        job.feedback.reflectedAt = now;
        job.feedback.reflectionId = reflection.id;
      }
      return { reflection, preferenceModel };
    });
    return sendJson(response, 201, result);
  }

  const reviewMatch = /^\/api\/jobs\/([^/]+)\/review$/.exec(path);
  if (request.method === "POST" && reviewMatch) {
    const body = await readJson(request);
    const job = await storage.update(async (state) => {
      const job = state.jobs.find((item) => item.id === reviewMatch[1]);
      if (!job) throw new Error("Job was not found.");
      if (body.description !== undefined) job.description = String(body.description).trim() || null;
      const profile = state.profiles.find((item) => item.id === state.activeProfileId);
      if (!profile) throw new Error("Activate a career profile before JD review.");
      if (!job.description) throw new Error("A complete job description is not available. Rerun its source task to fetch the JD first.");
      const run = job.runId ? state.runs.find((item) => item.id === job.runId) : null;
      const hasAi = aiStatus().configured;
      const aiBudgetAvailable = hasAi && canUseAiForRun(run);
      try {
        if (aiBudgetAvailable) {
          if (run) run.counters.ai.calls += 1;
          const evaluated = await evaluateJdWithAi(job, profile.profile, state.settings.thresholds, state.preferenceModel);
          job.screening = evaluated.screening;
          const reviewedAt = new Date().toISOString();
          const roleRejected = job.screening.category === "REJECTED" && job.screening.workRights?.assessment !== "INELIGIBLE";
          job.learningSignals = {
            targetKeywords: evaluated.preferenceSignals.targetKeywords,
            exclusionKeywords: roleRejected ? evaluated.preferenceSignals.exclusionKeywords : [],
            exclusionReason: roleRejected ? evaluated.preferenceSignals.exclusionReason : "",
            generatedAt: reviewedAt,
            engine: "ai"
          };
          if (roleRejected) addExclusionSuggestions(state, job, job.learningSignals);
          recordAiUsage(run, evaluated.usage);
        } else {
          job.screening = localJdScreen(job, profile.profile, state.settings.thresholds, state.preferenceModel);
          if (hasAi && run) {
            run.counters.ai.budgetSkipped += 1;
            job.screening.engine = "local-rules-budget-fallback";
            job.screening.concerns = [...job.screening.concerns, "AI daily budget reached; local screening used"];
          }
        }
      } catch (error) {
        job.screening = {
          ...job.screening,
          jdReviewed: false,
          screeningStatus: "AI_ERROR",
          engine: hasAi ? "ai-error" : "local-rules",
          reason: `JD screening failed: ${error.message}`,
          concerns: [...(job.screening?.concerns ?? []), "screening needs another attempt"]
        };
      }
      job.reviewedAt = new Date().toISOString();
      if (run) recalculateRunCounters(state, run);
      return job;
    });
    return sendJson(response, 200, { job });
  }

  const fetchJdMatch = /^\/api\/jobs\/([^/]+)\/fetch-jd$/.exec(path);
  if (request.method === "POST" && path === "/api/jobs/retry-failed-jd") {
    const body = await readJson(request);
    const requestedIds = [...new Set((Array.isArray(body.jobIds) ? body.jobIds : [])
      .map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 100);
    if (!requestedIds.length) throw new Error("Choose at least one failed JD to retry.");
    const currentState = await storage.ensureState();
    const eligibleIds = requestedIds.filter((id) => retryableFailedJd(
      currentState.jobs.find((job) => job.id === id)
    ));
    if (!eligibleIds.length) throw new Error("None of the selected jobs still need JD retrieval.");
    const batch = {
      id: newId("jd_retry"),
      jobIds: eligibleIds,
      cursor: 0,
      completed: 0,
      currentJobId: null,
      createdAt: new Date().toISOString()
    };
    jdRetryBatches.set(batch.id, batch);
    const first = await advanceJdRetryBatch(batch.id);
    return sendJson(response, 201, first);
  }

  if (request.method === "POST" && path === "/api/jobs/retry-failed-ai") {
    const body = await readJson(request);
    const requestedIds = [...new Set((Array.isArray(body.jobIds) ? body.jobIds : [])
      .map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 100);
    if (!requestedIds.length) throw new Error("Choose at least one failed AI review to retry.");
    if (!aiStatus().configured) throw new Error("Configure AI before retrying failed reviews.");
    const result = await storage.update((state) => {
      if (!state.profiles.find((profile) => profile.id === state.activeProfileId)) {
        throw new Error("Activate a career profile before retrying failed reviews.");
      }
      const queuedAt = new Date().toISOString();
      const jobIds = requestedIds.filter((id) => retryableFailedAiReview(
        state.jobs.find((job) => job.id === id)
      ));
      for (const id of jobIds) {
        const job = state.jobs.find((item) => item.id === id);
        job.screening = { ...job.screening, screeningStatus: "AI_QUEUED", engine: "ai-pending" };
        job.aiReview = {
          status: "queued",
          queuedAt,
          retryRequested: true,
          previousError: job.aiReview?.reason || job.screening?.reason || null
        };
      }
      return { jobIds };
    });
    if (!result.jobIds.length) throw new Error("None of the selected jobs still have a retryable AI review failure.");
    enqueueAutoReviews(result.jobIds);
    return sendJson(response, 202, { queued: result.jobIds.length, jobIds: result.jobIds });
  }

  if (request.method === "POST" && fetchJdMatch) {
    const result = await storage.update((state) => {
      const job = state.jobs.find((item) => item.id === fetchJdMatch[1]);
      if (!job) throw new Error("Job was not found.");
      if (isRejectedBeforeJd(job)) throw new Error("This job was explicitly rejected by its title and does not need JD retrieval.");
      const launchUrl = buildOnDemandJdUrl(job);
      markJobJdFetching(job);
      return { job, launchUrl };
    });
    return sendJson(response, 200, result);
  }

  return apiError(response, 404, "API route not found.");
}

async function serveStatic(response, pathname, directory = publicDirectory) {
  const requested = pathname === "/" && directory === publicDirectory ? "index.html" : pathname.replace(/^\/+/, "");
  const baseDirectory = resolve(directory);
  const filePath = resolve(baseDirectory, requested);
  if (!filePath.startsWith(`${baseDirectory}${sep}`) && filePath !== join(baseDirectory, "index.html")) {
    return apiError(response, 403, "Invalid path.");
  }
  try {
    const extension = extname(filePath).toLowerCase();
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[extension] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") return apiError(response, 404, "Page not found.");
    throw error;
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);
    const workerInstallMatch = /^\/workers\/install\/(linkedin|indeed|seek)-agent-worker-v[\d.]+\.user\.js$/.exec(url.pathname);
    if (workerInstallMatch) {
      const platform = workerInstallMatch[1];
      return await serveStatic(response, `${platform}/${platform}-agent-worker.user.js`, workerDirectory);
    }
    if (url.pathname.startsWith("/workers/")) return await serveStatic(response, url.pathname.slice("/workers/".length), workerDirectory);
    return await serveStatic(response, url.pathname);
  } catch (error) {
    console.error(error);
    return apiError(response, 400, error.message || "Request failed.");
  }
});

const port = Number(process.env.PORT || 4317);
server.listen(port, "127.0.0.1", () => {
  console.log(`Personal AI Job Agent running at http://127.0.0.1:${port}`);
  void resumeAutoReviews().catch((error) => console.error("Could not resume automatic AI reviews", error));
});
