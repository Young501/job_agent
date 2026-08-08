const state = {
  data: null,
  view: "overview",
  profileId: null,
  jobId: null,
  resumeSource: ""
};

const names = { linkedin: "LinkedIn", indeed: "Indeed", seek: "SEEK", manual: "手动" };
const pages = {
  overview: ["今日工作区", "职位概览"],
  jobs: ["组合清单", "职位审阅"],
  routine: ["例行搜索", "每日任务"],
  profile: ["候选人资料", "职业画像"],
  settings: ["共用配置", "搜索设置"]
};

const el = (selector) => document.querySelector(selector);
const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const listText = (value) => Array.isArray(value) ? value.join(", ") : "";
const toList = (value) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
const nice = (value) => String(value || "-").replaceAll("_", " ");
const dateTime = (value) => value ? new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "-";

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

function activeProfile() {
  return state.data.activeProfile || null;
}

function selectedProfile() {
  return state.data.profiles.find((profile) => profile.id === state.profileId) || null;
}

function currentRun() {
  return state.data.runs[0] || null;
}

function visibleJobs() {
  const query = (el("#job-search").value || "").trim().toLowerCase();
  const category = el("#job-category").value;
  const source = el("#job-source").value;
  const status = el("#job-status").value;
  const sort = el("#job-sort").value;
  const jobs = state.data.jobs.filter((job) => {
    const words = [job.title, job.company, job.location, job.searchKeyword].join(" ").toLowerCase();
    return (!query || words.includes(query))
      && (!category || job.screening.category === category)
      && (!source || job.source === source)
      && (!status || job.screening.screeningStatus === status);
  });
  return jobs.sort((a, b) => {
    if (sort === "score") return b.screening.score - a.screening.score;
    if (sort === "source") return a.source.localeCompare(b.source);
    if (sort === "company") return String(a.company || "").localeCompare(String(b.company || ""));
    if (sort === "title") return a.title.localeCompare(b.title);
    return String(b.discoveredAt).localeCompare(String(a.discoveredAt));
  });
}

function actionButtons(job) {
  const open = /^https?:\/\//i.test(job.jobUrl || "")
    ? '<a class="icon-button" href="' + escapeHtml(job.jobUrl) + '" target="_blank" rel="noreferrer" title="打开原职位"><i data-lucide="external-link"></i></a>'
    : "";
  return open + '<button class="icon-button" data-review="' + job.id + '" title="查看或审阅 JD"><i data-lucide="scan-search"></i></button>';
}

function jobRow(job, compact = false) {
  const duplicate = job.duplicateOf ? '<span class="tiny-note">重复导入</span>' : "";
  const search = compact ? "" : '<td class="muted">' + escapeHtml(job.searchKeyword || "-") + "</td>";
  return '<tr>'
    + '<td><strong>' + escapeHtml(job.title) + "</strong>" + duplicate + "</td>"
    + '<td><span>' + escapeHtml(job.company || "-") + "</span><small>" + escapeHtml(job.location || "-") + "</small></td>"
    + '<td>' + badge(names[job.source] || job.source, "source-" + job.source) + "</td>"
    + search
    + '<td><span class="score">' + job.screening.score + "</span>" + badge(job.screening.category, "category-" + job.screening.category.toLowerCase()) + "</td>"
    + '<td>' + badge(job.screening.screeningStatus, "status-badge") + "</td>"
    + '<td class="action-cell">' + actionButtons(job) + "</td></tr>";
}

function renderOverview() {
  const jobs = state.data.jobs;
  const run = currentRun();
  const metrics = [
    ["已导入职位", jobs.length, "briefcase-business"],
    ["强匹配", jobs.filter((job) => job.screening.category === "STRONG_MATCH").length, "sparkles"],
    ["待 JD 审阅", jobs.filter((job) => job.screening.screeningStatus === "NEEDS_JD_REVIEW").length, "scan-search"],
    ["最近任务", run ? run.tasks.length : 0, "list-todo"]
  ];
  el("#overview-metrics").innerHTML = metrics.map((item) =>
    '<article class="metric"><div><span>' + item[0] + "</span><strong>" + item[1] + '</strong></div><i data-lucide="' + item[2] + '"></i></article>'
  ).join("");
  const rows = visibleJobs().slice(0, 8).map((job) => jobRow(job, true)).join("");
  el("#overview-jobs").innerHTML = rows || '<tr><td colspan="6" class="empty-cell">尚未导入职位结果。</td></tr>';
}

function renderJobs() {
  const jobs = visibleJobs();
  el("#jobs-summary").textContent = jobs.length + " / " + state.data.jobs.length + " 个职位";
  el("#jobs-table").innerHTML = jobs.map((job) => jobRow(job)).join("")
    || '<tr><td colspan="7" class="empty-cell">没有匹配当前筛选条件的职位。</td></tr>';
}

function renderRoutine() {
  const run = currentRun();
  if (!run) {
    el("#run-summary").innerHTML = '<div class="empty-state"><i data-lucide="calendar-clock"></i><p>尚未创建每日任务。</p></div>';
    el("#tasks-table").innerHTML = '<tr><td colspan="6" class="empty-cell">创建任务后，队列会显示在这里。</td></tr>';
  } else {
    const c = run.counters;
    const metric = (label, value) => '<div class="run-metric"><span>' + label + "</span><strong>" + value + "</strong></div>";
    el("#run-summary").innerHTML = '<div class="run-state"><span>当前状态</span>' + badge(run.state, "run-state-badge") + "</div>"
      + metric("LinkedIn 新职位", c.linkedin.newJobs)
      + metric("Indeed 新职位", c.indeed.newJobs)
      + metric("SEEK 新职位", c.seek.newJobs)
      + metric("JD 已审阅", c.ai.jdReviewed)
      + metric("AI 调用", c.ai.calls)
      + metric("AI tokens", c.ai.totalTokens)
      + metric("预算跳过", c.ai.budgetSkipped);
    el("#tasks-table").innerHTML = run.tasks.map((task) => '<tr>'
      + "<td>" + badge(names[task.platform], "source-" + task.platform) + "</td>"
      + "<td><strong>" + escapeHtml(task.keyword) + "</strong></td>"
      + "<td>" + escapeHtml(task.location) + "</td><td>" + task.priority + "</td>"
      + "<td>" + badge(task.status, "status-badge") + "</td>"
      + '<td class="muted">' + escapeHtml(task.reason || "-") + "</td></tr>").join("");
  }
  el("#runs-list").innerHTML = state.data.runs.map((run) => '<article class="run-row"><div><strong>'
    + dateTime(run.startedAt) + "</strong><span>" + run.tasks.length + " 项任务</span></div><div>"
    + badge(run.state, "run-state-badge") + '</div><div class="run-platform-counts"><span>LI '
    + run.counters.linkedin.newJobs + "</span><span>IN " + run.counters.indeed.newJobs
    + "</span><span>SEEK " + run.counters.seek.newJobs + "</span></div></article>").join("")
    || '<div class="empty-state compact-empty"><p>没有运行记录。</p></div>';
}

function renderProfile() {
  const selected = selectedProfile();
  const active = activeProfile();
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
    el("#profile-fields").innerHTML = '<div class="profile-empty"><i data-lucide="contact-round"></i><p>生成一个简历画像草稿后，可在这里确认和调整。</p></div>';
    return;
  }
  const p = selected.profile;
  const activeButton = selected.id === active?.id
    ? '<button class="button button-quiet" disabled><i data-lucide="circle-check"></i><span>当前画像</span></button>'
    : '<button class="button button-primary" data-activate="' + selected.id + '"><i data-lucide="circle-check"></i><span>确认并设为当前</span></button>';
  el("#profile-fields").innerHTML = '<div class="profile-badges">' + badge("v" + selected.version, "version-badge")
    + badge(selected.status, selected.id === active?.id ? "active-badge" : "status-badge") + "</div>"
    + '<label class="field full"><span>画像名称</span><input id="p-name" value="' + escapeHtml(p.name) + '"></label>'
    + '<label class="field full"><span>职业标题</span><input id="p-headline" value="' + escapeHtml(p.headline) + '"></label>'
    + '<label class="field full"><span>摘要</span><textarea id="p-summary" rows="4">' + escapeHtml(p.summary) + "</textarea></label>"
    + '<div class="two-fields"><label class="field"><span>目标职位</span><textarea id="p-targets" rows="4">' + escapeHtml(listText(p.targetRoles))
    + '</textarea></label><label class="field"><span>方向</span><textarea id="p-areas" rows="4">' + escapeHtml(listText(p.focusAreas)) + "</textarea></label></div>"
    + '<label class="field full"><span>技能</span><textarea id="p-skills" rows="3">' + escapeHtml(listText(p.skills)) + "</textarea></label>"
    + '<label class="field full"><span>学历与阶段</span><textarea id="p-education" rows="2">' + escapeHtml(listText(p.education)) + "</textarea></label>"
    + '<div class="two-fields"><label class="field"><span>偏好地点</span><input id="p-locations" value="' + escapeHtml(listText(p.preferences.locations))
    + '"></label><label class="field"><span>排除方向</span><input id="p-exclusions" value="' + escapeHtml(listText(p.preferences.exclusions)) + '"></label></div>'
    + '<div class="editor-actions"><button class="button button-secondary" data-save-profile="' + selected.id
    + '"><i data-lucide="save"></i><span>保存画像</span></button>' + activeButton + "</div>";
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
  el("#platform-toggles").innerHTML = ["linkedin", "indeed", "seek"].map((platform) =>
    '<label class="toggle-control"><input type="checkbox" data-platform="' + platform + '" '
    + (settings.platforms.includes(platform) ? "checked" : "") + "><span>" + names[platform] + "</span></label>").join("");
  el("#locations-list").innerHTML = settings.locations.map((item) => settingsRow("location", item)).join("");
  el("#searches-list").innerHTML = settings.searches.map((item) => settingsRow("search", item)).join("");
  const thresholds = [["strongMatch", "强匹配"], ["goodMatch", "好匹配"], ["maybe", "可考虑"], ["lowMatch", "低匹配"]];
  el("#threshold-row").innerHTML = thresholds.map((item) => '<label class="threshold"><span>' + item[1]
    + '</span><input type="number" min="0" max="100" data-threshold="' + item[0] + '" value="' + settings.thresholds[item[0]] + '"></label>').join("");
}

function renderImportOptions() {
  el("#import-run").innerHTML = '<option value="">不关联运行任务</option>' + state.data.runs.map((run) =>
    '<option value="' + run.id + '">' + escapeHtml(dateTime(run.startedAt)) + " - " + escapeHtml(run.state) + "</option>").join("");
}

function render() {
  const title = pages[state.view];
  el("#page-kicker").textContent = title[0];
  el("#page-title").textContent = title[1];
  el("#ai-state").textContent = state.data.ai.configured ? "AI · " + state.data.ai.model : "本地规则";
  document.querySelectorAll(".view").forEach((node) => node.classList.toggle("is-active", node.id === "view-" + state.view));
  document.querySelectorAll("[data-view]").forEach((node) => node.classList.toggle("is-active", node.dataset.view === state.view));
  renderOverview();
  renderJobs();
  renderRoutine();
  renderProfile();
  renderSettings();
  renderImportOptions();
  refreshIcons();
}

async function reload() {
  state.data = await api("/api/bootstrap");
  if (!state.profileId && state.data.profiles.length) state.profileId = state.data.activeProfile?.id || state.data.profiles[0].id;
  el("#api-status").textContent = "本地服务已连接";
  el("#api-status-dot").classList.add("is-online");
  render();
}

async function createRun() {
  try {
    const result = await api("/api/runs", { method: "POST", body: "{}" });
    await reload();
    state.view = "routine";
    render();
    toast("已创建 " + result.run.tasks.length + " 项顺序任务。");
  } catch (error) {
    toast(error.message, "error");
  }
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

async function generateProfile() {
  const resumeText = el("#resume-text").value.trim();
  if (resumeText.length < 80) return toast("请先提供足够的简历文本。", "error");
  try {
    const result = await api("/api/profiles/generate", {
      method: "POST",
      body: JSON.stringify({ resumeText, sourceName: state.resumeSource || "pasted-resume.txt" })
    });
    state.profileId = result.profile.id;
    await reload();
    state.view = "profile";
    render();
    toast(result.profile.engine === "ai" ? "已生成 AI 画像草稿。" : "已生成本地画像草稿。");
  } catch (error) {
    toast(error.message, "error");
  }
}

function profileForm() {
  return {
    name: el("#p-name").value,
    headline: el("#p-headline").value,
    summary: el("#p-summary").value,
    targetRoles: toList(el("#p-targets").value),
    focusAreas: toList(el("#p-areas").value),
    skills: toList(el("#p-skills").value),
    education: toList(el("#p-education").value),
    preferences: { locations: toList(el("#p-locations").value), workTypes: [], exclusions: toList(el("#p-exclusions").value) }
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
    await api("/api/profiles/" + id + "/activate", { method: "POST", body: "{}" });
    state.profileId = id;
    await reload();
    toast("已更新当前职业画像。");
  } catch (error) {
    toast(error.message, "error");
  }
}

function settingPayload() {
  const rows = [...document.querySelectorAll(".settings-row")];
  const locations = rows.filter((row) => row.dataset.kind === "location").map((row) => ({
    id: row.dataset.id, name: row.querySelector(".row-name").value, enabled: row.querySelector("input").checked
  }));
  const searches = rows.filter((row) => row.dataset.kind === "search").map((row) => ({
    id: row.dataset.id, keyword: row.querySelector(".row-name").value, enabled: row.querySelector("input").checked,
    priority: Number(row.querySelector(".row-priority").value)
  }));
  const platforms = [...document.querySelectorAll("[data-platform]:checked")].map((node) => node.dataset.platform);
  const thresholds = Object.fromEntries([...document.querySelectorAll("[data-threshold]")].map((node) => [node.dataset.threshold, Number(node.value)]));
  return { enabled: true, platforms, locations, searches, thresholds };
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

function openReview(id) {
  const job = state.data.jobs.find((item) => item.id === id);
  if (!job) return;
  state.jobId = id;
  el("#review-source").textContent = names[job.source] || job.source;
  el("#review-title").textContent = job.title;
  el("#review-meta").innerHTML = escapeHtml(job.company || "-") + " · " + escapeHtml(job.location || "-") + " " + badge(job.screening.category, "category-" + job.screening.category.toLowerCase());
  el("#review-description").value = job.description || "";
  el("#review-note").textContent = job.screening.reason || "";
  el("#review-dialog").showModal();
  refreshIcons();
}

async function reviewJob(event) {
  event.preventDefault();
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
  }
}

document.addEventListener("click", (event) => {
  const view = event.target.closest("[data-view]");
  if (view) { state.view = view.dataset.view; return render(); }
  const review = event.target.closest("[data-review]");
  if (review) return openReview(review.dataset.review);
  const profile = event.target.closest("[data-profile]");
  if (profile) { state.profileId = profile.dataset.profile; return renderProfile(); }
  const save = event.target.closest("[data-save-profile]");
  if (save) return saveProfile(save.dataset.saveProfile);
  const activate = event.target.closest("[data-activate]");
  if (activate) return activateProfile(activate.dataset.activate);
  const add = event.target.closest("[data-add]");
  if (add) return addSetting(add.dataset.add);
  const remove = event.target.closest("[data-remove]");
  if (remove) return remove.closest(".settings-row").remove();
});

document.addEventListener("input", (event) => {
  if (event.target.matches("#job-search")) renderJobs();
});
document.addEventListener("change", (event) => {
  if (event.target.matches("#job-category, #job-source, #job-status, #job-sort")) renderJobs();
});

el("#start-run").addEventListener("click", createRun);
el("#start-run-secondary").addEventListener("click", createRun);
el("#open-import").addEventListener("click", openImport);
el("#extract-resume").addEventListener("click", uploadResume);
el("#generate-profile").addEventListener("click", generateProfile);
el("#save-settings").addEventListener("click", saveSettings);
el("#import-form").addEventListener("submit", importJobs);
el("#review-form").addEventListener("submit", reviewJob);

reload().catch((error) => {
  el("#api-status").textContent = "本地服务未连接";
  toast(error.message, "error");
});
