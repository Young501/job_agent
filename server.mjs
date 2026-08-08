import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, join, resolve, sep } from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { aiStatus, evaluateJdWithAi, generateProfile } from "./src/ai.mjs";
import {
  localJdScreen,
  normalizeJob,
  strongSourceKey,
  validateProfileDraft
} from "./src/screening.mjs";
import { createStorage, newId } from "./src/storage.mjs";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL(".", import.meta.url));
const publicDirectory = join(root, "public");
const dataDirectory = process.env.JOB_AGENT_DATA_DIRECTORY
  ? resolve(process.env.JOB_AGENT_DATA_DIRECTORY)
  : join(root, "data");
const uploadDirectory = join(dataDirectory, "uploads");
const defaultSettings = JSON.parse(await readFile(join(root, "config", "job-search-routine.json"), "utf8"));

await loadDotEnv(join(root, ".env"));
const storage = createStorage({ dataDirectory, defaultSettings });
await storage.ensureState();

const allowedPlatforms = new Set(["linkedin", "indeed", "seek"]);
const maxBodyBytes = 7 * 1024 * 1024;
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
  return safe;
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
    const python = process.env.JOB_AGENT_PYTHON_PATH || "python";
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
  if (![thresholds.strongMatch, thresholds.goodMatch, thresholds.maybe, thresholds.lowMatch]
    .every((value) => Number.isFinite(value) && value >= 0 && value <= 100)
    || !(thresholds.strongMatch >= thresholds.goodMatch && thresholds.goodMatch >= thresholds.maybe && thresholds.maybe >= thresholds.lowMatch)) {
    throw new Error("Match thresholds must be descending values between 0 and 100.");
  }
  return {
    enabled: Boolean(input.enabled),
    platforms: [...new Set((Array.isArray(input.platforms) ? input.platforms : [])
      .map((platform) => String(platform).toLowerCase())
      .filter((platform) => allowedPlatforms.has(platform)))],
    locations,
    searches,
    thresholds
  };
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

function addJobsToState(state, rawJobs, { runId = null, label = "manual import" } = {}) {
  if (!Array.isArray(rawJobs) || !rawJobs.length) throw new Error("Provide at least one job.");
  if (rawJobs.length > 250) throw new Error("Import at most 250 jobs at a time.");
  const run = runId ? state.runs.find((item) => item.id === runId) : null;
  if (runId && !run) throw new Error("Run was not found.");
  if (run) ensureRunCounterShape(run);
  const existingByKey = new Map(state.jobs.map((job) => [strongSourceKey(job), job]).filter(([key]) => key));
  const jobs = [];

  for (const rawJob of rawJobs) {
    const candidate = normalizeJob(rawJob, { thresholds: state.settings.thresholds, runId });
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
    importedAt: new Date().toISOString(),
    count: jobs.length
  });
  state.importBatches = state.importBatches.slice(0, 100);
  return jobs;
}

function createRun(settings) {
  const searches = settings.searches.filter((search) => search.enabled).sort((a, b) => b.priority - a.priority);
  const locations = settings.locations.filter((location) => location.enabled);
  const tasks = [];
  for (const search of searches) {
    for (const location of locations) {
      for (const platform of settings.platforms) {
        tasks.push({
          id: newId("task"),
          platform,
          searchId: search.id,
          keyword: search.keyword,
          location: location.name,
          priority: search.priority,
          status: "queued",
          reason: null,
          startedAt: null,
          completedAt: null
        });
      }
    }
  }
  if (!tasks.length) throw new Error("Enable at least one platform, location, and search before starting a run.");
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

async function handleApi(request, response, url) {
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/health") {
    return sendJson(response, 200, { ok: true, ai: aiStatus() });
  }
  if (request.method === "GET" && path === "/api/bootstrap") {
    return sendJson(response, 200, buildBootstrap(await storage.ensureState()));
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
    const generated = await generateProfile(resumeText, body.sourceName || "resume");
    const profile = await storage.update((state) => {
      const record = {
        id: newId("profile"),
        version: state.profiles.length + 1,
        status: "draft",
        createdAt: new Date().toISOString(),
        activatedAt: null,
        sourceName: String(body.sourceName || "resume").slice(0, 120),
        sourceText: resumeText,
        sourceTextLength: resumeText.length,
        engine: generated.engine,
        aiError: generated.aiError,
        aiUsage: generated.usage,
        profile: generated.profile
      };
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
    const profile = await storage.update((state) => {
      const record = state.profiles.find((item) => item.id === activateMatch[1]);
      if (!record) throw new Error("Profile was not found.");
      state.activeProfileId = record.id;
      record.status = "approved";
      record.activatedAt = new Date().toISOString();
      return record;
    });
    return sendJson(response, 200, { profile: publicProfile(profile) });
  }

  if (request.method === "POST" && path === "/api/runs") {
    const run = await storage.update((state) => {
      const run = createRun(state.settings);
      state.runs.unshift(run);
      state.runs = state.runs.slice(0, 60);
      return run;
    });
    return sendJson(response, 201, { run });
  }
  if (request.method === "GET" && path === "/api/worker/next") {
    const runId = url.searchParams.get("runId");
    const task = await storage.update((state) => {
      const run = runId
        ? state.runs.find((item) => item.id === runId)
        : state.runs.find((item) => item.state === "WAITING_FOR_WORKERS");
      if (!run) return { run: null, task: null };
      const next = run.tasks.find((item) => item.status === "queued");
      if (!next) {
        updateRunState(run);
        return { run, task: null };
      }
      next.status = "running";
      next.startedAt = new Date().toISOString();
      return { run, task: next };
    });
    return sendJson(response, 200, task);
  }
  if (request.method === "POST" && path === "/api/worker/result") {
    const body = await readJson(request);
    const result = await storage.update((state) => {
      const run = state.runs.find((item) => item.id === body.runId);
      if (!run) throw new Error("Run was not found.");
      const task = run.tasks.find((item) => item.id === body.taskId);
      if (!task) throw new Error("Task was not found.");
      const status = ["completed", "failed", "needs_user_action"].includes(body.status) ? body.status : "completed";
      task.status = status;
      task.reason = String(body.reason ?? "").slice(0, 500) || null;
      task.completedAt = status === "completed" || status === "failed" ? new Date().toISOString() : null;
      if (status === "failed") run.counters[task.platform].failed += 1;
      const jobs = status === "completed" && Array.isArray(body.jobs) && body.jobs.length
        ? addJobsToState(state, body.jobs, { runId: run.id, label: `${task.platform} worker result` })
        : [];
      updateRunState(run);
      return { run, task, jobs };
    });
    return sendJson(response, 200, result);
  }

  if (request.method === "POST" && path === "/api/jobs/import") {
    const body = await readJson(request);
    const jobs = await storage.update((state) =>
      addJobsToState(state, body.jobs, { runId: body.runId || null, label: body.label || "manual import" }));
    return sendJson(response, 201, { jobs });
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
          const evaluated = await evaluateJdWithAi(job, profile.profile, state.settings.thresholds);
          job.screening = evaluated.screening;
          recordAiUsage(run, evaluated.usage);
        } else {
          job.screening = localJdScreen(job, profile.profile, state.settings.thresholds);
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

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = resolve(publicDirectory, requested);
  if (!filePath.startsWith(`${resolve(publicDirectory)}${sep}`) && filePath !== join(publicDirectory, "index.html")) {
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
