// ==UserScript==
// @name         Job Agent Worker - Indeed
// @namespace    https://routine.local/job-agent-worker
// @version      1.0.1
// @description  Job Agent worker for Indeed. Runs one assigned task at a time and reports results locally.
// @updateURL    http://127.0.0.1:4317/workers/indeed/indeed-agent-worker.user.js
// @downloadURL  http://127.0.0.1:4317/workers/indeed/indeed-agent-worker.user.js
// @match        https://au.indeed.com/jobs*
// @match        https://*.indeed.com/jobs*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      au.indeed.com
// @connect      *.indeed.com
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
    "use strict";

    const APP_VERSION = "1.0.1";
    const DEFAULT_AGENT_TIMING = {
        accessLimit: 20,
        cooldownMinutes: 5,
        actionDelaySeconds: 1,
        scrollDelaySeconds: 2,
        pageDelaySeconds: 10,
        jdIntervalSeconds: 1,
        jdRequestTimeoutSeconds: 5,
        jdPageTimeoutSeconds: 10
    };
    const SITE = getSiteAdapter();
    if (!SITE) return;

    const AGENT = {
        apiBase: String(gmGet("job-agent:api-base", "http://127.0.0.1:4317")).replace(/\/+$/, ""),
        platform: "indeed",
        taskKey: "job-agent:worker-task:indeed",
        workerKey: "job-agent:worker-id:indeed",
        pauseKey: "job-agent:worker-pause:indeed",
        preflightKey: "job-agent:worker-preflight:indeed",
        accessThrottleKey: "job-agent:access-throttle:indeed:v1"
    };
    let agentTask = null;
    let agentScanFailure = null;
    let agentClaiming = false;
    let agentPollTimer = null;
    let agentHeartbeatTimer = null;
    let agentStartedTaskId = null;
    let agentTiming = { ...DEFAULT_AGENT_TIMING };
    let agentStopRequested = false;

    const KEYS = {
        settings: `indeed-helper:settings:${SITE.id}:v1`,
        history: `indeed-helper:history:${SITE.id}:v1`,
        latestSummary: `indeed-helper:latest-summary:${SITE.id}:v1`
    };
    const DEFAULT_SETTINGS = {
        include: "graduate",
        exclude: "expression of interest\neoi",
        maxPages: 0,
        pageDelaySeconds: 2,
        autoMarkSeen: true
    };

    let settings = loadSettings();
    let historyStore = loadHistory();
    let state = createState();
    let ui = null;

    function getSiteAdapter() {
        const host = location.hostname.toLowerCase();
        if (!host.endsWith("indeed.com")) return null;
        return {
                id: "indeed",
                label: "Indeed",
                findCards(root) {
                    const found = new Set();
                    root.querySelectorAll('a[data-jk]').forEach((anchor) => {
                        const card = anchor.closest(
                            '.job_seen_beacon, [data-testid="slider_item"], li, table.mainContentTable, table'
                        );
                        if (card) found.add(card);
                    });
                    return Array.from(found);
                },
                readCard(card, baseUrl) {
                    const titleLink = firstElement(card, [
                        'h2 a[data-jk]',
                        'h3 a[data-jk]',
                        'a.jcs-JobTitle[data-jk]',
                        'a[data-jk]'
                    ]);
                    const jobId = titleLink?.getAttribute("data-jk") || getIndeedJobId(titleLink?.href || "");
                    const lines = textLines(card);
                    return {
                        id: jobId,
                        title: textOf(titleLink?.querySelector("span[title]")) || textOf(titleLink),
                        company: textOf(firstElement(card, [
                            '[data-testid="company-name"]',
                            '.companyName',
                            '[class*="companyName"]'
                        ])),
                        location: textOf(firstElement(card, [
                            '[data-testid="text-location"]',
                            '[data-testid="job-location"]',
                            '.companyLocation',
                            '[class*="companyLocation"]'
                        ])),
                        listedAt: findLine(lines, /^(just posted|today|yesterday|\d+\+?\s+(minute|hour|day|week)s?\s+ago)$/i),
                        description: textOf(firstElement(card, [
                            '[data-testid="job-snippet"]',
                            '.job-snippet',
                            '[class*="job-snippet"]'
                        ])),
                        link: jobId ? new URL(`/viewjob?jk=${encodeURIComponent(jobId)}`, baseUrl).href : canonicalLink(titleLink?.href || "", baseUrl)
                    };
                },
                findNextUrl(root, currentUrl) {
                    const next = firstElement(root, [
                        'a[data-testid="pagination-page-next"]',
                        'a[aria-label="Next Page"]',
                        'a[aria-label="Next"]'
                    ]);
                    return toAbsoluteUrl(next?.getAttribute("href"), currentUrl);
                }
        };
    }

    function createState() {
        return {
            running: false,
            stopRequested: false,
            page: 0,
            scanned: 0,
            matched: 0,
            skippedSeen: 0,
            excluded: 0,
            duplicates: 0,
            results: new Map(),
            processed: new Set(),
            startedAt: null,
            endedAt: null
        };
    }

    function init() {
        waitForCards().then(() => {
            initUI();
            log(`已就绪：${SITE.label} 搜索结果页`);
        }).catch(() => {
            initUI();
            log("未找到职位列表；请在搜索结果页刷新后重试。", "warn");
        });
    }

    async function waitForCards() {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
            if (SITE.findCards(document).length) return;
            await sleep(400);
        }
        throw new Error("Job cards did not load");
    }

    function initUI() {
        if (document.getElementById("sih-panel")) return;

        const host = document.createElement("aside");
        host.id = "sih-panel";
        host.innerHTML = `
            <div class="sih-head">
                <div>
                    <strong>Job Agent Worker - ${SITE.label}</strong>
                    <span>v${APP_VERSION}</span>
                </div>
                <button type="button" class="sih-icon" data-action="collapse" title="收起面板" aria-label="收起面板">&times;</button>
            </div>
            <div class="sih-body">
                <label>包含关键词<textarea data-field="include" rows="3" placeholder="每行一个关键词"></textarea></label>
                <label>排除关键词<textarea data-field="exclude" rows="3" placeholder="每行一个关键词"></textarea></label>
                <div class="sih-grid">
                    <label>最大页数<input data-field="maxPages" type="number" min="0" max="200" step="1"></label>
                    <label>翻页等待（秒）<input data-field="pageDelaySeconds" type="number" min="0" max="30" step="0.5"></label>
                </div>
                <label class="sih-check"><input data-field="autoMarkSeen" type="checkbox"> 生成汇总后写入已看记录</label>
                <div class="sih-stats">
                    <span>页数<b data-stat="page">0</b></span><span>扫描<b data-stat="scanned">0</b></span>
                    <span>汇总<b data-stat="matched">0</b></span><span>已看跳过<b data-stat="seen">0</b></span>
                    <span>排除<b data-stat="excluded">0</b></span><span>历史<b data-stat="history">0</b></span>
                </div>
                <div class="sih-actions">
                    <button type="button" class="sih-primary" data-action="start">扫描并生成汇总</button>
                    <button type="button" data-action="stop" disabled>停止并汇总</button>
                </div>
                <div class="sih-actions">
                    <button type="button" data-action="latest">打开最近汇总</button>
                    <button type="button" data-action="export">导出历史</button>
                    <button type="button" data-action="import">导入历史</button>
                    <button type="button" data-action="clear">清空历史</button>
                </div>
                <div class="sih-actions">
                    <button type="button" data-action="save">保存设置</button>
                </div>
                <p class="sih-status" data-role="status">等待开始</p>
                <pre class="sih-log" data-role="log"></pre>
            </div>`;
        document.documentElement.appendChild(host);
        addPanelStyles();
        document.body.classList.add("sih-has-panel");

        ui = {
            host,
            include: host.querySelector('[data-field="include"]'),
            exclude: host.querySelector('[data-field="exclude"]'),
            maxPages: host.querySelector('[data-field="maxPages"]'),
            pageDelaySeconds: host.querySelector('[data-field="pageDelaySeconds"]'),
            autoMarkSeen: host.querySelector('[data-field="autoMarkSeen"]'),
            start: host.querySelector('[data-action="start"]'),
            stop: host.querySelector('[data-action="stop"]'),
            status: host.querySelector('[data-role="status"]'),
            log: host.querySelector('[data-role="log"]')
        };
        writeSettingsToUI(settings);
        host.addEventListener("click", handlePanelClick);
        updateCounters();
    }

    function addPanelStyles() {
        if (document.getElementById("sih-styles")) return;
        const style = document.createElement("style");
        style.id = "sih-styles";
        style.textContent = `
            #sih-panel{position:fixed;z-index:2147483646;top:0;right:0;width:352px;height:100vh;background:#fff;border-left:1px solid #b9c3cc;box-shadow:-8px 0 24px rgba(24,39,53,.15);font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#17212b;box-sizing:border-box;overflow:auto}
            .sih-has-panel body{padding-right:352px!important;box-sizing:border-box!important}.sih-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:#0a66c2;color:#fff}.sih-head strong{display:block;font-size:15px}.sih-head span{font-size:11px;opacity:.8}.sih-body{padding:14px}.sih-body label{display:block;margin:0 0 11px;font-weight:650;color:#27333f}.sih-body textarea,.sih-body input[type="number"]{width:100%;box-sizing:border-box;margin-top:4px;padding:7px 8px;border:1px solid #9eabb6;border-radius:4px;background:#fff;color:#17212b;font:inherit}.sih-body textarea{resize:vertical}.sih-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.sih-check{display:flex!important;align-items:center;gap:7px;font-weight:500!important}.sih-check input{margin:0}.sih-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:13px 0}.sih-stats span{padding:7px;background:#eef3f7;border:1px solid #d6e0e8;border-radius:4px;color:#566675;font-size:11px}.sih-stats b{display:block;color:#17212b;font-size:17px}.sih-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:7px}.sih-actions button{min-height:32px;border:1px solid #95a5b4;border-radius:4px;background:#fff;color:#17212b;cursor:pointer;font:600 12px/1.2 inherit}.sih-actions button:hover{background:#eef4f8}.sih-actions .sih-primary{grid-column:span 2;background:#0a66c2;border-color:#0a66c2;color:#fff}.sih-actions .sih-primary:hover{background:#004182}.sih-actions button:disabled{opacity:.45;cursor:not-allowed}.sih-icon{border:0;background:transparent;color:#fff;font-size:24px;line-height:1;cursor:pointer}.sih-status{margin:12px 0 6px;color:#33475b;font-weight:650}.sih-log{margin:0;min-height:84px;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#f5f8fa;border:1px solid #d6e0e8;border-radius:4px;padding:8px;color:#425466;font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}@media(max-width:820px){#sih-panel{width:min(352px,100vw)}.sih-has-panel body{padding-right:0!important}}
        `;
        document.head.appendChild(style);
    }

    function handlePanelClick(event) {
        const button = event.target.closest("button[data-action]");
        if (!button) return;
        const action = button.dataset.action;
        if (action === "start") startScan();
        if (action === "stop") requestStop();
        if (action === "save") saveSettingsFromUI();
        if (action === "export") exportHistory();
        if (action === "import") showImportModal();
        if (action === "clear") clearHistory();
        if (action === "latest") openLatestSummary();
        if (action === "collapse") collapsePanel();
    }

    function collapsePanel() {
        ui.host.remove();
        document.body.classList.remove("sih-has-panel");
        ui = null;
    }

    function readSettingsFromUI() {
        return {
            include: ui.include.value,
            exclude: ui.exclude.value,
            maxPages: clampInt(ui.maxPages.value, 0, 200, DEFAULT_SETTINGS.maxPages),
            pageDelaySeconds: clampFloat(ui.pageDelaySeconds.value, 0, 30, DEFAULT_SETTINGS.pageDelaySeconds),
            autoMarkSeen: ui.autoMarkSeen.checked
        };
    }

    function writeSettingsToUI(next) {
        ui.include.value = next.include;
        ui.exclude.value = next.exclude;
        ui.maxPages.value = String(next.maxPages);
        ui.pageDelaySeconds.value = String(next.pageDelaySeconds);
        ui.autoMarkSeen.checked = Boolean(next.autoMarkSeen);
    }

    function loadSettings() {
        const saved = gmGet(KEYS.settings, {});
        return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === "object" ? saved : {}) };
    }

    function saveSettingsFromUI() {
        settings = readSettingsFromUI();
        gmSet(KEYS.settings, settings);
        setStatus("设置已保存");
        log("已保存筛选设置。");
    }

    async function startScan() {
        if (state.running || !ui) return;
        agentScanFailure = null;
        settings = readSettingsFromUI();
        if (!agentTask) gmSet(KEYS.settings, settings);
        state = createState();
        state.running = true;
        state.startedAt = new Date().toISOString();
        const includeRules = parseRules(settings.include);
        const excludeRules = parseRules(settings.exclude);
        setRunningUI(true);
        setStatus("正在读取职位列表...");
        clearLog();
        log(`开始扫描 ${SITE.label}，包含：${includeRules.join("、") || "全部职位"}`);
        try {
            await scanPages(includeRules, excludeRules);
        } catch (error) {
            agentScanFailure = error;
            console.error("Indeed Job Helper scan error", error);
            log(`扫描中断：${error.message || String(error)}`, "error");
        } finally {
            state.running = false;
            state.endedAt = new Date().toISOString();
            setRunningUI(false);
            finishWithSummary(includeRules, excludeRules);
        }
    }

    function requestStop() {
        if (!state.running) return;
        state.stopRequested = true;
        setStatus("将在当前页完成后汇总");
        log("已请求停止。", "warn");
    }

    async function scanPages(includeRules, excludeRules) {
        let currentUrl = location.href;
        const visitedPages = new Set();
        while (!state.stopRequested && currentUrl && !visitedPages.has(currentUrl)) {
            if (settings.maxPages > 0 && state.page >= settings.maxPages) {
                log(`已达到最大页数 ${settings.maxPages}。`);
                break;
            }
            visitedPages.add(currentUrl);
            state.page += 1;
            setStatus(`正在扫描第 ${state.page} 页...`);
            let pageDocument = document;
            if (state.page > 1) {
                pageDocument = await fetchPage(currentUrl);
            }
            const cards = SITE.findCards(pageDocument);
            if (!cards.length) {
                log(`第 ${state.page} 页没有找到职位卡，停止扫描。`, "warn");
                break;
            }
            collectJobs(cards, currentUrl, includeRules, excludeRules);
            updateCounters();
            log(`第 ${state.page} 页：读取 ${cards.length} 个职位，目前汇总 ${state.results.size} 个。`);
            currentUrl = SITE.findNextUrl(pageDocument, currentUrl);
            if (!currentUrl || state.stopRequested) break;
            setStatus(`等待后读取第 ${state.page + 1} 页...`);
            await sleep(jitterMs(settings.pageDelaySeconds));
        }
    }

    async function fetchPage(url) {
        await agentBeforePlatformAccess("Indeed 下一页");
        try {
        const response = await fetch(url, { credentials: "same-origin" });
        if (!response.ok) throw new Error(`读取列表页失败（${response.status}）`);
        const html = await response.text();
        const parsed = new DOMParser().parseFromString(html, "text/html");
        if (/captcha|verify you are human|unusual traffic/i.test(parsed.body?.innerText || "")) {
            throw new Error("站点要求人工验证；请完成验证后重新开始扫描");
        }
        return parsed;
        } catch (error) {
            if (typeof GM_xmlhttpRequest !== "function") throw error;
            log(`普通分页请求失败（${error.message || "unknown error"}），正在使用 Tampermonkey 请求重试。`, "warn");
            const html = await requestIndeedPage(url);
            const parsed = new DOMParser().parseFromString(html, "text/html");
            if (/captcha|verify you are human|unusual traffic/i.test(parsed.body?.innerText || "")) {
                throw new Error("站点要求人工验证；请完成验证后重新开始扫描");
            }
            return parsed;
        }
    }

    async function requestIndeedPage(url) {
        await agentBeforePlatformAccess("Indeed 分页保底请求");
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url,
                responseType: "text",
                timeout: 30000,
                headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
                onload(response) {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response.responseText);
                    } else {
                        reject(new Error(`Indeed 分页请求失败（HTTP ${response.status}）`));
                    }
                },
                onerror() {
                    reject(new Error("Indeed 分页请求发生网络错误"));
                },
                ontimeout() {
                    reject(new Error("Indeed 分页请求超时"));
                }
            });
        });
    }

    function collectJobs(cards, baseUrl, includeRules, excludeRules) {
        for (const card of cards) {
            if (state.stopRequested) break;
            const raw = SITE.readCard(card, baseUrl);
            const job = normalizeJob(raw, baseUrl);
            if (!job.title || !job.link) continue;
           const sessionKey = canonicalSessionKey(job);
            if (sessionKey && state.processed.has(sessionKey)) {
               state.duplicates += 1;
               continue;
           }
            if (sessionKey) state.processed.add(sessionKey);
            state.scanned += 1;
            const classification = classifyJob(job, includeRules, excludeRules);
            if (classification.excludedKeywords.length) {
                state.excluded += 1;
                continue;
            }
            if (!classification.matchedKeywords.length && includeRules.length) continue;
            state.matched += 1;
            if (!agentTask && isSeen(job)) {
                state.skippedSeen += 1;
                continue;
            }
            job.primaryKeyword = classification.primaryKeyword;
            job.matchedKeywords = classification.matchedKeywords;
            job.titleZh = translateJobTitle(job.title);
            const resultKey = sessionKey || `unkeyed:${state.page}:${state.scanned}`;
            state.results.set(resultKey, job);
        }
    }

    function normalizeJob(raw, baseUrl) {
        const link = canonicalLink(raw.link || "", baseUrl);
        const id = String(raw.id || getJobId(link) || "").trim();
        return {
            site: SITE.id,
            id,
            title: cleanText(raw.title),
            company: cleanText(raw.company),
            location: cleanText(raw.location),
            listedAt: cleanText(raw.listedAt),
            description: cleanText(raw.description),
            link,
            page: state.page
        };
    }

    function classifyJob(job, includeRules, excludeRules) {
        const source = normalizeText([job.title, job.company, job.location, job.description].join(" "));
        const matchedKeywords = includeRules.filter((rule) => source.includes(rule));
        const excludedKeywords = excludeRules.filter((rule) => source.includes(rule));
        return {
            matchedKeywords,
            excludedKeywords,
            primaryKeyword: matchedKeywords[0] || "全部职位"
        };
    }

    function finishWithSummary(includeRules, excludeRules) {
        const results = Array.from(state.results.values()).sort(compareJobs);
        if (!agentTask && settings.autoMarkSeen) {
            results.forEach((job) => markSeen(job, "summary-generated"));
            saveHistory();
        }
        updateCounters();
        const payload = {
            appVersion: APP_VERSION,
            site: SITE.id,
            siteLabel: SITE.label,
            generatedAt: new Date().toISOString(),
            settings: { includeRules, excludeRules, autoMarkSeen: settings.autoMarkSeen },
            stats: {
                page: state.page,
                scanned: state.scanned,
                matched: state.matched,
                summary: results.length,
                skippedSeen: state.skippedSeen,
                excluded: state.excluded,
                duplicates: state.duplicates
            },
            results
        };
        gmSet(KEYS.latestSummary, payload);
        void agentReportSummary(payload);
        if (agentTask) {
            setStatus(`正在向 Job Agent 上传 ${results.length} 个职位...`);
            agentShowOverlay("正在上传职位", `已完成扫描，正在上传 ${results.length} 个职位。请勿关闭或操作此窗口。`);
            log(`扫描完成，正在向 Job Agent 上传 ${results.length} 个职位。`);
            return;
        }
        if (!results.length) {
            setStatus("扫描完成，没有新的匹配职位");
            log("没有新的匹配职位可汇总。", "warn");
            return;
        }
        setStatus(`扫描完成，已生成 ${results.length} 个职位的汇总`);
        log(`扫描完成：生成 ${results.length} 个职位的汇总。`);
        openSummaryPayload(payload);
    }

    function compareJobs(a, b) {
        return a.primaryKeyword.localeCompare(b.primaryKeyword) || a.title.localeCompare(b.title) || a.company.localeCompare(b.company);
    }

    function openLatestSummary() {
        const payload = gmGet(KEYS.latestSummary, null);
        if (!payload?.results) {
            setStatus("还没有可打开的汇总");
            return;
        }
        openSummaryPayload(payload);
    }

    function openSummaryPayload(payload) {
        const blob = new Blob([buildSummaryHtml(payload)], { type: "text/html;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        try {
            if (typeof GM_openInTab === "function") {
                GM_openInTab(url, { active: true, insert: true, setParent: true });
            } else {
                window.open(url, "_blank", "noopener");
            }
        } catch (error) {
            console.error(error);
            window.open(url, "_blank", "noopener");
        }
    }

    function buildSummaryHtml(payload) {
        const payloadJson = JSON.stringify(payload).replace(/</g, "\\u003c");
        return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(payload.siteLabel)} 职位筛选汇总</title><style>
            *{box-sizing:border-box}body{margin:0;background:#f4f7f9;color:#17212b;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}.top{padding:28px max(24px,calc((100vw - 1180px)/2));background:#0a66c2;color:#fff}.top h1{margin:0;font-size:26px}.top p{margin:6px 0 0;opacity:.88}.shell{max-width:1180px;margin:0 auto;padding:22px 24px 48px}.stats{display:grid;grid-template-columns:repeat(6,minmax(90px,1fr));gap:8px;margin-bottom:18px}.stat{padding:11px;background:#fff;border:1px solid #d6e0e8;border-radius:5px;color:#596b7a;font-size:12px}.stat b{display:block;font-size:20px;color:#17212b}.tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}.tools input{min-width:250px;flex:1;padding:9px 10px;border:1px solid #9eabb6;border-radius:4px;font:inherit}.tools button,.keyword{padding:8px 10px;border:1px solid #95a5b4;border-radius:4px;background:#fff;color:#17212b;cursor:pointer;font:600 13px/1.2 inherit}.keyword.active{background:#0a66c2;border-color:#0a66c2;color:#fff}.keywords{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:20px}.group{margin:25px 0}.group h2{margin:0 0 9px;font-size:18px}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(285px,1fr));gap:10px}.card{position:relative;padding:15px;background:#fff;border:1px solid #d6e0e8;border-radius:5px}.card h3{margin:0 0 6px;padding-right:30px;font-size:16px;line-height:1.3}.card h3 a{color:#075da8;text-decoration:none}.zh{margin:0 0 9px;color:#3e5366}.meta{margin:4px 0;color:#536574}.tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:11px}.tag{padding:3px 6px;background:#e9f3fb;color:#075da8;border-radius:3px;font-size:11px}.open{position:absolute;right:12px;top:12px;color:#075da8;text-decoration:none;font-size:12px}.empty{padding:35px;text-align:center;background:#fff;border:1px solid #d6e0e8;border-radius:5px;color:#536574}@media(max-width:700px){.top{padding:22px 16px}.shell{padding:16px}.stats{grid-template-columns:repeat(3,1fr)}.tools input{min-width:100%}}</style></head><body><header class="top"><h1 id="title"></h1><p id="sub"></p></header><main class="shell"><section class="stats" id="stats"></section><div class="tools"><input id="search" type="search" placeholder="搜索职位、公司或地点"><button id="copy">复制链接</button><button id="download">下载 JSON</button></div><div class="keywords" id="keywords"></div><div id="content"></div></main><script>
            const payload=${payloadJson};let active="全部";const esc=v=>String(v??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;","'":"&#39;"}[c]));
            const byId=id=>document.getElementById(id);const stats=[['页数',payload.stats.page],['扫描',payload.stats.scanned],['命中',payload.stats.matched],['汇总',payload.stats.summary],['已看跳过',payload.stats.skippedSeen],['排除',payload.stats.excluded]];
            byId('title').textContent=payload.siteLabel+' 职位筛选汇总';byId('sub').textContent='生成于 '+new Date(payload.generatedAt).toLocaleString()+' · 关键词：'+(payload.settings.includeRules.join('、')||'全部职位');byId('stats').innerHTML=stats.map(s=>'<div class="stat">'+s[0]+'<b>'+s[1]+'</b></div>').join('');
            function renderKeywords(){const counts={};payload.results.forEach(j=>counts[j.primaryKeyword]=(counts[j.primaryKeyword]||0)+1);const names=['全部',...Object.keys(counts).sort()];byId('keywords').innerHTML=names.map(n=>'<button class="keyword '+(n===active?'active':'')+'" data-key="'+esc(n)+'">'+esc(n)+' ('+(n==='全部'?payload.results.length:counts[n])+')</button>').join('');document.querySelectorAll('.keyword').forEach(b=>b.onclick=()=>{active=b.dataset.key;renderKeywords();render();});}
            function render(){const query=byId('search').value.trim().toLocaleLowerCase();const items=payload.results.filter(j=>(active==='全部'||j.primaryKeyword===active)&&[j.title,j.titleZh,j.company,j.location,j.description].join(' ').toLocaleLowerCase().includes(query));if(!items.length){byId('content').innerHTML='<div class="empty">没有符合当前筛选的职位。</div>';return;}const groups={};items.forEach(j=>(groups[j.primaryKeyword]??=[]).push(j));byId('content').innerHTML=Object.keys(groups).sort().map(k=>'<section class="group"><h2>'+esc(k)+' ('+groups[k].length+')</h2><div class="cards">'+groups[k].map(j=>'<article class="card"><a class="open" href="'+esc(j.link)+'" target="_blank" rel="noopener">打开</a><h3><a href="'+esc(j.link)+'" target="_blank" rel="noopener">'+esc(j.title)+'</a></h3><p class="zh">'+esc(j.titleZh||'')+'</p><p class="meta">'+esc(j.company||'未知公司')+'</p><p class="meta">'+esc(j.location||'地点未列出')+(j.listedAt?' · '+esc(j.listedAt):'')+'</p><div class="tags">'+(j.matchedKeywords||[]).map(t=>'<span class="tag">'+esc(t)+'</span>').join('')+'</div></article>').join('')+'</div></section>').join('');}
            byId('search').addEventListener('input',render);byId('copy').onclick=async()=>{const text=payload.results.map(j=>[j.title,j.titleZh||'',j.company||'',j.location||'',j.link].join('\\t')).join('\\n');try{await navigator.clipboard.writeText(text);byId('copy').textContent='已复制';setTimeout(()=>byId('copy').textContent='复制链接',1200);}catch{prompt('复制以下内容',text);}};byId('download').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));a.download=payload.site+'-job-summary-'+new Date(payload.generatedAt).toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};renderKeywords();render();
        </script><style>
            .cards{display:block;background:#fff;border:1px solid #d6e0e8;border-radius:5px}
            .card{position:relative;display:grid;grid-template-columns:minmax(0,2fr) minmax(185px,1fr) minmax(125px,.65fr) auto;column-gap:18px;row-gap:4px;align-items:center;padding:14px 16px;border:0;border-bottom:1px solid #dfe7ed;border-radius:0;box-shadow:none}
            .card:last-child{border-bottom:0}.card h3{grid-column:1;grid-row:1;margin:0;padding-right:0}.zh{grid-column:1;grid-row:2;margin:0}.card .meta:nth-of-type(2){grid-column:2;grid-row:1;margin:0;font-weight:650;color:#2c4053}.card .meta:nth-of-type(3){grid-column:2;grid-row:2;margin:0}.tags{grid-column:3;grid-row:1 / span 2;align-content:center;margin:0}.open{position:static;grid-column:4;grid-row:1 / span 2;align-self:center;padding:7px 10px;border:1px solid #95a5b4;border-radius:4px;white-space:nowrap}
            @media(max-width:760px){.card{display:block;padding:14px 16px}.card h3{padding-right:56px}.card .meta:nth-of-type(2),.card .meta:nth-of-type(3),.tags{margin-top:5px}.open{position:absolute;right:12px;top:12px;border:0;padding:0}.cards{border-radius:4px}}
        </style></body></html>`;
    }

   function loadHistory() {
       const raw = gmGet(KEYS.history, null);
        const store = {
            schema: "indeed-helper-history",
            version: 1,
            entries: raw?.entries && typeof raw.entries === "object" ? raw.entries : {}
        };
        hydrateStrongHistoryKeys(store);
        return store;
   }

    function hydrateStrongHistoryKeys(store) {
        let changed = false;
        for (const record of Object.values(store.entries)) {
            for (const key of historyKeysForJob(record)) {
                if (!store.entries[key]) {
                    store.entries[key] = { ...record };
                    changed = true;
                }
            }
        }
        if (changed) gmSet(KEYS.history, store);
    }

    function saveHistory() {
        gmSet(KEYS.history, historyStore);
    }

    function markSeen(job, source) {
        const now = new Date().toISOString();
        for (const key of historyKeysForJob(job)) {
            historyStore.entries[key] = {
                site: SITE.id,
                id: job.id,
                title: job.title,
                company: job.company,
                location: job.location,
                link: job.link,
                firstSeenAt: historyStore.entries[key]?.firstSeenAt || now,
                lastSeenAt: now,
                source
            };
        }
    }

    function isSeen(job) {
        return historyKeysForJob(job).some((key) => Boolean(historyStore.entries[key]));
    }

   function historyKeysForJob(job) {
       const keys = [];
       if (job.id) keys.push(`${SITE.id}:job:${job.id}`);
        const linkKey = historyLinkKey(job.link);
        if (linkKey) keys.push(linkKey);
       return keys;
   }

    function historyLinkKey(link) {
        const canonical = canonicalLink(link || "", location.href);
        const normalized = normalizeText(canonical);
        return normalized ? `${SITE.id}:url:${normalized}` : "";
    }

    function exportHistory() {
        const pack = { schema: "indeed-helper-history-pack", version: 1, site: SITE.id, exportedAt: new Date().toISOString(), history: historyStore };
        const text = JSON.stringify(pack, null, 2);
        copyText(text);
        setStatus("历史 JSON 已复制到剪贴板");
        log(`已导出 ${historyCount()} 条历史记录。`);
    }

    function showImportModal() {
        showTextModal("导入已看记录", "", (text) => {
            let pack;
            try { pack = JSON.parse(text); } catch { throw new Error("不是有效的 JSON"); }
            const entries = pack?.history?.entries || pack?.entries;
            if (!entries || typeof entries !== "object") throw new Error("没有找到 history.entries");
            Object.entries(entries).forEach(([key, value]) => {
                if (key.startsWith(`${SITE.id}:`)) historyStore.entries[key] = value;
            });
            saveHistory();
            updateCounters();
            setStatus("历史记录已导入");
            log(`导入完成，当前共 ${historyCount()} 条记录。`);
        });
    }

    function clearHistory() {
        if (!window.confirm(`确定清空 ${SITE.label} 的 ${historyCount()} 条已看记录吗？`)) return;
        historyStore = { schema: "indeed-helper-history", version: 1, entries: {} };
        saveHistory();
        updateCounters();
        setStatus("已清空历史记录");
        log("已清空已看记录。", "warn");
    }

    function showTextModal(title, initialText, onConfirm) {
        const overlay = document.createElement("div");
        overlay.className = "sih-modal";
        overlay.innerHTML = `<div class="sih-modal-card"><h2>${escapeHtml(title)}</h2><textarea rows="14" placeholder="粘贴 JSON"></textarea><p class="sih-modal-error"></p><div><button type="button" data-modal="cancel">取消</button><button type="button" data-modal="confirm">确认导入</button></div></div>`;
        overlay.querySelector("textarea").value = initialText;
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay || event.target.dataset.modal === "cancel") overlay.remove();
            if (event.target.dataset.modal === "confirm") {
                try { onConfirm(overlay.querySelector("textarea").value); overlay.remove(); }
                catch (error) { overlay.querySelector(".sih-modal-error").textContent = error.message || String(error); }
            }
        });
        document.body.appendChild(overlay);
        const style = document.createElement("style");
        style.textContent = `.sih-modal{position:fixed;z-index:2147483647;inset:0;background:rgba(16,32,45,.45);display:grid;place-items:center;padding:18px}.sih-modal-card{width:min(640px,100%);background:#fff;border-radius:6px;padding:18px;box-shadow:0 16px 45px rgba(0,0,0,.3);font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}.sih-modal-card h2{margin:0 0 12px;font-size:18px}.sih-modal-card textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid #9eabb6;border-radius:4px;font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}.sih-modal-card div:last-child{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}.sih-modal-card button{padding:7px 12px;border:1px solid #95a5b4;border-radius:4px;background:#fff;cursor:pointer}.sih-modal-card button[data-modal="confirm"]{background:#0a66c2;border-color:#0a66c2;color:#fff}.sih-modal-error{min-height:18px;margin:5px 0 0;color:#b42318}`;
        overlay.appendChild(style);
    }

    function translateJobTitle(title) {
        const source = normalizeText(title);
        const phrases = [
            [/expression of interest|\beoi\b/, "意向登记"], [/graduate program/, "毕业生项目"], [/graduate role|graduate position/, "毕业生岗位"],
            [/software engineer/, "软件工程师"], [/software developer/, "软件开发工程师"], [/full[ -]?stack/, "全栈"],
            [/front[ -]?end/, "前端"], [/back[ -]?end/, "后端"], [/data scientist/, "数据科学家"],
            [/data analyst/, "数据分析师"], [/business analyst/, "业务分析师"], [/machine learning/, "机器学习"],
            [/artificial intelligence|\bai\b/, "人工智能"], [/project manager/, "项目经理"], [/product manager/, "产品经理"],
            [/cloud engineer/, "云工程师"], [/devops/, "开发运维"], [/cyber security|cybersecurity/, "网络安全"],
            [/quality assurance|\bqa\b/, "质量保证"], [/civil engineer/, "土木工程师"], [/electrical engineer/, "电气工程师"],
            [/mechanical engineer/, "机械工程师"], [/accountant/, "会计"], [/financial analyst/, "财务分析师"],
            [/marketing/, "市场营销"], [/human resources|\bhr\b/, "人力资源"], [/customer success/, "客户成功"]
        ];
        const exact = phrases.find(([pattern]) => pattern.test(source));
        if (exact) return `中文参考：${exact[1]}`;
        const words = source.replace(/[^a-z0-9+#]+/g, " ").trim().split(/\s+/);
        const map = {
            graduate: "毕业生", intern: "实习生", internship: "实习", junior: "初级", senior: "高级", lead: "负责人", manager: "经理",
            analyst: "分析师", engineer: "工程师", developer: "开发工程师", designer: "设计师", consultant: "顾问", specialist: "专员",
            data: "数据", business: "业务", software: "软件", cloud: "云", security: "安全", product: "产品", project: "项目",
            finance: "财务", accounting: "会计", marketing: "市场", sales: "销售", operations: "运营", research: "研究",
            customer: "客户", support: "支持", network: "网络", systems: "系统", remote: "远程", hybrid: "混合办公", full: "全职", part: "兼职"
        };
        const translated = words.map((word) => map[word] || (isTechnicalWord(word) ? word.toUpperCase() : "")).filter(Boolean);
        return translated.length ? `中文参考：${translated.join(" ")}` : "中文参考：";
    }

    function isTechnicalWord(word) {
        return ["c", "c++", "c#", "java", "javascript", "typescript", "python", "sql", "react", "angular", "vue", "node", "nodejs", "aws", "azure", "gcp", "sap"].includes(word);
    }

    function getJobId(link) {
        return link.match(/(?:job\/|jk=)([a-z0-9]+)/i)?.[1] || "";
    }

    function getIndeedJobId(link) {
        return new URL(link, location.href).searchParams.get("jk") || "";
    }

    function canonicalLink(href, baseUrl) {
        if (!href) return "";
        try {
            const url = new URL(href, baseUrl);
            url.hash = "";
            return url.href;
        } catch { return ""; }
    }

    function toAbsoluteUrl(href, baseUrl) {
        return href ? canonicalLink(href, baseUrl) : "";
    }

    function firstElement(root, selectors) {
        for (const selector of selectors) {
            const found = root.querySelector(selector);
            if (found) return found;
        }
        return null;
    }

    function textOf(element) { return cleanText(element?.textContent || ""); }
    function textLines(element) { return (element?.innerText || element?.textContent || "").split(/\n+/).map(cleanText).filter(Boolean); }
    function findLine(lines, pattern) { return lines.find((line) => pattern.test(line)) || ""; }
    function cleanText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
    function normalizeText(value) { return cleanText(String(value || "").normalize("NFKC")).toLocaleLowerCase(); }
    function splitKeywordAlternatives(value) { return [...new Set(String(value || "").split(/[\n,，]+|\s+\bOR\b\s+/i).map(cleanText).filter(Boolean))]; }
    function parseRules(value) { return splitKeywordAlternatives(value).map(normalizeText); }
    function agentSearchKeyword(value) { return splitKeywordAlternatives(value)[0] || cleanText(value); }
    function agentIncludeKeywordText(value) { return splitKeywordAlternatives(value).join("\n"); }
    function canonicalSessionKey(job) { return historyKeysForJob(job)[0] || ""; }
    function historyCount() {
        const jobs = new Set();
        Object.values(historyStore.entries).forEach((record) => {
            const key = record?.id ? `id:${record.id}` : record?.link ? `link:${record.link}` : `title:${record?.company || ""}|${record?.title || ""}`;
            jobs.add(key);
        });
        return jobs.size;
    }
    function clampInt(value, min, max, fallback) { const num = Number.parseInt(value, 10); return Number.isFinite(num) ? Math.min(max, Math.max(min, num)) : fallback; }
    function clampFloat(value, min, max, fallback) { const num = Number.parseFloat(value); return Number.isFinite(num) ? Math.min(max, Math.max(min, num)) : fallback; }
    function jitterMs(seconds) { const base = Math.max(0, Number(seconds) || 0) * 1000; return Math.round(base * (0.85 + Math.random() * 0.3)); }
    function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
    function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
    function gmGet(key, fallback) { try { return typeof GM_getValue === "function" ? GM_getValue(key, fallback) : fallback; } catch { return fallback; } }
    function gmSet(key, value) { try { if (typeof GM_setValue === "function") GM_setValue(key, value); } catch (error) { console.error(error); } }
    function copyText(text) { try { if (typeof GM_setClipboard === "function") GM_setClipboard(text); else navigator.clipboard?.writeText(text); } catch (error) { console.error(error); } }

    function updateCounters() {
        if (!ui) return;
        const values = { page: state.page, scanned: state.scanned, matched: state.results.size, seen: state.skippedSeen, excluded: state.excluded, history: historyCount() };
        Object.entries(values).forEach(([name, value]) => { const node = ui.host.querySelector(`[data-stat="${name}"]`); if (node) node.textContent = String(value); });
    }

    function setRunningUI(running) {
        if (!ui) return;
        ui.start.disabled = running;
        ui.stop.disabled = !running;
        ui.host.querySelectorAll("textarea,input,button:not([data-action='stop'])").forEach((element) => { if (element !== ui.start) element.disabled = running; });
    }

    function setStatus(message) { if (ui) ui.status.textContent = message; }
    function log(message, level = "info") { if (!ui) return; const stamp = new Date().toLocaleTimeString(); ui.log.textContent += `[${stamp}] ${message}\n`; ui.log.scrollTop = ui.log.scrollHeight; ui.log.dataset.level = level; }
    function clearLog() { if (ui) ui.log.textContent = ""; }

    function agentIsManagedWorkerWindow() {
        return window.name.startsWith("job-agent-worker-");
    }

    function agentIsActive() {
        const params = new URL(location.href).searchParams;
        const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
        return params.get("jobAgentWorker") === "1" || params.get("jobAgentPreflight") === "1"
            || hash.has("jobAgentOnDemandJd") || hash.has("jobAgentJdRequest")
            || agentIsManagedWorkerWindow() || agentIsManagedPreflightWindow();
    }

    function agentShowOverlay(title, detail = "请勿操作这个浏览器窗口。") {
        let overlay = document.getElementById("job-agent-operation-overlay");
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = "job-agent-operation-overlay";
            overlay.innerHTML = '<div class="ja-operation-card"><span class="ja-operation-spinner"></span><strong></strong><p></p><small>脚本正在操作 · 请勿操作此窗口</small></div>';
            const style = document.createElement("style");
            style.textContent = "#job-agent-operation-overlay{position:fixed;z-index:2147483646;inset:0;display:flex;align-items:flex-end;justify-content:center;padding:14px;background:transparent;pointer-events:none;font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#fff}#job-agent-operation-overlay .ja-operation-card{display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:center;gap:2px 10px;width:min(700px,calc(100vw - 28px));padding:9px 12px;background:rgba(24,33,29,.94);border:1px solid rgba(255,255,255,.3);border-radius:4px;box-shadow:0 6px 20px rgba(22,35,29,.2);text-align:left;animation:ja-operation-float 2.4s ease-in-out infinite}#job-agent-operation-overlay strong{font-size:14px}#job-agent-operation-overlay p{grid-column:2/4;margin:0;color:#dbe5df}#job-agent-operation-overlay small{color:#a9e6cc;font-weight:700;white-space:nowrap}#job-agent-operation-overlay .ja-operation-spinner{grid-row:1/3;width:16px;height:16px;border:2px solid #74827a;border-top-color:#79d5ad;border-radius:50%;animation:ja-operation-spin .8s linear infinite}@keyframes ja-operation-spin{to{transform:rotate(360deg)}}@keyframes ja-operation-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}";
            document.documentElement.append(style, overlay);
        }
        overlay.querySelector("strong").textContent = title;
        overlay.querySelector("p").textContent = detail;
    }

    function agentHideOverlay() {
        document.getElementById("job-agent-operation-overlay")?.remove();
    }

    function agentProgressStats() {
        return { scanned: state.scanned, found: state.results.size };
    }

    function agentAccessState() {
        const now = Date.now();
        const stored = gmGet(AGENT.accessThrottleKey, null) || {};
        if (Number(stored.cooldownUntil || 0) && now >= Number(stored.cooldownUntil)) {
            const reset = { count: 0, cooldownUntil: 0, updatedAt: now };
            gmSet(AGENT.accessThrottleKey, reset);
            return reset;
        }
        return { count: Math.max(0, Number(stored.count) || 0), cooldownUntil: Math.max(0, Number(stored.cooldownUntil) || 0), updatedAt: Number(stored.updatedAt) || now };
    }

    function agentCooldownText(remainingMs) {
        const minutes = Math.floor(remainingMs / 60000);
        const seconds = Math.floor((remainingMs % 60000) / 1000);
        return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    function agentApplyTiming(input) {
        const source = input && typeof input === "object" ? input : {};
        const bounded = (key, minimum, maximum) => {
            const value = Number(source[key]);
            return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : DEFAULT_AGENT_TIMING[key]));
        };
        agentTiming = {
            accessLimit: Math.round(bounded("accessLimit", 1, 100)),
            cooldownMinutes: bounded("cooldownMinutes", 0.5, 120),
            actionDelaySeconds: bounded("actionDelaySeconds", 0.3, 10),
            scrollDelaySeconds: bounded("scrollDelaySeconds", 0.5, 20),
            pageDelaySeconds: bounded("pageDelaySeconds", 1, 120),
            jdIntervalSeconds: bounded("jdIntervalSeconds", 0.2, 30),
            jdRequestTimeoutSeconds: bounded("jdRequestTimeoutSeconds", 2, 30),
            jdPageTimeoutSeconds: bounded("jdPageTimeoutSeconds", 3, 60)
        };
    }

    async function agentRefreshTiming(runId = agentTask?.runId) {
        try {
            const query = runId ? `?${new URLSearchParams({ runId }).toString()}` : "";
            const response = await agentRequest("GET", `/api/worker/settings${query}`);
            agentApplyTiming(response.workerTiming);
        } catch (error) {
            console.warn("Job Agent timing settings could not be refreshed", error);
        }
    }

    function agentActionDelay(multiplier = 1) {
        return sleep(Math.round(agentTiming.actionDelaySeconds * multiplier * 1000));
    }

    function agentJdInterval() {
        const base = agentTiming.jdIntervalSeconds * 1000;
        return sleep(Math.max(100, Math.round(base * (0.8 + Math.random() * 0.4))));
    }

    async function agentBeforePlatformAccess(label) {
        if (!agentIsActive() || agentStopRequested) return;
        let access = agentAccessState();
        if (access.count >= agentTiming.accessLimit) {
            access.cooldownUntil ||= Date.now() + agentTiming.cooldownMinutes * 60 * 1000;
            gmSet(AGENT.accessThrottleKey, access);
            const hadHeartbeat = Boolean(agentHeartbeatTimer);
            agentStopHeartbeat();
            let lastProgressAt = 0;
            while (Date.now() < access.cooldownUntil) {
                const remaining = access.cooldownUntil - Date.now();
                const detail = `已连续完成 ${agentTiming.accessLimit} 次 Indeed 平台访问，为降低访问压力暂停 ${agentTiming.cooldownMinutes} 分钟；${agentCooldownText(remaining)} 后自动继续 ${label}。`;
                agentShowOverlay(`访问节流休息中 · ${agentCooldownText(remaining)}`, detail);
                setStatus(`访问节流休息中 · ${agentCooldownText(remaining)}`);
                if (Date.now() - lastProgressAt >= 2500) {
                    lastProgressAt = Date.now();
                    await agentProgress("cooldown", detail, { ...agentProgressStats(), accessCount: access.count, accessLimit: agentTiming.accessLimit, cooldownUntil: new Date(access.cooldownUntil).toISOString(), cooldownReason: `已连续访问 ${agentTiming.accessLimit} 次 Indeed，暂停 ${agentTiming.cooldownMinutes} 分钟后自动继续。` });
                }
                await sleep(Math.min(1000, remaining));
            }
            if (agentStopRequested) return;
            access = { count: 0, cooldownUntil: 0, updatedAt: Date.now() };
            gmSet(AGENT.accessThrottleKey, access);
            agentShowOverlay("Indeed 正在继续", `访问节流休息已结束，继续 ${label}。`);
            if (hadHeartbeat) agentStartHeartbeat();
        }
        access.count += 1;
        access.updatedAt = Date.now();
        if (access.count >= agentTiming.accessLimit) access.cooldownUntil = Date.now() + agentTiming.cooldownMinutes * 60 * 1000;
        gmSet(AGENT.accessThrottleKey, access);
    }

    async function agentProgress(phase, message, stats = agentProgressStats()) {
        if (!agentTask) return;
        try {
            const response = await agentRequest("POST", "/api/worker/progress", {
                runId: agentTask.runId,
                taskId: agentTask.id,
                taskAttempt: agentTask.attempt || 1,
                workerId: agentWorkerId(),
                phase,
                message,
                ...stats
            });
            if (response.stopRequested && !agentStopRequested) {
                agentStopRequested = true;
                requestStop();
                agentShowOverlay("正在停止并保留结果", "已收到停止请求，正在结束当前步骤并上传已获取的职位。");
            }
            return response;
        } catch (error) {
            console.warn("Job Agent progress update failed", error);
        }
    }

    function agentStartHeartbeat() {
        clearInterval(agentHeartbeatTimer);
        void agentProgress("scanning", "Indeed 正在扫描职位列表。");
        agentHeartbeatTimer = setInterval(() => { void agentProgress("scanning", "Indeed 正在扫描职位列表。"); }, 2500);
    }

    function agentStopHeartbeat() {
        clearInterval(agentHeartbeatTimer);
        agentHeartbeatTimer = null;
    }

    function agentResetLocalRecords() {
        historyStore = { schema: "indeed-helper-history", version: 1, entries: {} };
        saveHistory();
        gmSet(KEYS.latestSummary, null);
        gmSet(AGENT.taskKey, null);
        gmSet(AGENT.pauseKey, "");
        gmSet(AGENT.preflightKey, null);
        gmSet(AGENT.accessThrottleKey, { count: 0, cooldownUntil: 0, updatedAt: Date.now() });
        setStatus("Worker 历史记录已清空");
        log("Job Agent 已清空 Indeed Worker 历史记录。", "warn");
        updateCounters();
    }

    function agentNextResetUrl() {
        if (AGENT.platform === "linkedin") {
            return "https://au.indeed.com/jobs?jobAgentReset=1&jobAgentResetAll=1";
        }
        if (AGENT.platform === "indeed") {
            return "https://www.seek.com.au/jobs?jobAgentReset=1&jobAgentResetAll=1";
        }
        return "";
    }

    function agentNotifyHistoryReset(type) {
        try {
            window.opener?.postMessage({ type, platform: AGENT.platform }, AGENT.apiBase);
        } catch (error) {
            console.warn("Job Agent could not report history reset progress", error);
        }
    }

    function agentRunHistoryReset(params) {
        const resetAll = params.get("jobAgentResetAll") === "1";
        agentShowOverlay("正在清理 Indeed Worker 历史", "清理完成后会自动继续下一个平台，请勿操作此窗口。");
        agentResetLocalRecords();
        agentNotifyHistoryReset("job-agent-reset-progress");

        if (resetAll) {
            const nextUrl = agentNextResetUrl();
            if (nextUrl) {
                setTimeout(() => window.location.replace(nextUrl), 450);
                return;
            }
            agentNotifyHistoryReset("job-agent-reset-finished");
            setTimeout(() => {
                window.opener?.focus();
                window.close();
                setTimeout(() => {
                    if (!window.closed) window.location.replace(`${AGENT.apiBase}/?view=setup`);
                }, 250);
            }, 600);
            return;
        }

        params.delete("jobAgentReset");
        params.delete("jobAgentResetAll");
        history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
        agentHideOverlay();
    }

    function agentWorkerId() {
        let workerId = String(gmGet(AGENT.workerKey, "") || "");
        if (!workerId) {
            workerId = (typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `worker-${Date.now()}-${Math.random()}`).slice(0, 120);
            gmSet(AGENT.workerKey, workerId);
        }
        return workerId;
    }

    function agentStoredTask() {
        const stored = gmGet(AGENT.taskKey, null);
        return stored && stored.platform === AGENT.platform && stored.runId ? stored : null;
    }

    function agentHumanBlockReason() {
        const path = location.pathname.toLowerCase();
        if (/(captcha|challenge|checkpoint|authwall|login)/.test(path)) return "The site requires sign-in or a security check in this worker tab.";
        const text = (document.body?.innerText || "").slice(0, 16000);
        if (/captcha|verify you are human|unusual traffic|security check|robot check/i.test(text)) {
            return "The site requested a manual security verification in this worker tab.";
        }
        return null;
    }

    function agentTaskUrl(task) {
        const url = new URL("https://au.indeed.com/jobs");
        url.searchParams.set("q", agentSearchKeyword(task.keyword));
        url.searchParams.set("l", task.location);
        if (Number(task.postedWithinDays) > 0) url.searchParams.set("fromage", String(task.postedWithinDays));
        url.searchParams.set("jobAgentWorker", "1");
        url.searchParams.set("jobAgentRun", task.runId);
        url.searchParams.set("jobAgentTask", task.id);
        return url.href;
    }

    function agentOnTaskPage(task) {
        const params = new URL(location.href).searchParams;
        return params.get("jobAgentTask") === task.id && params.get("jobAgentRun") === task.runId;
    }

    function agentRequest(method, path, payload) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== "function") return reject(new Error("Tampermonkey request permission is unavailable."));
            GM_xmlhttpRequest({
                method,
                url: AGENT.apiBase + path,
                data: payload === undefined ? undefined : JSON.stringify(payload),
                timeout: 20000,
                headers: payload === undefined ? undefined : { "content-type": "application/json" },
                onload(response) {
                    let body;
                    try { body = JSON.parse(response.responseText || "{}"); } catch { return reject(new Error("The local Job Agent returned invalid JSON.")); }
                    if (response.status >= 200 && response.status < 300) return resolve(body);
                    reject(new Error(body.error || `Local Job Agent request failed (${response.status}).`));
                },
                onerror() { reject(new Error("Could not reach the local Job Agent.")); },
                ontimeout() { reject(new Error("The local Job Agent request timed out.")); }
            });
        });
    }

    async function agentMigrateWorkerHistory(reportEmpty = false) {
        const records = Object.entries(historyStore.entries || {}).map(([key, record]) => ({ ...(record || {}), key: record?.key || key }));
        if (!records.length && !reportEmpty) return { ok: true, received: 0, skipped: true };
        try {
            const response = await agentRequest("POST", "/api/worker/history/import", { platform: AGENT.platform, records });
            if (response.clearLocalHistory) {
                historyStore = { schema: "indeed-helper-history", version: 1, entries: {} };
                saveHistory();
                log(`已把 ${records.length} 条 Indeed Worker 历史迁移到 Job Agent；后续 Agent 任务统一在本地平台判重。`);
            }
            return { ok: true, received: records.length, ...response };
        } catch (error) {
            log(`Worker 历史暂未迁移，已保留本地副本：${error.message || String(error)}`, "warn");
            return { ok: false, received: records.length, error: error.message || String(error) };
        }
    }

    async function agentRunHistoryMigration(params) {
        agentShowOverlay("正在迁移 Indeed 历史", "只整理已看记录，不会搜索、领取或运行任何任务。");
        const result = await agentMigrateWorkerHistory(true);
        if (!result?.ok) {
            agentShowOverlay("Indeed 历史迁移失败", `${result?.error || "未知错误"}。原 Worker 历史已保留。`);
            window.opener?.postMessage({ type: "job-agent-history-migration-failed", platform: AGENT.platform, error: result?.error || "未知错误" }, AGENT.apiBase);
            return;
        }
        const migration = result.migration || {};
        agentShowOverlay("Indeed 历史迁移完成", `收到 ${migration.received || 0} 条；新增 ${migration.imported || 0} 条，已有 ${migration.covered || 0} 条。`);
        window.opener?.postMessage({ type: "job-agent-history-migration-progress", platform: AGENT.platform, migration, cleanup: result.cleanup }, AGENT.apiBase);
        const next = params.get("jobAgentMigrationNext") || (window.name === "job-agent-history-migration"
            ? "https://www.seek.com.au/jobs?keywords=jobs&where=Australia"
            : "");
        if (next) return setTimeout(() => window.location.replace(next), 900);
        window.opener?.postMessage({ type: "job-agent-history-migration-finished", platform: AGENT.platform, migration, cleanup: result.cleanup }, AGENT.apiBase);
        setTimeout(() => window.close(), 1200);
    }

    function agentScheduleClaim(runId, delay = 7000) {
        clearTimeout(agentPollTimer);
        agentPollTimer = setTimeout(() => { void agentClaimNext(runId); }, delay);
    }

    async function agentContinueOnNextPlatform(runId) {
        try {
            const next = await agentRequest("GET", `/api/worker/next-platform-launch?${new URLSearchParams({ runId, platform: AGENT.platform })}`);
            if (!next.url) return false;
            window.location.assign(next.url);
            return true;
        } catch (error) {
            console.warn("Job Agent next-platform worker launch failed", error);
            return false;
        }
    }

    function agentFinishRunWindow() {
        agentStopHeartbeat();
        agentShowOverlay("本次运行已结束", "所有队列任务已经处理完毕，正在返回 Job Agent。");
        try {
            window.opener?.postMessage({ type: "job-agent-run-finished", platform: AGENT.platform }, AGENT.apiBase);
            window.opener?.focus();
        } catch (error) {
            console.warn("Job Agent could not notify the dashboard", error);
        }
        if (!agentIsManagedWorkerWindow()) return agentHideOverlay();
        setTimeout(() => {
            window.close();
            setTimeout(() => {
                if (!window.closed) window.location.replace(`${AGENT.apiBase}/?view=routine`);
            }, 250);
        }, 900);
    }

    async function agentClaimNext(runId) {
        if (!runId || agentClaiming) return;
        agentClaiming = true;
        try {
            const query = new URLSearchParams({ runId, platform: AGENT.platform, workerId: agentWorkerId() });
            const response = await agentRequest("GET", `/api/worker/next?${query.toString()}`);
            if (!response.task || !response.run) {
                if (["needs_user_action", "platform_busy"].includes(response.reason)) {
                    return agentScheduleClaim(runId);
                }
                if (await agentContinueOnNextPlatform(runId)) return;
                if (response.reason === "waiting_turn") return agentScheduleClaim(runId);
                return agentFinishRunWindow();
            }
            agentStartedTaskId = null;
            agentApplyTiming(response.task.workerTiming || response.run.settingsSnapshot?.workerTiming);
            agentStopRequested = false;
            agentTask = { ...response.task, runId: response.run.id, workerTiming: { ...agentTiming } };
            gmSet(AGENT.taskKey, agentTask);
            gmSet(AGENT.pauseKey, "");
            if (agentOnTaskPage(agentTask)) await agentStartTask();
            else location.assign(agentTaskUrl(agentTask));
        } catch (error) {
            console.warn("Job Agent worker claim failed", error);
            agentScheduleClaim(runId, 10000);
        } finally {
            agentClaiming = false;
        }
    }

    async function agentWaitForSearchResults(timeout = 12000) {
        const deadline = Date.now() + timeout;
        setStatus("正在等待 Indeed 职位列表加载...");
        while (Date.now() < deadline) {
            if (SITE.findCards(document).length) return true;
            const text = (document.body?.innerText || "").slice(0, 30000);
            if (/\b0\s+jobs?\b|no jobs found|did not match any jobs|没有找到.*职位/i.test(text)) return false;
            await sleep(300);
        }
        return false;
    }

    async function agentStartTask() {
        if (!agentTask || agentStartedTaskId === agentTask.id || state.running) return;
        const humanReason = agentHumanBlockReason();
        if (humanReason) return agentPause(humanReason);
        const deadline = Date.now() + 16000;
        while (!ui && Date.now() < deadline) await sleep(300);
        if (!ui) return agentSubmit("failed", "Job results did not load in the worker tab.", { results: [] });
        agentStartedTaskId = agentTask.id;
        const includeKeywords = agentIncludeKeywordText(agentTask.keyword);
        ui.include.value = includeKeywords;
        const excludeKeywords = Array.isArray(agentTask.exclusionKeywords) ? agentTask.exclusionKeywords.join("\n") : "";
        ui.exclude.value = excludeKeywords;
        settings = { ...settings, include: includeKeywords, exclude: excludeKeywords, pageDelaySeconds: agentTiming.pageDelaySeconds };
        log(`Job Agent 访问节奏：连续访问 ${agentTiming.accessLimit} 次后休息 ${agentTiming.cooldownMinutes} 分钟；翻页 ${agentTiming.pageDelaySeconds} 秒，每份 JD ${agentTiming.jdIntervalSeconds} 秒。`);
        agentShowOverlay("Indeed 正在运行", `平台搜索“${agentSearchKeyword(agentTask.keyword)}” · 包含 ${parseRules(agentTask.keyword).join("、")} · ${agentTask.location}。请勿操作此窗口。`);
        await agentBeforePlatformAccess("搜索结果页");
        agentStartHeartbeat();
        const resultsReady = await agentWaitForSearchResults();
        if (!resultsReady) log("等待后仍未发现职位卡；将按当前页面结果生成空汇总。", "warn");
        await startScan();
    }

    function agentJobs(payload) {
        return (payload.results || []).map((job) => ({
            source: AGENT.platform,
            sourceJobId: job.id || null,
            title: job.title,
            company: job.company,
            location: job.location,
            jobUrl: job.link,
            description: job.description,
            descriptionSource: job.description ? "card-snippet" : null,
            descriptionFetchStatus: null,
            descriptionFetchError: null,
            postedAt: job.listedAt,
            searchKeyword: agentTask?.keyword,
            searchLocation: agentTask?.location
        })).filter((job) => job.title);
    }

    async function agentRequestJobPage(url) {
        await agentBeforePlatformAccess("JD 请求");
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url,
                responseType: "text",
                timeout: agentTiming.jdRequestTimeoutSeconds * 1000,
                headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
                onload(response) {
                    if (response.status >= 200 && response.status < 300) resolve(response.responseText || "");
                    else reject(new Error(`Indeed JD request failed (HTTP ${response.status}).`));
                },
                onerror() { reject(new Error("Indeed JD request failed due to a network error.")); },
                ontimeout() { reject(new Error("Indeed JD request timed out.")); }
            });
        });
    }

    function agentJsonLdJobPosting(value) {
        if (!value || typeof value !== "object") return null;
        if (Array.isArray(value)) {
            for (const item of value) {
                const found = agentJsonLdJobPosting(item);
                if (found) return found;
            }
            return null;
        }
        const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
        if (types.some((type) => String(type).toLowerCase() === "jobposting")) return value;
        return agentJsonLdJobPosting(value["@graph"]);
    }

    function agentExtractDescriptionFromDocument(root) {
        const selectors = [
            "#jobDescriptionText",
            '[data-testid="jobsearch-JobComponent-description"]',
            ".jobsearch-JobComponent-description",
            '[class*="jobDescription"]'
        ];
        let bestLength = 0;
        for (const selector of selectors) {
            for (const element of root.querySelectorAll(selector)) {
                const description = cleanText(element?.innerText || element?.textContent || "");
                bestLength = Math.max(bestLength, description.length);
                if (description.length >= 120) return { description };
            }
        }

        for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
            try {
                const posting = agentJsonLdJobPosting(JSON.parse(script.textContent || "null"));
                if (!posting?.description) continue;
                const parsedDescription = new DOMParser().parseFromString(String(posting.description), "text/html");
                const description = cleanText(parsedDescription.body?.textContent || "");
                bestLength = Math.max(bestLength, description.length);
                if (description.length >= 120) return { description };
            } catch {}
        }

        const pageText = cleanText(root.body?.innerText || root.body?.textContent || "");
        const pageTitle = cleanText(root.title || "");
        const path = root === document ? location.pathname.toLowerCase() : "";
        const blockedPath = /(captcha|challenge|checkpoint|authwall|login)/.test(path);
        const blockedContent = /captcha|verify you are human|unusual traffic|security check|cloudflare|ray id|需要进行其他验证/i.test(`${pageTitle} ${pageText}`);
        if (blockedPath || blockedContent) {
            return { humanReason: "Indeed 在获取职位 JD 时要求人工验证。请完成验证后重新获取 JD。" };
        }

        const panelFound = selectors.some((selector) => root.querySelector(selector));
        throw new Error(`Indeed detail page did not contain a complete job description. Description panel: ${panelFound ? "found" : "missing"}; extracted text: ${bestLength} characters; vjk: ${root === document ? new URL(location.href).searchParams.get("vjk") || "missing" : "static HTML"}.`);
    }

    function agentExtractDescription(html) {
        const parsed = new DOMParser().parseFromString(html, "text/html");
        return agentExtractDescriptionFromDocument(parsed);
    }

    async function agentFetchDescription(job) {
        const jobId = job.sourceJobId || new URL(job.jobUrl, location.href).searchParams.get("jk");
        if (!jobId) throw new Error("Indeed job ID is missing, so its description cannot be opened.");
        const detailUrl = new URL("https://au.indeed.com/jobs");
        detailUrl.searchParams.set("q", agentSearchKeyword(agentTask?.keyword || job.searchKeyword || job.title));
        detailUrl.searchParams.set("l", agentTask?.location || job.searchLocation || "Australia");
        if (Number(agentTask?.postedWithinDays) > 0) {
            detailUrl.searchParams.set("fromage", String(agentTask.postedWithinDays));
        }
        detailUrl.searchParams.set("vjk", jobId);
        let directError = null;
        try {
            const html = await agentRequestJobPage(detailUrl.href);
            const directResult = agentExtractDescription(html);
            if (!directResult.humanReason) return directResult;
            directError = new Error(directResult.humanReason);
        } catch (error) {
            directError = error;
        }
        if (typeof GM_openInTab !== "function") throw directError;
        await agentBeforePlatformAccess("JD 详情页保底标签");
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const resultKey = `job-agent:jd-result:indeed:${requestId}`;
        detailUrl.hash = new URLSearchParams({ jobAgentJdRequest: requestId }).toString();
        gmSet(resultKey, null);
        const childTab = GM_openInTab(detailUrl.href, { active: true, insert: true, setParent: true });
        let keepChildOpen = false;
        try {
            const deadline = Date.now() + agentTiming.jdPageTimeoutSeconds * 1000;
            while (Date.now() < deadline) {
                await sleep(350);
                const result = gmGet(resultKey, null);
                if (!result) continue;
                keepChildOpen = Boolean(result.humanReason);
                if (result.error) throw new Error(`${directError?.message || "Direct HTML extraction failed."} Rendered fallback: ${result.error}`);
                return result;
            }
            throw new Error(`${directError?.message || "Direct HTML extraction failed."} Indeed job description panel did not load within 10 seconds.`);
        } finally {
            gmSet(resultKey, null);
            if (!keepChildOpen) {
                try { childTab?.close?.(); } catch {}
            }
        }
    }

    async function agentRunJdChild(requestId) {
        await agentRefreshTiming();
        const resultKey = `job-agent:jd-result:indeed:${requestId}`;
        const deadline = Date.now() + agentTiming.jdPageTimeoutSeconds * 1000 - 1000;
        let lastError = "Indeed job description panel did not become available.";
        let lastHumanReason = null;
        while (Date.now() < deadline) {
            const currentHumanReason = agentHumanBlockReason();
            if (currentHumanReason) {
                lastHumanReason = currentHumanReason;
                lastError = currentHumanReason;
                await sleep(600);
                continue;
            }
            try {
                const result = agentExtractDescriptionFromDocument(document);
                if (result.humanReason) {
                    lastHumanReason = result.humanReason;
                    lastError = result.humanReason;
                } else {
                    gmSet(resultKey, result);
                    setTimeout(() => window.close(), 150);
                    return;
                }
            } catch (error) {
                lastError = error.message || String(error);
            }
            await sleep(500);
        }
        if (lastHumanReason) {
            gmSet(resultKey, { humanReason: lastHumanReason });
            return;
        }
        gmSet(resultKey, { error: `${lastError} Final page: ${location.pathname}${location.search}.` });
        setTimeout(() => window.close(), 150);
    }

    async function agentContinueJdBatch(batchId) {
        if (!batchId) return false;
        try {
            const next = await agentRequest("POST", `/api/worker/jd-retry/${encodeURIComponent(batchId)}/next`, {});
            if (next.launchUrl) {
                await agentBeforePlatformAccess("下一份批量 JD");
                agentShowOverlay("继续批量获取 JD", `已完成 ${next.completed}/${next.total}，正在打开下一项。`);
                setTimeout(() => window.location.replace(next.launchUrl), 450);
            } else {
                agentShowOverlay("批量 JD 获取完成", `已处理 ${next.completed}/${next.total} 个职位；Agent 会自动更新。`);
                setTimeout(() => window.close(), 700);
            }
        } catch (error) {
            agentShowOverlay("批量获取已停止", `无法继续下一项：${error.message || String(error)}。请回到 Job Agent 重试。`);
        }
        return true;
    }

    async function agentRunOnDemandJd(jobId, batchId = null) {
        await agentRefreshTiming();
        agentShowOverlay("Indeed 正在获取完整 JD", "正在等待职位详情面板加载；读取后会传回 Job Agent 并自动 AI 审阅。");
        const deadline = Date.now() + agentTiming.jdPageTimeoutSeconds * 1000;
        let lastError = "Indeed job description panel did not become available.";
        let lastHumanReason = null;
        while (Date.now() < deadline) {
            const currentHumanReason = agentHumanBlockReason();
            if (currentHumanReason) {
                lastHumanReason = currentHumanReason;
                lastError = currentHumanReason;
                await sleep(600);
                continue;
            }
            try {
                const result = agentExtractDescriptionFromDocument(document);
                if (result.humanReason) {
                    lastHumanReason = result.humanReason;
                    lastError = result.humanReason;
                } else {
                    await agentRequest("POST", "/api/worker/job-jd", { jobId, platform: AGENT.platform, batchId, description: result.description });
                    if (await agentContinueJdBatch(batchId)) return;
                    agentShowOverlay("完整 JD 已获取", "已传回 Job Agent，AI 审阅将自动继续。此页面即将关闭。");
                    setTimeout(() => {
                        window.close();
                        setTimeout(() => { if (!window.closed) window.location.replace(`${AGENT.apiBase}/?view=jobs`); }, 250);
                    }, 700);
                    return;
                }
            } catch (error) {
                lastError = error.message || String(error);
            }
            await sleep(500);
        }
        if (lastHumanReason) {
            await agentRequest("POST", "/api/worker/job-jd", { jobId, platform: AGENT.platform, batchId, humanReason: lastHumanReason });
            agentShowOverlay("需要人工处理 Indeed", "页面持续要求安全验证。请完成处理后回到 Job Agent 再次获取 JD。");
            if (typeof GM_notification === "function") GM_notification({ title: "Job Agent needs help", text: lastHumanReason, timeout: 0 });
            return;
        }
        try {
            await agentRequest("POST", "/api/worker/job-jd", { jobId, platform: AGENT.platform, batchId, error: `${lastError} Final page: ${location.pathname}${location.search}.` });
        } catch (error) {
            lastError = `${lastError} ${error.message || error}`;
        }
        if (await agentContinueJdBatch(batchId)) return;
        agentShowOverlay("未能获取 Indeed JD", `${lastError} 请回到 Job Agent 重试。`);
    }

    async function agentEnrichJobs(jobs, task) {
        if (agentStopRequested) return { jobs, humanReason: null };
        let plan;
        try {
            const response = await agentRequest("POST", "/api/worker/title-plan", {
                runId: task.runId,
                taskId: task.id,
                jobs
            });
            plan = response.plan;
            log(`Job Agent 中央预筛：发现 ${response.counts.total} 个，历史跳过 ${response.counts.seen} 个，复用 ${response.counts.reuse} 个，本地拒绝 ${response.counts.rejected} 个，需获取 ${response.counts.fetch} 份 JD。`);
        } catch (error) {
            log(`标题初筛计划暂不可用，将为全部职位尝试获取 JD：${error.message}`, "warn");
            plan = jobs.map((_, index) => ({ index, action: "fetch" }));
        }
        const planByIndex = new Map(plan.map((item) => [item.index, item]));
        const fetchIndexes = plan.filter((item) => item.action === "fetch").map((item) => item.index);
        let completed = 0;
        let humanReason = null;
        for (let index = 0; index < jobs.length; index += 1) {
            if (agentStopRequested) break;
            const job = jobs[index];
            const planItem = planByIndex.get(index);
            const action = planItem?.action || "fetch";
            if (planItem?.jobId) job.agentJobId = planItem.jobId;
            if (action === "reject") {
                job.descriptionFetchStatus = "skipped-rejected";
                continue;
            }
            if (action === "skip_seen") {
                job.descriptionFetchStatus = "skipped-history";
                continue;
            }
            if (action === "reuse") {
                job.descriptionFetchStatus = "reused";
                continue;
            }
            completed += 1;
            const message = `正在获取完整 JD ${completed}/${fetchIndexes.length}：${job.title}`;
            agentShowOverlay("Indeed 正在获取完整 JD", `${message}。请勿操作此窗口。`);
            setStatus(message);
            if (completed === 1 || completed % 3 === 0 || completed === fetchIndexes.length) {
                await agentProgress("fetching_jd", message, { ...agentProgressStats(), found: jobs.length });
            }
            try {
                const result = await agentFetchDescription(job);
                if (result.humanReason) {
                    humanReason = result.humanReason;
                    job.descriptionFetchStatus = "failed";
                    job.descriptionFetchError = humanReason;
                    break;
                }
                job.description = result.description;
                job.descriptionSource = "detail-page";
                job.descriptionFetchStatus = "fetched";
                job.descriptionFetchError = null;
                job.descriptionFetchedAt = new Date().toISOString();
            } catch (error) {
                job.descriptionFetchStatus = "failed";
                job.descriptionFetchError = error.message || String(error);
                log(`未能获取 ${job.title} 的完整 JD：${job.descriptionFetchError}`, "warn");
            }
            await agentJdInterval();
        }
        if (humanReason) {
            for (const index of fetchIndexes) {
                const job = jobs[index];
                if (job.descriptionFetchStatus) continue;
                job.descriptionFetchStatus = "failed";
                job.descriptionFetchError = "JD retrieval stopped for human verification.";
            }
        }
        return { jobs, humanReason };
    }

    function agentNotify(message) {
        if (typeof GM_notification === "function") GM_notification({ title: "Job Agent needs help", text: message, timeout: 0 });
    }

    async function agentSubmit(status, reason, payload) {
        const task = agentTask;
        if (!task) return;
        payload ||= { results: [] };
        if (status === "completed" && agentStopRequested) reason ||= "Stopped early by user; partial results were kept.";
        if (!payload.__agentPreparedJobs && status === "completed") {
            const enriched = await agentEnrichJobs(agentJobs(payload), task);
            payload.__agentPreparedJobs = enriched.jobs;
            if (enriched.humanReason) {
                status = "needs_user_action";
                reason = enriched.humanReason;
            }
        }
        const submission = {
            runId: task.runId,
            taskId: task.id,
            taskAttempt: task.attempt || 1,
            workerId: agentWorkerId(),
            status,
            reason,
            jobs: payload.__agentPreparedJobs || agentJobs(payload)
        };
        try {
            agentStopHeartbeat();
            const phase = status === "needs_user_action" ? "needs_user_action" : "uploading";
            const message = status === "needs_user_action" ? (reason || "等待人工处理。") : `正在上传 ${submission.jobs.length} 个职位。`;
            if (status !== "needs_user_action") agentShowOverlay("正在上传职位", `${message} 请勿关闭或操作此窗口。`);
            await agentProgress(phase, message, { ...agentProgressStats(), found: submission.jobs.length });
            const response = await agentRequest("POST", "/api/worker/result", submission);
            if (response.discarded) log("本次结果属于已取消或已重跑的旧任务，Agent 已安全忽略。", "warn");
            else log(`Job Agent 已接收 ${submission.jobs.length} 个职位。`);
            if (status === "needs_user_action") {
                gmSet(AGENT.pauseKey, task.id);
                agentHideOverlay();
                agentNotify(`${SITE.label}: ${reason}`);
                agentScheduleClaim(task.runId, 8000);
                return;
            }
            gmSet(AGENT.taskKey, null);
            gmSet(AGENT.pauseKey, "");
            agentTask = null;
            agentStartedTaskId = null;
            agentShowOverlay("本项任务已完成", "正在检查队列中的下一项任务。");
            agentScheduleClaim(task.runId, 1200);
        } catch (error) {
            console.warn("Job Agent worker report failed", error);
            agentShowOverlay("上传暂未完成", `Job Agent 暂时未接收结果：${error.message || String(error)}。10 秒后自动重试。`);
            setTimeout(() => { void agentSubmit(status, reason, payload); }, 10000);
        }
    }

    async function agentPause(reason, payload = { results: [] }) {
        if (!agentTask || gmGet(AGENT.pauseKey, "") === agentTask.id) return agentScheduleClaim(agentTask?.runId);
        await agentSubmit("needs_user_action", reason, payload);
    }

    function agentReportSummary(payload) {
        if (!agentTask) return;
        const failureMessage = String(agentScanFailure?.message || agentScanFailure || "");
        if (/captcha|verify|human|unusual traffic|security|sign.?in/i.test(failureMessage)) {
            void agentPause(failureMessage, payload);
        } else {
            void agentSubmit(failureMessage ? "failed" : "completed", failureMessage || null, payload);
        }
    }

    function agentVisible(element) {
        if (!element?.isConnected || !element.getClientRects().length) return false;
        for (let node = element; node && node !== document.body; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        }
        return true;
    }

    function agentFirst(selectors) {
        for (const selector of selectors) {
            const found = Array.from(document.querySelectorAll(selector)).find(agentVisible);
            if (found) return found;
        }
        return null;
    }

    async function agentWaitFor(selectors, timeout = 12000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const element = agentFirst(selectors);
            if (element) return element;
            await sleep(250);
        }
        return null;
    }

    function agentSetInput(input, value) {
        if (!input || input.disabled) return false;
        const nextValue = String(value || "");
        const previousValue = input.value;
        input.focus();
        const pageInputPrototype = input.ownerDocument?.defaultView?.HTMLInputElement?.prototype;
        const sandboxInputPrototype = typeof HTMLInputElement === "function" ? HTMLInputElement.prototype : null;
        const inputPrototype = input.constructor?.prototype;
        const setter = [pageInputPrototype, sandboxInputPrototype, inputPrototype]
            .filter(Boolean)
            .map((prototype) => Object.getOwnPropertyDescriptor(prototype, "value")?.set)
            .find(Boolean);
        if (setter) setter.call(input, nextValue);
        else input.value = nextValue;
        input._valueTracker?.setValue(previousValue);
        input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        return input.value === nextValue;
    }

    function agentClickText(pattern) {
        const candidates = Array.from(document.querySelectorAll("button, [role='button'], [role='option'], [role='radio'], input[type='radio'], a, label"));
        const element = candidates.find((node) => agentVisible(node) && pattern.test((node.innerText || node.textContent || "").trim()));
        if (!element) return false;
        element.click();
        return true;
    }

    async function agentWaitAndClickText(pattern, timeout = 7000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (agentClickText(pattern)) return true;
            await sleep(180);
        }
        return false;
    }

    async function agentWaitForIndeedDateOption(pattern, timeout = 8000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const listbox = document.querySelector("[role='listbox'][aria-label='Date posted options'], [role='listbox']");
            const options = Array.from(listbox?.querySelectorAll("[role='option']") || []);
            const option = options.find((node) => agentVisible(node) && pattern.test((node.innerText || node.textContent || "").trim()));
            if (option) return option;
            await sleep(180);
        }
        return null;
    }

    async function agentWaitForIndeedDateSelection(option, pattern, timeout = 3000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (option?.isConnected && option.getAttribute("aria-selected") === "true") return true;
            const selected = Array.from(document.querySelectorAll("[role='listbox'] [role='option'][aria-selected='true']"))
                .find((node) => pattern.test((node.innerText || node.textContent || "").trim()));
            if (selected) return true;
            await sleep(120);
        }
        return false;
    }

    function agentFindIndeedDateUpdateButton(listbox) {
        let container = listbox;
        while (container && container !== document.body) {
            const update = Array.from(container.querySelectorAll("button, [role='button']"))
                .find((node) => agentVisible(node) && /^update$/i.test((node.innerText || node.textContent || "").trim()));
            if (update) return update;
            container = container.parentElement;
        }
        return null;
    }

    async function agentWaitForIndeedDateParameter(days, timeout = 10000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (Number(new URL(location.href).searchParams.get("fromage")) === days) return true;
            await sleep(200);
        }
        return false;
    }

    function agentIndeedSearchState() {
        const keyword = agentFirst(["input[name='q']", "input[placeholder*='job title' i]"]);
        const location = agentFirst(["input[name='l']", "input[placeholder*='city' i]"]);
        return { keyword: keyword?.value?.trim() || "", location: location?.value?.trim() || "" };
    }

    function agentPreflightState(validation) {
        const stored = gmGet(AGENT.preflightKey, null);
        const preflightAttempt = Number(validation.preflightAttempt || 1);
        return stored?.validationId === validation.id && stored?.preflightAttempt === preflightAttempt
            ? stored
            : { validationId: validation.id, preflightAttempt, stage: "search" };
    }

    function agentClearPreflight() {
        gmSet(AGENT.preflightKey, null);
        const url = new URL(location.href);
        url.searchParams.delete("jobAgentPreflight");
        url.searchParams.delete("jobAgentValidation");
        history.replaceState(null, "", url.href);
    }

    function agentIsManagedPreflightWindow() {
        return window.name.startsWith("job-agent-preflight-");
    }

    function agentReturnToRoutine() {
        try {
            window.opener?.postMessage({ type: "job-agent-preflight-finished", platform: AGENT.platform }, AGENT.apiBase);
            window.opener?.focus();
        } catch (error) {
            console.warn("Job Agent could not notify the dashboard", error);
        }
        if (!agentIsManagedPreflightWindow()) {
            agentHideOverlay();
            return;
        }
        setTimeout(() => {
            window.close();
            setTimeout(() => {
                if (!window.closed) window.location.replace(`${AGENT.apiBase}/?view=routine`);
            }, 250);
        }, 500);
    }

    async function agentContinuePreflightQueue() {
        await sleep(450);
        if (await agentRunPendingPreflight()) return;
        try {
            const next = await agentRequest("GET", "/api/worker/preflight/next-launch");
            if (next.url) {
                window.location.assign(next.url);
                return;
            }
        } catch (error) {
            console.warn("Job Agent next-platform preflight check failed", error);
        }
        agentReturnToRoutine();
    }

    async function agentSubmitPreflight(validation, status, reason = null) {
        try {
            await agentRequest("POST", "/api/worker/preflight/result", {
                validationId: validation.id,
                preflightAttempt: Number(validation.preflightAttempt || 1),
                platform: AGENT.platform,
                status,
                reason
            });
        } catch (error) {
            if (/older attempt/i.test(error.message || String(error))) {
                agentClearPreflight();
                setTimeout(() => void agentContinuePreflightQueue(), 300);
                return;
            }
            throw error;
        }
        if (status === "needs_user_action") {
            agentNotify(`${SITE.label}: ${reason}`);
            agentClearPreflight();
            agentHideOverlay();
            return;
        }
        agentClearPreflight();
        setTimeout(() => void agentContinuePreflightQueue(), 300);
    }

    async function agentApplyIndeedDateFilter(validation) {
        const days = Number(validation.postedWithinDays);
        if (!days) return true;
        const labels = {
            1: /last 24 hours|past 24 hours/i,
            3: /last 3 days|past 3 days/i,
            7: /last 7 days|past week/i,
            14: /last 14 days|past 2 weeks/i
        };
        if (!labels[days]) throw new Error("Indeed 的 Date posted 不支持所选时间范围。");
        setStatus("Job Agent: 正在打开 Date posted...");
        log(`预检：正在选择 Date posted = 过去 ${days} 天`);
        const trigger = await agentWaitFor(["button[aria-label='Date posted filter']"], 6000);
        if (trigger) {
            if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
        } else if (!agentClickText(/^date posted$/i)) {
            throw new Error("未找到 Indeed 的 Date posted 筛选器。");
        }
        await sleep(650);
        log("预检：等待 Date posted 下拉选项加载。");
        const option = await agentWaitForIndeedDateOption(labels[days]);
        if (!option) {
            const available = Array.from(document.querySelectorAll("[role='listbox'] [role='option']"))
                .map((node) => (node.innerText || node.textContent || "").trim())
                .filter(Boolean)
                .join("、");
            throw new Error(`Date posted 已打开，但 8 秒内未找到可点击的所选时间范围。当前选项：${available || "未加载"}。`);
        }
        const listbox = option.closest("[role='listbox']");
        let updateButton = agentFindIndeedDateUpdateButton(listbox);
        option.scrollIntoView({ block: "nearest" });
        option.click();
        if (!await agentWaitForIndeedDateSelection(option, labels[days])) {
            throw new Error("已点击 Date posted 时间范围，但 Indeed 没有将该选项标记为已选中。");
        }
        setStatus(`Job Agent: Date posted 已选中，准备确认...`);
        log("预检：Date posted 选项已确认选中，等待 Indeed 保存选择状态。");
        await sleep(850);
        setStatus("Job Agent: 正在应用 Date posted...");
        log("预检：正在点击 Indeed 的 Update 确认按钮。");
        if (!agentVisible(updateButton)) updateButton = agentFindIndeedDateUpdateButton(listbox);
        gmSet(AGENT.preflightKey, {
            validationId: validation.id,
            preflightAttempt: Number(validation.preflightAttempt || 1),
            stage: "verify"
        });
        if (updateButton) updateButton.click();
        else if (!await agentWaitAndClickText(/^update$/i, 4000)) throw new Error("已选择 Date posted，但未找到 Indeed 的 Update 确认按钮。");
        log("预检：等待 Indeed 应用 Date posted 并更新结果 URL。");
        if (await agentWaitForIndeedDateParameter(days)) {
            log(`预检：Date posted 已生效，fromage=${days}。`);
            return true;
        }
        const directUrl = new URL(location.href);
        directUrl.searchParams.set("fromage", String(days));
        directUrl.searchParams.delete("start");
        gmSet(AGENT.preflightKey, {
            validationId: validation.id,
            preflightAttempt: Number(validation.preflightAttempt || 1),
            stage: "direct-verify"
        });
        log(`预检：Indeed 未及时更新 URL，正在使用官方 fromage=${days} 参数重新打开结果页。`);
        window.location.assign(directUrl.href);
        return false;
    }

    async function agentStartIndeedOfficialSearch(validation) {
        const searchKeyword = agentSearchKeyword(validation.keyword);
        const keywordInput = await agentWaitFor(["input[name='q']", "input[placeholder*='job title' i]"]);
        const locationInput = await agentWaitFor(["input[name='l']", "input[placeholder*='city' i]"]);
        if (!keywordInput || !locationInput) throw new Error("Indeed primary search inputs were not found.");
        if (!agentSetInput(keywordInput, searchKeyword)) throw new Error("Keyword input could not retain its value.");
        log(`预检：平台搜索关键词 = ${searchKeyword}；本地包含规则 = ${parseRules(validation.keyword).join("、")}`);
        await agentActionDelay();
        if (!agentSetInput(locationInput, validation.location)) throw new Error("Location input could not retain its value.");
        log(`预检：已填写地点 = ${validation.location}`);
        await agentActionDelay();
        gmSet(AGENT.preflightKey, {
            validationId: validation.id,
            preflightAttempt: Number(validation.preflightAttempt || 1),
            stage: "date"
        });
        setStatus("Job Agent: 正在提交搜索条件...");
        log("预检：正在打开 Indeed 官方搜索结果页。");
        const searchUrl = new URL("https://au.indeed.com/jobs");
        searchUrl.searchParams.set("q", searchKeyword);
        searchUrl.searchParams.set("l", validation.location.trim());
        window.location.assign(searchUrl.href);
        return true;
    }

    async function agentAssertSearchResults(validation) {
        const deadline = Date.now() + 10000;
        log("预检：正在确认搜索结果不为空。");
        while (Date.now() < deadline) {
            if (SITE.findCards(document).length) return;
            const text = (document.body?.innerText || "").slice(0, 30000);
            if (/\b0\s+jobs?\b|no jobs found|did not match any jobs|没有找到.*职位/i.test(text)) {
                throw new Error(`没有搜索到职位。请检查关键词“${validation.keyword}”和地点“${validation.location}”是否输入正确。`);
            }
            await sleep(300);
        }
        throw new Error(`10 秒内无法确认搜索结果。请检查关键词“${validation.keyword}”和地点“${validation.location}”，然后重新预检。`);
    }

    async function agentRunPreflight(validationIdOverride = "") {
        const params = new URL(location.href).searchParams;
        const validationId = validationIdOverride || params.get("jobAgentValidation") || gmGet(AGENT.preflightKey, null)?.validationId;
        if (!validationId) return false;
        const response = await agentRequest("GET", `/api/worker/preflight?${new URLSearchParams({ validationId, platform: AGENT.platform })}`);
        const validation = response.validation;
        await agentRefreshTiming();
        await agentRequest("POST", "/api/worker/preflight/started", {
            validationId: validation.id,
            preflightAttempt: Number(validation.preflightAttempt || 1),
            platform: AGENT.platform,
            workerId: agentWorkerId()
        });
        setStatus("Job Agent: 正在预检搜索条件...");
        log(`Job Agent 正在预检：${validation.keyword} / ${validation.location}`);
        const humanReason = agentHumanBlockReason();
        if (humanReason) {
            await agentSubmitPreflight(validation, "needs_user_action", humanReason);
            return true;
        }
        const state = agentPreflightState(validation);
        try {
            if (state.stage === "search") return agentStartIndeedOfficialSearch(validation);
            if (state.stage === "__legacy_search__") {
                const keyword = await agentWaitFor(["input[name='q']", "input[placeholder*='job title' i]"]);
                const location = await agentWaitFor(["input[name='l']", "input[placeholder*='city' i]"]);
                const submit = await agentWaitFor(["form button[type='submit']", "button[type='submit']"]);
                if (!keyword || !location || !submit) throw new Error("Indeed search controls were not found.");
    const searchKeyword = agentSearchKeyword(validation.keyword);
    agentSetInput(keyword, searchKeyword);
    log(`预检：平台搜索关键词 = ${searchKeyword}；本地包含规则 = ${parseRules(validation.keyword).join("、")}`);
    await agentActionDelay();
    agentSetInput(location, validation.location);
    log(`预检：已填写地点 = ${validation.location}`);
                await agentActionDelay();
                gmSet(AGENT.preflightKey, { validationId: validation.id, preflightAttempt: Number(validation.preflightAttempt || 1), stage: "date" });
                setStatus("Job Agent: 正在提交搜索条件...");
                submit.click();
                await agentActionDelay(1.1);
            }
            const searchState = agentIndeedSearchState();
            if (searchState.keyword.toLowerCase() !== agentSearchKeyword(validation.keyword).toLowerCase() || searchState.location.toLowerCase() !== validation.location.trim().toLowerCase()) {
                throw new Error(`关键词或地点未正确应用。页面当前显示：关键词“${searchState.keyword || "空"}”、地点“${searchState.location || "空"}”。`);
            }
            log("预检：关键词和地点已确认。");
            if ((agentPreflightState(validation).stage || "date") === "date") {
                if (!await agentApplyIndeedDateFilter(validation)) return true;
                await agentActionDelay(0.8);
            }
            const appliedDays = Number(validation.postedWithinDays);
            const current = new URL(location.href).searchParams;
            if (appliedDays && Number(current.get("fromage")) !== appliedDays) {
                if (agentPreflightState(validation).stage === "verify") {
                    const directUrl = new URL(location.href);
                    directUrl.searchParams.set("fromage", String(appliedDays));
                    directUrl.searchParams.delete("start");
                    gmSet(AGENT.preflightKey, {
                        validationId: validation.id,
                        preflightAttempt: Number(validation.preflightAttempt || 1),
                        stage: "direct-verify"
                    });
                    setStatus("Job Agent: 正在确认 Date posted 结果...");
                    log(`预检：Update 跳转后尚未保留日期参数，正在用 Indeed 官方 fromage=${appliedDays} 参数确认。`);
                    window.location.assign(directUrl.href);
                    return true;
                }
                throw new Error("Date posted 未确认生效。Indeed 没有在结果 URL 中写入对应的 fromage 参数。");
            }
            await agentAssertSearchResults(validation);
            setStatus("Job Agent: 预检通过。");
            log("预检通过：搜索条件与 Date posted 均已确认。");
            await agentSubmitPreflight(validation, "valid");
        } catch (error) {
            const reason = `预检失败：${error.message || String(error)}`;
            setStatus(`Job Agent: ${reason}`);
            log(reason);
            await agentSubmitPreflight(validation, "failed", reason);
        }
        return true;
    }

    async function agentRunPendingPreflight() {
        try {
            const response = await agentRequest("GET", `/api/worker/preflight/pending?${new URLSearchParams({ platform: AGENT.platform })}`);
            return response.validation ? agentRunPreflight(response.validation.id) : false;
        } catch (error) {
            console.warn("Job Agent pending preflight check failed", error);
            return false;
        }
    }

    async function agentFindActiveRun() {
        try {
            const response = await agentRequest("GET", `/api/worker/active-run?${new URLSearchParams({ platform: AGENT.platform })}`);
            return response.run?.id || null;
        } catch (error) {
            console.warn("Job Agent active run check failed", error);
            return null;
        }
    }

    async function agentBoot() {
        const params = new URL(location.href).searchParams;
        const migrationParams = new URLSearchParams(location.hash.replace(/^#/, ""));
        if (window.name === "job-agent-history-migration" || migrationParams.get("jobAgentHistoryMigration") === "1" || params.get("jobAgentHistoryMigration") === "1") {
            await agentRunHistoryMigration(migrationParams.get("jobAgentHistoryMigration") === "1" ? migrationParams : params);
            return;
        }
        if (params.get("jobAgentReset") === "1") {
            agentRunHistoryReset(params);
            return;
        }
        const preflightMode = params.get("jobAgentPreflight") === "1" || agentIsManagedPreflightWindow();
        const workerMode = params.get("jobAgentWorker") === "1" || agentIsManagedWorkerWindow();
        if (!preflightMode && !workerMode) return;
        if (preflightMode) {
            agentShowOverlay("正在验证 Indeed 搜索条件", "Job Agent 正在填写关键词、地点和时间范围。请勿操作此窗口。");
            if (await agentRunPreflight()) return;
            if (agentIsManagedPreflightWindow()) await agentRunPendingPreflight();
            return;
        }
        await agentMigrateWorkerHistory();
        let runId = params.get("jobAgentRun") || agentStoredTask()?.runId;
        agentTask = agentStoredTask();
        if (agentTask && runId && agentTask.runId !== runId) {
            gmSet(AGENT.taskKey, null);
            agentTask = null;
        }
        const humanReason = agentHumanBlockReason();
        if (agentTask && humanReason) return agentPause(humanReason);
        if (agentTask && gmGet(AGENT.pauseKey, "") === agentTask.id) return agentScheduleClaim(agentTask.runId, 4000);
        if (agentTask) {
            agentApplyTiming(agentTask.workerTiming);
            await agentRefreshTiming(agentTask.runId);
            agentTask.workerTiming = { ...agentTiming };
            gmSet(AGENT.taskKey, agentTask);
            return agentStartTask();
        }
        if (!runId && agentIsManagedWorkerWindow()) runId = await agentFindActiveRun();
        if (runId) await agentClaimNext(runId);
    }

    const agentHashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
    const agentOnDemandJd = agentHashParams.get("jobAgentOnDemandJd");
    const agentJdBatch = agentHashParams.get("jobAgentJdBatch");
    const agentJdChildRequest = agentHashParams.get("jobAgentJdRequest");
    if (agentOnDemandJd) {
        void agentRunOnDemandJd(agentOnDemandJd, agentJdBatch);
    } else if (agentJdChildRequest) {
        void agentRunJdChild(agentJdChildRequest);
    } else if (agentHashParams.get("jobAgentHistoryMigration") === "1" || new URL(location.href).searchParams.get("jobAgentHistoryMigration") === "1") {
        void agentBoot();
    } else {
        init();
        void agentBoot();
    }
})();
