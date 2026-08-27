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
  feedbackJobId: null,
  feedbackMode: "positive",
  pendingRunTaskIds: null,
  pendingRunProfileId: null,
  resumeSource: "",
  editingValidationId: null,
  notifiedTaskIds: new Set(),
  jobsPane: "current",
  historyRunId: "",
  historyTaskId: "",
  currentRunId: "",
  currentRunTaskId: "",
  routinePane: "plan",
  selectedCategoryIds: new Set(),
  selectedRoutineTaskIds: new Set(),
  routineSelectionAnchorId: "",
  expandedCategoryIds: new Set(["standalone"]),
  editingCategoryId: null,
  categoryEditorSelectedValidationIds: new Set(),
  categoryEditorTaskIdsByValidationId: new Map(),
  profilePane: "editor",
  profileSection: "basicInfo",
  workerScripts: {},
  workerScriptsLoading: false,
  aiConfigDirty: false,
  historyReset: { running: false, completed: new Set(), timeout: null, window: null },
  historyMigration: { running: false, completed: new Set(), results: {}, timeout: null, window: null },
  jobAssistantOpen: false,
  jobAssistantBusy: false,
  jobAssistantMessages: [],
  jobAssistantContextKey: "",
  profilePointerDrag: null,
  suppressProfileChipClick: false,
  settingsProfileId: null,
  coverLetterJobId: null,
  coverLetterCurrent: null
};

const names = { linkedin: "LinkedIn", indeed: "Indeed", seek: "SEEK", manual: "手动" };
const routinePlatformOrder = ["linkedin", "seek", "indeed"];
const postedWithinLabels = { 0: "不限", 1: "过去 24 小时", 3: "过去 3 天", 7: "过去 7 天", 14: "过去 14 天", 30: "过去 30 天" };
const jobTypeLabels = {
  any: "不限",
  "full-time": "Full-time",
  "part-time": "Part-time",
  casual: "Casual",
  contract: "Contract / Temp",
  permanent: "Permanent",
  temporary: "Temporary",
  "temp-to-perm": "Temp to perm",
  "fixed-term": "Fixed term",
  graduate: "Graduate",
  seasonal: "Seasonal",
  subcontract: "Subcontract",
  "student-job": "Student Job"
};
const platformJobTypes = {
  linkedin: ["any"],
  seek: ["any", "full-time", "part-time", "contract", "casual"],
  indeed: ["any", "casual", "part-time", "full-time", "permanent", "temporary", "temp-to-perm", "fixed-term", "graduate", "seasonal", "contract", "subcontract", "student-job"]
};
const validationStatusLabels = {
  WAITING_FOR_WORKER: "等待预检",
  VALID: "已验证",
  FAILED: "预检失败",
  NEEDS_USER_ACTION: "需要人工处理"
};
const feedbackReasonLabels = {
  ROLE_RELEVANT: "方向合适",
  SKILL_MATCH: "技能匹配",
  WOULD_APPLY: "准备申请",
  REJECTION_CORRECT: "Rejected 判断正确",
  CLASSIFICATION_WRONG: "分类错了",
  NOT_RELEVANT: "与我无关",
  ROLE_NOT_INTERESTED: "方向不感兴趣",
  SKILL_MISMATCH: "技能不合适",
  WOULD_NOT_APPLY: "不会申请"
};
const scoreCategoryLabels = {
  STRONG_MATCH: "强匹配",
  GOOD_MATCH: "良好匹配",
  MAYBE: "可考虑",
  LOW_MATCH: "低匹配",
  REJECTED: "已排除"
};
const titleClassificationLabels = {
  CLEAR_MATCH: "标题明确匹配",
  AMBIGUOUS: "标题信息不足",
  CLEAR_REJECT: "标题明确不匹配"
};
const workRightsLabels = {
  ELIGIBLE: "签证 / 工作权利符合",
  INELIGIBLE: "签证 / 工作权利不符合",
  UNCERTAIN: "签证 / 工作权利待确认",
  OVERRIDE_KEEP: "命中强制保留条件",
  NOT_STATED: "JD 未说明签证要求"
};
const workRightsShortLabels = {
  ELIGIBLE: "符合",
  INELIGIBLE: "不符合",
  UNCERTAIN: "待确认",
  OVERRIDE_KEEP: "强制保留",
  NOT_STATED: "未说明"
};

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

const screeningStatusLabels = {
  TITLE_SCREENED: "标题初筛完成",
  NEEDS_JD_REVIEW: "等待 JD 审阅",
  JD_FETCHING: "正在获取 JD",
  JD_FETCH_FAILED: "JD 获取失败",
  AI_QUEUED: "等待 AI 审阅",
  AI_REVIEWING: "AI 审阅中",
  AI_RETRY_WAIT: "AI 暂停后重试",
  AI_ERROR: "AI 审阅失败",
  JD_SCREENED: "完整 JD 已审阅",
  PROFILE_REQUIRED: "需要职业画像",
  AI_NOT_CONFIGURED: "AI 未配置",
  AI_BUDGET_SKIPPED: "已达到 AI 审阅上限"
};
const externalGptProfilePrompt = [
  "You are a meticulous resume data extractor. The user will attach or paste their resume in this chat.",
  "Extract only facts explicitly supported by the resume. Never invent missing contact details, dates, work rights, achievements, or preferences.",
  "Empty strings and empty arrays are valid. Keep each work, project, education, activity, certification, language, and honor as one complete entry.",
  "Return JSON only, with exactly this shape:",
  '{"schemaVersion":2,"basicInfo":{"name":"","location":"","phone":"","email":"","linkedinUrl":"","githubUrl":"","websiteUrl":""},"visa":{"visaType":"","visaName":"","grantedDate":"","expiryDate":"","details":"","forceKeepRequirements":[]},"workExperience":[{"company":"","role":"","location":"","startDate":"","endDate":"","description":"","highlights":[]}],"projectExperience":[{"name":"","role":"","startDate":"","endDate":"","url":"","description":"","technologies":[],"highlights":[]}],"education":[{"institution":"","location":"","degree":"","field":"","startDate":"","endDate":"","description":""}],"extracurricular":[{"organization":"","role":"","location":"","startDate":"","endDate":"","description":"","highlights":[]}],"certifications":[{"name":"","issuer":"","issuedDate":"","expiryDate":"","credentialId":"","url":""}],"languages":[{"language":"","proficiency":""}],"skills":[],"honors":[{"title":"","issuer":"","date":"","description":""}],"customSections":[{"title":"","entries":[{"title":"","subtitle":"","location":"","startDate":"","endDate":"","description":"","highlights":[]}]}]}'
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
  { id: "linkedin", name: "LinkedIn", version: "v1.1.0", domain: "linkedin.com/jobs", path: "/workers/linkedin/linkedin-agent-worker.user.js" },
  { id: "indeed", name: "Indeed", version: "v1.1.1", domain: "au.indeed.com/jobs", path: "/workers/indeed/indeed-agent-worker.user.js" },
  { id: "seek", name: "SEEK", version: "v1.1.0", domain: "seek.com.au/jobs", path: "/workers/seek/seek-agent-worker.user.js" }
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
const structuredProfileSections = [
  { key: "basicInfo", label: "基本信息", icon: "contact", singular: true },
  { key: "visa", label: "身份与签证", icon: "badge-check", singular: true },
  { key: "workExperience", label: "工作经历", icon: "briefcase-business", addLabel: "添加工作经历" },
  { key: "projectExperience", label: "项目经历", icon: "blocks", addLabel: "添加项目经历" },
  { key: "education", label: "教育经历", icon: "graduation-cap", addLabel: "添加教育经历" },
  { key: "extracurricular", label: "课外活动经历", icon: "users", addLabel: "添加活动经历" },
  { key: "certifications", label: "证书", icon: "badge-check", addLabel: "添加证书" },
  { key: "languages", label: "语言", icon: "languages", addLabel: "添加语言" },
  { key: "skills", label: "技能", icon: "code-2", skills: true, addLabel: "添加技能" },
  { key: "honors", label: "荣誉", icon: "award", addLabel: "添加荣誉" }
];
const profileEntryFields = {
  workExperience: [["company", "公司"], ["role", "职位"], ["location", "地点"], ["startDate", "开始时间"], ["endDate", "结束时间"], ["description", "经历说明", "textarea"], ["highlights", "职责与成果（一行一项）", "lines"]],
  projectExperience: [["name", "项目名称"], ["role", "担任角色"], ["startDate", "开始时间"], ["endDate", "结束时间"], ["url", "项目网址", "url"], ["description", "项目说明", "textarea"], ["technologies", "技术（一行一项）", "lines"], ["highlights", "成果（一行一项）", "lines"]],
  education: [["institution", "学校"], ["location", "地点"], ["degree", "学位"], ["field", "专业"], ["startDate", "开始时间"], ["endDate", "结束时间"], ["description", "补充说明", "textarea"]],
  extracurricular: [["organization", "组织"], ["role", "角色"], ["location", "地点"], ["startDate", "开始时间"], ["endDate", "结束时间"], ["description", "经历说明", "textarea"], ["highlights", "活动与成果（一行一项）", "lines"]],
  certifications: [["name", "证书名称"], ["issuer", "颁发机构"], ["issuedDate", "取得时间"], ["expiryDate", "到期时间"], ["credentialId", "证书编号"], ["url", "证书网址", "url"]],
  languages: [["language", "语言"], ["proficiency", "熟练程度"]],
  honors: [["title", "荣誉名称"], ["issuer", "颁发方"], ["date", "时间"], ["description", "说明", "textarea"]],
  custom: [["title", "标题"], ["subtitle", "副标题 / 组织"], ["location", "地点"], ["startDate", "开始时间"], ["endDate", "结束时间"], ["description", "说明", "textarea"], ["highlights", "要点（一行一项）", "lines"]]
};

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
  "local-rules": "本地规则",
  manual: "手动创建",
  copied: "复制创建"
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

function screeningMethodBadge(job) {
  const screening = job.screening || {};
  const ai = /^ai(?:$|-)/i.test(screening.engine || "");
  const rawAiError = String(job.aiReview?.reason || screening.reason || "");
  const aiErrorMessage = /upstream_error|api_error|temporar(?:y|ily)|\b50[234]\b/i.test(rawAiError)
    ? "AI 服务上游暂时不可用，完整 JD 已保留，可稍后重新审阅"
    : /fetch failed|network|connection|socket/i.test(rawAiError)
      ? "连接 AI 服务失败，完整 JD 已保留，请检查网络后重试"
      : rawAiError.replace(/^AI JD review failed:\s*/i, "").slice(0, 360) || "AI 审阅发生错误，结果未确认";
  const pendingPresentation = {
    AI_QUEUED: ["clock-3", "AI 排队中", "完整 JD 已获取，正在等待自动 AI 审阅"],
    AI_REVIEWING: ["loader-circle", "AI 审阅中", "AI 正在结合职业画像评估完整 JD"],
    AI_RETRY_WAIT: ["timer-reset", "AI 稍后重试", aiErrorMessage + (job.aiReview?.retryAt ? `；预计 ${dateTime(job.aiReview.retryAt)} 自动重试` : "")],
    JD_FETCHING: ["file-search", "正在获取 JD", "Worker 正在原职位页面读取完整 JD"],
    JD_FETCH_FAILED: ["file-warning", "JD 获取失败", job.descriptionFetchError || "未能自动获取完整 JD，可稍后单独重跑任务"],
    AI_NOT_CONFIGURED: ["key-round", "等待 AI 配置", "完整 JD 已获取；配置 AI 后会自动继续审阅"],
    PROFILE_REQUIRED: ["contact-round", "等待职业画像", "完整 JD 已获取；激活职业画像后会自动继续审阅"],
    AI_BUDGET_SKIPPED: ["gauge", "AI 额度上限", "本次运行达到 AI 自动审阅上限" ]
  }[screening.screeningStatus];
  if (pendingPresentation) {
    return '<span class="badge screening-method-badge is-pending" title="' + escapeHtml(pendingPresentation[2]) + '"><i data-lucide="' + pendingPresentation[0] + '"></i>' + pendingPresentation[1] + '</span>';
  }
  if (screening.screeningStatus === "AI_ERROR") {
    return '<span class="badge screening-method-badge is-error" title="' + escapeHtml(aiErrorMessage) + '"><i data-lucide="triangle-alert"></i>AI 审阅失败</span>';
  }
  if (screening.jdReviewed) {
    return ai
      ? '<span class="badge screening-method-badge ai-review-badge" title="此职位的 JD 已由 AI 审阅"><i data-lucide="sparkles"></i>AI 已审阅 JD</span>'
      : '<span class="badge screening-method-badge" title="此职位的 JD 使用本地规则审阅"><i data-lucide="cpu"></i>本地已审阅 JD</span>';
  }
  return ai
    ? '<span class="badge screening-method-badge ai-review-badge" title="此职位已由 AI 筛查"><i data-lucide="sparkles"></i>AI 已筛查</span>'
    : '<span class="badge screening-method-badge" title="当前只完成了本地标题筛查，尚未进行 AI JD 审阅"><i data-lucide="text-search"></i>本地标题筛查</span>';
}

function workRightsBadge(job) {
  const workRights = job.screening?.workRights;
  if (!workRights?.assessment) return "";
  const presentation = {
    ELIGIBLE: ["shield-check", "签证符合", "is-eligible"],
    INELIGIBLE: ["shield-x", "签证不符", "is-ineligible"],
    UNCERTAIN: ["circle-help", "签证待确认", "is-uncertain"],
    OVERRIDE_KEEP: ["bookmark-check", "签证强制保留", "is-override"],
    NOT_STATED: ["minus", "JD 未提签证", "is-neutral"]
  }[workRights.assessment] || ["circle-help", "签证待确认", "is-uncertain"];
  const requirements = (workRights.requirements || []).length
    ? ` 要求：${workRights.requirements.join("；")}`
    : "";
  return '<span class="badge work-rights-badge ' + presentation[2] + '" title="' + escapeHtml((workRights.reason || "签证结论没有说明。") + requirements)
    + '"><i data-lucide="' + presentation[0] + '"></i>' + presentation[1] + "</span>";
}

function feedbackBadge(job) {
  if (isRejectionApproval(job)) {
    return '<span class="feedback-badge is-helpful"><i data-lucide="thumbs-up"></i>Rejected 判断正确</span>';
  }
  if (isRejectionCorrection(job)) {
    return '<span class="feedback-badge is-correction"><i data-lucide="rotate-ccw"></i>Rejected 判断有误</span>';
  }
  if (job.feedback?.helpfulness === "NOT_HELPFUL") {
    const reason = feedbackReasonLabels[job.feedback.reason];
    return '<span class="feedback-badge is-negative"><i data-lucide="thumbs-down"></i>没用' + (reason ? " · " + escapeHtml(reason) : "") + "</span>";
  }
  if (job.feedback?.helpfulness !== "HELPFUL") return "";
  const reason = feedbackReasonLabels[job.feedback.reason];
  return '<span class="feedback-badge is-helpful"><i data-lucide="thumbs-up"></i>有用' + (reason ? " · " + escapeHtml(reason) : "") + "</span>";
}

function isRejectionCorrection(job) {
  return job.feedback?.helpfulness === "REJECTION_INCORRECT"
    || (job.feedback?.helpfulness === "NOT_HELPFUL" && job.feedback?.reason === "CLASSIFICATION_WRONG");
}

function isRejectionApproval(job) {
  return job.feedback?.helpfulness === "HELPFUL" && job.feedback?.reason === "REJECTION_CORRECT";
}

function hasLikedJobFeedback(job) {
  return (job.feedback?.helpfulness === "HELPFUL" && !isRejectionApproval(job)) || isRejectionCorrection(job);
}

function isRejectedLearningSignal(job) {
  const rejected = job.screening?.category === "REJECTED" || job.screening?.titleClassification === "CLEAR_REJECT";
  if (!rejected || job.screening?.workRights?.assessment === "INELIGIBLE") return false;
  return isRejectionApproval(job) || Boolean(job.screening?.jdReviewed
    && !hasLikedJobFeedback(job)
    && job.learningSignals?.exclusionKeywords?.length);
}

function effectiveJobCategory(job) {
  if (isRejectionCorrection(job)) return "MAYBE";
  if (job.feedback?.helpfulness === "NOT_HELPFUL") {
    return job.screening?.category === "REJECTED" ? "REJECTED" : "LOW_MATCH";
  }
  return job.screening?.category;
}

function activeProfile() {
  return state.data.activeProfile || null;
}

function selectedProfile() {
  return state.data.profiles.find((profile) => profile.id === state.profileId) || null;
}

function profileLabel(profile) {
  return profile?.name || profile?.profile?.basicInfo?.name || `Profile ${profile?.version || ""}`;
}

function selectedSettingsProfile() {
  return state.data.profiles.find((profile) => profile.id === state.settingsProfileId)
    || activeProfile()
    || state.data.profiles[0]
    || null;
}

function contextForProfile(profileId) {
  return state.data.profileContexts?.[profileId] || { exclusionKeywords: [], exclusionSuggestions: [], preferenceModel: null };
}

function profileSelectOptions(selectedId) {
  return (state.data.profiles || []).map((profile) => '<option value="' + profile.id + '"' + (profile.id === selectedId ? " selected" : "") + '>'
    + escapeHtml(profileLabel(profile)) + (profile.id === state.data.activeProfile?.id ? " · 默认" : "") + "</option>").join("");
}

function jobTypeOptions(platform, selected = "any") {
  return (platformJobTypes[platform] || ["any"]).map((value) => '<option value="' + value + '"' + (value === selected ? " selected" : "") + '>'
    + escapeHtml(jobTypeLabels[value] || value) + "</option>").join("");
}

function syncRoutineJobTypeOptions(selected = null) {
  const platform = el("#routine-task-platform").value || "linkedin";
  const current = selected || el("#routine-task-job-type").value || "any";
  const allowed = platformJobTypes[platform] || ["any"];
  el("#routine-task-job-type").innerHTML = jobTypeOptions(platform, allowed.includes(current) ? current : "any");
}

function currentRun() {
  const latest = state.data.runs[0] || null;
  return latest?.reviewCompletedAt ? null : latest;
}

function runIsFinished(run) {
  return Boolean(run && ["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(run.state));
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function todayRoutineTaskRun(routineTaskId) {
  const today = localDateKey(new Date());
  let latest = null;
  for (const run of state.data.runs || []) {
    for (const task of run.tasks || []) {
      if (task.routineTaskId !== routineTaskId || !task.startedAt || localDateKey(task.startedAt) !== today) continue;
      if (!latest || Date.parse(task.startedAt) > Date.parse(latest.startedAt)) latest = task;
    }
  }
  return latest;
}

function todayRoutineTaskBadge(runTask) {
  if (!runTask) return "";
  const startedAt = new Date(runTask.startedAt);
  const time = Number.isFinite(startedAt.getTime())
    ? startedAt.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false })
    : "";
  const status = String(runTask.status || "").toUpperCase();
  const presentation = status === "RUNNING"
    ? { label: "今日运行中", className: "is-running", icon: "loader-circle" }
    : status === "NEEDS_USER_ACTION"
      ? { label: "今日需处理", className: "is-action", icon: "circle-alert" }
      : ["FAILED", "CANCELLED", "SKIPPED"].includes(status)
        ? { label: "今日已尝试", className: "is-attempted", icon: "history" }
        : { label: "今日已运行", className: "is-complete", icon: "check" };
  const title = presentation.label + (time ? "，最近启动于 " + time : "") + "；仍可手动再次运行";
  return '<span class="today-run-badge ' + presentation.className + '" title="' + escapeHtml(title) + '"><i data-lucide="' + presentation.icon + '"></i>'
    + presentation.label + (time ? " " + time : "") + "</span>";
}

function currentRunJobs() {
  const run = currentRun();
  return run ? state.data.jobs.filter((job) => job.runId === run.id && !job.duplicateOf) : [];
}

function pendingReviewTaskEntries() {
  const entries = [];
  for (const run of state.data.runs || []) {
    const runJobs = state.data.jobs.filter((job) => job.runId === run.id);
    for (const task of run.tasks || []) {
      const allJobs = runJobs.filter((job) => matchingRunTask(run, job)?.id === task.id);
      const jobs = allJobs.filter((job) => !job.duplicateOf);
      if (!jobs.some((job) => !job.viewedAt)) continue;
      entries.push({
        run,
        task,
        runId: run.id,
        taskId: task.id,
        platform: task.platform,
        keyword: task.keyword,
        location: task.location,
        postedWithinDays: task.postedWithinDays,
        executedAt: task.startedAt || task.completedAt || run.startedAt,
        status: task.status,
        jobs,
        discoveredCount: allJobs.length,
        duplicateCount: allJobs.length - jobs.length
      });
    }
  }
  return entries.sort((a, b) => Date.parse(b.executedAt || 0) - Date.parse(a.executedAt || 0));
}

function selectedPendingReviewTaskEntry(entries = pendingReviewTaskEntries()) {
  if (!state.currentRunId || !state.currentRunTaskId) return null;
  const entry = entries.find((item) => item.runId === state.currentRunId && item.taskId === state.currentRunTaskId) || null;
  if (!entry) {
    state.currentRunId = "";
    state.currentRunTaskId = "";
  }
  return entry;
}

function pendingReviewJobs(entries = pendingReviewTaskEntries()) {
  return uniqueJobsById(entries.flatMap((entry) => entry.jobs));
}

function historicalJobs() {
  return state.data.jobs;
}

function historicalTaskEntries() {
  const jobs = historicalJobs();
  const entries = [];
  const terminalTaskStatuses = new Set(["completed", "failed", "cancelled", "skipped"]);
  for (const run of state.data.runs) {
    const runJobs = jobs.filter((job) => job.runId === run.id);
    const assignedJobIds = new Set();
    for (const task of run.tasks || []) {
      if (!task.completedAt && !terminalTaskStatuses.has(task.status)) continue;
      const taskJobs = runJobs.filter((job) => matchingRunTask(run, job)?.id === task.id);
      taskJobs.forEach((job) => assignedJobIds.add(job.id));
      entries.push({
        run,
        task,
        runId: run.id,
        taskId: task.id,
        platform: task.platform,
        keyword: task.keyword,
        location: task.location,
        postedWithinDays: task.postedWithinDays,
        executedAt: task.startedAt || task.completedAt || run.startedAt,
        status: task.status,
        jobs: taskJobs
      });
    }
    const unassigned = runJobs.filter((job) => !assignedJobIds.has(job.id));
    if (unassigned.length) {
      const sources = [...new Set(unassigned.map((job) => job.source))];
      entries.push({
        run,
        task: null,
        runId: run.id,
        taskId: "__unassigned",
        platform: sources.length === 1 ? sources[0] : "manual",
        keyword: "未关联任务",
        location: "手动导入或旧版 Worker 数据",
        postedWithinDays: null,
        executedAt: unassigned.map((job) => job.discoveredAt).filter(Boolean).sort().at(-1) || run.startedAt,
        status: "UNASSIGNED",
        jobs: unassigned
      });
    }
  }
  const orphanJobs = jobs.filter((job) => !runForJob(job));
  if (orphanJobs.length) {
    const sources = [...new Set(orphanJobs.map((job) => job.source))];
    entries.push({
      run: null,
      task: null,
      runId: "__unassigned",
      taskId: "__unassigned",
      platform: sources.length === 1 ? sources[0] : "manual",
      keyword: "未关联任务",
      location: "手动导入或旧版 Worker 数据",
      postedWithinDays: null,
      executedAt: orphanJobs.map((job) => job.discoveredAt).filter(Boolean).sort().at(-1) || null,
      status: "UNASSIGNED",
      jobs: orphanJobs
    });
  }
  return entries.sort((a, b) => Date.parse(b.executedAt || 0) - Date.parse(a.executedAt || 0));
}

function selectedHistoryTaskEntry(entries = historicalTaskEntries()) {
  if (!state.historyRunId || !state.historyTaskId) return null;
  return entries.find((entry) => entry.runId === state.historyRunId && entry.taskId === state.historyTaskId) || null;
}

function runForJob(job) {
  return state.data.runs.find((run) => run.id === job.runId) || null;
}

function jobsInSelectedPane() {
  if (state.jobsPane === "current") {
    const entries = pendingReviewTaskEntries();
    return selectedPendingReviewTaskEntry(entries)?.jobs || pendingReviewJobs(entries);
  }
  return selectedHistoryTaskEntry()?.jobs || [];
}

function failedJdJobsInSelectedPane() {
  return jobsInSelectedPane().filter((job) => {
    const staleFetch = job.screening?.screeningStatus === "JD_FETCHING"
      && Date.now() - new Date(job.aiReview?.startedAt || 0).getTime() > 30_000;
    return ["linkedin", "indeed", "seek"].includes(job.source)
      && job.screening?.category !== "REJECTED"
      && (job.descriptionFetchStatus === "failed"
        || job.screening?.screeningStatus === "JD_FETCH_FAILED"
        || staleFetch);
  });
}

function failedAiReviewJobsInSelectedPane() {
  return jobsInSelectedPane().filter((job) => job.screening?.screeningStatus === "AI_ERROR"
    && hasCompleteJobJd(job));
}

function screeningBucket(job) {
  const screening = job.screening || {};
  if (isRejectionCorrection(job)) return "pending";
  if (job.feedback?.helpfulness === "NOT_HELPFUL") return screening.category === "REJECTED" ? "rejected" : "pending";
  if (screening.category === "REJECTED" || screening.titleClassification === "CLEAR_REJECT") return "rejected";
  if (!screening.jdReviewed || !/^ai(?:$|-)/i.test(screening.engine || "")) return "pending";
  if (["STRONG_MATCH", "GOOD_MATCH", "MAYBE"].includes(screening.category)) return "selected";
  if (screening.category === "LOW_MATCH") return "pending";
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
  const counts = { entered: jobs.length, selected: 0, pending: 0, rejected: 0, viewed: 0, unviewed: 0 };
  for (const job of jobs) counts[screeningBucket(job)] += 1;
  counts.viewed = jobs.filter((job) => Boolean(job.viewedAt)).length;
  counts.unviewed = counts.entered - counts.viewed;
  return counts;
}

function renderPendingReviewTasks() {
  const entries = pendingReviewTaskEntries();
  const jobs = pendingReviewJobs(entries);
  const total = jobStats(jobs);
  el("#job-run-stats-total").textContent = entries.length
    ? `共 ${entries.length} 个任务 · 未看 ${total.unviewed} · 选中 ${total.selected} · 待定 ${total.pending} · 不符合 ${total.rejected}`
    : "没有待完成任务";
  if (!entries.length) {
    el("#job-run-stats-body").innerHTML = '<tr><td colspan="8" class="empty-cell">所有已返回职位的任务都已看完。</td></tr>';
    return;
  }

  const platforms = ["linkedin", "indeed", "seek", "manual"]
    .filter((platform) => entries.some((entry) => entry.platform === platform));
  const rows = [];
  for (const platform of platforms) {
    const platformEntries = entries.filter((entry) => entry.platform === platform);
    const platformJobs = pendingReviewJobs(platformEntries);
    const platformStats = jobStats(platformJobs);
    rows.push('<tr class="job-stats-platform-row"><th colspan="8"><span>' + escapeHtml(names[platform] || platform) + '</span><small>' + platformEntries.length + ' 个任务 · 未看 ' + platformStats.unviewed + ' · 选中 ' + platformStats.selected + ' · 待定 ' + platformStats.pending + ' · 不符合 ' + platformStats.rejected + "</small></th></tr>");
    for (const entry of platformEntries) {
      const { run, task } = entry;
      const stats = jobStats(entry.jobs);
      const activeStatus = ["queued", "running", "needs_user_action"].includes(task.status);
      const active = state.currentRunId === run.id && state.currentRunTaskId === task.id;
      const filterAttributes = ' data-filter-job-stat-task="' + task.id + '" data-job-stat-run="' + run.id + '"';
      rows.push('<tr class="job-stats-task-row' + (active ? " is-active" : "") + '"' + filterAttributes + ' title="只看这个任务的职位；再次点击取消筛选">'
        + '<td><button class="job-stat-task-button"' + filterAttributes + ' type="button" title="只看这个任务的职位"><strong>' + escapeHtml(task.keyword) + '</strong><small>' + escapeHtml(task.location) + '<br>执行于 ' + escapeHtml(dateTime(entry.executedAt)) + "</small></button></td>"
        + "<td>" + escapeHtml(postedWithinLabels[Number(task.postedWithinDays)] || "不限") + "</td>"
        + "<td>" + badge(task.status, "status-badge") + '<small>未看 ' + stats.unviewed + " / " + stats.entered + (entry.duplicateCount ? " · 历史跳过 " + entry.duplicateCount : "") + "</small></td>"
        + '<td class="job-stat-number">' + entry.discoveredCount + "</td>"
        + '<td class="job-stat-number stat-selected">' + stats.selected + "</td>"
        + '<td class="job-stat-number stat-pending">' + stats.pending + "</td>"
        + '<td class="job-stat-number stat-rejected">' + stats.rejected + "</td>"
        + '<td class="action-cell job-stat-actions"><button class="button button-secondary task-view-all-action" data-mark-task-viewed="' + task.id + '" data-job-stat-run="' + run.id
        + '" type="button" title="' + (activeStatus ? "任务结束后才能批量标记" : "将这个任务的全部职位标记为已看") + '"'
        + (activeStatus ? " disabled" : "") + '><i data-lucide="check-check"></i><span>标记已全部看完</span></button>'
        + '<button class="icon-button destructive" data-delete-job-stat-task="' + task.id + '" data-job-stat-run="' + run.id
        + '" type="button" title="' + (activeStatus ? "请先在每日任务中结束或移除此任务" : "删除此任务统计及关联职位") + '"'
        + (activeStatus ? " disabled" : "") + '><i data-lucide="trash-2"></i></button></td></tr>');
    }
  }
  el("#job-run-stats-body").innerHTML = rows.join("");
}

function sortJobs(jobs, sort) {
  return [...jobs].sort((a, b) => {
    if (sort === "priority") {
      const rank = { STRONG_MATCH: 0, GOOD_MATCH: 1, MAYBE: 2, LOW_MATCH: 3, REJECTED: 4 };
      const categoryOrder = (rank[effectiveJobCategory(a)] ?? 5) - (rank[effectiveJobCategory(b)] ?? 5);
      if (categoryOrder) return categoryOrder;
      const scoreOrder = Number(b.screening?.score || 0) - Number(a.screening?.score || 0);
      if (scoreOrder) return scoreOrder;
      return String(b.discoveredAt).localeCompare(String(a.discoveredAt));
    }
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
  const viewed = el("#job-viewed").value;
  const sort = el("#job-sort").value;
  const jobs = jobsInSelectedPane().filter((job) => {
    const words = [job.title, job.company, job.location, job.searchKeyword].join(" ").toLowerCase();
    return (!query || words.includes(query))
      && (!category || effectiveJobCategory(job) === category)
      && (!source || job.source === source)
      && (!status || job.screening.screeningStatus === status)
      && (viewed === "all" || (viewed === "viewed" ? Boolean(job.viewedAt) : !job.viewedAt));
  });
  return sortJobs(jobs, sort);
}

function jobAssistantReviewContext() {
  if (!state.data) return { jobs: [], label: "职位数据尚未载入", key: "loading" };
  const historyEntries = historicalTaskEntries();
  const historyEntry = selectedHistoryTaskEntry(historyEntries);
  let jobs = [];
  let label = "";
  let scope = "";
  if (state.jobsPane === "history" && !historyEntry) {
    const query = (el("#history-search")?.value || "").trim().toLowerCase();
    if (query) {
      jobs = uniqueJobsById(historyEntries.flatMap((entry) => entry.jobs)
        .filter((job) => [job.title, job.company, job.location].join(" ").toLowerCase().includes(query)));
      label = `历史搜索“${el("#history-search").value.trim()}” · ${jobs.length} 个职位`;
      scope = "history-search:" + query;
    } else {
      label = "历史任务首页 · 请选择任务或先搜索职位";
      scope = "history-index";
    }
  } else {
    jobs = uniqueJobsById(visibleJobs());
    if (state.jobsPane === "history" && historyEntry) {
      label = `${names[historyEntry.platform] || historyEntry.platform} · ${historyEntry.keyword} · ${historyEntry.location} · 当前筛选 ${jobs.length} 个职位`;
      scope = historyEntry.runId + ":" + historyEntry.taskId;
    } else {
      const pendingEntry = selectedPendingReviewTaskEntry();
      label = pendingEntry
        ? `${names[pendingEntry.platform] || pendingEntry.platform} · ${pendingEntry.keyword} · ${pendingEntry.location} · 当前筛选 ${jobs.length} 个职位`
        : `全部待审阅任务 · 当前筛选 ${jobs.length} 个职位`;
      scope = pendingEntry ? pendingEntry.runId + ":" + pendingEntry.taskId : "current-all";
    }
  }
  const filterKey = [el("#job-search")?.value, el("#job-category")?.value, el("#job-source")?.value, el("#job-status")?.value, el("#job-viewed")?.value, el("#job-sort")?.value].join("|");
  const ids = jobs.map((job) => job.id);
  const idKey = ids.length > 300 ? ids.slice(0, 150).concat(ids.slice(-150)).join(",") : ids.join(",");
  return {
    jobs,
    label,
    key: [state.jobsPane, scope, filterKey, ids.length, idKey].join("::")
  };
}

function jobAssistantMessageMarkup(message) {
  const citedJobs = (message.citedJobIds || []).map((id) => state.data.jobs.find((job) => job.id === id)).filter(Boolean);
  const citations = citedJobs.length
    ? '<div class="job-assistant-citations"><span>提到的职位</span>' + citedJobs.map((job) => '<span><strong>' + escapeHtml(job.title) + '</strong><small>' + escapeHtml(job.company || names[job.source] || "-") + "</small></span>").join("") + "</div>"
    : "";
  const meta = message.role === "assistant" && message.context
    ? '<small class="job-assistant-message-meta">参考 ' + message.context.includedJobCount + " 个职位"
      + (message.context.omittedJobCount ? " · 另有 " + message.context.omittedJobCount + " 个未送入本次上下文" : "") + "</small>"
    : "";
  const content = String(message.content || "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
  return '<article class="job-assistant-message is-' + escapeHtml(message.role) + '"><div>'
    + escapeHtml(content).replace(/\n/g, "<br>") + "</div>" + citations + meta + "</article>";
}

function renderJobAssistant() {
  const root = el("#job-assistant");
  const visible = state.view === "jobs";
  root.hidden = !visible;
  if (!visible) return;
  const context = jobAssistantReviewContext();
  if (state.jobAssistantContextKey && state.jobAssistantContextKey !== context.key) {
    state.jobAssistantMessages = [];
  }
  state.jobAssistantContextKey = context.key;
  el("#job-assistant-panel").hidden = !state.jobAssistantOpen;
  el("#toggle-job-assistant").setAttribute("aria-expanded", String(state.jobAssistantOpen));
  el("#toggle-job-assistant").classList.toggle("is-open", state.jobAssistantOpen);
  el("#job-assistant-context").innerHTML = '<i data-lucide="scan-search"></i><span>' + escapeHtml(context.label) + "</span>";
  let messages = state.jobAssistantMessages.map(jobAssistantMessageMarkup).join("");
  if (!messages) {
    const empty = !state.data.ai?.configured
      ? "请先在搜索设置中配置 AI。"
      : !context.jobs.length
        ? "当前没有可供分析的职位；请选择历史任务、搜索历史职位，或切换到有结果的待审阅任务。"
        : "可以直接问当前职位，例如：优先看哪几个、哪些技能最匹配，或哪个地点离我的所在地更近。";
    messages = '<div class="job-assistant-empty"><i data-lucide="messages-square"></i><p>' + escapeHtml(empty) + "</p></div>";
  }
  if (state.jobAssistantBusy) {
    messages += '<article class="job-assistant-message is-assistant is-loading"><span></span><span></span><span></span></article>';
  }
  el("#job-assistant-messages").innerHTML = messages;
  const input = el("#job-assistant-input");
  input.disabled = state.jobAssistantBusy || !state.data.ai?.configured || !context.jobs.length;
  el("#send-job-assistant").disabled = input.disabled || !input.value.trim();
  if (state.jobAssistantOpen) requestAnimationFrame(() => {
    const box = el("#job-assistant-messages");
    box.scrollTop = box.scrollHeight;
  });
}

async function sendJobAssistant(event) {
  event.preventDefault();
  if (state.jobAssistantBusy) return;
  const input = el("#job-assistant-input");
  const question = input.value.trim();
  const context = jobAssistantReviewContext();
  if (!question || !context.jobs.length) return;
  const conversation = state.jobAssistantMessages.slice(-6).map((message) => ({ role: message.role, content: message.content }));
  state.jobAssistantMessages.push({ role: "user", content: question });
  state.jobAssistantBusy = true;
  input.value = "";
  renderJobAssistant();
  refreshIcons();
  try {
    const result = await api("/api/jobs/assistant", {
      method: "POST",
      body: JSON.stringify({
        question,
        conversation,
        jobIds: context.jobs.map((job) => job.id),
        context: { pane: state.jobsPane, label: context.label }
      })
    });
    state.jobAssistantMessages.push({
      role: "assistant",
      content: result.answer,
      citedJobIds: result.citedJobIds,
      context: result.context,
      usage: result.usage
    });
  } catch (error) {
    state.jobAssistantMessages.push({ role: "assistant", content: "这次没有成功回答：" + error.message, isError: true });
  } finally {
    state.jobAssistantBusy = false;
    renderJobAssistant();
    refreshIcons();
    input.focus();
  }
}

function actionButtons(job) {
  const open = /^https?:\/\//i.test(job.jobUrl || "")
    ? '<a class="icon-button" href="' + escapeHtml(job.jobUrl) + '" target="_blank" rel="noreferrer" title="打开原职位"><i data-lucide="external-link"></i></a>'
    : "";
  const correctionActive = isRejectionCorrection(job);
  const rejected = job.screening?.category === "REJECTED" || job.screening?.titleClassification === "CLEAR_REJECT";
  const positiveActive = rejected ? isRejectionApproval(job) : hasLikedJobFeedback(job);
  const negativeActive = rejected ? correctionActive : job.feedback?.helpfulness === "NOT_HELPFUL";
  const feedbackAllowed = positiveActive || negativeActive || rejected || Boolean(job.screening?.jdReviewed && /^ai(?:$|-)/i.test(job.screening?.engine || ""));
  const viewed = Boolean(job.viewedAt);
  const jdFetching = job.screening?.screeningStatus === "JD_FETCHING";
  const jdFetchStale = jdFetching && Date.now() - new Date(job.aiReview?.startedAt || 0).getTime() > 45_000;
  const aiBusy = ["AI_QUEUED", "AI_REVIEWING", "AI_RETRY_WAIT"].includes(job.screening?.screeningStatus) || (jdFetching && !jdFetchStale);
  const titleRejected = !job.screening?.jdReviewed
    && rejected
    && !correctionActive;
  const hasCompleteJd = hasCompleteJobJd(job);
  const canCoverLetter = hasCompleteJd && Boolean(state.data?.ai?.configured && state.data?.profiles?.length);
  const canFetchJd = Boolean(job.jobUrl && ["linkedin", "indeed", "seek"].includes(job.source));
  const canRereview = (hasCompleteJd || canFetchJd) && !titleRejected && !aiBusy && state.data?.ai?.configured && Boolean(state.data?.profiles?.length);
  const rereviewTitle = aiBusy
    ? (job.screening?.screeningStatus === "JD_FETCHING" ? "正在原职位页面获取完整 JD" : "AI 正在审阅此职位")
    : titleRejected
      ? "标题已明确排除，无需获取 JD 或重新审阅"
      : !state.data?.profiles?.length
        ? "请先创建职业画像"
        : !state.data?.ai?.configured
          ? "请先配置 AI 服务"
          : jdFetchStale
            ? "上次 JD 获取没有回传，点击重新打开原职位"
          : !hasCompleteJd && canFetchJd
            ? "打开原职位获取完整 JD，然后自动 AI 审阅"
            : !hasCompleteJd
              ? "缺少原职位链接，不能获取完整 JD"
              : "使用已保存的完整 JD 重新 AI 审阅";
  return open
    + '<button class="icon-button" data-rereview="' + job.id + '" type="button" title="' + rereviewTitle + '" aria-label="' + (hasCompleteJd ? "重新 AI 审阅" : "获取 JD 并 AI 审阅") + '"' + (canRereview ? "" : " disabled") + '><i data-lucide="' + (aiBusy ? "loader-circle" : hasCompleteJd ? "refresh-cw" : "file-search") + '"></i></button>'
    + '<button class="icon-button" data-cover-letter="' + job.id + '" type="button" title="' + (canCoverLetter ? "生成 Cover Letter" : "需要完整 JD、画像与 AI 配置") + '" aria-label="生成 Cover Letter"' + (canCoverLetter ? "" : " disabled") + '><i data-lucide="file-pen-line"></i></button>'
    + '<button class="viewed-action' + (viewed ? " is-active" : "") + '" data-toggle-viewed="' + job.id + '" data-viewed="' + String(viewed) + '" type="button" title="' + (viewed ? "点击恢复为未看" : "标记为已看") + '"><i data-lucide="' + (viewed ? "check" : "eye") + '"></i><span>' + (viewed ? "已看" : "看过了") + "</span></button>"
    + '<button class="feedback-action is-compact' + (positiveActive ? " is-active" : "") + '" data-feedback="' + job.id + '" data-feedback-mode="positive" type="button" aria-label="有用" aria-pressed="' + String(positiveActive) + '" title="' + (feedbackAllowed ? (rejected ? "有用：Rejected 判断正确" : positiveActive ? "修改有用反馈" : "有用：告诉 Agent 你喜欢这个职位") : "AI 完成完整 JD 审阅后才能评价") + '"' + (feedbackAllowed ? "" : " disabled") + '><i data-lucide="thumbs-up"></i></button>'
    + '<button class="feedback-action is-compact is-negative' + (negativeActive ? " is-active" : "") + '" data-feedback="' + job.id + '" data-feedback-mode="negative" type="button" aria-label="没用" aria-pressed="' + String(negativeActive) + '" title="' + (feedbackAllowed ? (rejected ? "没用：Rejected 判断不正确" : negativeActive ? "修改没用反馈" : "没用：告诉 Agent 你不喜欢的原因") : "AI 完成完整 JD 审阅后才能评价") + '"' + (feedbackAllowed ? "" : " disabled") + '><i data-lucide="thumbs-down"></i></button>';
}

function hasCompleteJobJd(job) {
  return Boolean(job.description && (
    job.descriptionSource === "detail-page"
    || ["fetched", "reused"].includes(job.descriptionFetchStatus)
    || job.screening?.jdReviewed
  ));
}

function jobRow(job, compact = false, includeBatch = false) {
  const duplicate = job.duplicateOf ? '<span class="tiny-note">重复导入</span>' : "";
  const search = compact ? "" : '<td class="muted">' + escapeHtml(job.searchKeyword || "-") + "</td>";
  const run = includeBatch ? runForJob(job) : null;
  const batch = includeBatch
    ? '<td><span>' + escapeHtml(run ? dateTime(run.startedAt) : "未关联运行") + '</span><small>' + escapeHtml(run ? nice(run.state) : "手动或旧版导入") + "</small></td>"
    : "";
  const rowClasses = [job.feedback?.helpfulness === "HELPFUL" ? "job-helpful" : "", job.feedback?.helpfulness === "NOT_HELPFUL" && !isRejectionCorrection(job) ? "job-not-helpful" : "", isRejectionCorrection(job) ? "job-correction" : "", job.viewedAt ? "job-viewed" : ""].filter(Boolean).join(" ");
  const feedback = feedbackBadge(job);
  const viewed = job.viewedAt && !feedback ? '<span class="viewed-badge"><i data-lucide="check"></i>已看</span>' : "";
  const reviewMeta = viewed || feedback ? '<span class="job-review-meta">' + viewed + feedback + "</span>" : "";
  const scoreReason = escapeHtml(job.screening?.reason || "尚无评分说明");
  return '<tr' + (rowClasses ? ' class="' + rowClasses + '"' : "") + '>'
    + '<td><strong>' + escapeHtml(job.title) + "</strong>" + duplicate + reviewMeta + "</td>"
    + '<td><span>' + escapeHtml(job.company || "-") + "</span><small>" + escapeHtml(job.location || "-") + "</small></td>"
    + '<td>' + badge(names[job.source] || job.source, "source-" + job.source) + "</td>"
    + search
    + '<td><button class="score score-trigger" type="button" data-score-details="' + job.id + '" title="点击查看分数构成：' + scoreReason + '" aria-label="查看评分 ' + job.screening.score + ' 的构成">' + job.screening.score + "</button>" + badge(effectiveJobCategory(job), "category-" + effectiveJobCategory(job).toLowerCase()) + "</td>"
    + '<td>' + badge(job.screening.screeningStatus, "status-badge") + screeningMethodBadge(job) + workRightsBadge(job) + "</td>"
    + batch
    + '<td class="action-cell">' + actionButtons(job) + "</td></tr>";
}

function renderOverview() {
  const jobs = currentRunJobs();
  const historyCount = historicalJobs().length;
  const metrics = [
    ["本次导入", jobs.length, "briefcase-business"],
    ["本次强匹配", jobs.filter((job) => effectiveJobCategory(job) === "STRONG_MATCH").length, "badge-check"],
    ["本次待审阅", jobs.filter((job) => job.screening.screeningStatus === "NEEDS_JD_REVIEW").length, "scan-search"],
    ["历史职位", historyCount, "history"]
  ];
  el("#overview-metrics").innerHTML = metrics.map((item) =>
    '<article class="metric"><div><span>' + item[0] + "</span><strong>" + item[1] + '</strong></div><i data-lucide="' + item[2] + '"></i></article>'
  ).join("");
  const rows = sortJobs(jobs, "discoveredAt").slice(0, 8).map((job) => jobRow(job, true)).join("");
  el("#overview-jobs").innerHTML = rows || '<tr><td colspan="6" class="empty-cell">本次任务尚未导入职位。</td></tr>';
}

function renderHistoryTaskIndex(entries) {
  const rawQuery = (el("#history-search")?.value || "").trim();
  const query = rawQuery.toLowerCase();
  const results = query
    ? entries.flatMap((entry) => entry.jobs.map((job) => ({ entry, job })))
      .filter(({ job }) => [job.title, job.company, job.location].join(" ").toLowerCase().includes(query))
      .sort((a, b) => Date.parse(b.entry.executedAt || b.job.discoveredAt || 0) - Date.parse(a.entry.executedAt || a.job.discoveredAt || 0))
    : [];
  const searching = Boolean(query);
  const matchingTaskCount = new Set(results.map(({ entry }) => entry.runId + "::" + entry.taskId)).size;
  el("#history-task-index-subtitle").textContent = searching
    ? "正在全部历史任务中匹配职位名、公司名或地点；点击结果可回到所属任务继续查看。"
    : "按实际执行时间倒序排列；点击任务查看当次搜索进入 Agent 的全部职位。";
  el("#history-task-index-count").textContent = searching
    ? results.length + " 个职位 · " + matchingTaskCount + " 项任务"
    : entries.length + " 项任务";
  el("#history-task-table-wrap").hidden = searching;
  el("#history-search-results").hidden = !searching;
  el("#history-task-index-body").innerHTML = entries.map((entry) => {
    const stats = jobStats(entry.jobs);
    const scope = entry.postedWithinDays === null || entry.postedWithinDays === undefined
      ? "不限 / 未记录"
      : postedWithinLabels[Number(entry.postedWithinDays)] || "不限";
    return '<tr class="history-task-row" data-open-history-task="' + escapeHtml(entry.taskId) + '" data-history-run="' + escapeHtml(entry.runId) + '" title="查看此任务的全部职位">'
      + '<td><strong>' + escapeHtml(entry.executedAt ? dateTime(entry.executedAt) : "时间未记录") + '</strong><small>' + escapeHtml(entry.run ? "运行批次 " + dateTime(entry.run.startedAt) : "未关联运行") + "</small></td>"
      + '<td>' + badge(names[entry.platform] || entry.platform, "source-" + entry.platform) + "</td>"
      + '<td><strong>' + escapeHtml(entry.keyword) + '</strong><small>' + escapeHtml(entry.location || "-") + "</small></td>"
      + '<td>' + escapeHtml(scope) + "</td>"
      + '<td><strong>' + stats.entered + ' 个职位</strong><small>选中 ' + stats.selected + " · 待定 " + stats.pending + " · 不符合 " + stats.rejected + "</small></td>"
      + '<td>' + badge(entry.status || "UNKNOWN", "status-badge") + "</td>"
      + '<td class="history-task-open"><button class="icon-button" type="button" data-open-history-task="' + escapeHtml(entry.taskId) + '" data-history-run="' + escapeHtml(entry.runId) + '" title="查看任务职位"><i data-lucide="arrow-right"></i></button></td></tr>';
  }).join("") || '<tr><td colspan="7" class="empty-cell">尚无历史任务。完成一次新的运行后会显示在这里。</td></tr>';
  el("#history-search-results-body").innerHTML = results.map(({ entry, job }) => {
    const category = effectiveJobCategory(job);
    return '<tr class="history-search-row" data-open-history-task="' + escapeHtml(entry.taskId) + '" data-history-run="' + escapeHtml(entry.runId) + '" data-history-query="' + escapeHtml(rawQuery) + '" title="查看此职位所属的历史任务">'
      + '<td><strong>' + escapeHtml(job.title || "未记录职位名") + '</strong><small>' + (job.viewedAt ? "已看" : "未看") + "</small></td>"
      + '<td><span>' + escapeHtml(job.company || "-") + '</span><small>' + escapeHtml(job.location || "-") + "</small></td>"
      + '<td>' + badge(names[job.source] || job.source, "source-" + job.source) + "</td>"
      + '<td><strong class="history-search-score">' + Number(job.screening?.score || 0) + "</strong>" + badge(category, "category-" + category.toLowerCase()) + "</td>"
      + '<td><strong>' + escapeHtml(entry.keyword) + '</strong><small>' + escapeHtml(entry.location || "-") + "</small></td>"
      + '<td><span>' + escapeHtml(entry.executedAt ? dateTime(entry.executedAt) : "时间未记录") + "</span></td>"
      + '<td class="history-task-open"><button class="icon-button" type="button" data-open-history-task="' + escapeHtml(entry.taskId) + '" data-history-run="' + escapeHtml(entry.runId) + '" data-history-query="' + escapeHtml(rawQuery) + '" title="查看所属任务"><i data-lucide="arrow-right"></i></button></td></tr>';
  }).join("") || '<tr><td colspan="7" class="empty-cell">没有找到匹配的历史职位。可尝试职位关键词、公司名或地点。</td></tr>';
}

function selectedReviewRun() {
  if (state.jobsPane === "current") return selectedPendingReviewTaskEntry()?.run || currentRun();
  if (!state.historyRunId || state.historyRunId === "__unassigned") return null;
  return state.data.runs.find((run) => run.id === state.historyRunId) || null;
}

function reflectionHasCurrentFeedback(reflection, evidenceJobs) {
  if (!reflection) return false;
  const reflectedIds = new Set(reflection.feedbackJobIds || []);
  return reflectedIds.size === evidenceJobs.length
    && evidenceJobs.every((job) => reflectedIds.has(job.id)
      && String(job.feedback?.updatedAt || job.learningSignals?.generatedAt || "") <= String(reflection.createdAt || ""));
}

function uniqueJobsById(jobs) {
  return [...new Map(jobs.map((job) => [job.id, job])).values()];
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
  const helpfulJobs = jobs.filter(hasLikedJobFeedback);
  const correctionJobs = helpfulJobs.filter(isRejectionCorrection);
  const rejectedJobs = jobs.filter(isRejectedLearningSignal);
  const confirmedRejectedJobs = rejectedJobs.filter(isRejectionApproval);
  const automaticRejectedJobs = rejectedJobs.filter((job) => !isRejectionApproval(job));
  const legacyJobs = jobs.filter((job) => job.feedback?.helpfulness === "NOT_HELPFUL" && job.feedback?.reason !== "CLASSIFICATION_WRONG");
  const evidenceJobs = uniqueJobsById([...helpfulJobs, ...rejectedJobs, ...legacyJobs]);
  const reflection = run ? (state.data.reviewReflections || []).find((item) => item.runId === run.id) : null;
  const runFinished = run && ["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(run.state);
  const pendingAiReviews = jobs.filter((job) => ["AI_QUEUED", "AI_REVIEWING", "AI_RETRY_WAIT"].includes(job.screening?.screeningStatus)).length;
  const reflected = reflectionHasCurrentFeedback(reflection, evidenceJobs);
  const button = el("#complete-run-review");
  const label = button.querySelector("span");
  el("#review-feedback-count").textContent = (helpfulJobs.length - correctionJobs.length) + " 条有用 · " + legacyJobs.length + " 条没用 · " + correctionJobs.length + " 条 Rejected 纠错 · " + confirmedRejectedJobs.length + " 条 Rejected 已确认 · " + automaticRejectedJobs.length + " 条 AI 排除";
  button.hidden = false;
  button.disabled = !runFinished || pendingAiReviews > 0 || (!evidenceJobs.length && !reflection) || reflected;
  label.textContent = reflection ? (reflected ? "本次复盘已完成" : "更新本次复盘") : "完成本次审阅并复盘";
  el("#review-learning-subtitle").textContent = state.jobsPane === "history"
    ? "查看该历史批次的人工反馈和复盘结论。"
    : !run ? "运行每日任务后，可标记有用或没用，并结合 AI 排除结果完成复盘。"
      : !runFinished ? "任务仍在运行；AI 审阅完成后再进行人工反馈和复盘。"
        : pendingAiReviews ? `还有 ${pendingAiReviews} 个职位正在自动 AI 审阅；完成后再进行复盘。`
        : "普通职位的“有用 / 没用”用于学习偏好；Rejected 的“有用 / 没用”用于确认或纠正排除判断，候选排除词只进入待审核区。";

}

function renderJobs() {
  const pendingEntries = pendingReviewTaskEntries();
  const currentJobs = pendingReviewJobs(pendingEntries);
  const historyEntries = historicalTaskEntries();
  let historyEntry = selectedHistoryTaskEntry(historyEntries);
  if (state.jobsPane === "history" && (state.historyRunId || state.historyTaskId) && !historyEntry) {
    state.historyRunId = "";
    state.historyTaskId = "";
  }
  historyEntry = selectedHistoryTaskEntry(historyEntries);
  const historyIndex = state.jobsPane === "history" && !historyEntry;
  renderHistoryTaskIndex(historyEntries);
  document.querySelectorAll("[data-jobs-pane]").forEach((node) => {
    const active = node.dataset.jobsPane === state.jobsPane;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-selected", String(active));
  });
  el("#current-jobs-count").textContent = String(pendingEntries.length);
  el("#history-jobs-count").textContent = String(historyEntries.length);
  el("#history-task-index").hidden = !historyIndex;
  el("#jobs-run-filter").hidden = state.jobsPane !== "history" || historyIndex;
  el("#job-run-stats").hidden = state.jobsPane !== "current";
  el("#jobs-filter-bar").hidden = historyIndex;
  el("#jobs-list-table").hidden = historyIndex;
  if (historyEntry) {
    el("#history-task-context").textContent = `${names[historyEntry.platform] || historyEntry.platform} · ${historyEntry.keyword} · ${historyEntry.location} · ${dateTime(historyEntry.executedAt)}`;
  }
  const selectedRun = historyEntry?.run || null;
  el("#delete-selected-history-run").disabled = !selectedRun || !["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(selectedRun.state);
  const failedJdJobs = failedJdJobsInSelectedPane();
  const paneJobIds = new Set(jobsInSelectedPane().map((job) => job.id));
  const activeJdRetry = (state.data.jdRetryBatches || []).find((batch) => batch.jobIds.some((id) => paneJobIds.has(id)));
  const retryFailedButton = el("#retry-failed-jds");
  retryFailedButton.hidden = !activeJdRetry && !failedJdJobs.length;
  retryFailedButton.disabled = Boolean(activeJdRetry) || !failedJdJobs.length;
  retryFailedButton.classList.toggle("is-busy", Boolean(activeJdRetry));
  if (historyIndex) retryFailedButton.hidden = true;
  retryFailedButton.innerHTML = activeJdRetry
    ? '<i data-lucide="loader-circle" class="button-spinner"></i><span>获取 JD ' + activeJdRetry.completed + '/' + activeJdRetry.total + '</span>'
    : '<i data-lucide="files"></i><span>重试失败 JD (' + failedJdJobs.length + ')</span>';
  const failedAiJobs = failedAiReviewJobsInSelectedPane();
  const retryFailedAiButton = el("#retry-failed-ai-reviews");
  const canRetryFailedAi = Boolean(state.data.ai?.configured && state.data.activeProfile);
  retryFailedAiButton.hidden = historyIndex || !failedAiJobs.length;
  retryFailedAiButton.disabled = !canRetryFailedAi;
  retryFailedAiButton.title = !state.data.activeProfile
    ? "请先激活职业画像"
    : !state.data.ai?.configured
      ? "请先配置 AI 服务"
      : `使用已保存的完整 JD 重新审阅 ${failedAiJobs.length} 个失败职位`;
  retryFailedAiButton.innerHTML = '<i data-lucide="refresh-cw"></i><span>重新审阅 AI 失败项 (' + failedAiJobs.length + ')</span>';
  if (state.jobsPane === "current") renderPendingReviewTasks();
  const selectedPendingEntry = state.jobsPane === "current" ? selectedPendingReviewTaskEntry(pendingEntries) : null;
  const selectedTask = selectedPendingEntry?.task || null;
  const taskFilter = el("#active-job-task-filter");
  taskFilter.hidden = !selectedTask;
  if (selectedTask) {
    el("#active-job-task-filter-label").textContent = `${names[selectedTask.platform] || selectedTask.platform} · ${selectedTask.keyword} · ${selectedTask.location} · ${postedWithinLabels[Number(selectedTask.postedWithinDays)] || "不限"} · ${dateTime(selectedPendingEntry.executedAt)}`;
  }
  renderReviewLearning();
  if (historyIndex) {
    el("#jobs-list-title").textContent = "历史任务";
    el("#jobs-summary").textContent = historyEntries.length + " 项历史任务 · 按执行时间从新到旧";
    renderJobAssistant();
    refreshIcons();
    return;
  }
  el("#jobs-list-title").textContent = state.jobsPane === "history" ? "历史任务职位" : "待审阅职位";
  const jobs = visibleJobs();
  const paneTotal = jobsInSelectedPane().length;
  const viewedLabel = el("#job-viewed").selectedOptions[0]?.textContent || "全部";
  el("#jobs-summary").textContent = state.jobsPane === "history"
    ? jobs.length + " / " + paneTotal + " 个任务职位 · " + viewedLabel
    : pendingEntries.length ? jobs.length + " / " + paneTotal + " 个待审阅任务职位 · " + viewedLabel : "目前没有未审阅完成的任务";
  el("#jobs-table-head").innerHTML = "<tr><th>职位</th><th>公司 / 地点</th><th>来源</th><th>搜索</th><th>匹配</th><th>筛查状态 / 方法</th><th></th></tr>";
  const emptyMessage = el("#job-viewed").value === "unviewed"
    ? "当前筛选没有未看职位；可将“查看进度”切换到“已看”或“全部”。"
    : state.jobsPane === "history" ? "没有匹配当前筛选条件的历史职位。" : "目前没有未审阅完成的任务。";
  el("#jobs-table").innerHTML = jobs.map((job) => jobRow(job)).join("")
    || '<tr><td colspan="7" class="empty-cell">' + emptyMessage + "</td></tr>";
  renderJobAssistant();
  refreshIcons();
}

function taskCategoryValidation(task) {
  return (state.data.validations || []).find((validation) => validation.id === task.validationId)
    || (state.data.validations || []).find((validation) => validation.status === "VALID" && taskIdentityKey(validation) === taskIdentityKey(task))
    || null;
}

function categoryTaskRoutineTask(category, task) {
  const validation = taskCategoryValidation(task);
  return (state.data.routineTasks || []).find((routineTask) =>
    routineTask.id === validation?.routineTaskId
      || (routineTask.categoryId === category.id && routineTask.categoryTaskId === task.id)
      || (validation && routineTask.validationId === validation.id)
      || taskIdentityKey(routineTask) === taskIdentityKey(task)
  ) || null;
}

function categoryReadyRoutineTasks(category) {
  return category.tasks
    .map((task) => categoryTaskRoutineTask(category, task))
    .filter((task) => task?.status === "READY");
}

function categoryStatus(category) {
  const validations = category.tasks.map(taskCategoryValidation);
  const valid = validations.filter((validation) => validation?.status === "VALID").length;
  const active = validations.filter((validation) => validation?.status === "WAITING_FOR_WORKER").length;
  const failed = validations.filter((validation) => ["FAILED", "NEEDS_USER_ACTION"].includes(validation?.status)).length;
  const enabled = categoryReadyRoutineTasks(category).length;
  return { total: category.tasks.length, valid, active, failed, enabled, ready: enabled === category.tasks.length };
}

function categoryTaskStatusMarkup(task) {
  const validation = taskCategoryValidation(task);
  if (!validation) return badge("未预检", "status-badge");
  return badge(validationPresentation(validation).label, "status-badge");
}

function unifiedRoutineTaskRow(task, validation = null) {
  const routineTask = task?.status ? task : null;
  const source = routineTask || task;
  const selected = Boolean(routineTask && state.selectedRoutineTaskIds.has(routineTask.id));
  const todayRun = routineTask ? todayRoutineTaskRun(routineTask.id) : null;
  const runTitle = todayRun ? "今天已运行过，仍要再次运行此任务" : "单独运行此任务";
  const checkbox = routineTask
    ? '<input type="checkbox" data-routine-task-select="' + routineTask.id + '" aria-label="选择 ' + escapeHtml(source.keyword + "，" + source.location) + '" title="Shift + 点击可连续选择"' + (selected ? " checked" : "") + (routineTask.status === "READY" ? "" : " disabled") + ">"
    : '<input type="checkbox" disabled aria-label="任务尚未启用">';
  const status = routineTask
    ? badge("可运行", "status-badge")
    : validation ? badge(validationPresentation(validation).label, "status-badge") : badge("未预检", "status-badge");
  let actions = "";
  if (routineTask) {
    actions = '<button class="icon-button" data-run-routine-task="' + routineTask.id + '" title="' + runTitle + '"><i data-lucide="play"></i></button>'
      + '<button class="icon-button destructive" data-delete-routine-task="' + routineTask.id + '" title="停用任务；组合配置会保留"><i data-lucide="trash-2"></i></button>';
  } else if (validation?.status === "VALID") {
    actions = '<button class="icon-button" data-add-validation-task="' + validation.id + '" title="启用这个任务"><i data-lucide="circle-check-big"></i></button>';
  } else if (["FAILED", "NEEDS_USER_ACTION"].includes(validation?.status)) {
    actions = '<button class="icon-button" data-retry-validation="' + validation.id + '" title="重新尝试预检"><i data-lucide="rotate-cw"></i></button>';
  }
  return '<tr' + (selected ? ' class="is-selected"' : '') + '>'
    + '<td class="selection-column">' + checkbox + '</td>'
    + '<td>' + badge(names[source.platform], "source-" + source.platform) + '</td>'
    + '<td><strong>' + escapeHtml(source.keyword) + '</strong></td>'
    + '<td>' + escapeHtml(source.location) + '</td>'
    + '<td><span>' + escapeHtml(postedWithinLabels[Number(source.postedWithinDays)] || "不限") + '</span><small>' + escapeHtml(jobTypeLabels[source.jobType || "any"] || source.jobType || "不限") + '</small></td>'
    + '<td><div class="routine-task-status">' + status + todayRoutineTaskBadge(todayRun) + '</div></td>'
    + '<td class="action-cell unified-task-actions">' + actions + '</td></tr>';
}

function renderTaskCategories() {
  const categories = state.data.taskCategories || [];
  const routineTasks = state.data.routineTasks || [];
  const categoryIds = new Set(categories.map((category) => category.id));
  state.selectedCategoryIds = new Set([...state.selectedCategoryIds].filter((id) => categoryIds.has(id)));
  state.expandedCategoryIds = new Set([...state.expandedCategoryIds].filter((id) => id === "standalone" || categoryIds.has(id)));
  const selected = categories.filter((category) => state.selectedCategoryIds.has(category.id));
  const selectedTasks = selected.reduce((total, category) => total + category.tasks.length, 0);
  el("#selected-category-count").textContent = `已选 ${selected.length} 组 / ${selectedTasks} 项任务`;
  el("#select-all-categories").checked = Boolean(categories.length && selected.length === categories.length);
  el("#select-all-categories").indeterminate = selected.length > 0 && selected.length < categories.length;
  el("#preflight-selected-categories").disabled = !selected.length;
  el("#import-selected-categories").disabled = !selected.length;
  const linkedRoutineTaskIds = new Set();
  const categoryMarkup = categories.map((category, index) => {
    const status = categoryStatus(category);
    const selectedCategory = state.selectedCategoryIds.has(category.id);
    const expanded = state.expandedCategoryIds.has(category.id);
    const platforms = [...new Set(category.tasks.map((task) => task.platform))];
    const readyTasks = categoryReadyRoutineTasks(category);
    readyTasks.forEach((task) => linkedRoutineTaskIds.add(task.id));
    const selectedReady = readyTasks.filter((task) => state.selectedRoutineTaskIds.has(task.id)).length;
    const stateLabel = status.ready ? "全部可运行" : status.enabled ? status.enabled + " 项可运行" : status.valid === status.total ? "待启用" : status.active ? "预检中" : status.failed ? "需检查" : "未预检";
    const rows = category.tasks.map((task) => unifiedRoutineTaskRow(categoryTaskRoutineTask(category, task) || task, taskCategoryValidation(task))).join("");
    return '<article class="task-category-item' + (selectedCategory || selectedReady ? " is-selected" : "") + '">'
      + '<div class="task-category-main">'
      + '<label class="task-category-check" title="选择整个组合进行验证、启用或运行"><input type="checkbox" data-category-select="' + category.id + '"' + (selectedCategory ? " checked" : "") + '><span class="task-category-index">' + String(index + 1).padStart(2, "0") + '</span></label>'
      + '<div class="task-category-identity"><div><strong>' + escapeHtml(category.name) + '</strong>' + (category.builtin ? badge("预设", "category-preset-badge") : badge("自定义", "category-custom-badge")) + '</div><small>'
      + platforms.map((platform) => names[platform]).join(" / ") + ' · ' + category.tasks.length + ' 项任务 · ' + stateLabel + '</small></div>'
      + '<div class="task-category-progress"><strong>' + status.enabled + '/' + status.total + '</strong><span>可运行</span></div>'
      + '<div class="task-category-actions"><button class="icon-button" type="button" data-toggle-category="' + category.id + '" title="' + (expanded ? "收起子任务" : "查看子任务") + '"><i data-lucide="chevron-' + (expanded ? "up" : "down") + '"></i></button>'
      + (category.builtin ? "" : '<button class="icon-button" type="button" data-edit-category="' + category.id + '" title="编辑类别"><i data-lucide="pencil"></i></button><button class="icon-button destructive" type="button" data-delete-category="' + category.id + '" title="删除类别"><i data-lucide="trash-2"></i></button>')
      + '</div></div>'
      + '<div class="task-category-children"' + (expanded ? "" : " hidden") + '><div class="data-table-wrap"><table class="data-table unified-task-table"><thead><tr><th class="selection-column"></th><th>平台</th><th>关键词</th><th>地点</th><th>时间 / 类型</th><th>状态</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>'
      + '</article>';
  }).join("");
  const standaloneTasks = routineTasks.filter((task) => !linkedRoutineTaskIds.has(task.id));
  const standaloneExpanded = state.expandedCategoryIds.has("standalone");
  const standaloneSelected = standaloneTasks.some((task) => state.selectedRoutineTaskIds.has(task.id));
  const standaloneMarkup = standaloneTasks.length ? '<article class="task-category-item standalone-task-group' + (standaloneSelected ? " is-selected" : "") + '">'
    + '<div class="task-category-main"><div class="task-category-check standalone-category-mark"><i data-lucide="square-stack"></i><span class="task-category-index">--</span></div>'
    + '<div class="task-category-identity"><div><strong>单独任务</strong>' + badge("自动归类", "category-preset-badge") + '</div><small>不属于现有组合的已启用任务</small></div>'
    + '<div class="task-category-progress"><strong>' + standaloneTasks.length + '</strong><span>可运行</span></div>'
    + '<div class="task-category-actions"><button class="icon-button" type="button" data-toggle-category="standalone" title="' + (standaloneExpanded ? "收起任务" : "查看任务") + '"><i data-lucide="chevron-' + (standaloneExpanded ? "up" : "down") + '"></i></button></div></div>'
    + '<div class="task-category-children"' + (standaloneExpanded ? "" : " hidden") + '><div class="data-table-wrap"><table class="data-table unified-task-table"><thead><tr><th class="selection-column"></th><th>平台</th><th>关键词</th><th>地点</th><th>时间 / 类型</th><th>状态</th><th>操作</th></tr></thead><tbody>'
    + standaloneTasks.map((task) => unifiedRoutineTaskRow(task, (state.data.validations || []).find((validation) => validation.id === task.validationId))).join("")
    + '</tbody></table></div></div></article>' : "";
  el("#task-category-list").innerHTML = categoryMarkup + standaloneMarkup
    || '<div class="empty-state compact-empty"><p>尚未创建任务组合或启用单独任务。</p></div>';
  document.querySelectorAll("[data-category-select]").forEach((checkbox) => {
    const category = categories.find((item) => item.id === checkbox.dataset.categorySelect);
    const readyTasks = category ? categoryReadyRoutineTasks(category) : [];
    const selectedReady = readyTasks.filter((task) => state.selectedRoutineTaskIds.has(task.id)).length;
    checkbox.indeterminate = !checkbox.checked && selectedReady > 0;
  });
}

function syncSelectedCategoryRoutineTasks() {
  const categories = state.data.taskCategories || [];
  for (const category of categories) {
    if (!state.selectedCategoryIds.has(category.id)) continue;
    categoryReadyRoutineTasks(category).forEach((task) => state.selectedRoutineTaskIds.add(task.id));
  }
}

function reconcileCategorySelectionsFromRoutineTasks() {
  const categories = state.data.taskCategories || [];
  for (const category of categories) {
    const readyTasks = categoryReadyRoutineTasks(category);
    if (state.selectedCategoryIds.has(category.id)) {
      if (readyTasks.some((task) => !state.selectedRoutineTaskIds.has(task.id))) state.selectedCategoryIds.delete(category.id);
      continue;
    }
    if (readyTasks.length === category.tasks.length && readyTasks.every((task) => state.selectedRoutineTaskIds.has(task.id))) {
      state.selectedCategoryIds.add(category.id);
    }
  }
}

function setCategorySelection(categoryIds, checked) {
  const categories = (state.data.taskCategories || []).filter((category) => categoryIds.includes(category.id));
  for (const category of categories) {
    if (checked) state.selectedCategoryIds.add(category.id);
    else state.selectedCategoryIds.delete(category.id);
    categoryReadyRoutineTasks(category).forEach((task) => {
      if (checked) state.selectedRoutineTaskIds.add(task.id);
      else state.selectedRoutineTaskIds.delete(task.id);
    });
  }
  renderRoutine();
  refreshIcons();
}

function renderRoutine() {
  const routineTasks = state.data.routineTasks || [];
  const availableRoutineTaskIds = new Set(routineTasks.filter((task) => task.status === "READY").map((task) => task.id));
  for (const id of state.selectedRoutineTaskIds) {
    if (!availableRoutineTaskIds.has(id)) state.selectedRoutineTaskIds.delete(id);
  }
  syncSelectedCategoryRoutineTasks();
  const selectedRoutineTasks = routineTasks.filter((task) => state.selectedRoutineTaskIds.has(task.id));
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
  el("#selected-routine-task-count").textContent = "已选 " + selectedRoutineTasks.length + " 项";
  el("#run-selected-routine-tasks").disabled = !selectedRoutineTasks.length;
  el("#clear-routine-selection").disabled = !selectedRoutineTasks.length;
  el("#select-visible-routine-tasks").disabled = !availableRoutineTaskIds.size || selectedRoutineTasks.length === availableRoutineTaskIds.size;
  el("#routine-platform-selectors").innerHTML = routinePlatformOrder.map((platform) => {
    const tasks = routineTasks.filter((task) => task.platform === platform && task.status === "READY");
    if (!tasks.length) return "";
    const selectedCount = tasks.filter((task) => state.selectedRoutineTaskIds.has(task.id)).length;
    return '<label class="routine-platform-selector" title="选择全部 ' + escapeHtml(names[platform]) + ' 任务"><input type="checkbox" data-routine-platform-select="' + platform + '"'
      + (selectedCount === tasks.length ? " checked" : "") + '><span>' + escapeHtml(names[platform]) + '</span><small>' + selectedCount + "/" + tasks.length + "</small></label>";
  }).join("");
  document.querySelectorAll("[data-routine-platform-select]").forEach((checkbox) => {
    const tasks = routineTasks.filter((task) => task.platform === checkbox.dataset.routinePlatformSelect && task.status === "READY");
    const selectedCount = tasks.filter((task) => state.selectedRoutineTaskIds.has(task.id)).length;
    checkbox.indeterminate = selectedCount > 0 && selectedCount < tasks.length;
  });
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
    + "<td><span>" + escapeHtml(timeLabel(validation.postedWithinDays)) + "</span><small>" + escapeHtml(jobTypeLabels[validation.jobType || "any"] || validation.jobType || "不限") + "</small></td>"
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
    el("#tasks-table").innerHTML = queueTasks.map((task) => {
      const canOpenWorker = task.id === activeTask?.id && (task.status === "queued" || taskWorkerIsStale(task));
      const progressText = task.status === "queued" && task.id === activeTask?.id
        ? "等待 Worker 领取；若窗口已关闭，请点击“打开 Worker”。"
        : taskProgressText(task);
      return '<tr>'
      + "<td>" + badge(names[task.platform], "source-" + task.platform) + "</td>"
      + "<td><strong>" + escapeHtml(task.keyword) + "</strong></td>"
      + "<td>" + escapeHtml(task.location) + "</td><td><span>" + escapeHtml(timeLabel(task.postedWithinDays)) + "</span><small>" + escapeHtml(jobTypeLabels[task.jobType || "any"] || task.jobType || "不限") + "</small></td>"
      + "<td>" + badge(task.status, "status-badge") + "</td>"
      + '<td class="muted">' + escapeHtml(progressText) + "</td>"
      + '<td class="action-cell">' + (task.status === "needs_user_action"
        ? '<button class="button button-quiet task-resume" data-resume-task="' + task.id + '"><i data-lucide="play"></i><span>继续</span></button>'
        : "")
      + (canOpenWorker ? '<button class="button button-quiet task-resume" data-launch-run-task="' + task.id + '"><i data-lucide="external-link"></i><span>' + (task.status === "running" ? "重新打开 Worker" : "打开 Worker") + '</span></button>' : "")
      + (!["queued", "running"].includes(task.status) ? '<button class="icon-button" data-rerun-task="' + task.id + '" title="重新运行此任务"><i data-lucide="rotate-cw"></i></button>' : "")
      + (task.status === "running" ? '<button class="icon-button stop-keep-action" data-stop-run-task="' + task.id + '" title="停止并保留当前结果"' + (task.stopRequestedAt ? " disabled" : "") + '><i data-lucide="' + (task.stopRequestedAt ? "loader-circle" : "square") + '"></i></button>' : "")
      + '<button class="icon-button destructive" data-delete-run-task="' + task.id + '" data-running="' + (task.status === "running" ? "true" : "false") + '" title="' + (task.status === "running" ? "取消并丢弃本次结果" : "从本次队列移除") + '"><i data-lucide="trash-2"></i></button></td></tr>';
    }).join("")
      || '<tr><td colspan="7" class="empty-cell">本次运行队列已清空。</td></tr>';
    notifyPausedTasks(run);
  }
  if (!run) el("#clear-run-queue").disabled = true;
  el("#runs-list").innerHTML = state.data.runs.map((run) => {
    const canDelete = ["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(run.state);
    return '<article class="run-row"><div><strong>'
      + dateTime(run.startedAt) + "</strong><span>" + run.tasks.length + " 项任务</span></div><div>"
      + badge(run.state, "run-state-badge") + '</div><div class="run-platform-counts"><span>LI '
      + run.counters.linkedin.newJobs + "</span><span>IN " + run.counters.indeed.newJobs
      + "</span><span>SEEK " + run.counters.seek.newJobs + '</span></div><div class="run-history-actions">'
      + '<button class="icon-button destructive" data-delete-run-history="' + run.id + '" type="button" title="'
      + (canDelete ? "删除此次运行及关联职位" : "运行结束后才能删除历史") + '"' + (canDelete ? "" : " disabled")
      + '><i data-lucide="trash-2"></i></button></div></article>';
  }).join("")
    || '<div class="empty-state compact-empty"><p>没有运行记录。</p></div>';
}

function taskProgressText(task) {
  if (task.status === "running") {
    if (task.stopRequestedAt) return "已请求停止，等待 Worker 上传当前结果。";
    if (task.progress?.phase === "cooldown" && task.progress?.cooldownUntil) {
      const remaining = Math.max(0, Date.parse(task.progress.cooldownUntil) - Date.now());
      const minutes = Math.floor(remaining / 60_000);
      const seconds = Math.floor((remaining % 60_000) / 1000);
      return `访问节流休息中 · ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}；${task.progress.cooldownReason || "已连续访问 20 次平台页面，请稍候自动继续。"}`;
    }
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

function taskWorkerIsStale(task) {
  if (task?.status !== "running") return false;
  const heartbeat = Date.parse(task.workerHeartbeatAt || task.progress?.updatedAt || task.startedAt || "");
  return Number.isFinite(heartbeat) && Date.now() - heartbeat > 30_000;
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

function profileEntryCount(profile, key) {
  if (key === "basicInfo") return Object.values(profile.basicInfo || {}).filter(Boolean).length;
  if (key === "visa") return Object.entries(profile.visa || {}).reduce((count, [field, value]) => count + (field === "forceKeepRequirements" ? (value || []).length : Number(Boolean(value))), 0);
  if (key === "skills") return (profile.skills || []).length;
  return (profile[key] || []).length;
}

function profileEntrySummary(section, entry, index) {
  const rawMain = entry.role || entry.name || entry.degree || entry.language || entry.title || entry.description || `第 ${index + 1} 条`;
  const main = rawMain.length > 60 ? `${rawMain.slice(0, 57)}...` : rawMain;
  const secondary = entry.company || entry.institution || entry.organization || entry.issuer || entry.proficiency || entry.subtitle || "";
  const dates = [entry.startDate, entry.endDate].filter(Boolean).join(" - ") || entry.issuedDate || entry.date || "";
  return [main, secondary, dates].filter(Boolean).join(" · ");
}

function profileFieldMarkup(section, field, label, type, value) {
  const attributes = `data-profile-entry-field="${escapeHtml(field)}"`;
  const content = Array.isArray(value) ? value.join("\n") : value || "";
  if (type === "textarea" || type === "lines") {
    return '<label class="field ' + (type === "textarea" || type === "lines" ? "profile-field-wide" : "") + '"><span>' + label
      + '</span><textarea rows="' + (type === "lines" ? "4" : "5") + '" ' + attributes + '>' + escapeHtml(content) + "</textarea></label>";
  }
  const inputType = ["url", "email"].includes(type) ? type : "text";
  return '<label class="field"><span>' + label + '</span><input type="' + inputType + '" ' + attributes + ' value="' + escapeHtml(content) + '"></label>';
}

function profileEntryMarkup(section, entry, index, customSectionId = "") {
  const fields = profileEntryFields[section] || profileEntryFields.custom;
  const hasContent = Object.entries(entry).some(([key, value]) => key !== "id" && (Array.isArray(value)
    ? value.some(Boolean)
    : Boolean(String(value || "").trim())));
  return '<details class="profile-record"' + (hasContent ? "" : " open") + ' data-profile-record data-profile-record-section="' + escapeHtml(section)
    + '" data-profile-record-id="' + escapeHtml(entry.id || "") + '" data-custom-section-id="' + escapeHtml(customSectionId) + '"><summary><span>'
    + escapeHtml(profileEntrySummary(section, entry, index)) + '</span><i data-lucide="chevron-down"></i></summary><div class="profile-record-body"><div class="profile-record-fields">'
    + fields.map(([field, label, type]) => profileFieldMarkup(section, field, label, type, entry[field])).join("")
    + '</div><div class="profile-record-actions"><button class="button button-quiet destructive" type="button" data-remove-profile-record><i data-lucide="trash-2"></i><span>删除此条</span></button></div></div></details>';
}

function basicInfoMarkup(profile) {
  const fields = [
    ["name", "姓名"], ["location", "地区"], ["phone", "电话"], ["email", "邮箱", "email"],
    ["linkedinUrl", "LinkedIn 网址", "url"], ["githubUrl", "GitHub 网址", "url"], ["websiteUrl", "个人网页", "url"]
  ];
  return '<div class="profile-basic-grid">' + fields.map(([field, label, type]) => profileFieldMarkup("basicInfo", field, label, type, profile.basicInfo?.[field])).join("") + "</div>";
}

function visaMarkup(profile) {
  const visa = profile.visa || {};
  const fields = [
    ["visaType", "签证类型"], ["visaName", "签证名称 / 子类别"], ["grantedDate", "下签时间"],
    ["expiryDate", "到期时间"], ["details", "签证与工作权利说明", "textarea"]
  ];
  const keep = visa.forceKeepRequirements || [];
  return '<div class="profile-visa-editor"><div class="profile-basic-grid">'
    + fields.map(([field, label, type]) => profileFieldMarkup("visa", field, label, type, visa[field])).join("")
    + '</div><section class="profile-visa-keep"><div class="profile-visa-keep-heading"><strong>额外强制保留范围</strong><span>命中这些身份或签证要求时，AI 仍会保留职位供人工查看。</span></div><div class="profile-skill-list profile-visa-keep-list">'
    + (keep.length ? keep.map((value) => '<span class="profile-skill" data-visa-keep data-value="' + escapeHtml(value) + '"><span>' + escapeHtml(value)
      + '</span><button type="button" data-remove-visa-keep title="删除保留范围"><i data-lucide="x"></i></button></span>').join("") : '<p class="profile-section-empty">尚未设置额外保留范围。</p>')
    + '</div><div class="profile-skill-composer"><input id="visa-keep-input" type="text" placeholder="例如：澳洲永久居民"><button class="button button-secondary" type="button" data-add-visa-keep><i data-lucide="plus"></i><span>添加</span></button></div></section></div>';
}

function skillsMarkup(profile) {
  const skills = profile.skills || [];
  return '<div class="profile-skill-editor"><div class="profile-skill-list">'
    + (skills.length ? skills.map((skill) => '<span class="profile-skill" data-profile-skill data-value="' + escapeHtml(skill) + '"><span>' + escapeHtml(skill)
      + '</span><button type="button" data-remove-profile-skill title="删除技能"><i data-lucide="x"></i></button></span>').join("") : '<p class="profile-section-empty">尚未填写技能。</p>')
    + '</div><div class="profile-skill-composer"><input id="profile-skill-input" type="text" placeholder="输入技能，如 Python"><button class="button button-secondary" type="button" data-add-profile-skill><i data-lucide="plus"></i><span>添加</span></button></div></div>';
}

function customSectionMarkup(section) {
  const entries = section.entries || [];
  return '<section class="profile-custom-section" data-custom-profile-section="' + escapeHtml(section.id) + '"><div class="profile-custom-heading"><input data-custom-section-title value="'
    + escapeHtml(section.title || "自定义板块") + '" aria-label="自定义板块名称"><div><button class="button button-secondary" type="button" data-add-profile-record="custom" data-custom-section-id="'
    + escapeHtml(section.id) + '"><i data-lucide="plus"></i><span>添加一条</span></button><button class="icon-button destructive" type="button" data-remove-custom-section title="删除自定义板块"><i data-lucide="trash-2"></i></button></div></div>'
    + '<div class="profile-record-list">' + (entries.length ? entries.map((entry, index) => profileEntryMarkup("custom", entry, index, section.id)).join("") : '<p class="profile-section-empty">这个板块暂时为空。</p>') + "</div></section>";
}

function profileSectionEditor(profile) {
  if (state.profileSection === "basicInfo") return basicInfoMarkup(profile);
  if (state.profileSection === "visa") return visaMarkup(profile);
  if (state.profileSection === "skills") return skillsMarkup(profile);
  if (state.profileSection === "customSections") {
    return '<div class="profile-custom-list">' + (profile.customSections || []).map(customSectionMarkup).join("")
      + '<button class="button button-secondary profile-add-custom" type="button" data-add-custom-section><i data-lucide="folder-plus"></i><span>创建自定义板块</span></button></div>';
  }
  const definition = structuredProfileSections.find((item) => item.key === state.profileSection) || structuredProfileSections[0];
  const entries = profile[definition.key] || [];
  return '<div class="profile-record-toolbar"><span>' + entries.length + ' 条记录</span><button class="button button-secondary" type="button" data-add-profile-record="' + definition.key
    + '"><i data-lucide="plus"></i><span>' + definition.addLabel + '</span></button></div><div class="profile-record-list">'
    + (entries.length ? entries.map((entry, index) => profileEntryMarkup(definition.key, entry, index)).join("") : '<div class="profile-section-empty">这个板块暂时为空，可以保持为空或添加记录。</div>') + "</div>";
}

function renderProfile() {
  const selected = selectedProfile();
  const active = activeProfile();
  setProfilePane(state.profilePane);
  el("#profile-draft-count").textContent = String(state.data.profiles.length);
  el("#profile-current").innerHTML = active
    ? '<i data-lucide="circle-check"></i><span>默认：' + escapeHtml(profileLabel(active)) + "</span>"
    : '<i data-lucide="circle-alert"></i><span>尚未激活画像</span>';
  el("#profile-status").textContent = state.data.ai.configured
    ? "AI 已配置：" + state.data.ai.model
    : "本地规则模式；配置 AI 后可获得语义画像与 JD 审阅。";
  el("#profile-versions").innerHTML = state.data.profiles.map((record) =>
    '<button class="profile-version ' + (record.id === state.profileId ? "is-selected" : "") + '" data-profile="' + record.id + '"><span>'
    + escapeHtml(profileLabel(record)) + "</span><small>" + (record.id === active?.id ? "默认" : record.status === "approved" ? "已确认" : "草稿") + "</small></button>").join("")
    || '<span class="muted">暂无版本</span>';
  if (!selected) {
    el("#profile-fields").innerHTML = '<div class="profile-empty"><i data-lucide="contact-round"></i><p>尚未生成画像草稿。</p><button class="button button-primary" type="button" data-profile-pane="upload"><i data-lucide="file-up"></i><span>上传简历</span></button></div>';
    return;
  }
  const p = selected.profile;
  const activeButton = selected.id === active?.id
    ? '<button class="button button-quiet" disabled><i data-lucide="circle-check"></i><span>默认画像</span></button>'
    : '<button class="button button-primary" data-activate="' + selected.id + '"><i data-lucide="circle-check"></i><span>设为默认</span></button>';
  const deleteButton = state.data.profiles.length > 1
    ? '<button class="button button-danger" data-delete-profile="' + selected.id + '"><i data-lucide="trash-2"></i><span>删除画像</span></button>'
    : "";
  const sectionExists = structuredProfileSections.some((item) => item.key === state.profileSection) || state.profileSection === "customSections";
  if (!sectionExists) state.profileSection = "basicInfo";
  const sectionTabs = structuredProfileSections.map((definition) => '<button type="button" class="profile-section-tab ' + (state.profileSection === definition.key ? "is-active" : "")
    + '" data-profile-section="' + definition.key + '"><i data-lucide="' + definition.icon + '"></i><span>' + definition.label + '</span><small>' + profileEntryCount(p, definition.key) + "</small></button>").join("")
    + '<button type="button" class="profile-section-tab ' + (state.profileSection === "customSections" ? "is-active" : "")
    + '" data-profile-section="customSections"><i data-lucide="folder-cog"></i><span>自定义板块</span><small>' + (p.customSections || []).length + "</small></button>";
  const activeDefinition = structuredProfileSections.find((item) => item.key === state.profileSection);
  const editorTitle = activeDefinition?.label || "自定义板块";
  el("#profile-fields").innerHTML = '<section class="profile-record-header"><div class="profile-badges">' + badge("v" + selected.version, "version-badge")
    + badge(selected.status, selected.id === active?.id ? "active-badge" : "status-badge")
    + badge(profileEngineLabel(selected.engine), "status-badge") + '</div><label class="field profile-name-field"><span>画像名称</span><input id="profile-record-name" maxlength="80" value="' + escapeHtml(profileLabel(selected)) + '"></label><p>每个画像拥有独立的评分偏好和排除词；空白板块不会影响保存。</p></section><div class="profile-record-workspace"><nav class="profile-section-nav" aria-label="画像板块">'
    + sectionTabs + '</nav><section class="profile-section-editor"><div class="profile-section-heading"><div><p>当前板块</p><h3>' + editorTitle + '</h3></div></div>'
    + profileSectionEditor(p) + '</section></div><div class="editor-actions"><button class="button button-secondary" data-save-profile="' + selected.id
    + '"><i data-lucide="save"></i><span>保存画像</span></button>' + activeButton + deleteButton + "</div>";
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
  const settingsProfile = selectedSettingsProfile();
  if (settingsProfile && state.settingsProfileId !== settingsProfile.id) state.settingsProfileId = settingsProfile.id;
  el("#settings-profile-select").innerHTML = profileSelectOptions(settingsProfile?.id);
  el("#execution-mode").value = "sequential";
  const timing = settings.workerTiming || {};
  el("#timing-access-limit").value = timing.accessLimit ?? 20;
  el("#timing-cooldown-minutes").value = timing.cooldownMinutes ?? 5;
  el("#timing-action-delay").value = timing.actionDelaySeconds ?? 1;
  el("#timing-scroll-delay").value = timing.scrollDelaySeconds ?? 2;
  el("#timing-page-delay").value = timing.pageDelaySeconds ?? 10;
  el("#timing-jd-interval").value = timing.jdIntervalSeconds ?? 1;
  el("#timing-jd-request-timeout").value = timing.jdRequestTimeoutSeconds ?? 5;
  el("#timing-jd-page-timeout").value = timing.jdPageTimeoutSeconds ?? 10;
  el("#cover-letter-max-pages").value = String(settings.coverLetter?.maxPages ?? 1);
  el("#cover-letter-prompt").value = settings.coverLetter?.prompt || "";
  const thresholds = [["strongMatch", "强匹配"], ["goodMatch", "好匹配"], ["maybe", "可考虑"], ["lowMatch", "低匹配"]];
  el("#threshold-row").innerHTML = thresholds.map((item) => '<label class="threshold"><span>' + item[1]
    + '</span><input type="number" min="0" max="100" data-threshold="' + item[0] + '" value="' + settings.thresholds[item[0]] + '"></label>').join("");
  const history = state.data.unifiedHistory || {};
  el("#unified-history-summary").innerHTML = '<div><strong>' + Number(history.totalKnownJobs || 0).toLocaleString() + '</strong><span>已知职位</span></div>'
    + '<div><strong>' + Number(history.agentJobs || 0).toLocaleString() + '</strong><span>Agent 运行记录</span></div>'
    + '<div><strong>' + Number(history.migratedWorkerRecords || 0).toLocaleString() + '</strong><span>旧 Worker 已迁移</span></div>'
    + '<p><i data-lucide="shield-check"></i>同平台按 ID / 规范链接精确判重；跨平台仅在公司、完整职位名和地点同时一致时跳过。</p>';
  renderPreferenceLearningSettings();
  const profileLearning = contextForProfile(settingsProfile?.id);
  const activeExclusions = profileLearning.exclusionKeywords || [];
  const pendingSuggestions = (profileLearning.exclusionSuggestions || []).filter((suggestion) => suggestion.status === "pending"
    && !exclusionKeywordCovered(suggestion.keyword, activeExclusions));
  el("#active-exclusion-count").textContent = activeExclusions.length + " 项";
  el("#active-exclusion-keywords").innerHTML = activeExclusions.map((keyword) => '<span class="exclusion-chip"><span>' + escapeHtml(keyword)
    + '</span><button class="icon-button" type="button" data-remove-active-exclusion="' + encodeURIComponent(keyword) + '" title="停止使用这个排除词"><i data-lucide="x"></i></button></span>').join("")
    || '<p class="exclusion-empty">当前没有生效的排除关键词。</p>';
  el("#pending-exclusion-count").textContent = pendingSuggestions.length + " 项";
  el("#exclusion-suggestions").innerHTML = pendingSuggestions.map((suggestion) => '<article class="exclusion-suggestion">'
    + '<div><strong>' + escapeHtml(suggestion.keyword) + '</strong><p>' + escapeHtml(suggestion.reason || "AI 根据明确不匹配的完整 JD 提出此建议。") + '</p>'
    + (suggestion.sourceTitles?.length ? '<small>来源：' + escapeHtml(suggestion.sourceTitles.slice(0, 3).join("；")) + '</small>' : '') + '</div>'
    + '<div><button class="button button-secondary" type="button" data-approve-exclusion-suggestion="' + suggestion.id + '"><i data-lucide="check"></i><span>批准</span></button>'
    + '<button class="icon-button" type="button" data-dismiss-exclusion-suggestion="' + suggestion.id + '" title="忽略此建议"><i data-lucide="x"></i></button></div></article>').join("")
    || '<p class="exclusion-empty">暂无待审核建议。AI 不会自行启用排除词。</p>';
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

function renderPreferenceLearningSettings() {
  const target = el("#settings-learning-content");
  const model = contextForProfile(selectedSettingsProfile()?.id).preferenceModel;
  if (!model) {
    target.innerHTML = '<p class="review-learning-empty">尚未形成学习偏好。完成一次职位审阅复盘后会显示在这里。</p>';
    return;
  }
  const reflection = (state.data.reviewReflections || []).find((item) => item.version === model.version
    && item.runId === model.sourceRunId) || null;
  const engine = reflection?.engine || model.engine;
  target.innerHTML = '<div class="learning-summary"><div><strong>学习摘要</strong>'
    + '<span class="learning-version">v' + model.version + (model.updatedAt ? " · " + escapeHtml(dateTime(model.updatedAt)) : "") + "</span>"
    + (engine === "ai" ? '<span class="badge ai-review-badge"><i data-lucide="sparkles"></i>AI 复盘</span>' : '<span class="badge status-badge">本地复盘</span>')
    + '</div><p>' + escapeHtml(model.summary) + "</p></div>"
    + (model.targetSignals?.length ? '<div class="learning-rule-row"><strong>优先信号</strong><div>' + learningChips(model.targetSignals, "is-target") + "</div></div>" : "")
    + (model.deprioritizeSignals?.length ? '<div class="learning-rule-row"><strong>降低优先级</strong><div>' + learningChips(model.deprioritizeSignals, "is-avoid") + "</div></div>" : "")
    + (model.screeningGuidance?.length ? '<div class="learning-guidance"><strong>下次筛选</strong><ul>' + model.screeningGuidance.map((item) => "<li>" + escapeHtml(item) + "</li>").join("") + "</ul></div>" : "")
    + (reflection?.aiError ? '<p class="form-note warning-note">AI 复盘未完成，已使用本地规则：' + escapeHtml(reflection.aiError) + "</p>" : "");
}

async function addExclusionKeyword() {
  const input = el("#manual-exclusion-keyword");
  const keyword = input.value.trim();
  if (!keyword) return toast("请输入排除关键词。", "error");
  try {
    await api("/api/settings/exclusion-keywords", { method: "POST", body: JSON.stringify({ keyword, profileId: selectedSettingsProfile()?.id }) });
    input.value = "";
    await reload();
    toast("排除词已启用；启动任务前仍会再次要求确认。", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function approveExclusionSuggestion(id) {
  try {
    await api("/api/exclusion-suggestions/" + id, { method: "POST", body: JSON.stringify({ profileId: selectedSettingsProfile()?.id }) });
    await reload();
    toast("建议已批准并加入生效排除词。", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function dismissExclusionSuggestion(id) {
  try {
    await api("/api/exclusion-suggestions/" + id + "?profileId=" + encodeURIComponent(selectedSettingsProfile()?.id || ""), { method: "DELETE" });
    await reload();
    toast("已忽略这条排除建议。");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function removeActiveExclusion(encodedKeyword) {
  try {
    await api("/api/settings/exclusion-keywords/" + encodedKeyword + "?profileId=" + encodeURIComponent(selectedSettingsProfile()?.id || ""), { method: "DELETE" });
    await reload();
    toast("这个排除词已停止生效。", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

function workerCopyMarkup(worker, disabled = false) {
  return '<button class="button button-secondary" data-copy-worker="' + worker.id + '"' + (disabled ? " disabled" : "") + '><i data-lucide="copy"></i><span>复制代码</span></button>';
}

function workerInstallMarkup(worker) {
  const installPath = "/workers/install/" + worker.id + "-agent-worker-" + encodeURIComponent(worker.version) + ".user.js";
  return '<a class="button button-primary" data-install-worker="' + worker.id + '" href="' + installPath
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
  renderHistoryMigrationControl();
  renderHistoryResetControl();
}

function renderHistoryMigrationControl() {
  const target = el("#history-migration-summary");
  const button = el("#migrate-worker-history");
  if (!target || !button) return;
  const migrations = state.data?.unifiedHistory?.migrations || [];
  target.innerHTML = workerDefinitions.map((worker) => {
    const current = state.historyMigration.results[worker.id];
    const latest = current?.migration || migrations.find((item) => item.platform === worker.id);
    const latestNonempty = migrations.find((item) => item.platform === worker.id && Number(item.received || 0) > 0);
    const complete = state.historyMigration.completed.has(worker.id);
    const running = state.historyMigration.running && !complete;
    const detail = latest && Number(latest.received || 0) === 0 && latestNonempty
      ? `已迁移 · Worker 已空 · 上次 ${Number(latestNonempty.received).toLocaleString()}`
      : latest
        ? `读取项 ${Number(latest.received || 0).toLocaleString()} · 归并新增 ${Number(latest.imported || 0).toLocaleString()}`
      : running ? "等待读取" : "尚未迁移";
    return '<div class="history-migration-platform' + (complete ? " is-complete" : running ? " is-running" : "") + '">'
      + '<strong>' + escapeHtml(worker.name) + '</strong><span>' + escapeHtml(detail) + '</span></div>';
  }).join("");
  button.disabled = state.historyMigration.running;
  button.querySelector("span").textContent = state.historyMigration.running
    ? `正在迁移 (${state.historyMigration.completed.size}/3)`
    : "迁移并整理历史";
}

function historyMigrationLaunchUrl() {
  const seek = new URL("https://www.seek.com.au/jobs");
  seek.searchParams.set("keywords", "jobs");
  seek.searchParams.set("where", "Australia");
  seek.hash = new URLSearchParams({ jobAgentHistoryMigration: "1" }).toString();
  const indeed = new URL("https://au.indeed.com/jobs");
  indeed.searchParams.set("q", "jobs");
  indeed.searchParams.set("l", "Australia");
  indeed.hash = new URLSearchParams({ jobAgentHistoryMigration: "1", jobAgentMigrationNext: seek.href }).toString();
  const linkedin = new URL("https://www.linkedin.com/jobs/search/");
  linkedin.hash = new URLSearchParams({ jobAgentHistoryMigration: "1", jobAgentMigrationNext: indeed.href }).toString();
  return linkedin.href;
}

function armHistoryMigrationTimeout() {
  clearTimeout(state.historyMigration.timeout);
  state.historyMigration.timeout = setTimeout(() => {
    state.historyMigration.running = false;
    renderHistoryMigrationControl();
    toast("历史迁移未在 90 秒内完成。原 Worker 历史仍保留，可检查迁移窗口后重试。", "error");
  }, 90_000);
}

function migrateWorkerHistory() {
  if (state.historyMigration.running) return;
  const migrationWindow = window.open(historyMigrationLaunchUrl(), "job-agent-history-migration");
  if (!migrationWindow) return toast("迁移窗口被浏览器拦截，请允许此站点打开弹窗后重试。", "error");
  state.historyMigration = { running: true, completed: new Set(), results: {}, timeout: null, window: migrationWindow };
  armHistoryMigrationTimeout();
  renderHistoryMigrationControl();
  refreshIcons();
  toast("正在依次迁移 LinkedIn、Indeed 和 SEEK 历史；不会运行搜索任务。");
}

async function finishWorkerHistoryMigration() {
  clearTimeout(state.historyMigration.timeout);
  try {
    const result = await api("/api/history/normalize", { method: "POST", body: "{}" });
    state.historyMigration.running = false;
    state.historyMigration.window = null;
    await reload();
    state.view = "setup";
    render();
    const cleanup = result.cleanup || {};
    toast(`历史迁移完成：统一保留 ${Number(cleanup.totalKnownJobs || 0).toLocaleString()} 个职位，合并 ${Number(cleanup.mergedAliases || 0).toLocaleString()} 个重复别名。`);
  } catch (error) {
    state.historyMigration.running = false;
    renderHistoryMigrationControl();
    toast(error.message, "error");
  }
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
    toast("Worker 历史清理未在 45 秒内完成。请在安装设置中更新三份 Worker 后重试。", "error");
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
  el("#ai-state").textContent = state.data
    ? state.data.ai.configured ? "AI · " + state.data.ai.model : "本地规则"
    : "正在连接";
  el("#start-run").classList.toggle("is-hidden", state.view === "routine");
  document.querySelectorAll(".view").forEach((node) => node.classList.toggle("is-active", node.id === "view-" + state.view));
  document.querySelectorAll("[data-view]").forEach((node) => node.classList.toggle("is-active", node.dataset.view === state.view));
  if (!state.data) return refreshIcons();
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
  if (!state.data.profiles.some((profile) => profile.id === state.profileId)) state.profileId = state.data.activeProfile?.id || state.data.profiles[0]?.id || null;
  if (!state.data.profiles.some((profile) => profile.id === state.settingsProfileId)) state.settingsProfileId = state.data.activeProfile?.id || state.data.profiles[0]?.id || null;
  el("#api-status").textContent = "本地服务已连接";
  el("#api-status-dot").classList.add("is-online");
  render();
}

async function launchRun(routineTaskIds = null, profileId = null) {
  const launcher = window.open("about:blank", "job-agent-worker-launch");
  try {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    const result = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({ ...(routineTaskIds ? { routineTaskIds } : {}), profileId })
    });
    const firstLaunch = result.launchUrls[0];
    if (launcher && firstLaunch?.url) {
      launcher.location.href = firstLaunch.url;
    } else launcher?.close();
    state.jobsPane = "current";
    state.historyRunId = "";
    state.historyTaskId = "";
    state.currentRunId = "";
    state.currentRunTaskId = "";
    state.routinePane = "monitor";
    await reload();
    state.view = "routine";
    render();
    const blocked = Boolean(firstLaunch?.url && !launcher);
    toast(blocked
      ? "Worker 启动窗口被浏览器拦截，请允许此站点弹窗。"
      : "已创建 " + result.run.tasks.length + " 项任务；Worker 会按队列依次处理。", blocked ? "error" : "success");
    return result;
  } catch (error) {
    launcher?.close();
    toast(error.message, "error");
    return null;
  }
}

function createRun() {
  return requestRunConfirmation();
}

function runRoutineTask(id) {
  return requestRunConfirmation([id]);
}

function runSelectedRoutineTasks() {
  const availableIds = new Set((state.data.routineTasks || []).filter((task) => task.status === "READY").map((task) => task.id));
  const selectedIds = [...state.selectedRoutineTaskIds].filter((id) => availableIds.has(id));
  if (!selectedIds.length) return toast("请先勾选要一起运行的任务。", "error");
  return requestRunConfirmation(selectedIds);
}

function readyRoutineTaskIds(platform = null) {
  return (state.data.routineTasks || [])
    .filter((task) => task.status === "READY" && (!platform || task.platform === platform))
    .map((task) => task.id);
}

function selectRoutineTaskRange(id, checked, shiftKey) {
  const ids = readyRoutineTaskIds();
  const currentIndex = ids.indexOf(id);
  const anchorIndex = ids.indexOf(state.routineSelectionAnchorId);
  const range = shiftKey && anchorIndex >= 0 && currentIndex >= 0
    ? ids.slice(Math.min(anchorIndex, currentIndex), Math.max(anchorIndex, currentIndex) + 1)
    : [id];
  range.forEach((taskId) => {
    if (checked) state.selectedRoutineTaskIds.add(taskId);
    else state.selectedRoutineTaskIds.delete(taskId);
  });
  state.routineSelectionAnchorId = id;
  reconcileCategorySelectionsFromRoutineTasks();
}

function setRoutineTaskSelection(ids, checked) {
  ids.forEach((id) => {
    if (checked) state.selectedRoutineTaskIds.add(id);
    else state.selectedRoutineTaskIds.delete(id);
  });
  if (!checked && !state.selectedRoutineTaskIds.size) state.routineSelectionAnchorId = "";
  reconcileCategorySelectionsFromRoutineTasks();
  renderRoutine();
  refreshIcons();
}

function requestRunConfirmation(routineTaskIds = null) {
  const allTasks = (state.data.routineTasks || []).filter((task) => task.status === "READY");
  const selected = routineTaskIds ? allTasks.filter((task) => routineTaskIds.includes(task.id)) : allTasks;
  if (!selected.length) return toast("没有可运行任务。请先验证并启用任务组合。", "error");
  if (!state.data.profiles?.length) return toast("请先创建并确认至少一个职业画像。", "error");
  state.pendingRunTaskIds = routineTaskIds ? selected.map((task) => task.id) : null;
  state.pendingRunProfileId = state.data.activeProfile?.id || state.data.profiles[0].id;
  el("#run-profile-select").innerHTML = profileSelectOptions(state.pendingRunProfileId);
  renderRunProfileConfirmation(selected);
  el("#run-exclusion-confirmed").checked = false;
  el("#confirm-start-run").disabled = true;
  el("#run-confirmation-dialog").showModal();
  refreshIcons();
}

function renderRunProfileConfirmation(selectedTasks = null) {
  const allTasks = (state.data.routineTasks || []).filter((task) => task.status === "READY");
  const selected = selectedTasks || (state.pendingRunTaskIds ? allTasks.filter((task) => state.pendingRunTaskIds.includes(task.id)) : allTasks);
  const profile = state.data.profiles.find((item) => item.id === state.pendingRunProfileId) || state.data.profiles[0];
  const exclusions = contextForProfile(profile?.id).exclusionKeywords || [];
  el("#run-exclusion-review").innerHTML = '<div class="run-confirm-summary"><strong>本次 ' + selected.length + ' 项任务</strong><span>'
    + escapeHtml([...new Set(selected.map((task) => names[task.platform]))].join(" / ")) + ' · ' + escapeHtml(profileLabel(profile)) + '</span></div>'
    + (exclusions.length
      ? '<div class="run-confirm-keywords">' + exclusions.map((keyword) => '<span>' + escapeHtml(keyword) + '</span>').join("") + '</div>'
      : '<p class="exclusion-empty">当前没有生效的排除关键词，本次 Worker 不会按排除词跳过职位。</p>');
}

async function confirmStartRun(event) {
  event.preventDefault();
  if (!el("#run-exclusion-confirmed").checked) return;
  const button = el("#confirm-start-run");
  button.disabled = true;
  const requestedIds = state.pendingRunTaskIds;
  const result = await launchRun(requestedIds, state.pendingRunProfileId);
  if (!result) {
    button.disabled = false;
    return;
  }
  el("#run-confirmation-dialog").close();
  if (requestedIds) {
    requestedIds.forEach((id) => state.selectedRoutineTaskIds.delete(id));
    reconcileCategorySelectionsFromRoutineTasks();
  }
  state.pendingRunTaskIds = null;
  state.pendingRunProfileId = null;
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
  const profileName = el("#generated-profile-name").value.trim();
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
        name: profileName,
        resumeText,
        sourceName: state.resumeSource || "pasted-resume.txt",
        externalProfileText
      })
    });
    state.profileId = result.profile.id;
    state.profilePane = "editor";
    el("#generated-profile-name").value = "";
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

function openNewProfileDialog() {
  const selected = selectedProfile();
  const form = el("#new-profile-form");
  form.reset();
  const copy = el("#new-profile-copy-current");
  copy.disabled = !selected;
  el("#new-profile-copy-note").textContent = selected
    ? `复制“${profileLabel(selected)}”的画像字段；学习偏好、排除词和待审核建议会保持为空。`
    : "当前没有可复制的画像，将创建空白画像。";
  el("#new-profile-dialog").showModal();
  el("#new-profile-name").focus();
  refreshIcons();
}

async function createProfile(event) {
  event.preventDefault();
  const name = el("#new-profile-name").value.trim();
  if (!name) return toast("请输入画像名称。", "error");
  const selected = selectedProfile();
  const copyCurrent = el("#new-profile-copy-current").checked && selected;
  const submit = event.submitter || el("#new-profile-form button[type='submit']");
  submit.disabled = true;
  try {
    const result = await api("/api/profiles", {
      method: "POST",
      body: JSON.stringify({
        name,
        ...(copyCurrent ? { copyFromProfileId: selected.id, profile: commitProfileEditor() } : {})
      })
    });
    state.profileId = result.profile.id;
    state.profilePane = "editor";
    el("#new-profile-dialog").close();
    await reload();
    toast(copyCurrent ? "新画像已创建，并复制了当前画像内容。" : "空白画像已创建。", "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    submit.disabled = false;
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

function profileRecordFromNode(node) {
  const record = { id: node.dataset.profileRecordId || `entry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
  node.querySelectorAll("[data-profile-entry-field]").forEach((input) => {
    const field = input.dataset.profileEntryField;
    record[field] = ["highlights", "technologies"].includes(field)
      ? input.value.split(/\n+/).map((value) => value.trim()).filter(Boolean)
      : input.value.trim();
  });
  return record;
}

function profileForm() {
  const selected = selectedProfile();
  const profile = JSON.parse(JSON.stringify(selected?.profile || { schemaVersion: 2 }));
  profile.schemaVersion = 2;
  if (state.profileSection === "basicInfo") {
    profile.basicInfo ||= {};
    document.querySelectorAll("#profile-fields [data-profile-entry-field]").forEach((input) => {
      profile.basicInfo[input.dataset.profileEntryField] = input.value.trim();
    });
  } else if (state.profileSection === "visa") {
    profile.visa ||= {};
    document.querySelectorAll("#profile-fields [data-profile-entry-field]").forEach((input) => {
      profile.visa[input.dataset.profileEntryField] = input.value.trim();
    });
    profile.visa.forceKeepRequirements = [...document.querySelectorAll("#profile-fields [data-visa-keep]")]
      .map((node) => node.dataset.value).filter(Boolean);
  } else if (state.profileSection === "skills") {
    profile.skills = [...document.querySelectorAll("#profile-fields [data-profile-skill]")].map((node) => node.dataset.value).filter(Boolean);
  } else if (state.profileSection === "customSections") {
    profile.customSections = [...document.querySelectorAll("#profile-fields [data-custom-profile-section]")].map((section) => ({
      id: section.dataset.customProfileSection,
      title: section.querySelector("[data-custom-section-title]")?.value.trim() || "自定义板块",
      entries: [...section.querySelectorAll("[data-profile-record]")].map(profileRecordFromNode)
    }));
  } else if (structuredProfileSections.some((item) => item.key === state.profileSection)) {
    profile[state.profileSection] = [...document.querySelectorAll("#profile-fields [data-profile-record]")].map(profileRecordFromNode);
  }
  return profile;
}

function commitProfileEditor() {
  const selected = selectedProfile();
  if (selected && el("#profile-fields")?.querySelector(".profile-record-workspace")) {
    selected.profile = profileForm();
    selected.name = el("#profile-record-name")?.value.trim() || selected.name;
  }
  return selected?.profile;
}

function emptyProfileEntry(section) {
  const fields = profileEntryFields[section] || profileEntryFields.custom;
  return Object.fromEntries([["id", `${section}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`], ...fields.map(([field, , type]) => [field, type === "lines" ? [] : ""])]);
}

function setProfileSection(section) {
  commitProfileEditor();
  state.profileSection = section;
  renderProfile();
  refreshIcons();
}

function addProfileRecord(section, customSectionId = "") {
  const profile = commitProfileEditor();
  if (!profile) return;
  let entry;
  if (section === "custom") {
    const custom = profile.customSections.find((item) => item.id === customSectionId);
    if (!custom) return;
    entry = emptyProfileEntry("custom");
    custom.entries.push(entry);
  } else {
    profile[section] ||= [];
    entry = emptyProfileEntry(section);
    profile[section].push(entry);
  }
  renderProfile();
  refreshIcons();
  const record = document.querySelector(`[data-profile-record-id="${entry.id}"]`);
  record?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  record?.querySelector("input, textarea")?.focus();
}

function removeProfileRecord(button) {
  const profile = commitProfileEditor();
  const record = button.closest("[data-profile-record]");
  if (!profile || !record) return;
  const id = record.dataset.profileRecordId;
  if (record.dataset.profileRecordSection === "custom") {
    const custom = profile.customSections.find((item) => item.id === record.dataset.customSectionId);
    if (custom) custom.entries = custom.entries.filter((item) => item.id !== id);
  } else {
    const section = record.dataset.profileRecordSection;
    profile[section] = (profile[section] || []).filter((item) => item.id !== id);
  }
  renderProfile();
  refreshIcons();
}

function addProfileSkill() {
  const profile = commitProfileEditor();
  const input = el("#profile-skill-input");
  const value = input?.value.trim();
  if (!profile || !value) return;
  profile.skills ||= [];
  if (!profile.skills.some((skill) => skill.toLowerCase() === value.toLowerCase())) profile.skills.push(value);
  renderProfile();
  refreshIcons();
}

function removeProfileSkill(button) {
  const profile = commitProfileEditor();
  const value = button.closest("[data-profile-skill]")?.dataset.value;
  if (!profile || !value) return;
  profile.skills = (profile.skills || []).filter((skill) => skill !== value);
  renderProfile();
  refreshIcons();
}

function addVisaKeepRequirement() {
  const profile = commitProfileEditor();
  const input = el("#visa-keep-input");
  const value = input?.value.trim();
  if (!profile || !value) return;
  profile.visa ||= {};
  profile.visa.forceKeepRequirements ||= [];
  if (!profile.visa.forceKeepRequirements.some((item) => item.toLowerCase() === value.toLowerCase())) {
    profile.visa.forceKeepRequirements.push(value);
  }
  renderProfile();
  refreshIcons();
}

function removeVisaKeepRequirement(button) {
  const profile = commitProfileEditor();
  const value = button.closest("[data-visa-keep]")?.dataset.value;
  if (!profile || !value) return;
  profile.visa.forceKeepRequirements = (profile.visa.forceKeepRequirements || []).filter((item) => item !== value);
  renderProfile();
  refreshIcons();
}

function addCustomProfileSection() {
  const profile = commitProfileEditor();
  if (!profile) return;
  profile.customSections ||= [];
  const id = `section-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  profile.customSections.push({ id, title: "新板块", entries: [] });
  renderProfile();
  refreshIcons();
  const title = document.querySelector(`[data-custom-profile-section="${id}"] [data-custom-section-title]`);
  title?.focus();
  title?.select();
}

function removeCustomProfileSection(button) {
  const profile = commitProfileEditor();
  const id = button.closest("[data-custom-profile-section]")?.dataset.customProfileSection;
  if (!profile || !id || !window.confirm("删除这个自定义板块及其中所有内容？")) return;
  profile.customSections = (profile.customSections || []).filter((section) => section.id !== id);
  renderProfile();
  refreshIcons();
}

async function saveProfile(id) {
  try {
    const record = selectedProfile();
    await api("/api/profiles/" + id, { method: "PUT", body: JSON.stringify({ profile: profileForm(), name: el("#profile-record-name")?.value || record?.name }) });
    await reload();
    toast("画像已保存。");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function activateProfile(id) {
  try {
    const record = selectedProfile();
    await api("/api/profiles/" + id, { method: "PUT", body: JSON.stringify({ profile: profileForm(), name: el("#profile-record-name")?.value || record?.name }) });
    const result = await api("/api/profiles/" + id + "/activate", { method: "POST", body: "{}" });
    state.profileId = id;
    await reload();
    toast("已设为默认画像；其他画像仍会保留。", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteProfile(id) {
  const profile = state.data.profiles.find((item) => item.id === id);
  if (!profile || !window.confirm(`删除画像“${profileLabel(profile)}”？该画像的职位历史仍会保留，但不能再用于新任务或重新生成文档。`)) return;
  try {
    const result = await api("/api/profiles/" + id, { method: "DELETE" });
    state.profileId = result.activeProfileId;
    state.settingsProfileId = result.activeProfileId;
    await reload();
    toast("画像已删除。", "success");
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
    executionMode: el("#execution-mode").value,
    workerTiming: {
      accessLimit: Number(el("#timing-access-limit").value),
      cooldownMinutes: Number(el("#timing-cooldown-minutes").value),
      actionDelaySeconds: Number(el("#timing-action-delay").value),
      scrollDelaySeconds: Number(el("#timing-scroll-delay").value),
      pageDelaySeconds: Number(el("#timing-page-delay").value),
      jdIntervalSeconds: Number(el("#timing-jd-interval").value),
      jdRequestTimeoutSeconds: Number(el("#timing-jd-request-timeout").value),
      jdPageTimeoutSeconds: Number(el("#timing-jd-page-timeout").value)
    },
    coverLetter: {
      maxPages: Number(el("#cover-letter-max-pages").value),
      prompt: el("#cover-letter-prompt").value.trim()
    }
  };
}

function categoryTaskEditorRow(task = {}) {
  const platform = task.platform || "linkedin";
  const jobType = task.jobType || "any";
  const postedWithinDays = Number(task.postedWithinDays || 0);
  const platformOptions = ["linkedin", "indeed", "seek"].map((value) => '<option value="' + value + '"' + (platform === value ? " selected" : "") + '>' + names[value] + '</option>').join("");
  const timeOptions = Object.entries(postedWithinLabels).map(([value, label]) => '<option value="' + value + '"' + (postedWithinDays === Number(value) ? " selected" : "") + '>' + label + '</option>').join("");
  return '<div class="category-task-editor-row" data-category-task-id="' + escapeHtml(task.id || "") + '">'
    + '<label class="field"><span>平台</span><select data-category-task-field="platform">' + platformOptions + '</select></label>'
    + '<label class="field"><span>职位类型</span><select data-category-task-field="jobType">' + jobTypeOptions(platform, jobType) + '</select></label>'
    + '<label class="field category-task-keyword"><span>关键词（逗号表示任一）</span><input data-category-task-field="keyword" required maxlength="160" placeholder="intern, internship" value="' + escapeHtml(task.keyword || "") + '"></label>'
    + '<label class="field category-task-location"><span>地点</span><input data-category-task-field="location" required maxlength="120" value="' + escapeHtml(task.location || "") + '"></label>'
    + '<label class="field"><span>时间</span><select data-category-task-field="postedWithinDays">' + timeOptions + '</select></label>'
    + '<button class="icon-button destructive category-task-remove" type="button" data-remove-category-task title="删除子任务"><i data-lucide="trash-2"></i></button>'
    + '</div>';
}

function taskIdentityKey(task) {
  return [
    String(task?.platform || "").toLowerCase(),
    String(task?.keyword || "").toLowerCase().split(",").map((value) => value.trim()).filter(Boolean).join(","),
    String(task?.location || "").toLowerCase().replace(/\s+/g, " ").trim(),
    Number(task?.postedWithinDays || 0),
    String(task?.jobType || "any")
  ].join("\u0000");
}

function verifiedTaskOptions() {
  const validations = state.data.validations || [];
  const validationById = new Map(validations.map((validation) => [validation.id, validation]));
  const optionsByTask = new Map();
  const addOption = (source, validation, enabled) => {
    if (!validation || validation.status !== "VALID") return;
    const key = taskIdentityKey(source);
    const current = optionsByTask.get(key);
    if (current?.enabled && !enabled) return;
    optionsByTask.set(key, {
      validationId: validation.id,
      platform: source.platform,
      keyword: source.keyword,
      location: source.location,
      postedWithinDays: Number(source.postedWithinDays || 0),
      jobType: source.jobType || "any",
      enabled: Boolean(enabled)
    });
  };
  for (const task of state.data.routineTasks || []) {
    if (task.status === "READY") addOption(task, validationById.get(task.validationId), true);
  }
  for (const validation of validations) addOption(validation, validation, false);
  const platformRank = { linkedin: 0, seek: 1, indeed: 2 };
  return [...optionsByTask.values()].sort((left, right) =>
    (platformRank[left.platform] ?? 9) - (platformRank[right.platform] ?? 9)
      || left.keyword.localeCompare(right.keyword)
      || left.location.localeCompare(right.location));
}

function visibleVerifiedTaskOptions() {
  const query = String(el("#category-verified-search")?.value || "").toLowerCase().trim();
  if (!query) return verifiedTaskOptions();
  return verifiedTaskOptions().filter((task) => [names[task.platform], task.platform, task.keyword, task.location, postedWithinLabels[task.postedWithinDays], jobTypeLabels[task.jobType || "any"]]
    .some((value) => String(value || "").toLowerCase().includes(query)));
}

function renderVerifiedTaskPicker() {
  const options = verifiedTaskOptions();
  const visible = visibleVerifiedTaskOptions();
  const selected = state.categoryEditorSelectedValidationIds;
  el("#category-verified-count").textContent = `已选 ${selected.size} / ${options.length} 项`;
  el("#select-visible-verified-tasks").disabled = !visible.length || visible.every((task) => selected.has(task.validationId));
  el("#clear-verified-task-selection").disabled = !selected.size;
  el("#category-verified-task-list").innerHTML = visible.map((task) => {
    const checked = selected.has(task.validationId);
    return '<label class="category-verified-task-row' + (checked ? " is-selected" : "") + '">'
      + '<input type="checkbox" data-category-verified-task="' + task.validationId + '"' + (checked ? " checked" : "") + '>'
      + '<span>' + badge(names[task.platform], "source-" + task.platform) + '</span>'
      + '<strong title="' + escapeHtml(task.keyword) + '">' + escapeHtml(task.keyword) + '</strong>'
      + '<span class="verified-task-location" title="' + escapeHtml(task.location) + '">' + escapeHtml(task.location) + '</span>'
      + '<span class="verified-task-time">' + escapeHtml(postedWithinLabels[task.postedWithinDays] || "不限") + ' · ' + escapeHtml(jobTypeLabels[task.jobType || "any"] || task.jobType) + '</span>'
      + '<span class="verified-task-state">' + badge(task.enabled ? "可运行" : "已预检", "status-badge") + '</span>'
      + '</label>';
  }).join("") || '<div class="category-editor-empty">' + (options.length ? "没有匹配的已预检任务。" : "还没有通过预检的任务，可先在下方新增。") + '</div>';
  updateCategoryEditorCount();
}

function updateCategoryEditorCount() {
  const editor = el("#category-task-editor");
  const draftCount = editor.querySelectorAll(".category-task-editor-row").length;
  const verifiedCount = state.categoryEditorSelectedValidationIds.size;
  if (!draftCount && !editor.querySelector(".category-editor-empty")) {
    editor.innerHTML = '<div class="category-editor-empty">无需新增时可留空；也可以加入尚未预检的新任务。</div>';
  }
  el("#category-new-task-count").textContent = draftCount + " 项";
  el("#category-editor-count").textContent = verifiedCount + draftCount + " 项";
  el("#save-task-category").disabled = verifiedCount + draftCount === 0;
}

function addCategoryTaskEditor(task = {}) {
  el("#category-task-editor").querySelector(".category-editor-empty")?.remove();
  el("#category-task-editor").insertAdjacentHTML("beforeend", categoryTaskEditorRow(task));
  updateCategoryEditorCount();
  refreshIcons();
}

function openTaskCategoryDialog(id = null) {
  const category = id ? (state.data.taskCategories || []).find((item) => item.id === id) : null;
  if (id && (!category || category.builtin)) return toast("这个组合不能编辑。", "error");
  state.editingCategoryId = category?.id || null;
  el("#task-category-form").reset();
  el("#task-category-name").value = category?.name || "";
  el("#task-category-dialog-title").textContent = category ? "编辑自定义组合" : "新建自定义组合";
  el("#category-task-editor").innerHTML = "";
  el("#category-verified-search").value = "";
  state.categoryEditorSelectedValidationIds = new Set();
  state.categoryEditorTaskIdsByValidationId = new Map();
  const options = verifiedTaskOptions();
  const optionsByValidationId = new Map(options.map((task) => [task.validationId, task]));
  const optionsByTask = new Map(options.map((task) => [taskIdentityKey(task), task]));
  for (const task of category?.tasks || []) {
    const verified = optionsByValidationId.get(task.validationId) || optionsByTask.get(taskIdentityKey(task));
    if (verified) {
      state.categoryEditorSelectedValidationIds.add(verified.validationId);
      state.categoryEditorTaskIdsByValidationId.set(verified.validationId, task.id);
    } else {
      addCategoryTaskEditor(task);
    }
  }
  renderVerifiedTaskPicker();
  updateCategoryEditorCount();
  el("#task-category-dialog").showModal();
  refreshIcons();
}

function taskCategoryFormInput() {
  const optionsById = new Map(verifiedTaskOptions().map((task) => [task.validationId, task]));
  const verifiedTasks = [...state.categoryEditorSelectedValidationIds].map((validationId) => {
    const task = optionsById.get(validationId);
    if (!task) throw new Error("有一项已预检任务已失效，请刷新后重新选择。");
    return {
      id: state.categoryEditorTaskIdsByValidationId.get(validationId) || undefined,
      sourceValidationId: validationId,
      platform: task.platform,
      keyword: task.keyword,
      location: task.location,
      postedWithinDays: task.postedWithinDays,
      jobType: task.jobType || "any"
    };
  });
  const draftTasks = [...document.querySelectorAll("#category-task-editor .category-task-editor-row")].map((row) => ({
    id: row.dataset.categoryTaskId || undefined,
    platform: row.querySelector('[data-category-task-field="platform"]').value,
    keyword: row.querySelector('[data-category-task-field="keyword"]').value,
    location: row.querySelector('[data-category-task-field="location"]').value,
    postedWithinDays: Number(row.querySelector('[data-category-task-field="postedWithinDays"]').value),
    jobType: row.querySelector('[data-category-task-field="jobType"]').value
  }));
  const tasks = [...verifiedTasks, ...draftTasks];
  if (!tasks.length) throw new Error("请至少选择一项已预检任务，或新增一项待预检任务。");
  const keys = tasks.map(taskIdentityKey);
  if (new Set(keys).size !== keys.length) throw new Error("同一个任务不需要重复加入组合。");
  return { name: el("#task-category-name").value, tasks, verifiedCount: verifiedTasks.length, draftCount: draftTasks.length };
}

async function saveTaskCategory(event) {
  event.preventDefault();
  const id = state.editingCategoryId;
  try {
    const input = taskCategoryFormInput();
    await api(id ? "/api/task-categories/" + id : "/api/task-categories", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify({ name: input.name, tasks: input.tasks })
    });
    el("#task-category-dialog").close();
    state.editingCategoryId = null;
    await reload();
    const detail = input.verifiedCount && input.draftCount
      ? `已复用 ${input.verifiedCount} 项预检结果，另有 ${input.draftCount} 项等待预检。`
      : input.verifiedCount ? `已复用 ${input.verifiedCount} 项预检结果。` : `${input.draftCount} 项任务等待预检。`;
    toast((id ? "自定义组合已更新。" : "自定义组合已创建。") + detail, "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteTaskCategory(id) {
  const category = (state.data.taskCategories || []).find((item) => item.id === id);
  if (!category || category.builtin) return;
  if (!window.confirm(`删除自定义组合“${category.name}”？已启用的任务会保留，并自动归入“单独任务”。`)) return;
  try {
    await api("/api/task-categories/" + id, { method: "DELETE" });
    state.selectedCategoryIds.delete(id);
    state.expandedCategoryIds.delete(id);
    await reload();
    toast("自定义组合已删除；原有已启用任务仍保留。", "success");
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
    state.view = "routine";
    state.routinePane = "plan";
    persistView();
    await reload();
    if (firstLaunch?.url && !launcher) {
      toast("预检窗口被浏览器拦截。已保存待预检任务，请允许弹窗后点击统一预检。", "error");
    } else if (mode === "import" && prepared.pending) {
      toast(`已启用 ${prepared.added} 项；另有 ${prepared.pending} 项正在预检，通过后会自动在组合内启用。`);
    } else if (mode === "import") {
      toast(`已启用 ${prepared.added} 项任务，${prepared.alreadyAdded} 项原本已可运行。`);
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
  syncRoutineJobTypeOptions("any");
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
  syncRoutineJobTypeOptions(validation.jobType || "any");
  el("#routine-task-dialog-title").textContent = "修改待预检任务";
  el("#routine-task-submit-label").textContent = "保存到待预检";
  el("#routine-task-dialog").showModal();
}

function routineTaskInput() {
  return {
    platform: el("#routine-task-platform").value,
    keyword: el("#routine-task-keyword").value,
    location: el("#routine-task-location").value,
    postedWithinDays: Number(el("#routine-task-time").value),
    jobType: el("#routine-task-job-type").value
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
    const task = (state.data.routineTasks || []).find((item) => item.id === id);
    await api("/api/routine-tasks/" + id, { method: "DELETE" });
    state.selectedRoutineTaskIds.delete(id);
    if (task?.categoryId) state.selectedCategoryIds.delete(task.categoryId);
    await reload();
    toast("任务已停用；组合配置和历史运行仍保留。");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function clearRoutineTasks() {
  if (!window.confirm("停用全部可运行任务？任务组合、预检记录、历史运行和职位汇总都会保留。")) return;
  try {
    const result = await api("/api/routine-tasks", { method: "DELETE" });
    state.selectedRoutineTaskIds.clear();
    state.selectedCategoryIds.clear();
    await reload();
    toast("已停用 " + result.cleared.count + " 条任务；任务组合仍保留。");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteRunTask(id, isRunning) {
  const message = isRunning
    ? "取消并丢弃这个正在执行的任务？Worker 后续回传的本次结果不会导入。"
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

async function stopRunTask(id) {
  if (!window.confirm("停止这个任务并保留目前已经获取的职位？Worker 会尽快结束并上传当前结果，然后继续队列中的下一项任务。")) return;
  const run = currentRun();
  if (!run) return;
  try {
    await api("/api/runs/" + run.id + "/tasks/" + id + "/stop", { method: "POST", body: "{}" });
    await reload();
    toast("已通知 Worker 停止并保留当前结果。", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function markRunTaskViewed(runId, id, button) {
  const entry = pendingReviewTaskEntries().find((item) => item.runId === runId && item.taskId === id);
  if (!entry) return;
  const unviewed = entry.jobs.filter((job) => !job.viewedAt).length;
  if (!window.confirm(`将“${entry.task.keyword} / ${entry.task.location}”的 ${entry.jobs.length} 个职位全部标记为已看？\n\n其中 ${unviewed} 个目前未看；职位和审阅结果仍会保留在历史记录中。`)) return;
  const previousHtml = button?.innerHTML || "";
  if (button) {
    button.disabled = true;
    button.classList.add("is-busy");
    button.innerHTML = '<i data-lucide="loader-circle" class="button-spinner"></i><span>正在标记</span>';
    refreshIcons();
  }
  try {
    const result = await api("/api/runs/" + runId + "/tasks/" + id + "/viewed", { method: "PUT", body: "{}" });
    if (state.currentRunId === runId && state.currentRunTaskId === id) {
      state.currentRunId = "";
      state.currentRunTaskId = "";
    }
    await reload();
    toast("已将该任务的 " + result.total + " 个职位标记为已看；任务已从待审阅列表移除。", "success");
  } catch (error) {
    toast(error.message, "error");
    if (button?.isConnected) {
      button.disabled = false;
      button.classList.remove("is-busy");
      button.innerHTML = previousHtml;
      refreshIcons();
    }
  }
}

async function deleteJobStatTask(runId, id) {
  const run = state.data.runs.find((item) => item.id === runId);
  const task = run?.tasks.find((item) => item.id === id);
  if (!run || !task) return;
  const jobCount = state.data.jobs.filter((job) => job.runId === run.id && matchingRunTask(run, job)?.id === id).length;
  const message = `删除“${task.keyword} / ${task.location}”的任务统计及 ${jobCount} 个关联职位？\n\n每日任务和任务组合不会被删除。`;
  if (!window.confirm(message)) return;
  try {
    const result = await api("/api/runs/" + run.id + "/tasks/" + id + "/results", { method: "DELETE" });
    if (state.currentRunId === run.id && state.currentRunTaskId === id) {
      state.currentRunId = "";
      state.currentRunTaskId = "";
    }
    await reload();
    toast("已删除该任务统计及 " + result.removed.jobs + " 个关联职位。");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteRunHistory(id) {
  const run = state.data.runs.find((item) => item.id === id);
  if (!run) return;
  const jobCount = state.data.jobs.filter((job) => job.runId === id).length;
  const message = `删除 ${dateTime(run.startedAt)} 的运行历史、${run.tasks.length} 项任务统计及 ${jobCount} 个关联职位？\n\n每日任务、内置预设和自定义任务组合不会被删除。`;
  if (!window.confirm(message)) return;
  try {
    const result = await api("/api/runs/" + id, { method: "DELETE" });
    if (state.historyRunId === id) {
      state.historyRunId = "";
      state.historyTaskId = "";
    }
    if (state.currentRunId === id) {
      state.currentRunId = "";
      state.currentRunTaskId = "";
    }
    await reload();
    toast("已删除该次运行及 " + result.removed.jobs + " 个关联职位。");
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
  const launcher = window.open("about:blank", "job-agent-worker-launch");
  if (!launcher) return toast("浏览器阻止了 Worker 窗口，请允许本站打开弹窗后再点继续。", "error");
  try {
    const result = await api("/api/tasks/" + id + "/resume", { method: "POST", body: "{}" });
    launcher.location.replace(result.launchUrl);
    await reload();
    toast("任务已恢复，并重新打开了对应 Worker。", "success");
  } catch (error) {
    launcher.close();
    toast(error.message, "error");
  }
}

async function openRunTaskWorker(id) {
  const run = currentRun();
  if (!run) return;
  const launcher = window.open("about:blank", "job-agent-worker-launch");
  if (!launcher) return toast("浏览器阻止了 Worker 窗口，请允许本站打开弹窗后重试。", "error");
  try {
    const result = await api("/api/runs/" + run.id + "/tasks/" + id + "/launch", { method: "POST", body: "{}" });
    launcher.location.replace(result.launchUrl);
    await reload();
    state.routinePane = "monitor";
    state.view = "routine";
    render();
    toast(result.recovered ? "失联任务已重新排队并打开 Worker。" : "Worker 已重新打开，正在领取当前任务。", "success");
  } catch (error) {
    launcher.close();
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
    const preservedCategories = Number(result.preserved?.taskCategories || 0);
    toast(`Agent 已清除 ${count} 条记录，保留 ${preservedCategories} 个任务组合；正在依次清理三个 Worker。`);
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

const legacyScoreTechnologyTerms = [
  ["Python", /\bpython\b/i], ["JavaScript", /\bjavascript\b/i], ["TypeScript", /\btypescript\b/i],
  ["Java", /\bjava\b/i], ["C++", /\bc\+\+\b/i], ["React", /\breact\b/i], ["Next.js", /\bnext\.?js\b/i],
  ["Node.js", /\bnode\.?js\b/i], ["SQL", /\b(?:sql|mysql|postgres|pl\/pgsql)\b/i], ["Firebase", /\bfirebase|firestore\b/i],
  ["AWS", /\baws\b/i], ["Azure", /\bazure\b/i], ["GCP", /\bgcp\b/i], ["Docker", /\bdocker|containers?\b/i],
  ["Kubernetes", /\bkubernetes\b/i], ["Git", /\bgit\b/i], ["TensorFlow", /\btensorflow\b/i], ["PyTorch", /\bpytorch\b/i],
  ["scikit-learn", /\bscikit-learn\b/i], ["Pandas", /\bpandas\b/i], ["LLM", /\bllm\b/i], ["AI / ML", /\b(?:artificial intelligence|machine learning|ai\/ml)\b/i],
  ["CI/CD", /\bci\/cd\b/i], ["API", /\bapis?\b/i], ["DevOps", /\bdevops\b/i]
];
const legacyScoreDomains = [
  ["言语病理与临床健康", /speech patholog|speech\/language|dysphagia|\baac\b|spa registration/i],
  ["职业治疗或相关临床健康", /occupational therap|allied health|\bahpra\b|\bndis\b|participant care/i],
  ["土木工程与基础设施", /civil engineer|dams?|hydropower|geotechnical|structural|water infrastructure/i],
  ["水文测量、地理空间或海事", /hydrograph|surveying|geomatics|geospatial|marine|offshore|bathymetric|oceanographic/i],
  ["木工、建筑或职业培训", /carpentry|construction|vet\/tae|tae40122/i],
  ["数字营销与传播", /digital marketing|social media|email marketing|campaign management|promotional communications/i],
  ["人力资源与 People Operations", /human resources|people operations|people\/human resources|\bhr\b/i],
  ["销售或零售", /retail|sales role|technical sales/i]
];

function containsChinese(value) {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function legacyTechnologyTerms(value) {
  return legacyScoreTechnologyTerms.filter(([, pattern]) => pattern.test(String(value || ""))).map(([label]) => label);
}

function legacyDomain(value) {
  return legacyScoreDomains.find(([, pattern]) => pattern.test(String(value || "")))?.[0] || "";
}

function localizeLegacyEvidence(value, tone) {
  const original = String(value || "").trim();
  if (!original || containsChinese(original)) return original;
  const lower = original.toLowerCase();
  const technologies = legacyTechnologyTerms(original);
  const domain = legacyDomain(original);
  if (tone === "is-positive") {
    if (/degree|master|bachelor|university|academic background|tertiary graduate|graduat(?:ed|ing)/i.test(original)) {
      return technologies.length ? `教育背景匹配，并涉及：${technologies.join("、")}` : "教育背景或毕业阶段符合岗位要求";
    }
    if (technologies.length) return `技术或工具匹配：${technologies.join("、")}`;
    if (/software|full-stack|front-?end|back-?end|web |application development/i.test(original)) return "软件或 Web 开发经历与岗位要求匹配";
    if (/early-career|graduate-level|entry-level|junior/i.test(original)) return "职业阶段符合毕业生或初级岗位定位";
    if (/communication|stakeholder|teamwork|collaborat|leadership|tutoring|mentor/i.test(original)) return "沟通、协作或辅导经历与岗位要求匹配";
    if (/location|melbourne|australia|remote|hybrid/i.test(original)) return "地点或工作方式与候选人偏好匹配";
    if (/analytical|problem-solving|attention to detail|testing|debugging/i.test(original)) return "分析、问题解决或质量保障能力匹配";
    if (/documentation|report writing/i.test(original)) return "文档与报告能力与岗位要求匹配";
    if (/interest|learning|professional development|innovation/i.test(original)) return "学习意愿或技术兴趣与岗位方向匹配";
    if (domain) return `具有可迁移到${domain}的相关经历`;
    return "相关经历或能力与岗位要求存在匹配";
  }
  if (/work rights?|visa|citizen|permanent residen|sponsorship|security clearance/i.test(original)) return "签证、工作权利或安全审查条件需要确认";
  if (/wam|gpa|minimum 70|average/i.test(original)) return "成绩门槛尚未在画像中明确确认";
  if (/full-time|commence|availability|duration|student visa period|still (?:undertaking|completing)/i.test(original)) return "到岗时间、全职安排或签证有效期需要确认";
  if (/located|based on-site|relocation|on-site/i.test(original)) return "工作地点或到岗方式与当前所在地可能不一致";
  if (/voluntary|unpaid|side income/i.test(original)) return "岗位性质或薪酬安排可能不符合预期";
  if (/driver|vehicle|police check|worker screening|working with children|first aid|cpr|background check/i.test(original)) return "驾照、车辆或岗位检查条件未在画像中体现";
  if (/degree|qualification|certificate|registration|eligibility|membership|licen[cs]e/i.test(original)) return domain ? `缺少${domain}所需的学历、资质或注册条件` : "岗位要求的学历、资质或证书未在画像中体现";
  if (domain) return `岗位核心方向偏向${domain}，与当前技术求职方向不一致`;
  if (technologies.length) return `部分核心技术要求未在画像中明确体现：${technologies.join("、")}`;
  if (/no |limited|lack|not clearly|rather than|experience/i.test(lower)) return "岗位要求的相关经验未在画像中充分体现";
  if (/broad|select an actively hiring pathway/i.test(original)) return "岗位范围较宽，具体方向或地点需要进一步确认";
  return "AI 识别到一项需要人工确认的岗位风险";
}

function localizedScoreEvidence(items, tone) {
  return [...new Set((Array.isArray(items) ? items : []).map((item) => localizeLegacyEvidence(item, tone)).filter(Boolean))];
}

function localizedScoreReason(screening, category) {
  const reason = String(screening.reason || "").trim();
  if (containsChinese(reason)) return reason;
  if (screening.workRights?.assessment === "INELIGIBLE") return localizedWorkRightsReason(screening.workRights);
  const domain = legacyDomain([reason, ...(screening.concerns || [])].join(" "));
  if (category === "REJECTED" && domain) return `岗位核心方向偏向${domain}，与当前职业画像和求职方向不匹配。`;
  if (!screening.jdReviewed) return `当前仅完成职位标题初筛，结果为“${scoreCategoryLabels[category] || "待确认"}”；读取完整 JD 后会更新评分。`;
  const matched = localizedScoreEvidence(screening.matchedAreas, "is-positive").length;
  const concerns = localizedScoreEvidence(screening.concerns, "is-concern").length;
  return `完整 JD 审阅结果为“${scoreCategoryLabels[category] || "待确认"}”，识别到 ${matched} 项匹配证据和 ${concerns} 项风险。`;
}

function localizedWorkRightsReason(workRights) {
  const reason = String(workRights?.reason || "").trim();
  if (containsChinese(reason)) return reason;
  return {
    ELIGIBLE: "根据 JD 与职业画像中的签证信息，当前工作权利要求符合。",
    INELIGIBLE: "JD 明确要求的工作权利条件与当前职业画像不符。",
    UNCERTAIN: "JD 或职业画像中的工作权利信息不足，需要人工确认。",
    OVERRIDE_KEEP: "JD 的身份或工作权利要求命中了用户设置的强制保留条件，因此保留供人工确认。",
    NOT_STATED: "JD 未说明强制的公民身份、永久居留、签证、担保或工作权利要求。"
  }[workRights?.assessment] || "尚无明确的签证或工作权利说明。";
}

function localizedWorkRightsRequirement(value) {
  const original = String(value || "").trim();
  if (!original || containsChinese(original)) return original;
  if (/permanent residen/i.test(original)) return "Australian Permanent Resident（具体条件与例外请核对原 JD）";
  if (/citizen/i.test(original)) return /new zealand/i.test(original) ? "Australian or New Zealand Citizen" : "Australian Citizen";
  if (/full working rights|authorized to work|work visa entitlements/i.test(original)) return "full working rights in Australia（具备有效工作权利）";
  if (/valid visa/i.test(original)) return "valid visa permitting the role（允许从事该职位的有效签证）";
  if (/commence|full-time/i.test(original)) return "满足职位规定的全职到岗时间";
  if (/background check|police check|auscheck|medical assessment/i.test(original)) return "可能需要完成背景、警察、AusCheck 或健康检查";
  return "JD 还包含一项需要人工核对的身份或到岗要求";
}

function scoreEvidenceMarkup(values, emptyText, tone) {
  if (!values.length) return '<p class="score-empty">' + escapeHtml(emptyText) + "</p>";
  return '<ul class="score-evidence-list ' + tone + '">' + values.map((item) => '<li>' + escapeHtml(item) + "</li>").join("") + "</ul>";
}

function scoreThresholdText() {
  const thresholds = state.data?.settings?.thresholds || { strongMatch: 85, goodMatch: 70, maybe: 50, lowMatch: 30 };
  const range = (minimum, maximum) => maximum >= minimum ? `${minimum}-${maximum}` : String(minimum);
  return `强匹配 >= ${thresholds.strongMatch} · 良好匹配 ${range(thresholds.goodMatch, thresholds.strongMatch - 1)} · 可考虑 ${range(thresholds.maybe, thresholds.goodMatch - 1)} · 低匹配 ${range(thresholds.lowMatch, thresholds.maybe - 1)} · 已排除 < ${thresholds.lowMatch}`;
}

function scoreEngineDetails(screening) {
  const engine = String(screening.engine || "local-rules");
  if (/^ai(?:$|-)/i.test(engine)) {
    return {
      label: screening.jdReviewed ? "AI 综合审阅 · 完整 JD" : "AI 流程尚未完成",
      note: "AI 根据完整 JD 与职业画像进行语义综合评分；证据项共同构成判断，不使用可验证的固定逐项加减分公式。"
    };
  }
  if (screening.jdReviewed) {
    return {
      label: "本地规则 · 完整 JD",
      note: "本地规则以 50 分为基础，根据技术匹配点、画像技能、风险项和人工偏好信号调整，并限制在 0-100 分。"
    };
  }
  return {
    label: "本地标题初筛",
    note: "当前分数只依据职位标题和人工偏好信号，用于决定是否继续获取 JD；完成 AI JD 审阅后会被更准确的分数替换。"
  };
}

function openScoreDetails(id) {
  const job = state.data.jobs.find((item) => item.id === id);
  if (!job) return;
  const screening = job.screening || {};
  const engine = scoreEngineDetails(screening);
  const score = Number.isFinite(Number(screening.roleFitScore)) ? Number(screening.roleFitScore) : Number(screening.score) || 0;
  const category = effectiveJobCategory(job) || "LOW_MATCH";
  const workRights = screening.workRights || null;
  const matchedEvidence = localizedScoreEvidence(screening.matchedAreas, "is-positive");
  const concernEvidence = localizedScoreEvidence(screening.concerns, "is-concern");
  const requirements = [...new Set((workRights?.requirements || []).map(localizedWorkRightsRequirement).filter(Boolean))];
  const workRightsCopy = workRights
    ? '<div class="score-visa-heading"><strong>' + escapeHtml(workRightsLabels[workRights.assessment] || workRights.assessment || "待确认") + '</strong>'
      + badge(workRightsShortLabels[workRights.assessment] || "待确认", "work-rights-score") + '</div>'
      + '<p>' + escapeHtml(localizedWorkRightsReason(workRights)) + '</p>'
      + (requirements.length ? '<p class="score-requirements"><span>JD 要求</span>' + escapeHtml(requirements.join("；")) + "</p>" : "")
    : '<p class="score-empty">尚未读取完整 JD，因此还没有签证或工作权利结论。</p>';

  el("#score-dialog-title").textContent = job.title;
  el("#score-job-meta").textContent = [job.company, job.location, names[job.source]].filter(Boolean).join(" · ");
  el("#score-dialog-content").innerHTML = '<div class="score-summary" data-category="' + escapeHtml(category.toLowerCase()) + '">'
    + '<div class="score-total"><strong>' + score + '</strong><span>/ 100</span></div>'
    + '<div class="score-summary-copy">' + badge(scoreCategoryLabels[category] || category, "category-" + category.toLowerCase())
    + '<p>' + escapeHtml(localizedScoreReason(screening, category)) + "</p>"
    + (isRejectionCorrection(job) ? '<p class="score-override-note">你已标记原 Rejected 判断不正确；当前按 Maybe 保留并等待人工复核。</p>' : "")
    + "</div></div>"
    + '<dl class="score-facts">'
    + '<div><dt>评分对象</dt><dd>岗位匹配度</dd></div>'
    + '<div><dt>审阅方式</dt><dd>' + escapeHtml(engine.label) + "</dd></div>"
    + '<div><dt>标题判断</dt><dd>' + escapeHtml(titleClassificationLabels[screening.titleClassification] || screening.titleClassification || "未判断") + "</dd></div>"
    + '<div><dt>当前状态</dt><dd>' + escapeHtml(screeningStatusLabels[screening.screeningStatus] || "未审阅") + "</dd></div>"
    + "</dl>"
    + '<section class="score-section"><div class="score-section-heading"><i data-lucide="circle-plus"></i><h3>匹配证据</h3><span>' + matchedEvidence.length + " 项</span></div>"
    + scoreEvidenceMarkup(matchedEvidence, "当前没有记录明确的匹配证据。", "is-positive") + "</section>"
    + '<section class="score-section"><div class="score-section-heading"><i data-lucide="triangle-alert"></i><h3>风险与扣分依据</h3><span>' + concernEvidence.length + " 项</span></div>"
    + scoreEvidenceMarkup(concernEvidence, "当前没有记录明确的风险项。", "is-concern") + "</section>"
    + '<section class="score-section"><div class="score-section-heading"><i data-lucide="badge-check"></i><h3>身份与签证</h3></div><div class="score-visa">' + workRightsCopy + "</div></section>"
    + '<section class="score-method"><h3>这个分数怎么来的</h3><p>' + escapeHtml(engine.note) + '</p><small>' + escapeHtml(scoreThresholdText()) + "</small>"
    + (workRights?.assessment === "INELIGIBLE" ? '<p class="score-override-note">岗位匹配分仍保留为 ' + score + '，但明确的工作权利冲突会把最终分类改为 Rejected。</p>' : "")
    + "</section>";
  refreshIcons();
  el("#score-dialog").showModal();
}

function openFeedback(id, mode = "positive") {
  const job = state.data.jobs.find((item) => item.id === id);
  if (!job) return;
  state.feedbackJobId = id;
  state.feedbackMode = mode === "negative" ? "negative" : "positive";
  const rejected = job.screening?.category === "REJECTED" || job.screening?.titleClassification === "CLEAR_REJECT";
  const negative = state.feedbackMode === "negative";
  el("#feedback-title").textContent = job.title;
  el("#feedback-job-meta").textContent = [job.company, job.location, names[job.source]].filter(Boolean).join(" · ");
  document.querySelectorAll(".feedback-positive-reason").forEach((item) => { item.hidden = negative || rejected; });
  document.querySelectorAll(".feedback-negative-reason").forEach((item) => { item.hidden = !negative || rejected; });
  el("#feedback-no-reason").hidden = rejected;
  el("#feedback-rejection-correct").hidden = !rejected || negative;
  el("#feedback-rejection-wrong").hidden = !rejected || !negative;
  el("#feedback-no-reason-copy").textContent = negative
    ? "只记录这是我不想继续看的职位"
    : "只记录这是值得继续看的职位";
  el("#feedback-form-note").textContent = rejected
    ? negative
      ? "这会纠正 Rejected 判断、按 Maybe 保留职位，并移除由该职位产生的待审核排除词。"
      : "这会确认 Rejected 判断，并让 Agent 在复盘时整理候选排除词；候选词仍需你审核。"
    : negative
      ? "没用反馈会成为负向偏好证据，并自动将职位标记为已看。"
      : "有用反馈会成为正向偏好证据，并自动将职位标记为已看。";
  const feedbackMatchesMode = rejected
    ? negative ? isRejectionCorrection(job) : isRejectionApproval(job)
    : negative ? job.feedback?.helpfulness === "NOT_HELPFUL" : hasLikedJobFeedback(job);
  const reason = feedbackMatchesMode
    ? job.feedback?.reason || ""
    : rejected ? negative ? "CLASSIFICATION_WRONG" : "REJECTION_CORRECT"
      : negative ? "NOT_RELEVANT" : "";
  const reasonInput = document.querySelector('input[name="feedback-reason"][value="' + reason + '"]')
    || document.querySelector('input[name="feedback-reason"][value=""]');
  reasonInput.checked = true;
  el("#feedback-note").value = feedbackMatchesMode ? job.feedback?.note || "" : "";
  el("#remove-feedback").hidden = !job.feedback;
  el("#save-feedback").innerHTML = '<i data-lucide="' + (negative ? "thumbs-down" : "thumbs-up") + '"></i><span>'
    + (rejected ? negative ? "保存纠错" : "确认判断正确" : negative ? "保存没用" : "保存有用") + "</span>";
  el("#feedback-dialog").showModal();
  refreshIcons();
}

async function saveJobFeedback(event) {
  event.preventDefault();
  if (!state.feedbackJobId) return;
  const button = el("#save-feedback");
  button.disabled = true;
  try {
    const reason = document.querySelector('input[name="feedback-reason"]:checked')?.value || null;
    const correction = reason === "CLASSIFICATION_WRONG";
    const approvedRejection = reason === "REJECTION_CORRECT";
    const negative = state.feedbackMode === "negative" && !correction;
    await api("/api/jobs/" + state.feedbackJobId + "/feedback", {
      method: "PUT",
      body: JSON.stringify({
        helpfulness: correction ? "REJECTION_INCORRECT" : negative ? "NOT_HELPFUL" : "HELPFUL",
        reason,
        note: el("#feedback-note").value
      })
    });
    el("#feedback-dialog").close();
    await reload();
    toast(correction
      ? "已纠正 Rejected 判断；该职位已保留，复盘时 Agent 会学习这次纠错。"
      : approvedRejection
        ? "已确认 Rejected 判断正确；Agent 会据此整理待审核排除词。"
      : negative
        ? "已记录“没用”并标记为已看；复盘时 Agent 会学习你的负向偏好。"
      : "已记录“有用”，完成本次审阅后 Agent 会学习你的正向偏好。", "success");
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
      body: JSON.stringify({ helpful: false })
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
  const archiveAfterReflection = state.jobsPane === "current";
  const button = el("#complete-run-review");
  const label = button.querySelector("span");
  const original = label.textContent;
  button.disabled = true;
  button.classList.add("is-busy");
  label.textContent = "正在复盘...";
  try {
    const result = await api("/api/runs/" + run.id + "/reflection", { method: "POST", body: "{}" });
    await reload();
    if (archiveAfterReflection) {
      state.jobsPane = "history";
      state.historyRunId = "";
      state.historyTaskId = "";
      state.currentRunId = "";
      state.currentRunTaskId = "";
      render();
    }
    toast(result.reflection.engine === "ai"
      ? "AI 已完成本次审阅复盘；学习偏好和候选排除词已更新至搜索设置。"
      : "本地复盘已完成；学习偏好和候选排除词已更新至搜索设置。");
  } catch (error) {
    label.textContent = original;
    button.disabled = false;
    toast(error.message, "error");
  } finally {
    button.classList.remove("is-busy");
  }
}

async function toggleJobViewed(id, viewed) {
  try {
    await api("/api/jobs/" + id + "/viewed", {
      method: "PUT",
      body: JSON.stringify({ viewed: !viewed })
    });
    await reload();
    toast(viewed ? "已恢复为未看。" : "已标记为看过；下次会从其后的未看职位继续。");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function retryFailedJds() {
  const jobs = failedJdJobsInSelectedPane();
  if (!jobs.length) return toast("当前批次没有需要重新获取的 JD。", "error");
  const platformCounts = jobs.reduce((counts, job) => {
    counts[job.source] = (counts[job.source] || 0) + 1;
    return counts;
  }, {});
  const breakdown = Object.entries(platformCounts)
    .map(([platform, count]) => `${names[platform] || platform} ${count}`)
    .join(" · ");
  if (!window.confirm(`按顺序重新获取 ${jobs.length} 个失败 JD？\n\n${breakdown}\n\n只会使用一个 Worker 窗口；普通失败会继续下一项，遇到登录或机器人验证时会暂停。`)) return;
  const launcher = window.open("about:blank", "job-agent-jd-retry");
  if (!launcher) return toast("浏览器阻止了 JD 获取窗口，请允许本站打开弹窗后重试。", "error");
  const button = el("#retry-failed-jds");
  button.disabled = true;
  button.classList.add("is-busy");
  button.innerHTML = '<i data-lucide="loader-circle" class="button-spinner"></i><span>准备获取...</span>';
  refreshIcons();
  try {
    const result = await api("/api/jobs/retry-failed-jd", {
      method: "POST",
      body: JSON.stringify({ jobIds: jobs.map((job) => job.id) })
    });
    if (!result.launchUrl) throw new Error("没有可打开的 JD 页面。");
    launcher.location.replace(result.launchUrl);
    await reload();
    state.view = "jobs";
    render();
    toast(`已开始按顺序重新获取 ${result.total} 个 JD；Agent 会自动同步结果。`);
  } catch (error) {
    launcher.close();
    button.disabled = false;
    button.classList.remove("is-busy");
    toast(error.message, "error");
  }
}

async function retryFailedAiReviews() {
  const jobs = failedAiReviewJobsInSelectedPane();
  if (!jobs.length) return toast("当前任务没有可重新审阅的 AI 失败职位。", "error");
  if (!window.confirm(`重新审阅 ${jobs.length} 个 AI 失败职位？\n\n将直接复用已保存的完整 JD，每个职位会产生一次新的 AI 调用，不会重新打开招聘平台。`)) return;
  const button = el("#retry-failed-ai-reviews");
  button.disabled = true;
  button.classList.add("is-busy");
  button.innerHTML = '<i data-lucide="loader-circle" class="button-spinner"></i><span>正在重新排队...</span>';
  refreshIcons();
  try {
    const result = await api("/api/jobs/retry-failed-ai", {
      method: "POST",
      body: JSON.stringify({ jobIds: jobs.map((job) => job.id) })
    });
    await reload();
    state.view = "jobs";
    render();
    toast(`已将 ${result.queued} 个职位重新加入 AI 审阅队列。`);
  } catch (error) {
    button.disabled = false;
    button.classList.remove("is-busy");
    toast(error.message, "error");
  }
}

async function rereviewJob(id, button) {
  const job = state.data.jobs.find((item) => item.id === id);
  if (!job || button.disabled) return;
  const hasCompleteJd = hasCompleteJobJd(job);
  const confirmation = hasCompleteJd
    ? `重新使用完整 JD 和当前职业画像审阅“${job.title}”？\n\n这会调用一次 AI，并覆盖该职位当前的匹配评分和理由。`
    : `打开原职位获取“${job.title}”的完整 JD，并在获取后自动进行 AI 审阅？`;
  if (!window.confirm(confirmation)) return;
  const jdWindow = hasCompleteJd ? null : window.open("about:blank", "_blank");
  if (!hasCompleteJd && !jdWindow) {
    toast("浏览器阻止了职位页面，请允许此站点打开弹窗后重试。", "error");
    return;
  }
  const previousHtml = button.innerHTML;
  button.disabled = true;
  button.classList.add("is-busy");
  button.innerHTML = '<i data-lucide="loader-circle"></i>';
  refreshIcons();
  try {
    if (!hasCompleteJd) {
      const result = await api("/api/jobs/" + id + "/fetch-jd", { method: "POST", body: "{}" });
      jdWindow.location.replace(result.launchUrl);
      await reload();
      state.view = "jobs";
      render();
      toast("已打开原职位，Worker 正在获取完整 JD；完成后会自动 AI 审阅。");
      return;
    }
    const result = await api("/api/jobs/" + id + "/review", {
      method: "POST",
      body: "{}"
    });
    await reload();
    state.view = "jobs";
    render();
    toast(result.job.screening.screeningStatus === "AI_ERROR" ? "重新审阅失败，职位和原 JD 已保留。" : "AI 已使用完整 JD 重新审阅此职位。");
  } catch (error) {
    if (jdWindow && !jdWindow.closed) jdWindow.close();
    toast(error.message, "error");
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.classList.remove("is-busy");
      button.innerHTML = previousHtml;
      refreshIcons();
    }
  }
}

function renderCoverLetterRecord(record) {
  state.coverLetterCurrent = record || null;
  el("#cover-letter-result").hidden = !record;
  el("#cover-letter-version").textContent = record ? `版本 ${record.version} · ${profileLabel(state.data.profiles.find((item) => item.id === record.profileId))}` : "";
  el("#cover-letter-overview").textContent = record?.overview || "";
  el("#cover-letter-subject").value = record?.subject || "";
  el("#cover-letter-salutation").value = record?.salutation || "";
  el("#cover-letter-body").value = record?.body || "";
  el("#cover-letter-closing").value = record?.closing || "";
  el("#cover-letter-applicant").value = record?.applicantName || "";
  el("#cover-letter-revision").value = "";
}

function setCoverLetterBusy(busy, label = "生成 Cover Letter") {
  const generate = el("#generate-cover-letter");
  const revise = el("#revise-cover-letter");
  const save = el("#save-cover-letter");
  const exportButton = el("#export-cover-letter");
  [generate, revise, save, exportButton].forEach((button) => { button.disabled = busy; });
  generate.classList.toggle("is-busy", busy);
  generate.innerHTML = busy
    ? '<i data-lucide="loader-circle" class="button-spinner"></i><span>' + escapeHtml(label) + "</span>"
    : '<i data-lucide="sparkles"></i><span>生成 Cover Letter</span>';
  refreshIcons();
}

async function openCoverLetter(jobId) {
  const job = state.data.jobs.find((item) => item.id === jobId);
  if (!job || !hasCompleteJobJd(job)) return toast("需要先取得完整 JD，才能生成 Cover Letter。", "error");
  state.coverLetterJobId = jobId;
  state.coverLetterCurrent = null;
  const run = runForJob(job);
  const profileId = job.profileId || run?.profileId || state.data.activeProfile?.id || state.data.profiles[0]?.id;
  el("#cover-letter-title").textContent = job.title;
  el("#cover-letter-job-meta").textContent = [job.company, job.location, names[job.source]].filter(Boolean).join(" · ");
  el("#cover-letter-profile").innerHTML = profileSelectOptions(profileId);
  el("#cover-letter-pages").value = String(state.data.settings.coverLetter?.maxPages ?? 1);
  el("#cover-letter-instructions").value = state.data.settings.coverLetter?.prompt || "";
  renderCoverLetterRecord(null);
  el("#cover-letter-dialog").showModal();
  refreshIcons();
  try {
    const result = await api(`/api/jobs/${jobId}/cover-letters`);
    const latest = result.coverLetters?.[0] || null;
    if (latest) {
      el("#cover-letter-profile").value = latest.profileId;
      el("#cover-letter-pages").value = String(latest.maxPages || el("#cover-letter-pages").value);
      el("#cover-letter-instructions").value = latest.customInstructions || el("#cover-letter-instructions").value;
      renderCoverLetterRecord(latest);
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

function coverLetterDraftFromForm() {
  return {
    overview: el("#cover-letter-overview").textContent,
    subject: el("#cover-letter-subject").value,
    salutation: el("#cover-letter-salutation").value,
    body: el("#cover-letter-body").value,
    closing: el("#cover-letter-closing").value,
    applicantName: el("#cover-letter-applicant").value
  };
}

async function saveCoverLetterEdits({ quiet = false } = {}) {
  if (!state.coverLetterCurrent) throw new Error("请先生成 Cover Letter。");
  const result = await api(`/api/cover-letters/${state.coverLetterCurrent.id}`, {
    method: "PUT",
    body: JSON.stringify(coverLetterDraftFromForm())
  });
  renderCoverLetterRecord(result.coverLetter);
  if (!quiet) toast("Cover Letter 编辑已保存。", "success");
  return result.coverLetter;
}

async function generateCoverLetterDraft({ revise = false } = {}) {
  if (!state.coverLetterJobId) return;
  const revisionRequest = el("#cover-letter-revision").value.trim();
  if (revise && !revisionRequest) return toast("请先填写希望如何修改。", "error");
  try {
    if (revise && state.coverLetterCurrent) await saveCoverLetterEdits({ quiet: true });
    setCoverLetterBusy(true, revise ? "正在按建议修改..." : "正在生成...");
    const result = await api(`/api/jobs/${state.coverLetterJobId}/cover-letters`, {
      method: "POST",
      body: JSON.stringify({
        profileId: el("#cover-letter-profile").value,
        maxPages: Number(el("#cover-letter-pages").value),
        customInstructions: el("#cover-letter-instructions").value.trim(),
        previousCoverLetterId: revise ? state.coverLetterCurrent?.id : null,
        revisionRequest: revise ? revisionRequest : ""
      })
    });
    renderCoverLetterRecord(result.coverLetter);
    await reload();
    state.view = "jobs";
    toast(revise ? "已生成修改版本。" : "Cover Letter 已生成。", "success");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setCoverLetterBusy(false);
  }
}

function exportCoverLetterPdf() {
  if (!state.coverLetterCurrent || !state.coverLetterJobId) return toast("请先生成 Cover Letter。", "error");
  const printWindow = window.open("about:blank", "_blank");
  if (!printWindow) return toast("浏览器阻止了导出窗口，请允许本站打开弹窗。", "error");
  const job = state.data.jobs.find((item) => item.id === state.coverLetterJobId);
  const profile = state.data.profiles.find((item) => item.id === el("#cover-letter-profile").value)?.profile || {};
  const draft = coverLetterDraftFromForm();
  const basic = profile.basicInfo || {};
  const contact = [basic.location, basic.phone, basic.email, basic.linkedinUrl, basic.websiteUrl].filter(Boolean).map(escapeHtml).join(" · ");
  const body = draft.body.split(/\n{2,}/).filter(Boolean).map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`).join("");
  const documentTitle = `${draft.applicantName || "Cover Letter"} - ${job?.title || "Application"}`;
  printWindow.document.write(`<!doctype html><html><head><title>${escapeHtml(documentTitle)}</title><style>
    @page { size: A4; margin: 20mm 21mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #142033; font: 11pt/1.48 Arial, Helvetica, sans-serif; }
    header { border-bottom: 1px solid #b8c4d2; padding-bottom: 10px; margin-bottom: 22px; }
    h1 { margin: 0 0 5px; font-size: 18pt; font-weight: 700; letter-spacing: 0; }
    .contact, .meta { color: #526172; font-size: 9.5pt; }
    .meta { margin-bottom: 18px; }
    .subject { font-weight: 700; margin: 18px 0; }
    p { margin: 0 0 12px; }
    .closing { margin-top: 18px; }
  </style></head><body><header><h1>${escapeHtml(draft.applicantName)}</h1><div class="contact">${contact}</div></header>
  <div class="meta">${escapeHtml(new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }))}<br>${escapeHtml(job?.company || "")}<br>${escapeHtml(job?.location || "")}</div>
  ${draft.subject ? `<div class="subject">${escapeHtml(draft.subject)}</div>` : ""}<p>${escapeHtml(draft.salutation)}</p>${body}<div class="closing">${escapeHtml(draft.closing)}<br><br>${escapeHtml(draft.applicantName)}</div>
  <script>setTimeout(() => { window.print(); }, 250);<\/script></body></html>`);
  printWindow.document.close();
}

document.addEventListener("click", (event) => {
  if (event.target.closest("#toggle-job-assistant")) {
    state.jobAssistantOpen = !state.jobAssistantOpen;
    renderJobAssistant();
    refreshIcons();
    if (state.jobAssistantOpen) el("#job-assistant-input").focus();
    return;
  }
  if (event.target.closest("#close-job-assistant")) {
    state.jobAssistantOpen = false;
    renderJobAssistant();
    return;
  }
  if (event.target.closest("#clear-job-assistant")) {
    state.jobAssistantMessages = [];
    renderJobAssistant();
    refreshIcons();
    return;
  }
  const routineTaskCheckbox = event.target.closest("[data-routine-task-select]");
  if (routineTaskCheckbox) {
    selectRoutineTaskRange(routineTaskCheckbox.dataset.routineTaskSelect, routineTaskCheckbox.checked, event.shiftKey);
    renderRoutine();
    return refreshIcons();
  }
  const view = event.target.closest("[data-view]");
  if (view) {
    if (view.dataset.view === "jobs" && state.view !== "jobs") {
      state.jobsPane = "current";
      state.historyRunId = "";
      state.historyTaskId = "";
      state.currentRunId = "";
      state.currentRunTaskId = "";
    }
    state.view = view.dataset.view;
    return render();
  }
  const jobsPane = event.target.closest("[data-jobs-pane]");
  if (jobsPane) {
    state.jobsPane = jobsPane.dataset.jobsPane;
    state.historyRunId = "";
    state.historyTaskId = "";
    state.currentRunId = "";
    state.currentRunTaskId = "";
    renderJobs();
    return refreshIcons();
  }
  const openHistoryTask = event.target.closest("[data-open-history-task]");
  if (openHistoryTask) {
    state.jobsPane = "history";
    state.historyRunId = openHistoryTask.dataset.historyRun;
    state.historyTaskId = openHistoryTask.dataset.openHistoryTask;
    el("#job-search").value = openHistoryTask.dataset.historyQuery || "";
    el("#job-category").value = "";
    el("#job-source").value = "";
    el("#job-status").value = "";
    el("#job-viewed").value = "all";
    el("#job-sort").value = "priority";
    renderJobs();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  if (event.target.closest("#back-history-tasks")) {
    state.historyRunId = "";
    state.historyTaskId = "";
    renderJobs();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  const profilePane = event.target.closest("[data-profile-pane]");
  if (profilePane) {
    if (state.profilePane === "editor" && profilePane.dataset.profilePane === "upload") commitProfileEditor();
    return setProfilePane(profilePane.dataset.profilePane);
  }
  if (event.target.closest("#open-new-profile")) return openNewProfileDialog();
  const routinePane = event.target.closest("[data-routine-pane]");
  if (routinePane) return setRoutinePane(routinePane.dataset.routinePane);
  const scoreDetails = event.target.closest("[data-score-details]");
  if (scoreDetails) return openScoreDetails(scoreDetails.dataset.scoreDetails);
  const rereview = event.target.closest("[data-rereview]");
  if (rereview) return rereviewJob(rereview.dataset.rereview, rereview);
  const coverLetter = event.target.closest("[data-cover-letter]");
  if (coverLetter) return openCoverLetter(coverLetter.dataset.coverLetter);
  const feedback = event.target.closest("[data-feedback]");
  if (feedback) return openFeedback(feedback.dataset.feedback, feedback.dataset.feedbackMode);
  const viewedButton = event.target.closest("[data-toggle-viewed]");
  if (viewedButton) return toggleJobViewed(viewedButton.dataset.toggleViewed, viewedButton.dataset.viewed === "true");
  const clearJobTaskFilter = event.target.closest("[data-clear-job-task-filter]");
  if (clearJobTaskFilter) {
    state.currentRunId = "";
    state.currentRunTaskId = "";
    renderJobs();
    return refreshIcons();
  }
  const profile = event.target.closest("[data-profile]");
  if (profile) {
    commitProfileEditor();
    state.profileId = profile.dataset.profile;
    state.profilePane = "editor";
    renderProfile();
    return refreshIcons();
  }
  const profileSection = event.target.closest("[data-profile-section]");
  if (profileSection) return setProfileSection(profileSection.dataset.profileSection);
  const addProfileRecordButton = event.target.closest("[data-add-profile-record]");
  if (addProfileRecordButton) return addProfileRecord(addProfileRecordButton.dataset.addProfileRecord, addProfileRecordButton.dataset.customSectionId);
  const removeProfileRecordButton = event.target.closest("[data-remove-profile-record]");
  if (removeProfileRecordButton) return removeProfileRecord(removeProfileRecordButton);
  if (event.target.closest("[data-add-profile-skill]")) return addProfileSkill();
  const removeProfileSkillButton = event.target.closest("[data-remove-profile-skill]");
  if (removeProfileSkillButton) return removeProfileSkill(removeProfileSkillButton);
  if (event.target.closest("[data-add-visa-keep]")) return addVisaKeepRequirement();
  const removeVisaKeepButton = event.target.closest("[data-remove-visa-keep]");
  if (removeVisaKeepButton) return removeVisaKeepRequirement(removeVisaKeepButton);
  if (event.target.closest("[data-add-custom-section]")) return addCustomProfileSection();
  const removeCustomSectionButton = event.target.closest("[data-remove-custom-section]");
  if (removeCustomSectionButton) return removeCustomProfileSection(removeCustomSectionButton);
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
  const deleteProfileButton = event.target.closest("[data-delete-profile]");
  if (deleteProfileButton) return deleteProfile(deleteProfileButton.dataset.deleteProfile);
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
    removeCategoryTaskButton.closest(".category-task-editor-row").remove();
    updateCategoryEditorCount();
    return;
  }
  const resumeTaskButton = event.target.closest("[data-resume-task]");
  if (resumeTaskButton) return resumeTask(resumeTaskButton.dataset.resumeTask);
  const launchRunTaskButton = event.target.closest("[data-launch-run-task]");
  if (launchRunTaskButton) return openRunTaskWorker(launchRunTaskButton.dataset.launchRunTask);
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
  const stopRunTaskButton = event.target.closest("[data-stop-run-task]");
  if (stopRunTaskButton) return stopRunTask(stopRunTaskButton.dataset.stopRunTask);
  const deleteRunTaskButton = event.target.closest("[data-delete-run-task]");
  if (deleteRunTaskButton) return deleteRunTask(deleteRunTaskButton.dataset.deleteRunTask, deleteRunTaskButton.dataset.running === "true");
  const markTaskViewedButton = event.target.closest("[data-mark-task-viewed]");
  if (markTaskViewedButton) return markRunTaskViewed(markTaskViewedButton.dataset.jobStatRun, markTaskViewedButton.dataset.markTaskViewed, markTaskViewedButton);
  const deleteJobStatTaskButton = event.target.closest("[data-delete-job-stat-task]");
  if (deleteJobStatTaskButton) return deleteJobStatTask(deleteJobStatTaskButton.dataset.jobStatRun, deleteJobStatTaskButton.dataset.deleteJobStatTask);
  const filterJobStatTask = event.target.closest("[data-filter-job-stat-task]");
  if (filterJobStatTask) {
    const id = filterJobStatTask.dataset.filterJobStatTask;
    const runId = filterJobStatTask.dataset.jobStatRun;
    const active = state.currentRunId === runId && state.currentRunTaskId === id;
    state.currentRunId = active ? "" : runId;
    state.currentRunTaskId = active ? "" : id;
    renderJobs();
    refreshIcons();
    el("#active-job-task-filter").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const deleteRunHistoryButton = event.target.closest("[data-delete-run-history]");
  if (deleteRunHistoryButton) return deleteRunHistory(deleteRunHistoryButton.dataset.deleteRunHistory);
  const copyWorkerButton = event.target.closest("[data-copy-worker]");
  if (copyWorkerButton) return copyWorkerScript(copyWorkerButton);
  const approveExclusionButton = event.target.closest("[data-approve-exclusion-suggestion]");
  if (approveExclusionButton) return approveExclusionSuggestion(approveExclusionButton.dataset.approveExclusionSuggestion);
  const dismissExclusionButton = event.target.closest("[data-dismiss-exclusion-suggestion]");
  if (dismissExclusionButton) return dismissExclusionSuggestion(dismissExclusionButton.dataset.dismissExclusionSuggestion);
  const removeActiveExclusionButton = event.target.closest("[data-remove-active-exclusion]");
  if (removeActiveExclusionButton) return removeActiveExclusion(removeActiveExclusionButton.dataset.removeActiveExclusion);
  const closeDialog = event.target.closest("[data-close-dialog]");
  if (closeDialog) return el("#" + closeDialog.dataset.closeDialog).close();
  const add = event.target.closest("[data-add]");
  if (add) return addSetting(add.dataset.add);
  const remove = event.target.closest("[data-remove]");
  if (remove) return remove.closest(".settings-row").remove();
});

document.addEventListener("input", (event) => {
  if (event.target.matches("#job-search")) renderJobs();
  if (event.target.matches("#history-search")) renderJobs();
  if (event.target.matches("#job-assistant-input")) {
    const context = jobAssistantReviewContext();
    el("#send-job-assistant").disabled = state.jobAssistantBusy || !context.jobs.length || !event.target.value.trim();
  }
  if (event.target.matches("#category-verified-search")) renderVerifiedTaskPicker();
  if (event.target.matches("#ai-base-url, #ai-model, #ai-api-key")) state.aiConfigDirty = true;
  if (event.target.matches("#run-exclusion-confirmed")) el("#confirm-start-run").disabled = !event.target.checked;
});
document.addEventListener("keydown", (event) => {
  if (event.target.matches("#job-assistant-input") && event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    el("#job-assistant-form").requestSubmit();
    return;
  }
  if (event.key === "Escape" && state.jobAssistantOpen && !event.target.closest("dialog")) {
    state.jobAssistantOpen = false;
    renderJobAssistant();
    return;
  }
  if (event.target.matches("#profile-skill-input") && event.key === "Enter") {
    event.preventDefault();
    return addProfileSkill();
  }
  if (event.target.matches("#visa-keep-input") && event.key === "Enter") {
    event.preventDefault();
    return addVisaKeepRequirement();
  }
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
  if (event.target.matches("#job-category, #job-source, #job-status, #job-viewed, #job-sort")) renderJobs();
  if (event.target.matches("#settings-profile-select")) {
    state.settingsProfileId = event.target.value;
    renderSettings();
    refreshIcons();
  }
  if (event.target.matches("#run-profile-select")) {
    state.pendingRunProfileId = event.target.value;
    el("#run-exclusion-confirmed").checked = false;
    el("#confirm-start-run").disabled = true;
    renderRunProfileConfirmation();
  }
  if (event.target.matches("#routine-task-platform")) syncRoutineJobTypeOptions();
  if (event.target.matches('[data-category-task-field="platform"]')) {
    const row = event.target.closest(".category-task-editor-row");
    const jobType = row.querySelector('[data-category-task-field="jobType"]');
    jobType.innerHTML = jobTypeOptions(event.target.value, "any");
  }
  if (event.target.matches("#ai-wire-api")) state.aiConfigDirty = true;
  if (event.target.matches("[data-category-verified-task]")) {
    const id = event.target.dataset.categoryVerifiedTask;
    if (event.target.checked) state.categoryEditorSelectedValidationIds.add(id);
    else state.categoryEditorSelectedValidationIds.delete(id);
    renderVerifiedTaskPicker();
    refreshIcons();
  }
  if (event.target.matches("[data-category-select]")) {
    const id = event.target.dataset.categorySelect;
    setCategorySelection([id], event.target.checked);
  }
  if (event.target.matches("#select-all-categories")) {
    setCategorySelection((state.data.taskCategories || []).map((category) => category.id), event.target.checked);
  }
  if (event.target.matches("[data-routine-platform-select]")) {
    setRoutineTaskSelection(readyRoutineTaskIds(event.target.dataset.routinePlatformSelect), event.target.checked);
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
  if (event.data?.type === "job-agent-history-migration-progress") {
    if (!state.historyMigration.running) return;
    state.historyMigration.completed.add(event.data.platform);
    state.historyMigration.results[event.data.platform] = event.data;
    armHistoryMigrationTimeout();
    renderHistoryMigrationControl();
    toast((names[event.data.platform] || event.data.platform) + " 历史已迁移。", "success");
    return;
  }
  if (event.data?.type === "job-agent-history-migration-failed") {
    if (!state.historyMigration.running) return;
    clearTimeout(state.historyMigration.timeout);
    state.historyMigration.running = false;
    renderHistoryMigrationControl();
    toast((names[event.data.platform] || event.data.platform) + " 历史迁移失败：" + (event.data.error || "未知错误"), "error");
    return;
  }
  if (event.data?.type === "job-agent-history-migration-finished") {
    if (!state.historyMigration.running) return;
    state.historyMigration.completed.add(event.data.platform);
    state.historyMigration.results[event.data.platform] = event.data;
    void finishWorkerHistoryMigration();
    return;
  }
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
el("#run-selected-routine-tasks").addEventListener("click", runSelectedRoutineTasks);
el("#select-visible-routine-tasks").addEventListener("click", () => setRoutineTaskSelection(readyRoutineTaskIds(), true));
el("#clear-routine-selection").addEventListener("click", () => setRoutineTaskSelection([...state.selectedRoutineTaskIds], false));
el("#open-routine-task").addEventListener("click", openRoutineTaskDialog);
el("#open-task-category").addEventListener("click", () => openTaskCategoryDialog());
el("#add-category-task").addEventListener("click", () => addCategoryTaskEditor());
el("#select-visible-verified-tasks").addEventListener("click", () => {
  visibleVerifiedTaskOptions().forEach((task) => state.categoryEditorSelectedValidationIds.add(task.validationId));
  renderVerifiedTaskPicker();
  refreshIcons();
});
el("#clear-verified-task-selection").addEventListener("click", () => {
  state.categoryEditorSelectedValidationIds.clear();
  renderVerifiedTaskPicker();
  refreshIcons();
});
el("#preflight-selected-categories").addEventListener("click", () => prepareSelectedCategories("preflight"));
el("#import-selected-categories").addEventListener("click", () => prepareSelectedCategories("import"));
el("#start-preflight-batch").addEventListener("click", startPreflightBatch);
el("#clear-routine-tasks").addEventListener("click", clearRoutineTasks);
el("#clear-run-queue").addEventListener("click", clearRunQueue);
el("#delete-selected-history-run").addEventListener("click", () => deleteRunHistory(state.historyRunId));
el("#retry-failed-jds").addEventListener("click", retryFailedJds);
el("#retry-failed-ai-reviews").addEventListener("click", retryFailedAiReviews);
el("#open-import").addEventListener("click", openImport);
el("#extract-resume").addEventListener("click", uploadResume);
el("#copy-external-profile-prompt").addEventListener("click", copyExternalGptPrompt);
el("#generate-profile").addEventListener("click", generateProfile);
el("#new-profile-form").addEventListener("submit", createProfile);
el("#save-settings").addEventListener("click", saveSettings);
el("#add-exclusion-keyword").addEventListener("click", addExclusionKeyword);
el("#save-ai-config").addEventListener("click", saveAiConfig);
el("#test-ai-config").addEventListener("click", testAiConfig);
el("#clear-ai-key").addEventListener("click", clearAiKey);
el("#install-workers").addEventListener("click", installWorkers);
el("#migrate-worker-history").addEventListener("click", migrateWorkerHistory);
el("#open-clear-all-history").addEventListener("click", openClearAllHistoryDialog);
el("#confirm-clear-all-history").addEventListener("click", clearAllHistory);
el("#import-form").addEventListener("submit", importJobs);
el("#routine-task-form").addEventListener("submit", submitRoutineTask);
el("#task-category-form").addEventListener("submit", saveTaskCategory);
el("#feedback-form").addEventListener("submit", saveJobFeedback);
el("#run-confirmation-form").addEventListener("submit", confirmStartRun);
el("#remove-feedback").addEventListener("click", removeJobFeedback);
el("#complete-run-review").addEventListener("click", completeRunReview);
el("#job-assistant-form").addEventListener("submit", sendJobAssistant);
el("#generate-cover-letter").addEventListener("click", () => generateCoverLetterDraft());
el("#revise-cover-letter").addEventListener("click", () => generateCoverLetterDraft({ revise: true }));
el("#save-cover-letter").addEventListener("click", () => saveCoverLetterEdits().catch((error) => toast(error.message, "error")));
el("#export-cover-letter").addEventListener("click", exportCoverLetterPdf);

reload().catch((error) => {
  el("#api-status").textContent = "本地服务未连接";
  toast(error.message, "error");
});

let autoReloadInFlight = false;
let lastAutoReloadAt = 0;

function agentDataIsChanging() {
  const latestRunIsActive = state.data?.runs?.[0]?.tasks?.some((task) => ["queued", "running"].includes(task.status));
  const aiIsWorking = state.data?.jobs?.some((job) => ["JD_FETCHING", "AI_QUEUED", "AI_REVIEWING", "AI_RETRY_WAIT"].includes(job.screening?.screeningStatus));
  return Boolean(latestRunIsActive || aiIsWorking || state.data?.jdRetryBatches?.length);
}

async function autoReload() {
  if (autoReloadInFlight || document.visibilityState === "hidden") return;
  if (!["overview", "routine", "jobs"].includes(state.view)) return;
  const refreshInterval = agentDataIsChanging() ? 2500 : 8000;
  if (Date.now() - lastAutoReloadAt < refreshInterval) return;
  autoReloadInFlight = true;
  try {
    await reload();
    lastAutoReloadAt = Date.now();
  } catch {}
  finally {
    autoReloadInFlight = false;
  }
}

setInterval(autoReload, 2500);
window.addEventListener("focus", () => { void autoReload(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void autoReload();
});
