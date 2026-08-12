const validViews = new Set(["overview", "jobs", "routine", "profile", "settings", "setup"]);

function initialView() {
  const requested = new URL(window.location.href).searchParams.get("view");
  if (validViews.has(requested)) return requested;
  try {
    const saved = window.sessionStorage.getItem("job-agent:view");
    if (validViews.has(saved)) return saved;
  } catch {}
  return "overview";
}

const state = {
  data: null,
  view: initialView(),
  profileId: null,
  jobId: null,
  feedbackJobId: null,
  resumeSource: "",
  editingValidationId: null,
  notifiedTaskIds: new Set(),
  jobsPane: "current",
  historyRunId: "",
  routinePane: "plan",
  selectedCategoryIds: new Set(),
  expandedCategoryIds: new Set(),
  editingCategoryId: null,
  profilePane: "editor",
  workerScripts: {},
  workerScriptsLoading: false,
  aiConfigDirty: false,
  historyReset: { running: false, completed: new Set(), timeout: null, window: null },
  profilePointerDrag: null,
  suppressProfileChipClick: false
};

const names = { linkedin: "LinkedIn", indeed: "Indeed", seek: "SEEK", manual: "手动" };
const postedWithinLabels = { 0: "不限", 1: "过去 24 小时", 3: "过去 3 天", 7: "过去 7 天", 14: "过去 14 天", 30: "过去 30 天" };
const validationStatusLabels = {
  WAITING_FOR_WORKER: "等待预检",
  VALID: "已验证",
  FAILED: "预检失败",
  NEEDS_USER_ACTION: "需要人工处理"
};
const feedbackReasonLabels = {
  CLASSIFICATION_WRONG: "分类错了",
  NOT_RELEVANT: "与我无关"
};
const externalGptProfilePrompt = [
  "You are a meticulous career strategist. The user will attach or paste their resume in this chat.",
  "Create an evidence-based candidate profile for an early-career job-search agent.",
  "Use only facts explicitly supported by the resume. Do not invent years of experience, degrees, work rights, locations, salary expectations, or preferences.",
  "When something is unclear, omit it instead of guessing. Use many concise, specific list items so the user can curate them later.",
  "Aim for 4-8 target roles, 6-12 focus areas, 15-30 supported skills, 1-6 complete education records, and 10-20 additional candidateItems.",
  "Keep each education qualification, institution, and date range together in one string when those facts are available. Never split them into separate items.",
  "Each candidateItems entry must be an object with value and suggestedSection. suggestedSection must be one of targetRoles, focusAreas, skills, education, locations, workTypes, or exclusions.",
  "Return JSON only, with exactly this shape:",
  '{"name":"...","headline":"...","summary":"...","targetRoles":["..."],"focusAreas":["..."],"skills":["..."],"education":["Degree | Institution | 2022-2024"],"preferences":{"locations":["..."],"workTypes":["..."],"exclusions":["..."]},"candidateItems":[{"value":"...","suggestedSection":"skills"}]}'
].join("\n\n");
const pages = {
  overview: ["今日工作区", "职位概览"],
  jobs: ["组合清单", "职位审阅"],
  routine: ["例行搜索", "每日任务"],
  profile: ["候选人资料", "职业画像"],
  settings: ["共用配置", "搜索设置"],
  setup: ["浏览器连接", "安装设置"]
};
const workerDefinitions = [
  { id: "linkedin", name: "LinkedIn", version: "v2.2.2", domain: "linkedin.com/jobs", path: "/workers/linkedin/linkedin-agent-worker.user.js" },
  { id: "indeed", name: "Indeed", version: "v2.2.2", domain: "au.indeed.com/jobs", path: "/workers/indeed/indeed-agent-worker.user.js" },
  { id: "seek", name: "SEEK", version: "v2.2.2", domain: "seek.com.au/jobs", path: "/workers/seek/seek-agent-worker.user.js" }
];
const profileTagSections = [
  { key: "candidateItems", label: "候选池", icon: "inbox" },
  { key: "targetRoles", label: "目标职位", icon: "briefcase-business" },
  { key: "focusAreas", label: "方向", icon: "compass" },
  { key: "skills", label: "技能", icon: "code-2" },
  { key: "education", label: "教育与阶段", icon: "graduation-cap" },
  { key: "locations", label: "地点", icon: "map-pin" },
  { key: "workTypes", label: "工作方式", icon: "clock-3" },
  { key: "exclusions", label: "排除项", icon: "ban" }
];
const formalProfileTagSections = profileTagSections.slice(1);
const formalProfileTagKeys = new Set(formalProfileTagSections.map((definition) => definition.key));

const el = (selector) => document.querySelector(selector);
const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const listText = (value) => Array.isArray(value) ? value.join(", ") : "";
const nice = (value) => String(value || "-").replaceAll("_", " ");
const dateTime = (value) => value ? new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "-";
const profileEngineLabel = (engine) => ({
  ai: "AI 合成",
  "ai-with-external": "AI + 外部 GPT",
  "external-gpt": "外部 GPT",
  "local-rules": "本地规则"
}[engine] || "画像草稿");

function persistView() {
  if (!validViews.has(state.view)) state.view = "overview";
  try { window.sessionStorage.setItem("job-agent:view", state.view); } catch {}
  const url = new URL(window.location.href);
  url.searchParams.set("view", state.view);
  window.history.replaceState(null, "", url.href);
}

function validationPresentation(validation) {
  const status = validation.status;
  const age = Date.now() - new Date(validation.updatedAt || validation.createdAt || 0).getTime();
  if (status !== "WAITING_FOR_WORKER") {
    return { label: validationStatusLabels[status] || status, reason: validation.reason || "-" };
  }
  if (validation.workerStartedAt) {
    return age > 90_000
      ? { label: "预检超时", reason: "Worker 未在 90 秒内回传结果，请重新预检。" }
      : { label: "预检进行中", reason: "浏览器 Worker 正在填写搜索条件并验证时间范围。" };
  }
  if (!validation.preflightQueuedAt) {
    return { label: "待统一预检", reason: "任务已保存；点击“统一预检”后才会打开平台页面。" };
  }
  return age > 16_000
    ? { label: "Worker 未响应", reason: "本轮预检尚未被 Worker 领取。请确认对应 Worker 已安装并启用，随后再次点击统一预检。" }
    : { label: validationStatusLabels[status], reason: "已加入本轮统一预检，等待浏览器 Worker 领取" };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body instanceof FormData ? undefined : { "content-type": "application/json" },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "请求失败。");
  return body;
}

function toast(message, kind = "success") {
  const target = el("#toast");
  target.textContent = message;
  target.dataset.kind = kind;
  target.classList.add("is-visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => target.classList.remove("is-visible"), 3600);
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
}

function badge(value, type = "") {
  return '<span class="badge ' + type + '">' + escapeHtml(nice(value)) + "</span>";
}

function aiReviewBadge(job) {
  return /^ai(?:$|-)/i.test(job.screening?.engine || "")
    ? '<span class="badge ai-review-badge" title="此职位的 JD 已经过 AI 审阅"><i data-lucide="sparkles"></i>AI 审阅</span>'
    : "";
}

function feedbackBadge(job) {
  if (job.feedback?.helpfulness !== "NOT_HELPFUL") return "";
  const reason = feedbackReasonLabels[job.feedback.reason];
  return '<span class="feedback-badge"><i data-lucide="thumbs-down"></i>没帮助' + (reason ? " · " + escapeHtml(reason) : "") + "</span>";
}

function activeProfile() {
  return state.data.activeProfile || null;
}

function selectedProfile() {
  return state.data.profiles.find((profile) => profile.id === state.profileId) || null;
}

function currentRun() {
  return state.data.runs[0] || null;
}

function currentRunJobs() {
  const run = currentRun();
  return run ? state.data.jobs.filter((job) => job.runId === run.id) : [];
}

function historicalJobs() {
  const run = currentRun();
  return state.data.jobs.filter((job) => !run || job.runId !== run.id);
}

function runForJob(job) {
  return state.data.runs.find((run) => run.id === job.runId) || null;
}

function jobsInSelectedPane() {
  if (state.jobsPane === "current") return currentRunJobs();
  const jobs = historicalJobs();
  if (!state.historyRunId) return jobs;
  if (state.historyRunId === "__unassigned") return jobs.filter((job) => !runForJob(job));
  return jobs.filter((job) => job.runId === state.historyRunId);
}

function screeningBucket(job) {
  const screening = job.screening || {};
  if (screening.category === "REJECTED" || screening.titleClassification === "CLEAR_REJECT") return "rejected";
  if (["NEEDS_JD_REVIEW", "AI_ERROR"].includes(screening.screeningStatus) || screening.category === "LOW_MATCH") return "pending";
  if (["STRONG_MATCH", "GOOD_MATCH", "MAYBE"].includes(screening.category)) return "selected";
  return "pending";
}

function matchingRunTask(run, job) {
  if (job.runTaskId) return run.tasks.find((task) => task.id === job.runTaskId) || null;
  const normalized = (value) => String(value || "").trim().toLowerCase();
  const candidates = run.tasks.filter((task) => task.platform === job.source
    && normalized(task.keyword) === normalized(job.searchKeyword)
    && normalized(task.location) === normalized(job.searchLocation)
    && (job.searchPostedWithinDays === null || job.searchPostedWithinDays === undefined
      || Number(task.postedWithinDays) === Number(job.searchPostedWithinDays)));
  return candidates.length === 1 ? candidates[0] : null;
}

function jobStats(jobs) {
  const counts = { entered: jobs.length, selected: 0, pending: 0, rejected: 0 };
  for (const job of jobs) counts[screeningBucket(job)] += 1;
  return counts;
}

function renderCurrentRunStats() {
  const run = currentRun();
  const jobs = currentRunJobs();
  const total = jobStats(jobs);
  el("#job-run-stats-total").textContent = run
    ? `共 ${total.entered} 个职位 · 选中 ${total.selected} · 待定 ${total.pending} · 不符合 ${total.rejected}`
    : "尚未运行";
  if (!run) {
    el("#job-run-stats-body").innerHTML = '<tr><td colspan="7" class="empty-cell">开始每日任务后，这里会按平台和搜索条件显示统计。</td></tr>';
    return;
  }

  const jobsByTask = new Map(run.tasks.map((task) => [task.id, []]));
  const unassignedByPlatform = new Map();
  for (const job of jobs) {
    const task = matchingRunTask(run, job);
    if (task) jobsByTask.get(task.id).push(job);
    else {
      const platform = job.source || "manual";
      if (!unassignedByPlatform.has(platform)) unassignedByPlatform.set(platform, []);
      unassignedByPlatform.get(platform).push(job);
    }
  }

  const platforms = ["linkedin", "indeed", "seek", "manual"]
    .filter((platform) => run.tasks.some((task) => task.platform === platform) || unassignedByPlatform.has(platform));
  const rows = [];
  for (const platform of platforms) {
    const tasks = run.tasks.filter((task) => task.platform === platform);
    const platformJobs = [...tasks.flatMap((task) => jobsByTask.get(task.id) || []), ...(unassignedByPlatform.get(platform) || [])];
    const platformStats = jobStats(platformJobs);
    rows.push('<tr class="job-stats-platform-row"><th colspan="7"><span>' + escapeHtml(names[platform] || platform) + '</span><small>进入 ' + platformStats.entered + ' · 选中 ' + platformStats.selected + ' · 待定 ' + platformStats.pending + ' · 不符合 ' + platformStats.rejected + "</small></th></tr>");
    for (const task of tasks) {
      const stats = jobStats(jobsByTask.get(task.id) || []);
      rows.push("<tr>"
        + '<td><strong>' + escapeHtml(task.keyword) + '</strong><small>' + escapeHtml(task.location) + "</small></td>"
        + "<td>" + escapeHtml(postedWithinLabels[Number(task.postedWithinDays)] || "不限") + "</td>"
        + "<td>" + badge(task.status, "status-badge") + "</td>"
        + '<td class="job-stat-number">' + stats.entered + "</td>"
        + '<td class="job-stat-number stat-selected">' + stats.selected + "</td>"
        + '<td class="job-stat-number stat-pending">' + stats.pending + "</td>"
        + '<td class="job-stat-number stat-rejected">' + stats.rejected + "</td></tr>");
    }
    const unassigned = unassignedByPlatform.get(platform) || [];
    if (unassigned.length) {
      const stats = jobStats(unassigned);
      rows.push('<tr><td><strong>未关联任务</strong><small>手动导入或旧版 Worker 数据</small></td><td>-</td><td>' + badge("UNASSIGNED", "status-badge") + "</td>"
        + '<td class="job-stat-number">' + stats.entered + "</td>"
        + '<td class="job-stat-number stat-selected">' + stats.selected + "</td>"
        + '<td class="job-stat-number stat-pending">' + stats.pending + "</td>"
        + '<td class="job-stat-number stat-rejected">' + stats.rejected + "</td></tr>");
    }
  }
  el("#job-run-stats-body").innerHTML = rows.join("") || '<tr><td colspan="7" class="empty-cell">本次运行没有可统计的任务。</td></tr>';
}

function sortJobs(jobs, sort) {
  return [...jobs].sort((a, b) => {
    if (sort === "score") return b.screening.score - a.screening.score;
    if (sort === "source") return a.source.localeCompare(b.source);
    if (sort === "company") return String(a.company || "").localeCompare(String(b.company || ""));
    if (sort === "title") return a.title.localeCompare(b.title);
    return String(b.discoveredAt).localeCompare(String(a.discoveredAt));
  });
}

function visibleJobs() {
  const query = (el("#job-search").value || "").trim().toLowerCase();
  const category = el("#job-category").value;
  const source = el("#job-source").value;
  const status = el("#job-status").value;
  const sort = el("#job-sort").value;
  const jobs = jobsInSelectedPane().filter((job) => {
    const words = [job.title, job.company, job.location, job.searchKeyword].join(" ").toLowerCase();
    return (!query || words.includes(query))
      && (!category || job.screening.category === category)
      && (!source || job.source === source)
      && (!status || job.screening.screeningStatus === status);
  });
  return sortJobs(jobs, sort);
}

function actionButtons(job) {
  const open = /^https?:\/\//i.test(job.jobUrl || "")
    ? '<a class="icon-button" href="' + escapeHtml(job.jobUrl) + '" target="_blank" rel="noreferrer" title="打开原职位"><i data-lucide="external-link"></i></a>'
    : "";
  const feedbackActive = job.feedback?.helpfulness === "NOT_HELPFUL";
  return open
    + '<button class="icon-button" data-review="' + job.id + '" title="查看或审阅 JD"><i data-lucide="scan-search"></i></button>'
    + '<button class="feedback-action' + (feedbackActive ? " is-active" : "") + '" data-feedback="' + job.id + '" type="button" aria-pressed="' + String(feedbackActive) + '" title="' + (feedbackActive ? "修改没帮助反馈" : "标记为没帮助") + '"><i data-lucide="thumbs-down"></i><span>没帮助</span></button>';
}

function jobRow(job, compact = false, includeBatch = false) {
  const duplicate = job.duplicateOf ? '<span class="tiny-note">重复导入</span>' : "";
  const search = compact ? "" : '<td class="muted">' + escapeHtml(job.searchKeyword || "-") + "</td>";
  const run = includeBatch ? runForJob(job) : null;
  const batch = includeBatch
    ? '<td><span>' + escapeHtml(run ? dateTime(run.startedAt) : "未关联运行") + '</span><small>' + escapeHtml(run ? nice(run.state) : "手动或旧版导入") + "</small></td>"
    : "";
  return '<tr' + (job.feedback?.helpfulness === "NOT_HELPFUL" ? ' class="job-not-helpful"' : "") + '>'
    + '<td><strong>' + escapeHtml(job.title) + "</strong>" + duplicate + feedbackBadge(job) + "</td>"
    + '<td><span>' + escapeHtml(job.company || "-") + "</span><small>" + escapeHtml(job.location || "-") + "</small></td>"
    + '<td>' + badge(names[job.source] || job.source, "source-" + job.source) + "</td>"
    + search
    + '<td><span class="score">' + job.screening.score + "</span>" + badge(job.screening.category, "category-" + job.screening.category.toLowerCase()) + aiReviewBadge(job) + "</td>"
    + '<td>' + badge(job.screening.screeningStatus, "status-badge") + "</td>"
    + batch
    + '<td class="action-cell">' + actionButtons(job) + "</td></tr>";
}

function renderOverview() {
  const jobs = currentRunJobs();
  const historyCount = historicalJobs().length;
  const metrics = [
    ["本次导入", jobs.length, "briefcase-business"],
    ["本次强匹配", jobs.filter((job) => job.screening.category === "STRONG_MATCH").length, "badge-check"],
    ["本次待审阅", jobs.filter((job) => job.screening.screeningStatus === "NEEDS_JD_REVIEW").length, "scan-search"],
    ["历史职位", historyCount, "history"]
  ];
  el("#overview-metrics").innerHTML = metrics.map((item) =>
    '<article class="metric"><div><span>' + item[0] + "</span><strong>" + item[1] + '</strong></div><i data-lucide="' + item[2] + '"></i></article>'
  ).join("");
  const rows = sortJobs(jobs, "discoveredAt").slice(0, 8).map((job) => jobRow(job, true)).join("");
  el("#overview-jobs").innerHTML = rows || '<tr><td colspan="6" class="empty-cell">本次任务尚未导入职位。</td></tr>';
}

function renderHistoryRunOptions() {
  const currentId = currentRun()?.id || null;
  const counts = new Map();
  let unassigned = 0;
  for (const job of historicalJobs()) {
    if (job.runId && state.data.runs.some((run) => run.id === job.runId)) counts.set(job.runId, (counts.get(job.runId) || 0) + 1);
    else unassigned += 1;
  }
  const runs = state.data.runs.filter((run) => run.id !== currentId && counts.has(run.id));
  const validValues = new Set(["", ...runs.map((run) => run.id), ...(unassigned ? ["__unassigned"] : [])]);
  if (!validValues.has(state.historyRunId)) state.historyRunId = "";
  el("#job-history-run").innerHTML = '<option value="">全部历史批次</option>'
    + runs.map((run) => '<option value="' + escapeHtml(run.id) + '"' + (state.historyRunId === run.id ? " selected" : "") + ">" + escapeHtml(dateTime(run.startedAt)) + " · " + counts.get(run.id) + " 个职位</option>").join("")
    + (unassigned ? '<option value="__unassigned"' + (state.historyRunId === "__unassigned" ? " selected" : "") + ">未关联运行 · " + unassigned + " 个职位</option>" : "");
}

function selectedReviewRun() {
  if (state.jobsPane === "current") return currentRun();
  if (!state.historyRunId || state.historyRunId === "__unassigned") return null;
  return state.data.runs.find((run) => run.id === state.historyRunId) || null;
}

function reflectionHasCurrentFeedback(reflection, feedbackJobs) {
  if (!reflection) return false;
  const reflectedIds = new Set(reflection.feedbackJobIds || []);
  return reflectedIds.size === feedbackJobs.length
    && feedbackJobs.every((job) => reflectedIds.has(job.id) && String(job.feedback?.updatedAt || "") <= String(reflection.createdAt || ""));
}

function learningChips(items, tone = "") {
  return (items || []).map((item) => '<span class="learning-chip ' + tone + '">' + escapeHtml(item) + "</span>").join("");
}

function renderReviewLearning() {
  const panel = el("#review-learning");
  const run = selectedReviewRun();
  panel.hidden = state.jobsPane === "history" && !run;
  if (panel.hidden) return;
  const jobs = run ? state.data.jobs.filter((job) => job.runId === run.id) : [];
  const feedbackJobs = jobs.filter((job) => job.feedback?.helpfulness === "NOT_HELPFUL");
  const reflection = run ? (state.data.reviewReflections || []).find((item) => item.runId === run.id) : null;
  const model = reflection?.modelSnapshot || (!run ? state.data.preferenceModel : null);
  const runFinished = run && ["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(run.state);
  const reflected = reflectionHasCurrentFeedback(reflection, feedbackJobs);
  const button = el("#complete-run-review");
  const label = button.querySelector("span");
  el("#review-feedback-count").textContent = feedbackJobs.length + " 条没帮助";
  button.hidden = false;
  button.disabled = !runFinished || (!feedbackJobs.length && !reflection) || reflected;
  label.textContent = reflection ? (reflected ? "本次复盘已完成" : "更新本次复盘") : "完成本次审阅并复盘";
  el("#review-learning-subtitle").textContent = state.jobsPane === "history"
    ? "查看该历史批次的人工反馈和复盘结论。"
    : !run ? "运行每日任务后，可在这里标记没有帮助的职位并完成复盘。"
      : !runFinished ? "任务仍在运行；可以先标记反馈，运行结束后再完成复盘。"
        : "只学习你明确标记的职位；撤销反馈并更新复盘可以纠正偏好。";

  if (!model) {
    el("#review-learning-content").innerHTML = '<p class="review-learning-empty">尚未生成复盘。标记至少一条“没帮助”，并在任务结束后完成审阅。</p>';
    return;
  }
  const engine = reflection?.engine || model.engine;
  el("#review-learning-content").innerHTML = '<div class="learning-summary"><div><strong>学习摘要</strong>'
    + (reflection ? '<span class="learning-version">v' + reflection.version + " · " + escapeHtml(dateTime(reflection.createdAt)) + "</span>" : "")
    + (engine === "ai" ? '<span class="badge ai-review-badge"><i data-lucide="sparkles"></i>AI 复盘</span>' : '<span class="badge status-badge">本地复盘</span>')
    + '</div><p>' + escapeHtml(model.summary) + "</p></div>"
    + (model.targetSignals?.length ? '<div class="learning-rule-row"><strong>优先信号</strong><div>' + learningChips(model.targetSignals, "is-target") + "</div></div>" : "")
    + (model.avoidSignals?.length || model.titleExclusions?.length ? '<div class="learning-rule-row"><strong>降低优先级</strong><div>' + learningChips([...(model.avoidSignals || []), ...(model.titleExclusions || [])], "is-avoid") + "</div></div>" : "")
    + (model.screeningGuidance?.length ? '<div class="learning-guidance"><strong>下次筛选</strong><ul>' + model.screeningGuidance.map((item) => "<li>" + escapeHtml(item) + "</li>").join("") + "</ul></div>" : "")
    + (reflection?.aiError ? '<p class="form-note warning-note">AI 复盘未完成，已使用本地规则：' + escapeHtml(reflection.aiError) + "</p>" : "");
}

function renderJobs() {
  const currentJobs = currentRunJobs();
  const historyJobs = historicalJobs();
  renderHistoryRunOptions();
  document.querySelectorAll("[data-jobs-pane]").forEach((node) => {
    const active = node.dataset.jobsPane === state.jobsPane;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-selected", String(active));
  });
  el("#current-jobs-count").textContent = String(currentJobs.length);
  el("#history-jobs-count").textContent = String(historyJobs.length);
  el("#jobs-run-filter").hidden = state.jobsPane !== "history";
  el("#job-run-stats").hidden = state.jobsPane !== "current";
  if (state.jobsPane === "current") renderCurrentRunStats();
  renderReviewLearning();
  el("#jobs-list-title").textContent = state.jobsPane === "history" ? "历史职位" : "本次任务职位";
  const jobs = visibleJobs();
  const paneTotal = jobsInSelectedPane().length;
  el("#jobs-summary").textContent = state.jobsPane === "history"
    ? jobs.length + " / " + paneTotal + " 个历史职位"
    : currentRun() ? jobs.length + " / " + paneTotal + " 个本次任务职位" : "尚未开始本次任务";
  el("#jobs-table-head").innerHTML = state.jobsPane === "history"
    ? "<tr><th>职位</th><th>公司 / 地点</th><th>来源</th><th>搜索</th><th>匹配</th><th>状态</th><th>运行批次</th><th></th></tr>"
    : "<tr><th>职位</th><th>公司 / 地点</th><th>来源</th><th>搜索</th><th>匹配</th><th>状态</th><th></th></tr>";
  el("#jobs-table").innerHTML = jobs.map((job) => jobRow(job, false, state.jobsPane === "history")).join("")
    || '<tr><td colspan="' + (state.jobsPane === "history" ? "8" : "7") + '" class="empty-cell">' + (state.jobsPane === "history" ? "没有匹配当前筛选条件的历史职位。" : "本次任务尚未导入职位。") + "</td></tr>";
}

function taskCategoryValidation(task) {
  return (state.data.validations || []).find((validation) => validation.id === task.validationId) || null;
}

function categoryStatus(category) {
  const validations = category.tasks.map(taskCategoryValidation);
  const valid = validations.filter((validation) => validation?.status === "VALID").length;
  const active = validations.filter((validation) => validation?.status === "WAITING_FOR_WORKER").length;
  const failed = validations.filter((validation) => ["FAILED", "NEEDS_USER_ACTION"].includes(validation?.status)).length;
  return { total: category.tasks.length, valid, active, failed, ready: valid === category.tasks.length };
}

function categoryTaskStatusMarkup(task) {
  const validation = taskCategoryValidation(task);
  if (!validation) return badge("未预检", "status-badge");
  return badge(validationPresentation(validation).label, "status-badge");
}

function renderTaskCategories() {
  const categories = state.data.taskCategories || [];
  const categoryIds = new Set(categories.map((category) => category.id));
  state.selectedCategoryIds = new Set([...state.selectedCategoryIds].filter((id) => categoryIds.has(id)));
  state.expandedCategoryIds = new Set([...state.expandedCategoryIds].filter((id) => categoryIds.has(id)));
  const selected = categories.filter((category) => state.selectedCategoryIds.has(category.id));
  const selectedTasks = selected.reduce((total, category) => total + category.tasks.length, 0);
  el("#selected-category-count").textContent = `已选 ${selected.length} 类 / ${selectedTasks} 项任务`;
  el("#select-all-categories").checked = Boolean(categories.length && selected.length === categories.length);
  el("#select-all-categories").indeterminate = selected.length > 0 && selected.length < categories.length;
  el("#preflight-selected-categories").disabled = !selected.length;
  el("#import-selected-categories").disabled = !selected.length;
  el("#task-category-list").innerHTML = categories.map((category, index) => {
    const status = categoryStatus(category);
    const selectedCategory = state.selectedCategoryIds.has(category.id);
    const expanded = state.expandedCategoryIds.has(category.id);
    const platforms = [...new Set(category.tasks.map((task) => task.platform))];
    const stateLabel = status.ready ? "可导入" : status.active ? "待预检" : status.failed ? "需检查" : "未预检";
    const rows = category.tasks.map((task) => '<tr>'
      + '<td>' + badge(names[task.platform], "source-" + task.platform) + '</td>'
      + '<td><strong>' + escapeHtml(task.keyword) + '</strong></td>'
      + '<td>' + escapeHtml(task.location) + '</td>'
      + '<td>' + escapeHtml(postedWithinLabels[Number(task.postedWithinDays)] || "不限") + '</td>'
      + '<td>' + categoryTaskStatusMarkup(task) + '</td></tr>').join("");
    return '<article class="task-category-item' + (selectedCategory ? " is-selected" : "") + '">'
      + '<div class="task-category-main">'
      + '<label class="task-category-check"><input type="checkbox" data-category-select="' + category.id + '"' + (selectedCategory ? " checked" : "") + '><span class="task-category-index">' + String(index + 1).padStart(2, "0") + '</span></label>'
      + '<div class="task-category-identity"><div><strong>' + escapeHtml(category.name) + '</strong>' + (category.builtin ? badge("预设", "category-preset-badge") : badge("自定义", "category-custom-badge")) + '</div><small>'
      + platforms.map((platform) => names[platform]).join(" / ") + ' · ' + category.tasks.length + ' 项子任务</small></div>'
      + '<div class="task-category-progress"><strong>' + status.valid + '/' + status.total + '</strong><span>' + stateLabel + '</span></div>'
      + '<div class="task-category-actions"><button class="icon-button" type="button" data-toggle-category="' + category.id + '" title="' + (expanded ? "收起子任务" : "查看子任务") + '"><i data-lucide="chevron-' + (expanded ? "up" : "down") + '"></i></button>'
      + (category.builtin ? "" : '<button class="icon-button" type="button" data-edit-category="' + category.id + '" title="编辑类别"><i data-lucide="pencil"></i></button><button class="icon-button destructive" type="button" data-delete-category="' + category.id + '" title="删除类别"><i data-lucide="trash-2"></i></button>')
      + '</div></div>'
      + '<div class="task-category-children"' + (expanded ? "" : " hidden") + '><div class="data-table-wrap"><table class="data-table compact-table"><thead><tr><th>平台</th><th>关键词</th><th>地点</th><th>时间</th><th>预检</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>'
      + '</article>';
  }).join("") || '<div class="empty-state compact-empty"><p>尚未创建任务类别。</p></div>';
}

function renderRoutine() {
  const routineTasks = state.data.routineTasks || [];
  const validations = state.data.validations || [];
  const waitingValidations = validations.filter((validation) => validation.status === "WAITING_FOR_WORKER");
  const run = currentRun();
  const queueTasks = run ? run.tasks : [];
  const showingMonitor = state.routinePane === "monitor";
  const timeLabel = (days) => postedWithinLabels[Number(days)] || "不限";
  renderTaskCategories();
  el("#routine-task-count").textContent = String(routineTasks.length);
  el("#routine-monitor-count").textContent = String(queueTasks.length);
  el("#start-preflight-label").textContent = waitingValidations.length ? "统一预检 (" + waitingValidations.length + ")" : "统一预检";
  el("#start-preflight-batch").disabled = !waitingValidations.length;
  document.querySelectorAll("[data-routine-pane]").forEach((node) => {
    const active = node.dataset.routinePane === state.routinePane;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-selected", String(active));
  });
  el("#routine-plan-pane").hidden = showingMonitor;
  el("#routine-monitor-pane").hidden = !showingMonitor;
  el("#validation-summary").textContent = validations.length ? validations.length + " 条记录" : "暂无记录";
  if (validations.some((validation) => ["WAITING_FOR_WORKER", "FAILED", "NEEDS_USER_ACTION"].includes(validation.status))) {
    el("#preflight-history").open = true;
  }
  el("#routine-tasks-table").innerHTML = routineTasks.map((task) => '<tr>'
    + "<td>" + badge(names[task.platform], "source-" + task.platform) + "</td>"
    + "<td><strong>" + escapeHtml(task.keyword) + "</strong></td>"
    + "<td>" + escapeHtml(task.location) + "</td>"
    + "<td>" + escapeHtml(timeLabel(task.postedWithinDays)) + "</td>"
    + "<td>" + badge(task.status, "status-badge") + "</td>"
    + '<td class="action-cell"><button class="icon-button" data-run-routine-task="' + task.id + '" title="单独运行此任务"><i data-lucide="play"></i></button><button class="icon-button destructive" data-delete-routine-task="' + task.id + '" title="删除每日任务"><i data-lucide="trash-2"></i></button></td></tr>').join("")
    || '<tr><td colspan="6" class="empty-cell">添加单条任务并完成预检后，会显示在这里。</td></tr>';
  el("#clear-routine-tasks").disabled = !routineTasks.length;
  el("#validations-table").innerHTML = validations.map((validation) => {
    const presentation = validationPresentation(validation);
    const hasRoutineTask = routineTasks.some((task) => task.id === validation.routineTaskId || task.validationId === validation.id);
    const addButton = validation.status === "VALID" && !hasRoutineTask
      ? '<button class="icon-button" data-add-validation-task="' + validation.id + '" title="添加到每日任务"><i data-lucide="list-plus"></i></button>'
      : "";
    return '<tr>'
    + "<td>" + badge(names[validation.platform], "source-" + validation.platform) + "</td>"
    + "<td><strong>" + escapeHtml(validation.keyword) + "</strong></td>"
    + "<td>" + escapeHtml(validation.location) + "</td>"
    + "<td>" + escapeHtml(timeLabel(validation.postedWithinDays)) + "</td>"
    + "<td>" + badge(presentation.label, "status-badge") + "</td>"
    + '<td class="muted">' + escapeHtml(presentation.reason) + "</td>"
    + '<td class="action-cell validation-actions">' + addButton + '<button class="icon-button" data-retry-validation="' + validation.id + '" title="重新尝试预检"><i data-lucide="rotate-cw"></i></button>'
    + '<button class="icon-button" data-edit-validation="' + validation.id + '" title="修改预检参数"><i data-lucide="pencil"></i></button>'
    + '<button class="icon-button destructive" data-delete-validation="' + validation.id + '" title="删除预检记录"><i data-lucide="trash-2"></i></button></td></tr>';
  }).join("")
    || '<tr><td colspan="7" class="empty-cell">尚未发起平台预检。</td></tr>';
  if (!run) {
    el("#run-summary").innerHTML = '<div class="empty-state"><i data-lucide="calendar-clock"></i><p>尚未启动每日运行。</p></div>';
    el("#tasks-table").innerHTML = '<tr><td colspan="7" class="empty-cell">开始运行后，执行队列会显示在这里。</td></tr>';
  } else {
    const c = run.counters;
    const activeTask = run.tasks.find((task) => task.status === "running" || task.status === "needs_user_action") || run.tasks.find((task) => task.status === "queued");
    const metric = (label, value) => '<div class="run-metric"><span>' + label + "</span><strong>" + value + "</strong></div>";
    el("#run-summary").innerHTML = '<div class="run-state"><span>当前状态</span>' + badge(run.state, "run-state-badge")
      + (activeTask ? '<small>' + escapeHtml(taskProgressText(activeTask)) + "</small>" : "") + "</div>"
      + metric("LinkedIn 新职位", c.linkedin.newJobs)
      + metric("Indeed 新职位", c.indeed.newJobs)
      + metric("SEEK 新职位", c.seek.newJobs)
      + metric("JD 已审阅", c.ai.jdReviewed)
      + metric("AI 调用", c.ai.calls)
      + metric("AI tokens", c.ai.totalTokens)
      + metric("预算跳过", c.ai.budgetSkipped);
    el("#clear-run-queue").disabled = !queueTasks.length;
    el("#tasks-table").innerHTML = queueTasks.map((task) => '<tr>'
      + "<td>" + badge(names[task.platform], "source-" + task.platform) + "</td>"
      + "<td><strong>" + escapeHtml(task.keyword) + "</strong></td>"
      + "<td>" + escapeHtml(task.location) + "</td><td>" + escapeHtml(timeLabel(task.postedWithinDays)) + "</td>"
      + "<td>" + badge(task.status, "status-badge") + "</td>"
      + '<td class="muted">' + escapeHtml(taskProgressText(task)) + "</td>"
      + '<td class="action-cell">' + (task.status === "needs_user_action"
        ? '<button class="button button-quiet task-resume" data-resume-task="' + task.id + '"><i data-lucide="play"></i><span>继续</span></button>'
        : "")
      + (!["queued", "running"].includes(task.status) ? '<button class="icon-button" data-rerun-task="' + task.id + '" title="重新运行此任务"><i data-lucide="rotate-cw"></i></button>' : "")
      + '<button class="icon-button destructive" data-delete-run-task="' + task.id + '" data-running="' + (task.status === "running" ? "true" : "false") + '" title="' + (task.status === "running" ? "取消执行中的任务" : "从本次队列移除") + '"><i data-lucide="' + (task.status === "running" ? "square" : "trash-2") + '"></i></button></td></tr>').join("")
      || '<tr><td colspan="7" class="empty-cell">本次运行队列已清空。</td></tr>';
    notifyPausedTasks(run);
  }
  if (!run) el("#clear-run-queue").disabled = true;
  el("#runs-list").innerHTML = state.data.runs.map((run) => '<article class="run-row"><div><strong>'
    + dateTime(run.startedAt) + "</strong><span>" + run.tasks.length + " 项任务</span></div><div>"
    + badge(run.state, "run-state-badge") + '</div><div class="run-platform-counts"><span>LI '
    + run.counters.linkedin.newJobs + "</span><span>IN " + run.counters.indeed.newJobs
    + "</span><span>SEEK " + run.counters.seek.newJobs + "</span></div></article>").join("")
    || '<div class="empty-state compact-empty"><p>没有运行记录。</p></div>';
}

function taskProgressText(task) {
  if (task.status === "running") {
    const heartbeat = Date.parse(task.workerHeartbeatAt || task.progress?.updatedAt || task.startedAt || "");
    if (Number.isFinite(heartbeat) && Date.now() - heartbeat > 30_000) {
      return "Worker 超过 30 秒没有更新，可能已停止；可取消后重新运行。";
    }
    return task.progress?.message || "Worker 正在运行。";
  }
  if (task.status === "queued") return "等待 Worker 依次领取。";
  if (task.status === "completed") return task.progress?.message || "任务已完成。";
  return task.reason || task.progress?.message || "-";
}

function setRoutinePane(pane) {
  state.routinePane = pane === "monitor" ? "monitor" : "plan";
  renderRoutine();
  refreshIcons();
}

function setProfilePane(pane) {
  state.profilePane = pane === "upload" ? "upload" : "editor";
  document.querySelectorAll("[data-profile-pane]").forEach((node) => {
    const active = node.dataset.profilePane === state.profilePane;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-selected", String(active));
  });
  el("#profile-upload-pane").hidden = state.profilePane !== "upload";
  el("#profile-editor-pane").hidden = state.profilePane !== "editor";
}

function profileTagValues(profile, section) {
  if (section === "candidateItems") return profile.candidateItems || [];
  if (["locations", "workTypes", "exclusions"].includes(section)) return profile.preferences?.[section] || [];
  return profile[section] || [];
}

function suggestProfileSection(value) {
  const text = String(value || "").toLowerCase();
  if (/\b(bachelor|master|phd|doctorate|degree|diploma|certificate|university|college|unsw|rmit|monash)\b|\b(19|20)\d{2}\b/i.test(text)) return "education";
  if (/\b(developer|engineer|analyst|consultant|intern|graduate program|specialist|architect)\b/i.test(text)) return "targetRoles";
  if (/\b(remote|hybrid|on[- ]?site|full[- ]?time|part[- ]?time|contract|casual|internship)\b/i.test(text)) return "workTypes";
  if (/\b(avoid|exclude|not interested|do not target|no sales|no support)\b/i.test(text)) return "exclusions";
  if (/\b(melbourne|sydney|brisbane|perth|adelaide|canberra|australia|victoria|new south wales|queensland|nsw|vic|qld|wa|sa|act)\b/i.test(text)) return "locations";
  if (/\b(python|java(script)?|typescript|react|next\.?js|node\.?js|sql|firebase|tensorflow|pytorch|scikit|git|aws|azure|gcp|docker|kubernetes|c\+\+|c#)\b/i.test(text)) return "skills";
  return "focusAreas";
}

function profileSuggestion(profile, value) {
  const suggestions = profile.candidateSuggestions || {};
  const exact = suggestions[value];
  if (formalProfileTagKeys.has(exact)) return exact;
  const matchedKey = Object.keys(suggestions).find((key) => key.toLowerCase() === String(value).toLowerCase());
  const matched = matchedKey ? suggestions[matchedKey] : null;
  return formalProfileTagKeys.has(matched) ? matched : suggestProfileSection(value);
}

function profileChipMarkup(section, value, suggestedSection = "") {
  const suggestion = formalProfileTagKeys.has(suggestedSection) ? suggestedSection : "";
  return '<button class="profile-chip" type="button" aria-pressed="false" data-profile-chip data-profile-chip-section="'
    + escapeHtml(section) + '" data-suggested-section="' + escapeHtml(suggestion) + '" data-value="' + escapeHtml(value)
    + '" title="拖拽到其他分类">' + escapeHtml(value) + "</button>";
}

function profileTagBoardMarkup(definition, profile) {
  const values = profileTagValues(profile, definition.key);
  const content = values.length
    ? values.map((value) => profileChipMarkup(definition.key, value)).join("")
    : '<span class="profile-chip-empty" data-profile-chip-empty>暂无标签</span>';
  const body = '<div class="profile-tag-board-header"><span class="profile-tag-board-title"><i data-lucide="' + definition.icon + '"></i>'
    + escapeHtml(definition.label) + '</span><span class="profile-tag-board-actions"><small data-profile-section-count="' + definition.key + '">' + values.length
    + '</small><button class="icon-button" type="button" data-add-profile-chip="' + definition.key + '" title="添加'
    + escapeHtml(definition.label) + '"><i data-lucide="plus"></i></button></span></div><div class="profile-chip-list" data-profile-chip-list="'
    + definition.key + '">' + content + "</div>";
  return '<section class="profile-tag-board" data-profile-board="' + definition.key + '" data-profile-drop-section="' + definition.key + '">' + body + "</section>";
}

function candidateGroupMarkup(definition, values, profile) {
  const chips = values.map((value) => profileChipMarkup("candidateItems", value, profileSuggestion(profile, value))).join("");
  return '<section class="profile-candidate-group" data-candidate-group="' + definition.key + '"><div class="profile-candidate-group-header">'
    + '<span><i data-lucide="' + definition.icon + '"></i>建议归入' + escapeHtml(definition.label) + '</span>'
    + '<button class="button button-quiet profile-accept-suggested" type="button" data-accept-suggested="' + definition.key
    + '" title="全部归入' + escapeHtml(definition.label) + '"><i data-lucide="archive-restore"></i><span>全部归档</span></button></div>'
    + '<div class="profile-chip-list" data-profile-chip-list="candidateItems" data-candidate-group-list="' + definition.key + '">' + chips + "</div></section>";
}

function profileCandidatePanelMarkup(profile) {
  const values = profileTagValues(profile, "candidateItems");
  const groups = formalProfileTagSections.map((definition) => ({
    definition,
    values: values.filter((value) => profileSuggestion(profile, value) === definition.key)
  })).filter((group) => group.values.length);
  const content = groups.length
    ? groups.map((group) => candidateGroupMarkup(group.definition, group.values, profile)).join("")
    : '<div class="profile-candidate-empty" data-profile-candidate-empty>暂无候选标签</div>';
  return '<section class="profile-organizer-pane profile-candidate-panel"><div class="profile-organizer-heading"><div><h4>候选池</h4><small data-profile-section-count="candidateItems">'
    + values.length + '</small></div><button class="icon-button" type="button" data-add-profile-chip="candidateItems" title="添加候选标签"><i data-lucide="plus"></i></button></div>'
    + '<div class="profile-candidate-groups" id="profile-candidate-groups">' + content + "</div></section>";
}

function renderProfile() {
  const selected = selectedProfile();
  const active = activeProfile();
  setProfilePane(state.profilePane);
  el("#profile-draft-count").textContent = String(state.data.profiles.length);
  el("#profile-current").innerHTML = active
    ? '<i data-lucide="circle-check"></i><span>当前：' + escapeHtml(active.profile.name) + "</span>"
    : '<i data-lucide="circle-alert"></i><span>尚未激活画像</span>';
  el("#profile-status").textContent = state.data.ai.configured
    ? "AI 已配置：" + state.data.ai.model
    : "本地规则模式；配置 AI 后可获得语义画像与 JD 审阅。";
  el("#profile-versions").innerHTML = state.data.profiles.map((record) =>
    '<button class="profile-version ' + (record.id === state.profileId ? "is-selected" : "") + '" data-profile="' + record.id + '"><span>v'
    + record.version + "</span><small>" + (record.status === "approved" ? "当前/已确认" : "草稿") + "</small></button>").join("")
    || '<span class="muted">暂无版本</span>';
  if (!selected) {
    el("#profile-fields").innerHTML = '<div class="profile-empty"><i data-lucide="contact-round"></i><p>尚未生成画像草稿。</p><button class="button button-primary" type="button" data-profile-pane="upload"><i data-lucide="file-up"></i><span>上传简历</span></button></div>';
    return;
  }
  const p = selected.profile;
  const activeButton = selected.id === active?.id
    ? '<button class="button button-quiet" disabled><i data-lucide="circle-check"></i><span>当前画像</span></button>'
    : '<button class="button button-primary" data-activate="' + selected.id + '"><i data-lucide="circle-check"></i><span>确认并仅保留</span></button>';
  const clearOtherButton = selected.id === active?.id && state.data.profiles.length > 1
    ? '<button class="button button-danger" data-clear-other-profiles><i data-lucide="trash-2"></i><span>清理其他版本</span></button>'
    : "";
  const tagTotal = profileTagSections.reduce((total, definition) => total + profileTagValues(p, definition.key).length, 0);
  const candidatePanel = profileCandidatePanelMarkup(p);
  const tagBoards = formalProfileTagSections.map((definition) => profileTagBoardMarkup(definition, p)).join("");
  el("#profile-fields").innerHTML = '<section class="profile-identity"><div class="profile-badges">' + badge("v" + selected.version, "version-badge")
    + badge(selected.status, selected.id === active?.id ? "active-badge" : "status-badge")
    + badge(profileEngineLabel(selected.engine), "status-badge") + "</div>"
    + '<label class="field full"><span>画像名称</span><input id="p-name" value="' + escapeHtml(p.name) + '"></label>'
    + '<label class="field full"><span>职业标题</span><input id="p-headline" value="' + escapeHtml(p.headline) + '"></label>'
    + '<label class="field full"><span>摘要</span><textarea id="p-summary" rows="4">' + escapeHtml(p.summary) + "</textarea></label>"
    + '</section><section class="profile-tag-workbench"><div class="profile-tag-heading"><h3>画像标签</h3><div class="profile-tag-heading-actions"><span class="profile-selection-count" id="profile-selection-count">已选择 0 项</span>'
    + '<button class="icon-button destructive" id="delete-profile-chips" type="button" title="删除所选标签" disabled><i data-lucide="trash-2"></i></button><span class="profile-tag-total" id="profile-tag-total">'
    + tagTotal + ' 项</span></div></div><div class="profile-organizer">' + candidatePanel
    + '<section class="profile-organizer-pane profile-destination-panel"><div class="profile-organizer-heading"><div><h4>正式画像</h4><small id="profile-formal-count">' + (tagTotal - profileTagValues(p, "candidateItems").length)
    + ' 项</small></div></div><div class="profile-tag-grid">' + tagBoards + '</div></section></div></section><div class="editor-actions"><button class="button button-secondary" data-save-profile="' + selected.id
    + '"><i data-lucide="save"></i><span>保存画像</span></button>' + activeButton + clearOtherButton + "</div>";
}

function settingsRow(kind, item) {
  if (kind === "location") {
    return '<div class="settings-row" data-kind="location" data-id="' + escapeHtml(item.id) + '"><label class="row-toggle"><input type="checkbox" '
      + (item.enabled ? "checked" : "") + '><span></span></label><input class="row-name" value="' + escapeHtml(item.name)
      + '" aria-label="地点"><button class="icon-button destructive" data-remove title="移除地点"><i data-lucide="trash-2"></i></button></div>';
  }
  return '<div class="settings-row search-row" data-kind="search" data-id="' + escapeHtml(item.id) + '"><label class="row-toggle"><input type="checkbox" '
    + (item.enabled ? "checked" : "") + '><span></span></label><input class="row-name" value="' + escapeHtml(item.keyword)
    + '" aria-label="关键词"><input class="row-priority" type="number" min="0" max="1000" value="' + item.priority
    + '" aria-label="优先级"><button class="icon-button destructive" data-remove title="移除关键词"><i data-lucide="trash-2"></i></button></div>';
}

function renderSettings() {
  const settings = state.data.settings;
  el("#execution-mode").value = "sequential";
  const thresholds = [["strongMatch", "强匹配"], ["goodMatch", "好匹配"], ["maybe", "可考虑"], ["lowMatch", "低匹配"]];
  el("#threshold-row").innerHTML = thresholds.map((item) => '<label class="threshold"><span>' + item[1]
    + '</span><input type="number" min="0" max="100" data-threshold="' + item[0] + '" value="' + settings.thresholds[item[0]] + '"></label>').join("");
  if (!state.aiConfigDirty) {
    const ai = state.data.ai;
    el("#ai-base-url").value = ai.baseUrl || "";
    el("#ai-model").value = ai.model || "";
    el("#ai-wire-api").value = ai.wireApi === "responses" ? "responses" : "chat_completions";
    el("#ai-api-key").value = "";
    el("#ai-api-key").placeholder = ai.hasApiKey ? "已保存 " + (ai.keyHint || "密钥") + "；留空则保留" : "输入新密钥";
  }
  const ai = state.data.ai;
  const status = el("#ai-config-status");
  status.textContent = ai.configured
    ? "已配置 " + ai.model + (ai.hasApiKey ? " · 密钥已保存" : " · 未保存密钥")
    : "尚未配置完整的 Base URL 与模型";
  status.classList.toggle("is-configured", ai.configured);
  el("#clear-ai-key").disabled = !ai.hasApiKey;
}

function workerCopyMarkup(worker, disabled = false) {
  return '<button class="button button-secondary" data-copy-worker="' + worker.id + '"' + (disabled ? " disabled" : "") + '><i data-lucide="copy"></i><span>复制代码</span></button>';
}

function workerInstallMarkup(worker) {
  return '<a class="button button-primary" data-install-worker="' + worker.id + '" href="' + worker.path
    + '" target="_blank" rel="noopener"><i data-lucide="download"></i><span>安装 / 更新</span></a>';
}

function renderSetup() {
  const target = el("#worker-script-list");
  target.innerHTML = workerDefinitions.map((worker) => {
    const script = state.workerScripts[worker.id];
    const pending = state.workerScriptsLoading && !script;
    const code = script ? escapeHtml(script) : pending ? "正在读取脚本代码..." : "代码将在打开此页面后自动读取。";
    return '<article class="worker-script-row">'
      + '<div class="worker-script-header"><div class="worker-script-title"><span class="platform-dot source-' + worker.id + '"></span><div><h3>' + worker.name + ' Worker</h3><p>' + worker.domain + ' <span>' + worker.version + '</span></p></div></div>'
      + '<div class="worker-script-actions">' + workerInstallMarkup(worker) + workerCopyMarkup(worker, !script) + '</div></div>'
      + '<details class="worker-code"><summary><i data-lucide="code-2"></i><span>查看完整代码</span><small>' + (script ? script.length.toLocaleString() + ' 字符' : '读取中') + '</small></summary>'
      + '<pre><code>' + code + '</code></pre></details></article>';
  }).join("");
  renderHistoryResetControl();
}

function renderHistoryResetControl() {
  const button = el("#open-clear-all-history");
  if (!button) return;
  const completed = state.historyReset.completed.size;
  button.disabled = state.historyReset.running;
  button.querySelector("span").textContent = state.historyReset.running
    ? `正在清理 (${completed}/3)`
    : "清除全部历史记录";
}

function armHistoryResetTimeout() {
  clearTimeout(state.historyReset.timeout);
  state.historyReset.timeout = setTimeout(() => {
    state.historyReset.running = false;
    state.historyReset.window?.close();
    state.historyReset.window = null;
    renderHistoryResetControl();
    toast("Worker 历史清理未在 45 秒内完成。请确认三份 Worker 已更新到 v2.2.2，然后重试。", "error");
  }, 45_000);
}

async function loadWorkerScripts() {
  if (state.workerScriptsLoading || Object.keys(state.workerScripts).length === workerDefinitions.length) return;
  state.workerScriptsLoading = true;
  renderSetup();
  refreshIcons();
  try {
    const loaded = await Promise.all(workerDefinitions.map(async (worker) => {
      const response = await fetch(worker.path, { cache: "no-store" });
      if (!response.ok) throw new Error(worker.name + " Worker code could not be loaded.");
      return [worker.id, await response.text()];
    }));
    state.workerScripts = Object.fromEntries(loaded);
  } catch (error) {
    toast("无法读取 Worker 代码：" + error.message, "error");
  } finally {
    state.workerScriptsLoading = false;
    if (state.view === "setup") {
      renderSetup();
      refreshIcons();
    }
  }
}

function renderImportOptions() {
  el("#import-run").innerHTML = '<option value="">不关联运行任务</option>' + state.data.runs.map((run) =>
    '<option value="' + run.id + '">' + escapeHtml(dateTime(run.startedAt)) + " - " + escapeHtml(run.state) + "</option>").join("");
}

function render() {
  persistView();
  const title = pages[state.view];
  el("#page-kicker").textContent = title[0];
  el("#page-title").textContent = title[1];
  el("#ai-state").textContent = state.data.ai.configured ? "AI · " + state.data.ai.model : "本地规则";
  el("#start-run").classList.toggle("is-hidden", state.view === "routine");
  document.querySelectorAll(".view").forEach((node) => node.classList.toggle("is-active", node.id === "view-" + state.view));
  document.querySelectorAll("[data-view]").forEach((node) => node.classList.toggle("is-active", node.dataset.view === state.view));
  renderOverview();
  renderJobs();
  renderRoutine();
  renderProfile();
  renderSettings();
  renderSetup();
  renderImportOptions();
  refreshIcons();
  if (state.view === "setup") void loadWorkerScripts();
}

async function reload() {
  state.data = await api("/api/bootstrap");
  if (!state.profileId && state.data.profiles.length) state.profileId = state.data.activeProfile?.id || state.data.profiles[0].id;
  el("#api-status").textContent = "本地服务已连接";
  el("#api-status-dot").classList.add("is-online");
  render();
}

async function launchRun(routineTaskIds = null) {
  const launcher = window.open("about:blank", "job-agent-worker-launch");
  try {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    const result = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify(routineTaskIds ? { routineTaskIds } : {})
    });
    const firstLaunch = result.launchUrls[0];
    if (launcher && firstLaunch?.url) {
      launcher.location.href = firstLaunch.url;
    } else launcher?.close();
    state.jobsPane = "current";
    state.historyRunId = "";
    state.routinePane = "monitor";
    await reload();
    state.view = "routine";
    render();
    const blocked = Boolean(firstLaunch?.url && !launcher);
    toast(blocked
      ? "Worker 启动窗口被浏览器拦截，请允许此站点弹窗。"
      : "已创建 " + result.run.tasks.length + " 项任务；Worker 会按队列依次处理。", blocked ? "error" : "success");
  } catch (error) {
    launcher?.close();
    toast(error.message, "error");
  }
}

function createRun() {
  return launchRun();
}

function runRoutineTask(id) {
  return launchRun([id]);
}

async function uploadResume() {
  const file = el("#profile-file").files[0];
  if (!file) return toast("请先选择简历文件。", "error");
  const data = new FormData();
  data.append("resume", file);
  try {
    const result = await api("/api/resumes/upload", { method: "POST", body: data });
    el("#resume-text").value = result.text;
    state.resumeSource = result.sourceName;
    el("#resume-source").textContent = result.sourceName + " · 已读取";
    toast("已读取简历文本。");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function copyExternalGptPrompt() {
  const copied = await copyText(externalGptProfilePrompt);
  toast(copied ? "GPT 画像提示词已复制。" : "复制失败，请重试。", copied ? "success" : "error");
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = value;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.append(fallback);
    fallback.select();
    const copied = document.execCommand("copy");
    fallback.remove();
    return copied;
  }
}

async function copyWorkerScript(button) {
  const worker = workerDefinitions.find((item) => item.id === button.dataset.copyWorker);
  const script = worker && state.workerScripts[worker.id];
  if (!worker || !script) return toast("Worker 代码仍在读取，请稍后重试。", "error");
  button.disabled = true;
  const copied = await copyText(script);
  if (!copied) {
    button.disabled = false;
    return toast("复制失败，请重试。", "error");
  }
  button.innerHTML = '<i data-lucide="check"></i><span>已复制</span>';
  refreshIcons();
  toast(worker.name + " Worker 代码已复制，前往 Tampermonkey 新建脚本并粘贴保存。");
  setTimeout(() => {
    if (!button.isConnected) return;
    button.disabled = false;
    button.innerHTML = '<i data-lucide="copy"></i><span>复制 ' + worker.name + ' 脚本</span>';
    refreshIcons();
  }, 1800);
}

async function generateProfile() {
  const resumeText = el("#resume-text").value.trim();
  if (resumeText.length < 80) return toast("请先提供足够的简历文本。", "error");
  const externalProfileText = el("#external-profile-text").value.trim();
  const button = el("#generate-profile");
  const originalMarkup = button.innerHTML;
  button.disabled = true;
  button.classList.add("is-busy");
  button.setAttribute("aria-busy", "true");
  button.innerHTML = '<i data-lucide="loader-circle" class="button-spinner"></i><span>正在综合生成...</span>';
  refreshIcons();
  try {
    const result = await api("/api/profiles/generate", {
      method: "POST",
      body: JSON.stringify({
        resumeText,
        sourceName: state.resumeSource || "pasted-resume.txt",
        externalProfileText
      })
    });
    state.profileId = result.profile.id;
    state.profilePane = "editor";
    await reload();
    state.view = "profile";
    render();
    const message = {
      ai: "已生成 AI 画像草稿。",
      "ai-with-external": "已结合简历与外部 GPT 画像生成草稿。",
      "external-gpt": "已采用外部 GPT 画像草稿，请确认内容。",
      "local-rules": "已生成本地画像草稿。"
    }[result.profile.engine] || "已生成画像草稿。";
    const fallbackMessage = !result.profile.aiError
      ? message
      : result.profile.engine === "external-gpt"
        ? message + " 本地 AI 合并暂不可用。"
        : externalProfileText
          ? message + " 外部画像格式未识别，已回退。"
          : message + " AI 暂不可用，已回退。";
    toast(fallbackMessage, result.profile.aiError ? "error" : "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.classList.remove("is-busy");
    button.removeAttribute("aria-busy");
    button.innerHTML = originalMarkup;
    refreshIcons();
  }
}

function profileChipValues(section) {
  return [...document.querySelectorAll('[data-profile-chip-section="' + section + '"]')]
    .map((node) => node.dataset.value.trim())
    .filter(Boolean);
}

function refreshProfileTagWorkbench() {
  let total = 0;
  for (const definition of profileTagSections) {
    const chips = [...document.querySelectorAll('[data-profile-chip-section="' + definition.key + '"]')];
    total += chips.length;
    document.querySelectorAll('[data-profile-section-count="' + definition.key + '"]').forEach((node) => node.replaceChildren(String(chips.length)));
  }
  document.querySelectorAll("[data-candidate-group]").forEach((group) => {
    const chips = group.querySelectorAll('[data-profile-chip-section="candidateItems"]');
    if (!chips.length) group.remove();
  });
  const candidateGroups = el("#profile-candidate-groups");
  if (candidateGroups) {
    const candidateCount = document.querySelectorAll('[data-profile-chip-section="candidateItems"]').length;
    const empty = candidateGroups.querySelector("[data-profile-candidate-empty]");
    if (candidateCount) empty?.remove();
    else if (!empty) candidateGroups.insertAdjacentHTML("beforeend", '<div class="profile-candidate-empty" data-profile-candidate-empty>暂无候选标签</div>');
  }
  for (const definition of formalProfileTagSections) {
    const list = el('[data-profile-chip-list="' + definition.key + '"]');
    if (!list) continue;
    const chips = list.querySelectorAll("[data-profile-chip]");
    const empty = list.querySelector("[data-profile-chip-empty]");
    if (chips.length) empty?.remove();
    else if (!empty) list.insertAdjacentHTML("beforeend", '<span class="profile-chip-empty" data-profile-chip-empty>暂无标签</span>');
  }
  if (el("#profile-tag-total")) el("#profile-tag-total").textContent = total + " 项";
  if (el("#profile-formal-count")) {
    const candidateCount = document.querySelectorAll('[data-profile-chip-section="candidateItems"]').length;
    el("#profile-formal-count").textContent = String(total - candidateCount);
  }
  const selected = [...document.querySelectorAll("[data-profile-chip].is-selected")];
  if (el("#profile-selection-count")) el("#profile-selection-count").textContent = "已选择 " + selected.length + " 项";
  if (el("#delete-profile-chips")) el("#delete-profile-chips").disabled = !selected.length;
}

function toggleProfileChip(button) {
  const selected = button.classList.toggle("is-selected");
  button.setAttribute("aria-pressed", String(selected));
  refreshProfileTagWorkbench();
}

function moveProfileChip(chip, destination) {
  if (!chip || !formalProfileTagKeys.has(destination)) return false;
  const target = el('[data-profile-chip-list="' + destination + '"]');
  if (!target) return false;
  const valueKey = chip.dataset.value.toLowerCase();
  const duplicate = [...target.querySelectorAll("[data-profile-chip]")]
    .find((node) => node !== chip && node.dataset.value.toLowerCase() === valueKey);
  if (duplicate) chip.remove();
  else {
    target.querySelector("[data-profile-chip-empty]")?.remove();
    chip.dataset.profileChipSection = destination;
    chip.dataset.suggestedSection = "";
    chip.classList.remove("is-selected", "is-dragging");
    chip.setAttribute("aria-pressed", "false");
    target.append(chip);
  }
  refreshProfileTagWorkbench();
  return true;
}

function acceptSuggestedGroup(destination) {
  const chips = [...document.querySelectorAll('[data-profile-chip-section="candidateItems"][data-suggested-section="' + destination + '"]')];
  if (!chips.length) return;
  chips.forEach((chip) => moveProfileChip(chip, destination));
  toast("已归档 " + chips.length + " 个建议标签。", "success");
}

function deleteSelectedProfileChips() {
  document.querySelectorAll("[data-profile-chip].is-selected").forEach((chip) => chip.remove());
  refreshProfileTagWorkbench();
}

function closeProfileChipComposers() {
  document.querySelectorAll("[data-profile-inline-add]").forEach((node) => node.remove());
}

function addProfileChip(section) {
  const definition = profileTagSections.find((item) => item.key === section);
  if (!definition) return;
  closeProfileChipComposers();
  const host = section === "candidateItems"
    ? el(".profile-candidate-panel")
    : el('[data-profile-board="' + section + '"]');
  const heading = host?.querySelector(section === "candidateItems" ? ".profile-organizer-heading" : ".profile-tag-board-header");
  if (!heading) return;
  heading.insertAdjacentHTML("afterend", '<div class="profile-inline-add" data-profile-inline-add="' + section + '">'
    + '<input type="text" maxlength="180" aria-label="新建' + escapeHtml(definition.label) + '标签" placeholder="输入标签内容">'
    + '<button class="icon-button" type="button" data-confirm-profile-chip="' + section + '" title="确认添加"><i data-lucide="check"></i></button>'
    + '<button class="icon-button" type="button" data-cancel-profile-chip title="取消"><i data-lucide="x"></i></button></div>');
  refreshIcons();
  host.querySelector("[data-profile-inline-add] input")?.focus();
}

function commitProfileChip(section, value) {
  value = String(value || "").trim();
  if (!value) return;
  const duplicate = [...document.querySelectorAll("[data-profile-chip]")]
    .find((node) => node.dataset.value.toLowerCase() === value.toLowerCase());
  if (duplicate) {
    duplicate.classList.add("is-selected");
    duplicate.setAttribute("aria-pressed", "true");
    refreshProfileTagWorkbench();
    closeProfileChipComposers();
    return toast("该标签已存在，已为你选中。", "error");
  }
  if (section === "candidateItems") {
    const suggestion = suggestProfileSection(value);
    let target = el('[data-candidate-group-list="' + suggestion + '"]');
    if (!target) {
      const definition = formalProfileTagSections.find((item) => item.key === suggestion);
      el("#profile-candidate-groups")?.querySelector("[data-profile-candidate-empty]")?.remove();
      el("#profile-candidate-groups")?.insertAdjacentHTML("beforeend", candidateGroupMarkup(definition, [value], {
        candidateSuggestions: { [value]: suggestion }
      }));
    } else {
      target.insertAdjacentHTML("beforeend", profileChipMarkup(section, value, suggestion));
    }
  } else {
    const target = el('[data-profile-chip-list="' + section + '"]');
    target.querySelector("[data-profile-chip-empty]")?.remove();
    target.insertAdjacentHTML("beforeend", profileChipMarkup(section, value));
  }
  closeProfileChipComposers();
  refreshProfileTagWorkbench();
  refreshIcons();
}

function clearProfileDropTargets() {
  document.querySelectorAll("[data-profile-drop-section].is-drop-target").forEach((node) => node.classList.remove("is-drop-target"));
}

function startProfileChipPointerDrag(event) {
  const chip = event.target.closest("[data-profile-chip]");
  if (!chip || event.button !== 0) return;
  state.profilePointerDrag = {
    chip,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    active: false
  };
}

function moveProfileChipPointer(event) {
  const drag = state.profilePointerDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
  if (!drag.active && distance < 7) return;
  if (!drag.active) {
    drag.active = true;
    drag.chip.classList.add("is-dragging");
    document.body.classList.add("is-profile-dragging");
  }
  event.preventDefault();
  clearProfileDropTargets();
  document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-profile-drop-section]")?.classList.add("is-drop-target");
}

function finishProfileChipPointerDrag(event) {
  const drag = state.profilePointerDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  let moved = false;
  if (drag.active) {
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-profile-drop-section]");
    if (target) moved = moveProfileChip(drag.chip, target.dataset.profileDropSection);
    state.suppressProfileChipClick = true;
    setTimeout(() => { state.suppressProfileChipClick = false; }, 0);
  }
  drag.chip.classList.remove("is-dragging");
  state.profilePointerDrag = null;
  document.body.classList.remove("is-profile-dragging");
  clearProfileDropTargets();
  if (moved) toast("标签已移动。", "success");
}

function profileForm() {
  return {
    name: el("#p-name").value,
    headline: el("#p-headline").value,
    summary: el("#p-summary").value,
    targetRoles: profileChipValues("targetRoles"),
    focusAreas: profileChipValues("focusAreas"),
    skills: profileChipValues("skills"),
    education: profileChipValues("education"),
    preferences: {
      locations: profileChipValues("locations"),
      workTypes: profileChipValues("workTypes"),
      exclusions: profileChipValues("exclusions")
    },
    candidateItems: profileChipValues("candidateItems"),
    candidateSuggestions: Object.fromEntries([...document.querySelectorAll('[data-profile-chip-section="candidateItems"]')]
      .map((chip) => [chip.dataset.value, formalProfileTagKeys.has(chip.dataset.suggestedSection) ? chip.dataset.suggestedSection : suggestProfileSection(chip.dataset.value)]))
  };
}

async function saveProfile(id) {
  try {
    await api("/api/profiles/" + id, { method: "PUT", body: JSON.stringify({ profile: profileForm() }) });
    await reload();
    toast("画像已保存。");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function activateProfile(id) {
  try {
    await api("/api/profiles/" + id, { method: "PUT", body: JSON.stringify({ profile: profileForm() }) });
    const result = await api("/api/profiles/" + id + "/activate", { method: "POST", body: "{}" });
    state.profileId = id;
    await reload();
    toast(result.deleted ? "已确认画像，并清理 " + result.deleted + " 个其他版本。" : "已确认当前职业画像。");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function clearOtherProfiles() {
  try {
    const result = await api("/api/profiles/other-versions", { method: "DELETE" });
    state.profileId = result.profile.id;
    await reload();
    render();
    toast(result.deleted ? "已清理 " + result.deleted + " 个其他版本。" : "没有其他版本需要清理。");
  } catch (error) {
    toast(error.message, "error");
  }
}

function settingPayload() {
  const thresholds = Object.fromEntries([...document.querySelectorAll("[data-threshold]")].map((node) => [node.dataset.threshold, Number(node.value)]));
  return {
    ...state.data.settings,
    thresholds,
    executionMode: el("#execution-mode").value
  };
}

function categoryTaskEditorRow(task = {}) {
  const platform = task.platform || "linkedin";
  const postedWithinDays = Number(task.postedWithinDays || 0);
  const platformOptions = ["linkedin", "indeed", "seek"].map((value) => '<option value="' + value + '"' + (platform === value ? " selected" : "") + '>' + names[value] + '</option>').join("");
  const timeOptions = Object.entries(postedWithinLabels).map(([value, label]) => '<option value="' + value + '"' + (postedWithinDays === Number(value) ? " selected" : "") + '>' + label + '</option>').join("");
  return '<div class="category-task-editor-row" data-category-task-id="' + escapeHtml(task.id || "") + '">'
    + '<label class="field"><span>平台</span><select data-category-task-field="platform">' + platformOptions + '</select></label>'
    + '<label class="field category-task-keyword"><span>关键词（逗号表示任一）</span><input data-category-task-field="keyword" required maxlength="160" placeholder="intern, internship" value="' + escapeHtml(task.keyword || "") + '"></label>'
    + '<label class="field category-task-location"><span>地点</span><input data-category-task-field="location" required maxlength="120" value="' + escapeHtml(task.location || "") + '"></label>'
    + '<label class="field"><span>时间</span><select data-category-task-field="postedWithinDays">' + timeOptions + '</select></label>'
    + '<button class="icon-button destructive category-task-remove" type="button" data-remove-category-task title="删除子任务"><i data-lucide="trash-2"></i></button>'
    + '</div>';
}

function updateCategoryEditorCount() {
  const count = document.querySelectorAll("#category-task-editor .category-task-editor-row").length;
  el("#category-editor-count").textContent = count + " 项";
}

function addCategoryTaskEditor(task = {}) {
  el("#category-task-editor").insertAdjacentHTML("beforeend", categoryTaskEditorRow(task));
  updateCategoryEditorCount();
  refreshIcons();
}

function openTaskCategoryDialog(id = null) {
  const category = id ? (state.data.taskCategories || []).find((item) => item.id === id) : null;
  if (id && (!category || category.builtin)) return toast("这个类别不能编辑。", "error");
  state.editingCategoryId = category?.id || null;
  el("#task-category-form").reset();
  el("#task-category-name").value = category?.name || "";
  el("#task-category-dialog-title").textContent = category ? "编辑自定义类别" : "新建自定义类别";
  el("#category-task-editor").innerHTML = "";
  for (const task of category?.tasks?.length ? category.tasks : [{}]) addCategoryTaskEditor(task);
  el("#task-category-dialog").showModal();
}

function taskCategoryFormInput() {
  const tasks = [...document.querySelectorAll("#category-task-editor .category-task-editor-row")].map((row) => ({
    id: row.dataset.categoryTaskId || undefined,
    platform: row.querySelector('[data-category-task-field="platform"]').value,
    keyword: row.querySelector('[data-category-task-field="keyword"]').value,
    location: row.querySelector('[data-category-task-field="location"]').value,
    postedWithinDays: Number(row.querySelector('[data-category-task-field="postedWithinDays"]').value)
  }));
  return { name: el("#task-category-name").value, tasks };
}

async function saveTaskCategory(event) {
  event.preventDefault();
  const id = state.editingCategoryId;
  try {
    await api(id ? "/api/task-categories/" + id : "/api/task-categories", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(taskCategoryFormInput())
    });
    el("#task-category-dialog").close();
    state.editingCategoryId = null;
    await reload();
    toast(id ? "自定义类别已更新。" : "自定义类别已创建。先预检后即可导入。", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteTaskCategory(id) {
  const category = (state.data.taskCategories || []).find((item) => item.id === id);
  if (!category || category.builtin) return;
  if (!window.confirm(`删除自定义类别“${category.name}”？已导入的当天任务不会被删除。`)) return;
  try {
    await api("/api/task-categories/" + id, { method: "DELETE" });
    state.selectedCategoryIds.delete(id);
    state.expandedCategoryIds.delete(id);
    await reload();
    toast("自定义类别已删除。", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function prepareSelectedCategories(mode) {
  const categoryIds = [...state.selectedCategoryIds];
  if (!categoryIds.length) return;
  const launcher = window.open("about:blank", "job-agent-preflight-batch");
  const button = el(mode === "import" ? "#import-selected-categories" : "#preflight-selected-categories");
  button.disabled = true;
  button.classList.add("is-busy");
  try {
    const prepared = await api("/api/task-categories/prepare", {
      method: "POST",
      body: JSON.stringify({ categoryIds, mode })
    });
    let batch = null;
    if (prepared.pending) {
      batch = await api("/api/task-validations/start", {
        method: "POST",
        body: JSON.stringify({ validationIds: prepared.validationIds })
      });
    }
    const firstLaunch = batch?.launchUrls?.[0];
    if (launcher && firstLaunch?.url) launcher.location.href = firstLaunch.url;
    else launcher?.close();
    if (mode === "import") state.selectedCategoryIds.clear();
    state.view = "routine";
    state.routinePane = "plan";
    persistView();
    await reload();
    if (firstLaunch?.url && !launcher) {
      toast("预检窗口被浏览器拦截。已保存待预检任务，请允许弹窗后点击统一预检。", "error");
    } else if (mode === "import" && prepared.pending) {
      toast(`已导入 ${prepared.added} 项；另有 ${prepared.pending} 项正在预检，通过后会自动加入任务列表。`);
    } else if (mode === "import") {
      toast(`已导入 ${prepared.added} 项任务，${prepared.alreadyAdded} 项已在列表中。`);
    } else if (prepared.pending) {
      toast(`已开始预检 ${prepared.pending} 项子任务。`);
    } else {
      toast("所选类别的子任务都已通过预检。", "success");
    }
  } catch (error) {
    launcher?.close();
    toast(error.message, "error");
  } finally {
    button.classList.remove("is-busy");
    renderTaskCategories();
    refreshIcons();
  }
}

function openRoutineTaskDialog() {
  state.editingValidationId = null;
  el("#routine-task-form").reset();
  el("#routine-task-dialog-title").textContent = "添加待预检任务";
  el("#routine-task-submit-label").textContent = "加入待预检";
  el("#routine-task-dialog").showModal();
}

function openValidationEditor(id) {
  const validation = state.data.validations.find((item) => item.id === id);
  if (!validation) return toast("预检记录不存在。", "error");
  state.editingValidationId = id;
  el("#routine-task-platform").value = validation.platform;
  el("#routine-task-keyword").value = validation.keyword;
  el("#routine-task-location").value = validation.location;
  el("#routine-task-time").value = String(validation.postedWithinDays);
  el("#routine-task-dialog-title").textContent = "修改待预检任务";
  el("#routine-task-submit-label").textContent = "保存到待预检";
  el("#routine-task-dialog").showModal();
}

function routineTaskInput() {
  return {
    platform: el("#routine-task-platform").value,
    keyword: el("#routine-task-keyword").value,
    location: el("#routine-task-location").value,
    postedWithinDays: Number(el("#routine-task-time").value)
  };
}

async function submitRoutineTask(event) {
  event.preventDefault();
  const editingId = state.editingValidationId;
  try {
    await api(editingId ? "/api/task-validations/" + editingId : "/api/task-validations", {
      method: editingId ? "PUT" : "POST",
      body: JSON.stringify(routineTaskInput())
    });
    el("#routine-task-dialog").close();
    state.editingValidationId = null;
    await reload();
    toast(editingId ? "修改已保存，请统一预检。" : "任务已加入待预检列表。可继续添加，最后统一预检。");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function retryValidation(id) {
  try {
    const result = await api("/api/task-validations/" + id + "/retry", { method: "POST", body: "{}" });
    await reload();
    const message = result.routineTaskRemoved
      ? "已移回待预检，原每日任务会在重新验证通过后恢复。"
      : "已移回待统一预检列表。";
    toast(message);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function startPreflightBatch() {
  const platforms = [...new Set((state.data.validations || [])
    .filter((validation) => validation.status === "WAITING_FOR_WORKER")
    .map((validation) => validation.platform))];
  if (!platforms.length) return toast("没有等待预检的任务。", "error");
  const launcher = window.open("about:blank", "job-agent-preflight-batch");
  const button = el("#start-preflight-batch");
  button.disabled = true;
  button.classList.add("is-busy");
  try {
    const result = await api("/api/task-validations/start", { method: "POST", body: "{}" });
    const firstLaunch = result.launchUrls[0];
    if (launcher && firstLaunch?.url) launcher.location.href = firstLaunch.url;
    else launcher?.close();
    state.view = "routine";
    state.routinePane = "plan";
    await reload();
    const blocked = Boolean(firstLaunch?.url && !launcher);
    toast(blocked
      ? "预检窗口被浏览器拦截，请允许此站点弹窗。"
      : "已将 " + result.count + " 条任务加入统一预检，平台会在同一个窗口中依次验证。", blocked ? "error" : "success");
  } catch (error) {
    launcher?.close();
    toast(error.message, "error");
  } finally {
    button.classList.remove("is-busy");
    button.disabled = !(state.data.validations || []).some((validation) => validation.status === "WAITING_FOR_WORKER");
  }
}

async function deleteValidation(id) {
  if (!window.confirm("删除这条预检记录？已通过的每日任务会保留。")) return;
  try {
    const result = await api("/api/task-validations/" + id, { method: "DELETE" });
    await reload();
    toast(result.routineTaskRetained ? "预检记录已删除，每日任务已保留。" : "预检记录已删除。");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteRoutineTask(id) {
  if (!window.confirm("删除这条每日任务？已创建的历史运行不会受影响。")) return;
  try {
    await api("/api/routine-tasks/" + id, { method: "DELETE" });
    await reload();
    toast("每日任务已删除。");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function clearRoutineTasks() {
  if (!window.confirm("清空全部已验证的每日任务？此操作不会删除历史运行和职位汇总。")) return;
  try {
    const result = await api("/api/routine-tasks", { method: "DELETE" });
    await reload();
    toast("已清空 " + result.cleared.count + " 条每日任务。");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteRunTask(id, isRunning) {
  const message = isRunning
    ? "取消这个正在执行的任务？当前页面可能会继续完成扫描，但其回传结果不会导入。"
    : "从本次运行队列移除这个任务？";
  if (!window.confirm(message)) return;
  const run = currentRun();
  if (!run) return;
  try {
    const result = await api("/api/runs/" + run.id + "/tasks/" + id, { method: "DELETE" });
    await reload();
    toast(result.cancelled ? "任务已取消，后续回传会被忽略。" : "任务已从本次队列移除。");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function clearRunQueue() {
  const run = currentRun();
  if (!run || !window.confirm("清空本次运行队列？正在执行的任务会被取消，其稍后回传的结果不会导入。")) return;
  try {
    const result = await api("/api/runs/" + run.id + "/tasks", { method: "DELETE" });
    await reload();
    toast("已移除 " + result.cleared.removed + " 项并取消 " + result.cleared.cancelled + " 项任务。");
  } catch (error) {
    toast(error.message, "error");
  }
}

function notifyPausedTasks(run) {
  for (const task of run.tasks.filter((item) => item.status === "needs_user_action")) {
    if (state.notifiedTaskIds.has(task.id)) continue;
    state.notifiedTaskIds.add(task.id);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Job Agent needs help", { body: names[task.platform] + ": " + (task.reason || "需要人工处理") });
    }
  }
}

async function resumeTask(id) {
  try {
    await api("/api/tasks/" + id + "/resume", { method: "POST", body: "{}" });
    await reload();
    toast("任务已恢复；对应 worker 会继续领取。", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function rerunTask(id) {
  const run = currentRun();
  if (!run) return;
  const launcher = window.open("about:blank", "job-agent-worker-launch");
  try {
    const result = await api("/api/runs/" + run.id + "/tasks/" + id + "/retry", { method: "POST", body: "{}" });
    if (launcher && result.launchUrl) launcher.location.href = result.launchUrl;
    else launcher?.close();
    await reload();
    state.routinePane = "monitor";
    state.view = "routine";
    render();
    toast("任务已重新加入队列。", "success");
  } catch (error) {
    launcher?.close();
    toast(error.message, "error");
  }
}

async function addValidationTask(id) {
  try {
    const result = await api("/api/task-validations/" + id + "/add", { method: "POST", body: "{}" });
    await reload();
    toast(result.added ? "已添加到每日任务。" : "该任务已在每日任务列表中。", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function saveSettings() {
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify(settingPayload()) });
    await reload();
    toast("搜索设置已保存。");
  } catch (error) {
    toast(error.message, "error");
  }
}

function aiConfigPayload() {
  return {
    baseUrl: el("#ai-base-url").value.trim(),
    model: el("#ai-model").value.trim(),
    wireApi: el("#ai-wire-api").value,
    apiKey: el("#ai-api-key").value.trim()
  };
}

async function runAiConfigAction(button, busyLabel, action) {
  const originalMarkup = button.innerHTML;
  button.disabled = true;
  button.classList.add("is-busy");
  button.innerHTML = '<i class="button-spinner" data-lucide="loader-circle"></i><span>' + busyLabel + "</span>";
  refreshIcons();
  try {
    await action();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.classList.remove("is-busy");
    button.innerHTML = originalMarkup;
    button.disabled = button.id === "clear-ai-key" ? !state.data.ai.hasApiKey : false;
    refreshIcons();
  }
}

async function saveAiConfig() {
  const button = el("#save-ai-config");
  await runAiConfigAction(button, "保存中", async () => {
    await api("/api/ai-config", { method: "PUT", body: JSON.stringify(aiConfigPayload()) });
    state.aiConfigDirty = false;
    await reload();
    toast("AI 配置已保存到本机后端。密钥不会回显到页面。");
  });
}

async function testAiConfig() {
  const button = el("#test-ai-config");
  await runAiConfigAction(button, "测试中", async () => {
    const result = await api("/api/ai-config/test", { method: "POST", body: JSON.stringify(aiConfigPayload()) });
    toast("AI 连接成功" + (result.usage?.totalTokens ? "，本次使用 " + result.usage.totalTokens + " tokens。" : "。"));
  });
}

async function clearAiKey() {
  if (!window.confirm("清除保存在本机后端的 AI API Key？")) return;
  const button = el("#clear-ai-key");
  await runAiConfigAction(button, "清除中", async () => {
    await api("/api/ai-config/key", { method: "DELETE", body: "{}" });
    state.aiConfigDirty = false;
    await reload();
    toast("本机 AI API Key 已清除。密钥环境变量不会被修改。");
  });
}

function installWorkers() {
  state.view = "setup";
  render();
}

function openClearAllHistoryDialog() {
  if (state.historyReset.running) return;
  el("#clear-all-history-dialog").showModal();
}

async function clearAllHistory() {
  const dialog = el("#clear-all-history-dialog");
  const resetWindow = window.open("about:blank", "job-agent-history-reset");
  if (!resetWindow) return toast("清理窗口被浏览器拦截，请允许此站点打开弹窗后重试。", "error");
  dialog.close();
  state.historyReset.running = true;
  state.historyReset.completed = new Set();
  state.historyReset.window = resetWindow;
  renderHistoryResetControl();
  try {
    const result = await api("/api/records", { method: "DELETE" });
    await reload();
    state.view = "setup";
    render();
    armHistoryResetTimeout();
    resetWindow.location.href = "https://www.linkedin.com/jobs/search/?jobAgentReset=1&jobAgentResetAll=1";
    const count = Object.values(result.cleared || {}).reduce((total, value) => total + Number(value || 0), 0);
    toast(`Agent 已清除 ${count} 条记录，正在依次清理三个 Worker。`);
  } catch (error) {
    clearTimeout(state.historyReset.timeout);
    state.historyReset.running = false;
    resetWindow.close();
    state.historyReset.window = null;
    renderHistoryResetControl();
    toast(error.message, "error");
  }
}

function addSetting(kind) {
  const item = kind === "location"
    ? { id: "location_" + Date.now(), name: "", enabled: true }
    : { id: "search_" + Date.now(), keyword: "", enabled: true, priority: 50 };
  el(kind === "location" ? "#locations-list" : "#searches-list").insertAdjacentHTML("beforeend", settingsRow(kind, item));
  refreshIcons();
}

function openImport() {
  renderImportOptions();
  el("#import-dialog").showModal();
}

async function importJobs(event) {
  event.preventDefault();
  try {
    const jobs = JSON.parse(el("#import-json").value);
    const result = await api("/api/jobs/import", {
      method: "POST",
      body: JSON.stringify({ jobs, runId: el("#import-run").value || null, label: "dashboard import" })
    });
    el("#import-dialog").close();
    el("#import-json").value = "";
    await reload();
    state.view = "jobs";
    render();
    toast("已导入 " + result.jobs.length + " 个职位。");
  } catch (error) {
    toast(error.message.includes("JSON") ? "请输入有效的 JSON 职位数组。" : error.message, "error");
  }
}

function openFeedback(id) {
  const job = state.data.jobs.find((item) => item.id === id);
  if (!job) return;
  state.feedbackJobId = id;
  el("#feedback-title").textContent = job.title;
  el("#feedback-job-meta").textContent = [job.company, job.location, names[job.source]].filter(Boolean).join(" · ");
  const reason = job.feedback?.reason || "";
  const reasonInput = document.querySelector('input[name="feedback-reason"][value="' + reason + '"]')
    || document.querySelector('input[name="feedback-reason"][value=""]');
  reasonInput.checked = true;
  el("#feedback-note").value = job.feedback?.note || "";
  el("#remove-feedback").hidden = job.feedback?.helpfulness !== "NOT_HELPFUL";
  el("#feedback-dialog").showModal();
}

async function saveJobFeedback(event) {
  event.preventDefault();
  if (!state.feedbackJobId) return;
  const button = el("#save-feedback");
  button.disabled = true;
  try {
    await api("/api/jobs/" + state.feedbackJobId + "/feedback", {
      method: "PUT",
      body: JSON.stringify({
        notHelpful: true,
        reason: document.querySelector('input[name="feedback-reason"]:checked')?.value || null,
        note: el("#feedback-note").value
      })
    });
    el("#feedback-dialog").close();
    await reload();
    toast("已记录“没帮助”，完成本次审阅后可让 Agent 复盘。");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function removeJobFeedback() {
  if (!state.feedbackJobId) return;
  const button = el("#remove-feedback");
  button.disabled = true;
  try {
    await api("/api/jobs/" + state.feedbackJobId + "/feedback", {
      method: "PUT",
      body: JSON.stringify({ notHelpful: false })
    });
    el("#feedback-dialog").close();
    await reload();
    toast("已撤销这条反馈；可更新复盘以纠正学习结果。");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function completeRunReview() {
  const run = selectedReviewRun();
  if (!run) return;
  const button = el("#complete-run-review");
  const label = button.querySelector("span");
  const original = label.textContent;
  button.disabled = true;
  button.classList.add("is-busy");
  label.textContent = "正在复盘...";
  try {
    const result = await api("/api/runs/" + run.id + "/reflection", { method: "POST", body: "{}" });
    await reload();
    toast(result.reflection.engine === "ai" ? "AI 已完成本次审阅复盘。" : "本地复盘已完成；偏好会用于后续筛选。");
  } catch (error) {
    label.textContent = original;
    button.disabled = false;
    toast(error.message, "error");
  } finally {
    button.classList.remove("is-busy");
  }
}

function openReview(id) {
  const job = state.data.jobs.find((item) => item.id === id);
  if (!job) return;
  state.jobId = id;
  el("#review-source").textContent = names[job.source] || job.source;
  el("#review-title").textContent = job.title;
  el("#review-meta").innerHTML = escapeHtml(job.company || "-") + " · " + escapeHtml(job.location || "-") + " " + badge(job.screening.category, "category-" + job.screening.category.toLowerCase()) + aiReviewBadge(job);
  el("#review-description").value = job.description || "";
  el("#review-note").textContent = job.screening.reason || "";
  el("#review-dialog").showModal();
  refreshIcons();
}

async function reviewJob(event) {
  event.preventDefault();
  const button = el("#submit-review");
  if (button.disabled) return;
  const label = button.querySelector("span");
  button.disabled = true;
  if (label) label.textContent = "AI 审阅中...";
  try {
    const result = await api("/api/jobs/" + state.jobId + "/review", {
      method: "POST",
      body: JSON.stringify({ description: el("#review-description").value })
    });
    el("#review-dialog").close();
    await reload();
    state.view = "jobs";
    render();
    toast(result.job.screening.screeningStatus === "AI_ERROR" ? "JD 审阅出现错误，已保留岗位。" : "JD 审阅已完成。");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    if (label) label.textContent = "审阅 JD";
  }
}

document.addEventListener("click", (event) => {
  const view = event.target.closest("[data-view]");
  if (view) {
    if (view.dataset.view === "jobs" && state.view !== "jobs") {
      state.jobsPane = "current";
      state.historyRunId = "";
    }
    state.view = view.dataset.view;
    return render();
  }
  const jobsPane = event.target.closest("[data-jobs-pane]");
  if (jobsPane) {
    state.jobsPane = jobsPane.dataset.jobsPane;
    state.historyRunId = "";
    renderJobs();
    return refreshIcons();
  }
  const profilePane = event.target.closest("[data-profile-pane]");
  if (profilePane) return setProfilePane(profilePane.dataset.profilePane);
  const routinePane = event.target.closest("[data-routine-pane]");
  if (routinePane) return setRoutinePane(routinePane.dataset.routinePane);
  const review = event.target.closest("[data-review]");
  if (review) return openReview(review.dataset.review);
  const feedback = event.target.closest("[data-feedback]");
  if (feedback) return openFeedback(feedback.dataset.feedback);
  const profile = event.target.closest("[data-profile]");
  if (profile) { state.profileId = profile.dataset.profile; state.profilePane = "editor"; renderProfile(); return refreshIcons(); }
  const profileChip = event.target.closest("[data-profile-chip]");
  if (profileChip) return state.suppressProfileChipClick ? undefined : toggleProfileChip(profileChip);
  const addProfileChipButton = event.target.closest("[data-add-profile-chip]");
  if (addProfileChipButton) return addProfileChip(addProfileChipButton.dataset.addProfileChip);
  const confirmProfileChipButton = event.target.closest("[data-confirm-profile-chip]");
  if (confirmProfileChipButton) {
    const composer = confirmProfileChipButton.closest("[data-profile-inline-add]");
    return commitProfileChip(confirmProfileChipButton.dataset.confirmProfileChip, composer?.querySelector("input")?.value);
  }
  if (event.target.closest("[data-cancel-profile-chip]")) return closeProfileChipComposers();
  const acceptSuggestedButton = event.target.closest("[data-accept-suggested]");
  if (acceptSuggestedButton) return acceptSuggestedGroup(acceptSuggestedButton.dataset.acceptSuggested);
  if (event.target.closest("#delete-profile-chips")) return deleteSelectedProfileChips();
  const save = event.target.closest("[data-save-profile]");
  if (save) return saveProfile(save.dataset.saveProfile);
  const activate = event.target.closest("[data-activate]");
  if (activate) return activateProfile(activate.dataset.activate);
  const clearOtherProfilesButton = event.target.closest("[data-clear-other-profiles]");
  if (clearOtherProfilesButton) return clearOtherProfiles();
  const toggleCategoryButton = event.target.closest("[data-toggle-category]");
  if (toggleCategoryButton) {
    const id = toggleCategoryButton.dataset.toggleCategory;
    if (state.expandedCategoryIds.has(id)) state.expandedCategoryIds.delete(id);
    else state.expandedCategoryIds.add(id);
    renderTaskCategories();
    return refreshIcons();
  }
  const editCategoryButton = event.target.closest("[data-edit-category]");
  if (editCategoryButton) return openTaskCategoryDialog(editCategoryButton.dataset.editCategory);
  const deleteCategoryButton = event.target.closest("[data-delete-category]");
  if (deleteCategoryButton) return deleteTaskCategory(deleteCategoryButton.dataset.deleteCategory);
  const removeCategoryTaskButton = event.target.closest("[data-remove-category-task]");
  if (removeCategoryTaskButton) {
    const rows = document.querySelectorAll("#category-task-editor .category-task-editor-row");
    if (rows.length <= 1) return toast("类别至少需要一个子任务。", "error");
    removeCategoryTaskButton.closest(".category-task-editor-row").remove();
    updateCategoryEditorCount();
    return;
  }
  const resumeTaskButton = event.target.closest("[data-resume-task]");
  if (resumeTaskButton) return resumeTask(resumeTaskButton.dataset.resumeTask);
  const retryButton = event.target.closest("[data-retry-validation]");
  if (retryButton) return retryValidation(retryButton.dataset.retryValidation);
  const editValidationButton = event.target.closest("[data-edit-validation]");
  if (editValidationButton) return openValidationEditor(editValidationButton.dataset.editValidation);
  const deleteValidationButton = event.target.closest("[data-delete-validation]");
  if (deleteValidationButton) return deleteValidation(deleteValidationButton.dataset.deleteValidation);
  const deleteRoutineTaskButton = event.target.closest("[data-delete-routine-task]");
  if (deleteRoutineTaskButton) return deleteRoutineTask(deleteRoutineTaskButton.dataset.deleteRoutineTask);
  const runRoutineTaskButton = event.target.closest("[data-run-routine-task]");
  if (runRoutineTaskButton) return runRoutineTask(runRoutineTaskButton.dataset.runRoutineTask);
  const addValidationTaskButton = event.target.closest("[data-add-validation-task]");
  if (addValidationTaskButton) return addValidationTask(addValidationTaskButton.dataset.addValidationTask);
  const rerunTaskButton = event.target.closest("[data-rerun-task]");
  if (rerunTaskButton) return rerunTask(rerunTaskButton.dataset.rerunTask);
  const deleteRunTaskButton = event.target.closest("[data-delete-run-task]");
  if (deleteRunTaskButton) return deleteRunTask(deleteRunTaskButton.dataset.deleteRunTask, deleteRunTaskButton.dataset.running === "true");
  const copyWorkerButton = event.target.closest("[data-copy-worker]");
  if (copyWorkerButton) return copyWorkerScript(copyWorkerButton);
  const closeDialog = event.target.closest("[data-close-dialog]");
  if (closeDialog) return el("#" + closeDialog.dataset.closeDialog).close();
  const add = event.target.closest("[data-add]");
  if (add) return addSetting(add.dataset.add);
  const remove = event.target.closest("[data-remove]");
  if (remove) return remove.closest(".settings-row").remove();
});

document.addEventListener("input", (event) => {
  if (event.target.matches("#job-search")) renderJobs();
  if (event.target.matches("#ai-base-url, #ai-model, #ai-api-key")) state.aiConfigDirty = true;
});
document.addEventListener("keydown", (event) => {
  const input = event.target.closest("[data-profile-inline-add] input");
  if (!input) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeProfileChipComposers();
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const composer = input.closest("[data-profile-inline-add]");
    commitProfileChip(composer.dataset.profileInlineAdd, input.value);
  }
});
document.addEventListener("pointerdown", startProfileChipPointerDrag);
document.addEventListener("pointermove", moveProfileChipPointer, { passive: false });
document.addEventListener("pointerup", finishProfileChipPointerDrag);
document.addEventListener("pointercancel", finishProfileChipPointerDrag);
document.addEventListener("change", (event) => {
  if (event.target.matches("#job-category, #job-source, #job-status, #job-sort")) renderJobs();
  if (event.target.matches("#job-history-run")) {
    state.historyRunId = event.target.value;
    renderJobs();
    refreshIcons();
  }
  if (event.target.matches("#ai-wire-api")) state.aiConfigDirty = true;
  if (event.target.matches("[data-category-select]")) {
    const id = event.target.dataset.categorySelect;
    if (event.target.checked) state.selectedCategoryIds.add(id);
    else state.selectedCategoryIds.delete(id);
    renderTaskCategories();
    refreshIcons();
  }
  if (event.target.matches("#select-all-categories")) {
    state.selectedCategoryIds = event.target.checked
      ? new Set((state.data.taskCategories || []).map((category) => category.id))
      : new Set();
    renderTaskCategories();
    refreshIcons();
  }
});

window.addEventListener("message", (event) => {
  const platformOrigins = new Set([
    "https://www.linkedin.com",
    "https://au.indeed.com",
    "https://www.seek.com.au",
    "https://au.seek.com"
  ]);
  if (!platformOrigins.has(event.origin)) return;
  if (event.data?.type === "job-agent-reset-progress") {
    if (!state.historyReset.running) return;
    state.historyReset.completed.add(event.data.platform);
    armHistoryResetTimeout();
    renderHistoryResetControl();
    toast((names[event.data.platform] || event.data.platform) + " Worker 历史已清除。");
    return;
  }
  if (event.data?.type === "job-agent-reset-finished") {
    clearTimeout(state.historyReset.timeout);
    state.historyReset.running = false;
    state.historyReset.completed = new Set(["linkedin", "indeed", "seek"]);
    state.historyReset.window = null;
    state.view = "setup";
    persistView();
    window.focus();
    reload().then(() => toast("Agent 和三个 Worker 的全部历史记录已清除。"))
      .catch((error) => toast(error.message, "error"));
    return;
  }
  if (!["job-agent-preflight-finished", "job-agent-run-finished"].includes(event.data?.type)) return;
  state.view = "routine";
  state.routinePane = event.data.type === "job-agent-run-finished" ? "monitor" : "plan";
  persistView();
  window.focus();
  reload().catch((error) => toast(error.message, "error"));
});

el("#start-run").addEventListener("click", createRun);
el("#start-run-secondary").addEventListener("click", createRun);
el("#open-routine-task").addEventListener("click", openRoutineTaskDialog);
el("#open-task-category").addEventListener("click", () => openTaskCategoryDialog());
el("#add-category-task").addEventListener("click", () => addCategoryTaskEditor());
el("#preflight-selected-categories").addEventListener("click", () => prepareSelectedCategories("preflight"));
el("#import-selected-categories").addEventListener("click", () => prepareSelectedCategories("import"));
el("#start-preflight-batch").addEventListener("click", startPreflightBatch);
el("#clear-routine-tasks").addEventListener("click", clearRoutineTasks);
el("#clear-run-queue").addEventListener("click", clearRunQueue);
el("#open-import").addEventListener("click", openImport);
el("#extract-resume").addEventListener("click", uploadResume);
el("#copy-external-profile-prompt").addEventListener("click", copyExternalGptPrompt);
el("#generate-profile").addEventListener("click", generateProfile);
el("#save-settings").addEventListener("click", saveSettings);
el("#save-ai-config").addEventListener("click", saveAiConfig);
el("#test-ai-config").addEventListener("click", testAiConfig);
el("#clear-ai-key").addEventListener("click", clearAiKey);
el("#install-workers").addEventListener("click", installWorkers);
el("#open-clear-all-history").addEventListener("click", openClearAllHistoryDialog);
el("#confirm-clear-all-history").addEventListener("click", clearAllHistory);
el("#import-form").addEventListener("submit", importJobs);
el("#routine-task-form").addEventListener("submit", submitRoutineTask);
el("#task-category-form").addEventListener("submit", saveTaskCategory);
el("#review-form").addEventListener("submit", reviewJob);
el("#submit-review").addEventListener("click", reviewJob);
el("#feedback-form").addEventListener("submit", saveJobFeedback);
el("#remove-feedback").addEventListener("click", removeJobFeedback);
el("#complete-run-review").addEventListener("click", completeRunReview);

reload().catch((error) => {
  el("#api-status").textContent = "本地服务未连接";
  toast(error.message, "error");
});

setInterval(() => {
  if (state.view === "overview" || state.view === "routine") reload().catch(() => {});
}, 8000);
