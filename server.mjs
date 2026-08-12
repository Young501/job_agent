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
  configureAi,
  evaluateJdWithAi,
  generateProfile,
  reflectOnJobFeedback,
  testAiConnection
} from "./src/ai.mjs";
import {
  localJdScreen,
  normalizeJob,
  strongSourceKey,
  validateProfileDraft
} from "./src/screening.mjs";
import { localPreferenceReflection, validatePreferenceModel } from "./src/learning.mjs";
import { normalizeKeywordAlternatives } from "./src/task-keywords.mjs";
import { createStorage, newId } from "./src/storage.mjs";

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
await storage.ensureState();
await storage.update((state) => {
  state.settings = safeSettings(state.settings);
  for (const record of state.profiles) record.profile = validateProfileDraft(record.profile);
  if (state.preferenceModel) state.preferenceModel = validatePreferenceModel(state.preferenceModel);
  migrateKeywordAlternatives(state);
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

const feedbackReasons = new Set(["CLASSIFICATION_WRONG", "NOT_RELEVANT"]);

function safeJobFeedback(input) {
  if (input?.notHelpful === false || input?.helpfulness === null) return null;
  const reason = feedbackReasons.has(String(input?.reason ?? "")) ? String(input.reason) : null;
  return {
    helpfulness: "NOT_HELPFUL",
    reason,
    note: String(input?.note ?? "").trim().slice(0, 500) || null,
    updatedAt: new Date().toISOString(),
    reflectedAt: null,
    reflectionId: null
  };
}

function feedbackFingerprint(jobs) {
  const source = jobs
    .map((job) => `${job.id}:${job.feedback?.updatedAt ?? ""}:${job.feedback?.reason ?? ""}:${job.feedback?.note ?? ""}`)
    .sort()
    .join("|");
  return createHash("sha256").update(source).digest("hex");
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
    feedbackReason: job.feedback?.reason,
    userNote: job.feedback?.note
  };
}

function safeTaskCategoryInput(input, existing = null) {
  const name = String(input.name ?? "").trim().slice(0, 80);
  const incomingTasks = Array.isArray(input.tasks) ? input.tasks.slice(0, 80) : [];
  if (!name) throw new Error("Enter a category name.");
  if (!incomingTasks.length) throw new Error("Add at least one task to the category.");
  const existingTasks = new Map((existing?.tasks ?? []).map((task) => [task.id, task]));
  const usedIds = new Set();
  const tasks = incomingTasks.map((task) => {
    const taskInput = safeRoutineTaskInput(task);
    const requestedId = String(task.id ?? "");
    const previous = existingTasks.get(requestedId);
    const id = previous && !usedIds.has(requestedId) ? requestedId : newId("category_task");
    usedIds.add(id);
    return {
      id,
      ...taskInput,
      validationId: previous && sameRoutineTask(previous, taskInput) ? previous.validationId ?? null : null
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
    state.validations.find((record) => record.categoryId === category.id && record.categoryTaskId === task.id)
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
  const existingByKey = new Map(state.jobs.map((job) => [strongSourceKey(job), job]).filter(([key]) => key));
  const jobs = [];

  for (const rawJob of rawJobs) {
    const candidate = normalizeJob(task ? {
      ...rawJob,
      runTaskId: task.id,
      routineTaskId: task.routineTaskId,
      searchKeyword: task.keyword,
      searchLocation: task.location,
      searchPostedWithinDays: task.postedWithinDays
    } : rawJob, { thresholds: state.settings.thresholds, runId, preferenceModel: state.preferenceModel });
    const key = strongSourceKey(candidate);
    const existing = key ? existingByKey.get(key) : null;
    if (existing) candidate.duplicateOf = existing.id;
    if (key) existingByKey.set(key, candidate);
    state.jobs.push(candidate);
    jobs.push(candidate);
    if (run) {
      const counters = run.counters[candidate.source];
      if (counters) {
        if (candidate.duplicateOf) counters.repeatedImports += 1;
        else counters.newJobs += 1;
      }
      recordScreeningCounters(run, candidate.screening);
    }
  }

  state.importBatches.unshift({
    id: newId("import"),
    label: String(label).slice(0, 120),
    runId,
    taskId: task?.id ?? null,
    importedAt: new Date().toISOString(),
    count: jobs.length
  });
  state.importBatches = state.importBatches.slice(0, 100);
  return jobs;
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
  const removedFeedback = removedJobs.some((job) => job.feedback?.helpfulness === "NOT_HELPFUL");
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
  const activeFeedback = state.jobs
    .filter((job) => job.feedback?.helpfulness === "NOT_HELPFUL")
    .sort((left, right) => String(right.feedback.updatedAt).localeCompare(String(left.feedback.updatedAt)))
    .slice(0, 120);
  if (!activeFeedback.length) {
    state.preferenceModel = null;
    return;
  }
  const now = new Date().toISOString();
  state.preferenceModel = validatePreferenceModel(localPreferenceReflection(activeFeedback), {
    version: (Number(state.preferenceModel?.version) || 0) + 1,
    feedbackCount: activeFeedback.length,
    sourceRunId: null,
    engine: "local-rules-after-deletion",
    updatedAt: now
  });
}

function removeJobs(state, predicate) {
  const removedJobs = state.jobs.filter(predicate);
  if (!removedJobs.length) return [];
  const removedIds = new Set(removedJobs.map((job) => job.id));
  state.jobs = state.jobs.filter((job) => !removedIds.has(job.id));
  for (const job of state.jobs) {
    if (removedIds.has(job.duplicateOf)) job.duplicateOf = null;
  }
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
    attempt: 1,
    status: "queued",
    reason: null,
    startedAt: null,
    completedAt: null,
    workerId: null,
    workerHeartbeatAt: null,
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
  if (request.method === "PUT" && path === "/api/ai-config") {
    const body = await readJson(request);
    return sendJson(response, 200, { ai: await saveAiConfig(mergedAiConfig(body)) });
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
        preferenceModel: state.preferenceModel ? 1 : 0
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
    await storage.update((state) => { state.settings = settings; });
    return sendJson(response, 200, { settings });
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
    const input = safeTaskCategoryInput(body);
    const category = await storage.update((state) => {
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
      const input = safeTaskCategoryInput(body, record);
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
      if (run.settingsSnapshot.executionMode === "sequential" && nextInSequence?.platform !== platform) {
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
        updatedAt: now
      };
      return { run, task, discarded: false };
    });
    return sendJson(response, 200, result);
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
        ? addJobsToState(state, body.jobs, { runId: run.id, label: `${task.platform} worker result`, task })
        : [];
      updateRunState(run);
      return { run, task, jobs };
    });
    return sendJson(response, 200, result);
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
      task.progress = null;
      task.startedAt = null;
      task.completedAt = null;
      run.completedAt = null;
      updateRunState(run);
      return { run, task, launchUrl: workerLandingUrl(task.platform, run.id) };
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
      task.startedAt = null;
      task.completedAt = null;
      updateRunState(run);
      return { run, task };
    });
    return sendJson(response, 200, task);
  }

  if (request.method === "POST" && path === "/api/jobs/import") {
    const body = await readJson(request);
    const jobs = await storage.update((state) =>
      addJobsToState(state, body.jobs, { runId: body.runId || null, label: body.label || "manual import" }));
    return sendJson(response, 201, { jobs });
  }

  const feedbackMatch = /^\/api\/jobs\/([^/]+)\/feedback$/.exec(path);
  if (request.method === "PUT" && feedbackMatch) {
    const body = await readJson(request);
    const job = await storage.update((state) => {
      const job = state.jobs.find((item) => item.id === feedbackMatch[1]);
      if (!job) throw new Error("Job was not found.");
      job.feedback = safeJobFeedback(body);
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
      ensureRunCounterShape(run);
      const runFeedback = state.jobs.filter((job) => job.runId === run.id && job.feedback?.helpfulness === "NOT_HELPFUL");
      const previousReflection = state.reviewReflections.find((item) => item.runId === run.id) ?? null;
      if (!runFeedback.length && !previousReflection) throw new Error("Mark at least one job as not helpful before reflecting.");

      const activeFeedback = state.jobs
        .filter((job) => job.feedback?.helpfulness === "NOT_HELPFUL")
        .sort((left, right) => String(right.feedback.updatedAt).localeCompare(String(left.feedback.updatedAt)))
        .slice(0, 120);
      const feedback = activeFeedback.map(feedbackForAi);
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
          const evaluated = await reflectOnJobFeedback({ feedback, previousModel: state.preferenceModel, profile });
          generated = evaluated.preferenceModel;
          usage = evaluated.usage;
          recordAiUsage(run, usage);
          engine = "ai";
        } catch (error) {
          aiError = error.message;
          generated = localPreferenceReflection(activeFeedback);
          engine = "local-rules-fallback";
        }
      } else {
        generated = localPreferenceReflection(activeFeedback);
        if (ai.configured) aiError = "AI call budget reached; local reflection used.";
      }
      const now = new Date().toISOString();
      const version = (Number(state.preferenceModel?.version) || 0) + 1;
      const preferenceModel = validatePreferenceModel(generated, {
        version,
        feedbackCount: activeFeedback.length,
        sourceRunId: run.id,
        engine,
        updatedAt: now
      });
      const reflection = {
        id: newId("reflection"),
        runId: run.id,
        version,
        createdAt: now,
        feedbackCount: runFeedback.length,
        totalActiveFeedback: activeFeedback.length,
        feedbackJobIds: runFeedback.map((job) => job.id),
        feedbackFingerprint: feedbackFingerprint(runFeedback),
        engine,
        aiError,
        usage,
        modelSnapshot: preferenceModel
      };
      state.preferenceModel = preferenceModel;
      state.reviewReflections.unshift(reflection);
      state.reviewReflections = state.reviewReflections.slice(0, 100);
      run.reviewReflectionId = reflection.id;
      run.reviewCompletedAt = now;
      run.counters.ai.reflections += 1;
      for (const job of runFeedback) {
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
      if (!job.description) throw new Error("Paste the job description before reviewing it.");
      const run = job.runId ? state.runs.find((item) => item.id === job.runId) : null;
      const hasAi = aiStatus().configured;
      const aiBudgetAvailable = hasAi && canUseAiForRun(run);
      try {
        if (aiBudgetAvailable) {
          if (run) run.counters.ai.calls += 1;
          const evaluated = await evaluateJdWithAi(job, profile.profile, state.settings.thresholds, state.preferenceModel);
          job.screening = evaluated.screening;
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
          jdReviewed: true,
          screeningStatus: "AI_ERROR",
          engine: hasAi ? "ai" : "local-rules",
          reason: `JD screening failed: ${error.message}`,
          concerns: [...(job.screening?.concerns ?? []), "screening needs another attempt"]
        };
      }
      job.reviewedAt = new Date().toISOString();
      if (run) {
        run.counters.ai.jdReviewed += 1;
        if (job.screening.screeningStatus === "AI_ERROR") run.counters.ai.errors += 1;
      }
      return job;
    });
    return sendJson(response, 200, { job });
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
});
