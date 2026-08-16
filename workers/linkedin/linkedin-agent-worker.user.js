// ==UserScript==
// @name         Job Agent Worker - LinkedIn
// @namespace    https://routine.local/job-agent-worker
// @version      1.0.0
// @description  Job Agent worker for LinkedIn. Runs one assigned task at a time and reports results locally.
// @updateURL    http://127.0.0.1:4317/workers/linkedin/linkedin-agent-worker.user.js
// @downloadURL  http://127.0.0.1:4317/workers/linkedin/linkedin-agent-worker.user.js
// @author       Codex
// @match        https://www.linkedin.com/jobs/search/*
// @match        https://www.linkedin.com/jobs/view/*
// @match        https://www.linkedin.com/authwall*
// @match        https://www.linkedin.com/login*
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      www.linkedin.com
// @connect      *.linkedin.com
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
    "use strict";

    const APP_VERSION = "1.0.0";
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
    const HISTORY_KEY = "linkedin_seen_history_v19";
    const LEGACY_HISTORY_KEY = "linkedin_opened_history_v2";
    const SETTINGS_KEY = "linkedin_scan_settings_v19";
    const SUMMARY_HISTORY_KEY = "linkedin_summary_history_v1";
    const SUMMARY_HISTORY_LIMIT = 10;

    const AGENT = {
        apiBase: String(GM_getValue("job-agent:api-base", "http://127.0.0.1:4317")).replace(/\/+$/, ""),
        platform: "linkedin",
        taskKey: "job-agent:worker-task:linkedin",
        workerKey: "job-agent:worker-id:linkedin",
        pauseKey: "job-agent:worker-pause:linkedin",
        preflightKey: "job-agent:worker-preflight:linkedin",
        accessThrottleKey: "job-agent:access-throttle:linkedin:v1"
    };
    const LINKEDIN_KEYWORD_INPUT_SELECTORS = [
        "input[role='combobox'][aria-label='Search by title, skill, or company']:not([disabled]):not([aria-hidden='true'])",
        "input[role='combobox'][aria-label*='Search by title' i]:not([disabled]):not([aria-hidden='true'])",
        "input[role='combobox'][aria-label*='Search jobs' i]:not([disabled]):not([aria-hidden='true'])",
        "#job-search-bar-keywords"
    ];
    const LINKEDIN_LOCATION_INPUT_SELECTORS = [
        "input[role='combobox'][aria-label='City, state, or zip code']:not([disabled]):not([aria-hidden='true'])",
        "input[role='combobox'][aria-label*='City, state, or zip code' i]:not([disabled]):not([aria-hidden='true'])",
        "input[role='combobox'][aria-label*='location' i]:not([disabled]):not([aria-hidden='true'])",
        "#job-search-bar-location"
    ];
    let agentTask = null;
    let agentScanFailure = null;
    let agentClaiming = false;
    let agentPollTimer = null;
    let agentHeartbeatTimer = null;
    let agentStartedTaskId = null;
    let agentTiming = { ...DEFAULT_AGENT_TIMING };
    let agentStopRequested = false;

    const DEFAULT_SETTINGS = {
        target: "graduate",
        exclude: "expression of interest\neoi",
        maxPages: 0,
        scrollRounds: 18,
        scrollDelaySeconds: 2,
        pageDelaySeconds: 15,
        autoMarkSeen: true
    };

    const BAD_TITLE_LINES = new Set([
        "promoted",
        "viewed",
        "easy apply",
        "actively reviewing applicants",
        "be an early applicant",
        "reposted",
        "applied"
    ]);

    let settings = loadSettings();
    let historyStore = loadHistory();
    let summaryHistory = loadSummaryHistory();
    let ui = null;
    let scanState = createScanState();

    function createScanState() {
        return {
            running: false,
            stopRequested: false,
            page: 0,
            scanned: 0,
            matched: 0,
            collected: 0,
            skippedSeen: 0,
            excluded: 0,
            duplicates: 0,
            processedKeys: new Set(),
            resultMap: new Map(),
            startedAt: null,
            endedAt: null
        };
    }

    function getPanelStyles() {
        return `
            #lh-panel {
                position: fixed;
                top: 76px;
                right: 20px;
                z-index: 99999;
                width: 320px;
                max-height: calc(100vh - 96px);
                overflow: auto;
                padding: 14px;
                color: #17202a;
                background: #ffffff;
                border: 1px solid #1f2937;
                border-radius: 8px;
                box-shadow: 0 12px 30px rgba(15, 23, 42, 0.18);
                font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            #lh-panel * { box-sizing: border-box; }
            #lh-panel .lh-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                margin-bottom: 10px;
                font-weight: 700;
            }
            #lh-panel .lh-status {
                padding: 2px 7px;
                border-radius: 999px;
                color: #991b1b;
                background: #fee2e2;
                font-weight: 700;
            }
            #lh-panel .lh-status.is-running {
                color: #166534;
                background: #dcfce7;
            }
            #lh-panel .lh-group {
                margin: 8px 0;
                padding: 8px;
                border: 1px solid #e5e7eb;
                border-radius: 6px;
                background: #f8fafc;
            }
            #lh-panel label {
                display: block;
                margin-bottom: 4px;
                color: #374151;
                font-weight: 700;
            }
            #lh-panel textarea,
            #lh-panel input[type="number"] {
                width: 100%;
                min-width: 0;
                padding: 6px;
                color: #111827;
                background: #ffffff;
                border: 1px solid #cbd5e1;
                border-radius: 5px;
                font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            #lh-panel textarea {
                resize: vertical;
            }
            #lh-panel .lh-row {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 8px;
            }
            #lh-panel .lh-check {
                display: flex;
                align-items: center;
                gap: 6px;
                margin-top: 7px;
                color: #374151;
                font-weight: 600;
            }
            #lh-panel .lh-metrics {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                gap: 6px;
                margin: 8px 0;
            }
            #lh-panel .lh-metric {
                min-width: 0;
                padding: 7px 5px;
                text-align: center;
                background: #f1f5f9;
                border: 1px solid #e2e8f0;
                border-radius: 6px;
            }
            #lh-panel .lh-metric b {
                display: block;
                color: #111827;
                font-size: 16px;
                line-height: 1.1;
            }
            #lh-panel .lh-metric span {
                display: block;
                margin-top: 2px;
                color: #64748b;
                white-space: nowrap;
            }
            #lh-panel .lh-actions {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 6px;
                margin-top: 8px;
            }
            #lh-panel button {
                min-height: 30px;
                padding: 7px 8px;
                border: 1px solid #cbd5e1;
                border-radius: 5px;
                background: #ffffff;
                color: #111827;
                cursor: pointer;
                font-weight: 700;
            }
            #lh-panel button:hover {
                background: #f8fafc;
            }
            #lh-panel .lh-primary {
                grid-column: span 2;
                color: #ffffff;
                background: #111827;
                border-color: #111827;
            }
            #lh-panel .lh-primary:hover {
                background: #1f2937;
            }
            #lh-panel .lh-danger {
                color: #ffffff;
                background: #b91c1c;
                border-color: #b91c1c;
            }
            #lh-panel .lh-danger:hover {
                background: #991b1b;
            }
            #lh-panel .lh-log {
                height: 132px;
                overflow: auto;
                padding: 7px;
                margin-top: 8px;
                color: #475569;
                background: #f8fafc;
                border: 1px solid #e2e8f0;
                border-radius: 6px;
                font-size: 11px;
            }
            #lh-panel .lh-log div {
                margin-bottom: 4px;
            }
            #lh-history-modal {
                position: fixed;
                inset: 0;
                z-index: 100000;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 24px;
                background: rgba(15, 23, 42, 0.45);
            }
            #lh-history-modal .lh-modal-card {
                width: min(760px, 100%);
                padding: 16px;
                background: #ffffff;
                border-radius: 8px;
                box-shadow: 0 18px 50px rgba(15, 23, 42, 0.3);
                font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            #lh-history-modal textarea {
                width: 100%;
                height: 280px;
                margin: 10px 0;
                padding: 10px;
                border: 1px solid #cbd5e1;
                border-radius: 6px;
                font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            }
            #lh-history-modal .lh-modal-actions {
                display: flex;
                justify-content: flex-end;
                gap: 8px;
            }
        `;
    }

    function setImportantStyles(el, styles) {
        if (!el) return;
        for (const [property, value] of Object.entries(styles)) {
            el.style.setProperty(property, value, "important");
        }
    }

    function applySidebarLayout(host, panel) {
        setImportantStyles(host, {
            "position": "fixed",
            "top": "0",
            "right": "0",
            "bottom": "0",
            "z-index": "2147483647",
            "width": "360px",
            "height": "100vh",
            "background": "#ffffff",
            "border-left": "1px solid #d0d7de",
            "box-shadow": "-8px 0 24px rgba(15, 23, 42, 0.14)",
            "box-sizing": "border-box",
            "overflow": "hidden",
            "font-family": "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        });

        setImportantStyles(panel, {
            "position": "relative",
            "display": "block",
            "width": "360px",
            "height": "100vh",
            "max-height": "100vh",
            "overflow-y": "auto",
            "padding": "14px",
            "margin": "0",
            "color": "#17202a",
            "background": "#ffffff",
            "border": "0",
            "border-radius": "0",
            "box-shadow": "none",
            "box-sizing": "border-box",
            "font": "12px/1.45 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        });

        for (const node of panel.querySelectorAll("*")) {
            setImportantStyles(node, {
                "box-sizing": "border-box",
                "font-family": "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
            });
        }

        setImportantStyles(panel.querySelector(".lh-header"), {
            "display": "flex",
            "align-items": "center",
            "justify-content": "space-between",
            "gap": "8px",
            "margin": "0 0 10px",
            "font-weight": "700"
        });

        setImportantStyles(panel.querySelector('[data-lh="status"]'), {
            "display": "inline-block",
            "padding": "2px 7px",
            "border-radius": "999px",
            "color": "#991b1b",
            "background": "#fee2e2",
            "font-weight": "700",
            "white-space": "nowrap"
        });

        for (const group of panel.querySelectorAll(".lh-group")) {
            setImportantStyles(group, {
                "display": "block",
                "margin": "8px 0",
                "padding": "8px",
                "border": "1px solid #e5e7eb",
                "border-radius": "6px",
                "background": "#f8fafc"
            });
        }

        for (const label of panel.querySelectorAll("label")) {
            setImportantStyles(label, {
                "display": "block",
                "margin": "0 0 4px",
                "color": "#374151",
                "font-size": "12px",
                "font-weight": "700",
                "line-height": "1.35"
            });
        }

        for (const field of panel.querySelectorAll("textarea, input[type='number']")) {
            setImportantStyles(field, {
                "display": "block",
                "width": "100%",
                "min-width": "0",
                "padding": "6px",
                "color": "#111827",
                "background": "#ffffff",
                "border": "1px solid #cbd5e1",
                "border-radius": "5px",
                "font": "12px/1.35 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
            });
        }

        for (const textarea of panel.querySelectorAll("textarea")) {
            setImportantStyles(textarea, {
                "resize": "vertical",
                "min-height": textarea.id === "lh-exclude" ? "76px" : "54px"
            });
        }

        setImportantStyles(panel.querySelector(".lh-row"), {
            "display": "grid",
            "grid-template-columns": "1fr 1fr",
            "gap": "8px"
        });

        setImportantStyles(panel.querySelector(".lh-check"), {
            "display": "flex",
            "align-items": "center",
            "gap": "6px",
            "margin": "7px 0 0",
            "color": "#374151",
            "font-weight": "600"
        });

        setImportantStyles(panel.querySelector("#lh-auto-mark"), {
            "display": "inline-block",
            "width": "14px",
            "height": "14px",
            "margin": "0",
            "padding": "0",
            "flex": "0 0 auto"
        });

        setImportantStyles(panel.querySelector(".lh-metrics"), {
            "display": "grid",
            "grid-template-columns": "repeat(3, minmax(0, 1fr))",
            "gap": "6px",
            "margin": "8px 0"
        });

        for (const metric of panel.querySelectorAll(".lh-metric")) {
            setImportantStyles(metric, {
                "display": "block",
                "min-width": "0",
                "padding": "7px 5px",
                "text-align": "center",
                "background": "#f1f5f9",
                "border": "1px solid #e2e8f0",
                "border-radius": "6px"
            });
        }

        for (const value of panel.querySelectorAll(".lh-metric b")) {
            setImportantStyles(value, {
                "display": "block",
                "color": "#111827",
                "font-size": "16px",
                "line-height": "1.1",
                "font-weight": "800"
            });
        }

        for (const caption of panel.querySelectorAll(".lh-metric span")) {
            setImportantStyles(caption, {
                "display": "block",
                "margin-top": "2px",
                "color": "#64748b",
                "font-size": "11px",
                "white-space": "nowrap"
            });
        }

        setImportantStyles(panel.querySelector(".lh-actions"), {
            "display": "grid",
            "grid-template-columns": "1fr 1fr",
            "gap": "6px",
            "margin-top": "8px"
        });

        for (const button of panel.querySelectorAll("button")) {
            setImportantStyles(button, {
                "display": "inline-flex",
                "align-items": "center",
                "justify-content": "center",
                "min-height": "32px",
                "padding": "7px 8px",
                "border": "1px solid #cbd5e1",
                "border-radius": "5px",
                "background": "#ffffff",
                "color": "#111827",
                "cursor": "pointer",
                "font-size": "12px",
                "font-weight": "700",
                "line-height": "1.2",
                "text-align": "center",
                "white-space": "normal"
            });
        }

        setImportantStyles(panel.querySelector(".lh-primary"), {
            "grid-column": "span 2",
            "color": "#ffffff",
            "background": "#111827",
            "border-color": "#111827"
        });

        setImportantStyles(panel.querySelector(".lh-danger"), {
            "color": "#ffffff",
            "background": "#b91c1c",
            "border-color": "#b91c1c"
        });

        setImportantStyles(panel.querySelector(".lh-log"), {
            "display": "block",
            "height": "132px",
            "overflow-y": "auto",
            "padding": "7px",
            "margin-top": "8px",
            "color": "#475569",
            "background": "#f8fafc",
            "border": "1px solid #e2e8f0",
            "border-radius": "6px",
            "font-size": "11px",
            "line-height": "1.4"
        });

        reserveSidebarSpace();
    }

    function reserveSidebarSpace() {
        const width = "360px";
        if (!document.documentElement.dataset.lhOriginalPaddingRight) {
            document.documentElement.dataset.lhOriginalPaddingRight = document.documentElement.style.paddingRight || "";
        }
        if (!document.body.dataset.lhOriginalPaddingRight) {
            document.body.dataset.lhOriginalPaddingRight = document.body.style.paddingRight || "";
        }
        document.documentElement.style.setProperty("padding-right", width, "important");
        document.body.style.setProperty("padding-right", width, "important");
    }

    function applyModalLayout(modal) {
        setImportantStyles(modal, {
            "position": "fixed",
            "inset": "0",
            "z-index": "2147483647",
            "display": "flex",
            "align-items": "center",
            "justify-content": "center",
            "padding": "24px",
            "background": "rgba(15, 23, 42, 0.45)"
        });

        const card = modal.querySelector(".lh-modal-card");
        setImportantStyles(card, {
            "display": "block",
            "width": "min(760px, 100%)",
            "padding": "16px",
            "background": "#ffffff",
            "border-radius": "8px",
            "box-shadow": "0 18px 50px rgba(15, 23, 42, 0.3)",
            "font": "13px/1.45 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
            "box-sizing": "border-box"
        });

        setImportantStyles(modal.querySelector("h3"), {
            "display": "block",
            "margin": "0 0 6px",
            "font-size": "16px",
            "font-weight": "800",
            "color": "#111827"
        });

        setImportantStyles(modal.querySelector("textarea"), {
            "display": "block",
            "width": "100%",
            "height": "280px",
            "margin": "10px 0",
            "padding": "10px",
            "border": "1px solid #cbd5e1",
            "border-radius": "6px",
            "font": "12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            "box-sizing": "border-box"
        });

        setImportantStyles(modal.querySelector(".lh-modal-actions"), {
            "display": "flex",
            "justify-content": "flex-end",
            "gap": "8px"
        });

        for (const button of modal.querySelectorAll("button")) {
            setImportantStyles(button, {
                "display": "inline-flex",
                "align-items": "center",
                "justify-content": "center",
                "min-height": "32px",
                "padding": "7px 12px",
                "border": "1px solid #cbd5e1",
                "border-radius": "5px",
                "background": "#ffffff",
                "color": "#111827",
                "cursor": "pointer",
                "font-size": "12px",
                "font-weight": "700"
            });
        }
    }

    function initUI() {
        if (document.getElementById("lh-panel-host")) return;

        const oldFrame = document.getElementById("lh-panel-frame");
        if (oldFrame) oldFrame.remove();
        const oldHost = document.getElementById("lh-panel-host");
        if (oldHost) oldHost.remove();
        const legacyPanel = document.getElementById("lh-panel");
        if (legacyPanel) legacyPanel.remove();

        const host = document.createElement("aside");
        host.id = "lh-panel-host";
        host.setAttribute("aria-label", "LinkedIn 助手侧栏");

        const panel = document.createElement("div");
        panel.id = "lh-panel";

        const make = (tag, options = {}) => {
            const node = document.createElement(tag);
            if (options.id) node.id = options.id;
            if (options.className) node.className = options.className;
            if (options.text !== undefined) node.textContent = options.text;
            if (options.data) {
                for (const [key, value] of Object.entries(options.data)) node.setAttribute(`data-${key}`, value);
            }
            if (options.attrs) {
                for (const [key, value] of Object.entries(options.attrs)) node.setAttribute(key, String(value));
            }
            if (options.styles) setImportantStyles(node, options.styles);
            return node;
        };

        const fieldGroup = (labelText, field) => {
            const group = make("div", { className: "lh-group" });
            const label = make("label", { text: labelText, attrs: { for: field.id } });
            group.appendChild(label);
            group.appendChild(field);
            return group;
        };

        const header = make("div", { className: "lh-header" });
        header.appendChild(make("span", { text: `Job Agent Worker - LinkedIn v${APP_VERSION}` }));
        const status = make("span", { className: "lh-status", text: "已停止", data: { lh: "status" } });
        header.appendChild(status);
        panel.appendChild(header);

        const targetInput = make("textarea", { id: "lh-target", attrs: { rows: 3 } });
        panel.appendChild(fieldGroup("包含关键词（逗号或换行）", targetInput));

        const excludeInput = make("textarea", { id: "lh-exclude", attrs: { rows: 4 } });
        panel.appendChild(fieldGroup("排除关键词（一行一个）", excludeInput));

        const settingsGroup = make("div", { className: "lh-group" });
        const row = make("div", { className: "lh-row" });
        const maxWrap = make("div");
        const maxPages = make("input", { id: "lh-max-pages", attrs: { type: "number", min: 0, max: 99, step: 1 } });
        maxWrap.appendChild(make("label", { text: "最大页数（0 为全部）", attrs: { for: "lh-max-pages" } }));
        maxWrap.appendChild(maxPages);
        const scrollWrap = make("div");
        const scrollRounds = make("input", { id: "lh-scroll-rounds", attrs: { type: "number", min: 4, max: 60, step: 1 } });
        scrollWrap.appendChild(make("label", { text: "每页滚动轮数", attrs: { for: "lh-scroll-rounds" } }));
        scrollWrap.appendChild(scrollRounds);
        row.appendChild(maxWrap);
        row.appendChild(scrollWrap);
        settingsGroup.appendChild(row);
        const delayRow = make("div", { className: "lh-row" });
        setImportantStyles(delayRow, { "margin-top": "8px" });
        const scrollDelayWrap = make("div");
        const scrollDelay = make("input", { id: "lh-scroll-delay", attrs: { type: "number", min: 1, max: 15, step: 0.5 } });
        scrollDelayWrap.appendChild(make("label", { text: "滚动等待（秒）", attrs: { for: "lh-scroll-delay" } }));
        scrollDelayWrap.appendChild(scrollDelay);
        const pageDelayWrap = make("div");
        const pageDelay = make("input", { id: "lh-page-delay", attrs: { type: "number", min: 5, max: 90, step: 1 } });
        pageDelayWrap.appendChild(make("label", { text: "翻页冷却（秒）", attrs: { for: "lh-page-delay" } }));
        pageDelayWrap.appendChild(pageDelay);
        delayRow.appendChild(scrollDelayWrap);
        delayRow.appendChild(pageDelayWrap);
        settingsGroup.appendChild(delayRow);
        const checkLabel = make("label", { className: "lh-check" });
        const autoMark = make("input", { id: "lh-auto-mark", attrs: { type: "checkbox" } });
        checkLabel.appendChild(autoMark);
        checkLabel.appendChild(make("span", { text: "汇总页生成后自动写入已看记录" }));
        settingsGroup.appendChild(checkLabel);
        panel.appendChild(settingsGroup);

        const metrics = make("div", { className: "lh-metrics" });
        const metric = (key, label) => {
            const box = make("div", { className: "lh-metric" });
            box.appendChild(make("b", { text: "0", data: { lh: key } }));
            box.appendChild(make("span", { text: label }));
            return box;
        };
        metrics.appendChild(metric("page", "页数"));
        metrics.appendChild(metric("scanned", "扫描"));
        metrics.appendChild(metric("collected", "汇总"));
        metrics.appendChild(metric("skipped", "已看跳过"));
        metrics.appendChild(metric("excluded", "排除"));
        metrics.appendChild(metric("history", "历史"));
        panel.appendChild(metrics);

        const actions = make("div", { className: "lh-actions" });
        const startButton = make("button", { className: "lh-primary", text: "开始扫描并生成汇总页", data: { lh: "start" }, attrs: { type: "button" } });
        const stopButton = make("button", { className: "lh-danger", text: "停止并汇总当前结果", data: { lh: "stop" }, attrs: { type: "button" } });
        const exportButton = make("button", { text: "导出历史", data: { lh: "export" }, attrs: { type: "button" } });
        const importButton = make("button", { text: "导入历史", data: { lh: "import" }, attrs: { type: "button" } });
        const clearButton = make("button", { text: "清空历史", data: { lh: "clear" }, attrs: { type: "button" } });
        const saveButton = make("button", { text: "保存设置", data: { lh: "save" }, attrs: { type: "button" } });
        const openLatestSummaryButton = make("button", { text: "打开最近汇总", data: { lh: "open-latest-summary" }, attrs: { type: "button" } });
        const summaryHistoryButton = make("button", { text: "汇总历史", data: { lh: "summary-history" }, attrs: { type: "button" } });
        actions.appendChild(startButton);
        actions.appendChild(stopButton);
        actions.appendChild(openLatestSummaryButton);
        actions.appendChild(summaryHistoryButton);
        actions.appendChild(exportButton);
        actions.appendChild(importButton);
        actions.appendChild(clearButton);
        actions.appendChild(saveButton);
        panel.appendChild(actions);

        const logEl = make("div", { className: "lh-log", data: { lh: "log" } });
        panel.appendChild(logEl);

        host.appendChild(panel);
        document.body.appendChild(host);
        applySidebarLayout(host, panel);

        ui = {
            host,
            doc: document,
            panel,
            status,
            target: targetInput,
            exclude: excludeInput,
            maxPages,
            scrollRounds,
            scrollDelay,
            pageDelay,
            autoMark,
            page: panel.querySelector('[data-lh="page"]'),
            scanned: panel.querySelector('[data-lh="scanned"]'),
            collected: panel.querySelector('[data-lh="collected"]'),
            skipped: panel.querySelector('[data-lh="skipped"]'),
            excluded: panel.querySelector('[data-lh="excluded"]'),
            history: panel.querySelector('[data-lh="history"]'),
            start: startButton,
            stop: stopButton,
            openLatestSummary: openLatestSummaryButton,
            summaryHistory: summaryHistoryButton,
            export: exportButton,
            import: importButton,
            clear: clearButton,
            save: saveButton,
            log: logEl
        };

        ui.target.value = settings.target || "";
        ui.exclude.value = settings.exclude || "";
        ui.maxPages.value = String(toInt(settings.maxPages, DEFAULT_SETTINGS.maxPages));
        ui.scrollRounds.value = String(toInt(settings.scrollRounds, DEFAULT_SETTINGS.scrollRounds));
        ui.scrollDelay.value = String(toFloat(settings.scrollDelaySeconds, DEFAULT_SETTINGS.scrollDelaySeconds));
        ui.pageDelay.value = String(toFloat(settings.pageDelaySeconds, DEFAULT_SETTINGS.pageDelaySeconds));
        ui.autoMark.checked = settings.autoMarkSeen !== false;

        ui.start.addEventListener("click", startScan);
        ui.stop.addEventListener("click", requestStop);
        ui.openLatestSummary.addEventListener("click", openLatestSummary);
        ui.summaryHistory.addEventListener("click", showSummaryHistoryModal);
        ui.export.addEventListener("click", exportHistory);
        ui.import.addEventListener("click", showImportModal);
        ui.clear.addEventListener("click", clearHistory);
        ui.save.addEventListener("click", () => {
            settings = readSettingsFromUI();
            saveSettings(settings);
            log("设置已保存。");
        });

        setRunningUI(false);
        updateCounters();
        log("准备就绪。汇总页生成后，职位不会被逐个打开。");
    }

    function readSettingsFromUI() {
        return {
            target: ui.target.value || "",
            exclude: ui.exclude.value || "",
            maxPages: clampInt(ui.maxPages.value, 0, 99, DEFAULT_SETTINGS.maxPages),
            scrollRounds: clampInt(ui.scrollRounds.value, 4, 60, DEFAULT_SETTINGS.scrollRounds),
            scrollDelaySeconds: clampFloat(ui.scrollDelay.value, 1, 15, DEFAULT_SETTINGS.scrollDelaySeconds),
            pageDelaySeconds: clampFloat(ui.pageDelay.value, 5, 90, DEFAULT_SETTINGS.pageDelaySeconds),
            autoMarkSeen: Boolean(ui.autoMark.checked)
        };
    }

    function loadSettings() {
        const raw = GM_getValue(SETTINGS_KEY, {});
        return Object.assign({}, DEFAULT_SETTINGS, raw || {});
    }

    function saveSettings(nextSettings) {
        GM_setValue(SETTINGS_KEY, nextSettings);
    }

    function loadSummaryHistory() {
        const raw = GM_getValue(SUMMARY_HISTORY_KEY, []);
        const list = Array.isArray(raw) ? raw : [];
        return list
            .map(normalizeSummaryRecord)
            .filter(Boolean)
            .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))
            .slice(0, SUMMARY_HISTORY_LIMIT);
    }

    function normalizeSummaryRecord(record) {
        if (!record || typeof record !== "object") return null;
        const payload = record.payload && typeof record.payload === "object" ? record.payload : record;
        if (!Array.isArray(payload.results)) return null;
        const generatedAt = String(record.generatedAt || payload.generatedAt || new Date().toISOString());
        const stats = payload.stats || {};
        return {
            id: String(record.id || `summary-${generatedAt}-${payload.results.length}`),
            generatedAt,
            title: String(record.title || summaryRecordTitle(payload)),
            count: toInt(record.count ?? stats.collected, payload.results.length),
            page: toInt(record.page ?? stats.page, 0),
            payload
        };
    }

    function saveSummaryHistory() {
        summaryHistory = summaryHistory
            .map(normalizeSummaryRecord)
            .filter(Boolean)
            .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))
            .slice(0, SUMMARY_HISTORY_LIMIT);
        GM_setValue(SUMMARY_HISTORY_KEY, summaryHistory);
        updateSummaryButtons();
    }

    function rememberSummaryPayload(payload) {
        const record = normalizeSummaryRecord({
            id: `summary-${Date.now()}-${randomInt(1000, 9999)}`,
            generatedAt: payload.generatedAt,
            payload
        });
        if (!record) return;
        summaryHistory = [
            record,
            ...summaryHistory.filter((item) => item.id !== record.id)
        ].slice(0, SUMMARY_HISTORY_LIMIT);
        saveSummaryHistory();
        log(`已保存汇总页历史，可用“打开最近汇总”恢复。`);
    }

    function summaryRecordTitle(payload) {
        const stats = payload.stats || {};
        const keywords = payload.settings?.targetRules || [];
        const keywordText = keywords.length ? keywords.slice(0, 3).join(", ") : "全部职位";
        return `${stats.collected ?? payload.results?.length ?? 0} 个结果 · ${keywordText}`;
    }

    function openLatestSummary() {
        if (!summaryHistory.length) {
            log("暂无可恢复的汇总页历史。");
            return;
        }
        openSummaryPayload(summaryHistory[0].payload);
        log(`已打开最近汇总：${summaryHistory[0].title}`);
    }

    function showSummaryHistoryModal() {
        const modalDoc = ui?.doc || document;
        const existing = modalDoc.getElementById("lh-summary-history-modal");
        if (existing) existing.remove();

        const modal = modalDoc.createElement("div");
        modal.id = "lh-summary-history-modal";
        const card = modalDoc.createElement("div");
        const title = modalDoc.createElement("h3");
        title.textContent = `汇总页历史（最近 ${SUMMARY_HISTORY_LIMIT} 次）`;
        const list = modalDoc.createElement("div");
        const actions = modalDoc.createElement("div");
        const closeButton = modalDoc.createElement("button");
        const clearButton = modalDoc.createElement("button");

        closeButton.type = "button";
        closeButton.textContent = "关闭";
        clearButton.type = "button";
        clearButton.textContent = "清空汇总历史";

        card.appendChild(title);
        card.appendChild(list);
        actions.appendChild(clearButton);
        actions.appendChild(closeButton);
        card.appendChild(actions);
        modal.appendChild(card);
        modalDoc.body.appendChild(modal);

        applySummaryHistoryModalLayout(modal, card, title, list, actions);

        if (!summaryHistory.length) {
            const empty = modalDoc.createElement("div");
            empty.textContent = "还没有保存过汇总页。生成一次汇总页后，这里会自动出现记录。";
            setImportantStyles(empty, {
                "padding": "18px",
                "color": "#64748b",
                "background": "#f8fafc",
                "border": "1px solid #e2e8f0",
                "border-radius": "6px"
            });
            list.appendChild(empty);
            clearButton.disabled = true;
        } else {
            for (const record of summaryHistory) {
                list.appendChild(createSummaryHistoryRow(record, modal));
            }
        }

        closeButton.addEventListener("click", () => modal.remove());
        clearButton.addEventListener("click", () => {
            if (!confirm("确定清空保存过的汇总页历史？这不会清空已看职位历史。")) return;
            summaryHistory = [];
            saveSummaryHistory();
            modal.remove();
            log("汇总页历史已清空。");
        });
    }

    function createSummaryHistoryRow(record, modal) {
        const doc = ui?.doc || document;
        const row = doc.createElement("div");
        const info = doc.createElement("div");
        const primary = doc.createElement("div");
        const secondary = doc.createElement("div");
        const openButton = doc.createElement("button");
        const deleteButton = doc.createElement("button");

        primary.textContent = record.title;
        secondary.textContent = `${formatDateTime(record.generatedAt)} · 扫描 ${record.page || 0} 页 · ${record.count || 0} 个结果`;
        openButton.type = "button";
        openButton.textContent = "打开";
        deleteButton.type = "button";
        deleteButton.textContent = "删除";

        info.appendChild(primary);
        info.appendChild(secondary);
        row.appendChild(info);
        row.appendChild(openButton);
        row.appendChild(deleteButton);

        setImportantStyles(row, {
            "display": "grid",
            "grid-template-columns": "minmax(0, 1fr) auto auto",
            "gap": "8px",
            "align-items": "center",
            "padding": "10px",
            "margin-bottom": "8px",
            "background": "#ffffff",
            "border": "1px solid #e2e8f0",
            "border-radius": "6px"
        });
        setImportantStyles(primary, {
            "font-weight": "800",
            "color": "#111827",
            "overflow": "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap"
        });
        setImportantStyles(secondary, {
            "margin-top": "3px",
            "color": "#64748b",
            "font-size": "12px"
        });
        for (const button of [openButton, deleteButton]) {
            setImportantStyles(button, {
                "display": "inline-flex",
                "align-items": "center",
                "justify-content": "center",
                "min-height": "30px",
                "padding": "6px 10px",
                "border": "1px solid #cbd5e1",
                "border-radius": "5px",
                "background": "#ffffff",
                "color": "#111827",
                "cursor": "pointer",
                "font-size": "12px",
                "font-weight": "700"
            });
        }

        openButton.addEventListener("click", () => {
            openSummaryPayload(record.payload);
            modal.remove();
            log(`已从历史打开汇总：${record.title}`);
        });
        deleteButton.addEventListener("click", () => {
            summaryHistory = summaryHistory.filter((item) => item.id !== record.id);
            saveSummaryHistory();
            modal.remove();
            showSummaryHistoryModal();
        });

        return row;
    }

    function applySummaryHistoryModalLayout(modal, card, title, list, actions) {
        setImportantStyles(modal, {
            "position": "fixed",
            "inset": "0",
            "z-index": "2147483647",
            "display": "flex",
            "align-items": "center",
            "justify-content": "center",
            "padding": "24px",
            "background": "rgba(15, 23, 42, 0.45)"
        });
        setImportantStyles(card, {
            "display": "block",
            "width": "min(760px, calc(100vw - 48px))",
            "max-height": "min(720px, calc(100vh - 48px))",
            "overflow-y": "auto",
            "padding": "16px",
            "background": "#ffffff",
            "border-radius": "8px",
            "box-shadow": "0 18px 50px rgba(15, 23, 42, 0.3)",
            "font": "13px/1.45 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
            "box-sizing": "border-box"
        });
        setImportantStyles(title, {
            "display": "block",
            "margin": "0 0 12px",
            "font-size": "16px",
            "font-weight": "800",
            "color": "#111827"
        });
        setImportantStyles(list, {
            "display": "block",
            "max-height": "520px",
            "overflow-y": "auto",
            "margin-bottom": "12px"
        });
        setImportantStyles(actions, {
            "display": "flex",
            "justify-content": "flex-end",
            "gap": "8px"
        });
        for (const button of actions.querySelectorAll("button")) {
            setImportantStyles(button, {
                "display": "inline-flex",
                "align-items": "center",
                "justify-content": "center",
                "min-height": "32px",
                "padding": "7px 12px",
                "border": "1px solid #cbd5e1",
                "border-radius": "5px",
                "background": "#ffffff",
                "color": "#111827",
                "cursor": "pointer",
                "font-size": "12px",
                "font-weight": "700"
            });
        }
    }

    function formatDateTime(value) {
        try {
            return new Date(value).toLocaleString("zh-CN", { hour12: false });
        } catch (err) {
            return String(value || "");
        }
    }

    function emptyHistory() {
        return {
            schema: "linkedin-helper-history",
            version: 3,
            updatedAt: new Date().toISOString(),
            jobs: {},
            aliases: {}
        };
    }

    function loadHistory() {
        const store = normalizeHistoryStore(GM_getValue(HISTORY_KEY, null));
        const legacy = GM_getValue(LEGACY_HISTORY_KEY, []);
        let changed = false;

        if (Array.isArray(legacy) && legacy.length) {
            for (const legacyKey of legacy) {
                const fpKey = normalizeHistoryKey(legacyKey);
                if (!fpKey || store.jobs[fpKey]) continue;
                store.jobs[fpKey] = {
                    key: fpKey,
                    title: "",
                    company: "",
                    location: "",
                    link: "",
                    jobId: "",
                    firstSeen: "",
                    lastSeen: "",
                    source: "legacy-v18"
                };
                store.aliases[fpKey] = fpKey;
                changed = true;
            }
        }

        if (changed) saveHistory(store);
        hydrateStrongHistoryAliases(store);
        return store;
    }

    function normalizeHistoryStore(raw) {
        let input = raw;
        if (typeof input === "string") {
            try {
                input = JSON.parse(input);
            } catch (err) {
                input = null;
            }
        }
        if (input && input.history) input = input.history;

        const store = emptyHistory();

        if (Array.isArray(input)) {
            for (const item of input) {
                const key = normalizeHistoryKey(item);
                if (!key) continue;
                store.jobs[key] = {
                    key,
                    title: "",
                    company: "",
                    location: "",
                    link: "",
                    jobId: "",
                    firstSeen: "",
                    lastSeen: "",
                    source: "array-import"
                };
                store.aliases[key] = key;
            }
            return store;
        }

        if (!input || typeof input !== "object") return store;

        if (input.jobs && typeof input.jobs === "object") {
            for (const [key, record] of Object.entries(input.jobs)) {
                const cleanKey = normalizeHistoryKey(key || record?.key);
                if (!cleanKey) continue;
                store.jobs[cleanKey] = normalizeHistoryRecord(cleanKey, record);
                store.aliases[cleanKey] = cleanKey;
            }
        }

        if (input.entries && typeof input.entries === "object") {
            for (const [key, record] of Object.entries(input.entries)) {
                const cleanKey = normalizeHistoryKey(key || record?.key);
                if (!cleanKey || store.jobs[cleanKey]) continue;
                store.jobs[cleanKey] = normalizeHistoryRecord(cleanKey, record);
                store.aliases[cleanKey] = cleanKey;
            }
        }

        if (input.aliases && typeof input.aliases === "object") {
            for (const [alias, target] of Object.entries(input.aliases)) {
                const cleanAlias = normalizeHistoryKey(alias);
                const cleanTarget = normalizeHistoryKey(target);
                if (!cleanAlias || !cleanTarget || !store.jobs[cleanTarget]) continue;
                store.aliases[cleanAlias] = cleanTarget;
            }
        }

        return store;
    }

    function normalizeHistoryRecord(key, record) {
        const data = record && typeof record === "object" ? record : {};
        return {
            key,
            title: String(data.title || ""),
            company: String(data.company || ""),
            location: String(data.location || ""),
            link: String(data.link || ""),
            jobId: String(data.jobId || ""),
            firstSeen: String(data.firstSeen || data.createdAt || ""),
            lastSeen: String(data.lastSeen || data.updatedAt || ""),
            source: String(data.source || "import")
        };
    }

    function hydrateStrongHistoryAliases(store) {
        for (const [key, record] of Object.entries(store.jobs || {})) {
            const target = normalizeHistoryKey(key);
            if (!target) continue;
            for (const strongKey of strongHistoryKeysForJob(record)) {
                if (!store.aliases[strongKey]) store.aliases[strongKey] = target;
            }
        }
    }

    function saveHistory(store = historyStore) {
        store.updatedAt = new Date().toISOString();
        GM_setValue(HISTORY_KEY, store);
        updateCounters();
    }

    function historyCount() {
        return Object.keys(historyStore.jobs || {}).length;
    }

    function exportHistory() {
        const pack = {
            schema: "linkedin-helper-history-pack",
            version: 3,
            exportedAt: new Date().toISOString(),
            history: historyStore
        };
        const text = JSON.stringify(pack, null, 2);

        try {
            GM_setClipboard(text, "text");
            log(`历史记录包已复制，可在另一台设备点“导入历史”粘贴。记录数：${historyCount()}`);
        } catch (err) {
            showTextModal("复制失败，请手动复制下面内容", text);
        }
    }

    function showImportModal() {
        showTextModal("粘贴另一台设备导出的历史记录包", "", (text) => {
            let parsed = null;
            try {
                parsed = JSON.parse(text);
            } catch (err) {
                alert("导入失败：不是有效 JSON。");
                return false;
            }

            const incoming = normalizeHistoryStore(parsed);
            const before = historyCount();
            mergeHistory(historyStore, incoming);
            saveHistory(historyStore);
            log(`历史导入完成，新增 ${Math.max(0, historyCount() - before)} 条。`);
            return true;
        });
    }

    function showTextModal(title, initialText, onConfirm) {
        const modalDoc = ui?.doc || document;
        const modalRoot = modalDoc.body || document.body;
        const existing = modalDoc.getElementById("lh-history-modal");
        if (existing) existing.remove();

        const modal = modalDoc.createElement("div");
        modal.id = "lh-history-modal";
        modal.innerHTML = `
            <div class="lh-modal-card">
                <h3 style="margin:0 0 6px;font-size:16px;">${escapeHtml(title)}</h3>
                <textarea></textarea>
                <div class="lh-modal-actions">
                    <button data-modal="cancel">取消</button>
                    <button data-modal="confirm">确定</button>
                </div>
            </div>
        `;
        const textarea = modal.querySelector("textarea");
        textarea.value = initialText || "";
        modalRoot.appendChild(modal);
        applyModalLayout(modal);
        textarea.focus();
        textarea.select();

        modal.querySelector('[data-modal="cancel"]').addEventListener("click", () => modal.remove());
        modal.querySelector('[data-modal="confirm"]').addEventListener("click", () => {
            if (!onConfirm || onConfirm(textarea.value)) modal.remove();
        });
    }

    function mergeHistory(target, incoming) {
        for (const [key, record] of Object.entries(incoming.jobs || {})) {
            const cleanKey = normalizeHistoryKey(key);
            if (!cleanKey) continue;
            if (!target.jobs[cleanKey]) {
                target.jobs[cleanKey] = normalizeHistoryRecord(cleanKey, record);
            } else {
                target.jobs[cleanKey] = mergeHistoryRecord(target.jobs[cleanKey], record);
            }
            if (!target.aliases[cleanKey]) target.aliases[cleanKey] = cleanKey;
        }

        for (const [alias, targetKey] of Object.entries(incoming.aliases || {})) {
            const cleanAlias = normalizeHistoryKey(alias);
            const cleanTarget = normalizeHistoryKey(targetKey);
            if (!cleanAlias || !cleanTarget || !target.jobs[cleanTarget]) continue;
            target.aliases[cleanAlias] = cleanTarget;
        }
    }

    function mergeHistoryRecord(current, incoming) {
        const next = Object.assign({}, current);
        for (const field of ["title", "company", "location", "link", "jobId", "source"]) {
            if (!next[field] && incoming && incoming[field]) next[field] = String(incoming[field]);
        }
        if (incoming && incoming.firstSeen) {
            if (!next.firstSeen || incoming.firstSeen < next.firstSeen) next.firstSeen = String(incoming.firstSeen);
        }
        if (incoming && incoming.lastSeen) {
            if (!next.lastSeen || incoming.lastSeen > next.lastSeen) next.lastSeen = String(incoming.lastSeen);
        }
        return next;
    }

    function clearHistory() {
        if (!confirm("确定清空已看历史记录？此操作不会影响当前 LinkedIn 页面。")) return;
        historyStore = emptyHistory();
        saveHistory(historyStore);
        log("历史记录已清空。");
    }

    async function startScan() {
        if (scanState.running) return;
        agentScanFailure = null;

        settings = readSettingsFromUI();
        if (!agentTask) saveSettings(settings);

        scanState = createScanState();
        scanState.running = true;
        scanState.startedAt = new Date().toISOString();
        setRunningUI(true);
        clearLog();
        updateCounters();

        const targetRules = parseRules(settings.target);
        const excludeRules = parseRules(settings.exclude);
        log(`开始扫描。包含词 ${targetRules.length || "不限"} 个，排除词 ${excludeRules.length} 个。`);
        log(`慢速模式：滚动等待约 ${settings.scrollDelaySeconds}-${Math.round(settings.scrollDelaySeconds * 1.7)} 秒，翻页冷却约 ${settings.pageDelaySeconds}-${Math.round(settings.pageDelaySeconds * 1.7)} 秒。`);

        try {
            await scanAllPages(targetRules, excludeRules);
        } catch (err) {
            agentScanFailure = err;
            log(`扫描中断：${err.message || err}`);
        } finally {
            scanState.endedAt = new Date().toISOString();
            scanState.running = false;
            setRunningUI(false);
            updateCounters();
            finishWithSummary(targetRules, excludeRules);
        }
    }

    function requestStop() {
        if (!scanState.running) return;
        scanState.stopRequested = true;
        scanState.running = false;
        setStatus("停止中");
        log("收到停止请求，将汇总已经收集到的结果。");
    }

    async function scanAllPages(targetRules, excludeRules) {
        while (scanState.running) {
            scanState.page += 1;
            updateCounters();

            const scroller = findJobScroller();
            if (!scroller) {
                log("没有找到职位列表滚动区域。请确认当前页是 LinkedIn Jobs 搜索结果页。");
                break;
            }

            log(`扫描第 ${scanState.page} 页。`);
            await scanCurrentPage(scroller, targetRules, excludeRules);

            if (!scanState.running) break;

            const maxPages = toInt(settings.maxPages, 0);
            if (maxPages > 0 && scanState.page >= maxPages) {
                log(`已达到最大页数 ${maxPages}。`);
                break;
            }

            const nextButton = findNextButton();
            if (!nextButton) {
                log("没有找到下一页按钮，扫描结束。");
                break;
            }

            const beforePageState = getPageState();
            log("进入下一页。");
            await agentBeforePlatformAccess("LinkedIn 下一页");
            nextButton.scrollIntoView({ block: "center", behavior: "smooth" });
            await sleep(jitterMs(1.2, 0.8));
            nextButton.click();
            const didAdvance = await waitForPageChange(beforePageState, 16000);
            if (!didAdvance) {
                log("⚠️ 点击下一页后页面没有变化，已停止以避免重复扫描同一页。");
                break;
            }
            const pageCooldownMs = jitterMs(settings.pageDelaySeconds, 0.7);
            log(`翻页成功，冷却 ${formatSeconds(pageCooldownMs)} 秒后继续。`);
            await sleep(pageCooldownMs);
        }
    }

    async function scanCurrentPage(scroller, targetRules, excludeRules) {
        const rounds = toInt(settings.scrollRounds, DEFAULT_SETTINGS.scrollRounds);
        let unchanged = 0;
        let lastTop = -1;

        try {
            scroller.scrollTop = 0;
        } catch (err) {
            window.scrollTo(0, 0);
        }
        await sleep(jitterMs(1, 0.7));

        for (let round = 0; round <= rounds && scanState.running; round += 1) {
            const before = scanState.collected;
            collectVisibleJobs(scroller, targetRules, excludeRules);
            const added = scanState.collected - before;
            if (added > 0) log(`第 ${scanState.page} 页收集到 ${added} 个新结果。`);

            const step = Math.max(500, Math.floor((scroller.clientHeight || window.innerHeight) * 0.86));
            try {
                scroller.scrollBy(0, step);
            } catch (err) {
                window.scrollBy(0, step);
            }

            await sleep(jitterMs(settings.scrollDelaySeconds, 0.7));

            const currentTop = getScrollTop(scroller);
            if (currentTop === lastTop) {
                unchanged += 1;
                if (unchanged >= 2) break;
            } else {
                unchanged = 0;
                lastTop = currentTop;
            }
        }

        collectVisibleJobs(scroller, targetRules, excludeRules);
    }

    function collectVisibleJobs(scroller, targetRules, excludeRules) {
        const anchors = Array.from(scroller.querySelectorAll('a[href*="/jobs/view"], a[href*="currentJobId"]'));
        for (const anchor of anchors) {
            const candidate = readJobCandidate(anchor);
            if (!candidate) continue;

           const sessionKey = canonicalSessionKey(candidate);
            if (sessionKey && scanState.processedKeys.has(sessionKey)) {
                scanState.duplicates += 1;
                continue;
            }
            if (sessionKey) scanState.processedKeys.add(sessionKey);

            scanState.scanned += 1;

            const matchInfo = classifyJob(candidate, targetRules, excludeRules);
            if (!matchInfo.hasTarget) {
                updateCounters();
                continue;
            }

            scanState.matched += 1;
            if (matchInfo.excludedKeywords.length) {
                scanState.excluded += 1;
                updateCounters();
                continue;
            }

            if (isSeen(candidate)) {
                scanState.skippedSeen += 1;
                updateCounters();
                continue;
            }

            const result = Object.assign({}, candidate, {
                matchedKeywords: matchInfo.matchedKeywords,
                primaryKeyword: matchInfo.primaryKeyword,
                excludedKeywords: matchInfo.excludedKeywords,
                page: scanState.page
            });

            const resultKey = sessionKey || `unkeyed:${scanState.page}:${scanState.scanned}`;
            scanState.resultMap.set(resultKey, result);
            scanState.collected = scanState.resultMap.size;
            updateCounters();
        }
    }

    function readJobCandidate(anchor) {
        const href = anchor.href || anchor.getAttribute("href") || "";
        if (!href) return null;

        const card = anchor.closest(".job-card-container, .jobs-search-results__list-item, li, [data-job-id]") || anchor;
        const jobId = getJobId(href, card);
        const link = canonicalJobLink(href, jobId);
        const title = cleanTitle(extractTitle(anchor, card));
        if (!title || normalizeText(title).length < 3) return null;

        const meta = getJobMeta(card);
        return {
            title,
            titleZh: translateJobTitle(title),
            link,
            rawHref: href,
            jobId,
            company: meta.company,
            location: meta.location,
            listedAt: meta.listedAt
        };
    }

    function extractTitle(anchor, card) {
        const preferred = [
            anchor.querySelector(".job-card-list__title"),
            anchor.querySelector(".job-card-container__link"),
            anchor.querySelector("strong"),
            card.querySelector(".job-card-list__title"),
            card.querySelector(".job-card-container__link"),
            card.querySelector('[class*="job-card-list__title"]')
        ].find(Boolean);

        const raw = textOf(preferred || anchor);
        const lines = raw.split(/\n+/)
            .map((line) => line.replace(/\s+/g, " ").trim())
            .filter(Boolean);

        return lines.find((line) => !BAD_TITLE_LINES.has(normalizeText(line))) || lines[0] || "";
    }

    function cleanTitle(title) {
        return String(title || "")
            .replace(/\bPromoted\b/gi, "")
            .replace(/\bViewed\b/gi, "")
            .replace(/\bEasy Apply\b/gi, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    function translateJobTitle(title) {
        const source = cleanTitle(title);
        if (!source) return "";

        const normalized = normalizeText(source)
            .replace(/[()［］[\]{}]/g, " ")
            .replace(/[\/|&,+-]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        const phraseRules = [
            [/expression of interest|eoi/g, "意向申请"],
            [/graduate program|graduate programme/g, "毕业生项目"],
            [/graduate role/g, "毕业生职位"],
            [/summer internship/g, "暑期实习"],
            [/winter internship/g, "冬季实习"],
            [/software engineer/g, "软件工程师"],
            [/software developer/g, "软件开发工程师"],
            [/full stack engineer|fullstack engineer/g, "全栈工程师"],
            [/full stack developer|fullstack developer/g, "全栈开发工程师"],
            [/front end engineer|frontend engineer/g, "前端工程师"],
            [/front end developer|frontend developer/g, "前端开发工程师"],
            [/back end engineer|backend engineer/g, "后端工程师"],
            [/back end developer|backend developer/g, "后端开发工程师"],
            [/data analyst/g, "数据分析师"],
            [/business analyst/g, "业务分析师"],
            [/data scientist/g, "数据科学家"],
            [/machine learning engineer/g, "机器学习工程师"],
            [/artificial intelligence engineer|ai engineer/g, "人工智能工程师"],
            [/cloud engineer/g, "云工程师"],
            [/devops engineer/g, "DevOps 工程师"],
            [/platform engineer/g, "平台工程师"],
            [/site reliability engineer|sre/g, "站点可靠性工程师"],
            [/cyber security analyst|cybersecurity analyst/g, "网络安全分析师"],
            [/cyber security engineer|cybersecurity engineer/g, "网络安全工程师"],
            [/security analyst/g, "安全分析师"],
            [/security engineer/g, "安全工程师"],
            [/quality assurance engineer|qa engineer/g, "质量保障工程师"],
            [/test engineer/g, "测试工程师"],
            [/automation engineer/g, "自动化工程师"],
            [/systems engineer|system engineer/g, "系统工程师"],
            [/network engineer/g, "网络工程师"],
            [/database administrator|dba/g, "数据库管理员"],
            [/product manager/g, "产品经理"],
            [/project manager/g, "项目经理"],
            [/program manager/g, "项目群经理"],
            [/scrum master/g, "敏捷教练"],
            [/ux designer/g, "用户体验设计师"],
            [/ui designer/g, "用户界面设计师"],
            [/product designer/g, "产品设计师"],
            [/civil engineer/g, "土木工程师"],
            [/electrical engineer/g, "电气工程师"],
            [/mechanical engineer/g, "机械工程师"],
            [/structural engineer/g, "结构工程师"],
            [/process engineer/g, "流程工程师"],
            [/accountant/g, "会计"],
            [/financial analyst/g, "财务分析师"],
            [/finance analyst/g, "金融分析师"],
            [/marketing coordinator/g, "市场协调员"],
            [/marketing specialist/g, "市场专员"],
            [/sales representative/g, "销售代表"],
            [/sales consultant/g, "销售顾问"],
            [/customer success manager/g, "客户成功经理"],
            [/customer service representative/g, "客户服务代表"],
            [/operations analyst/g, "运营分析师"],
            [/operations coordinator/g, "运营协调员"],
            [/human resources|hr/g, "人力资源"],
            [/talent acquisition/g, "招聘"],
            [/recruitment consultant/g, "招聘顾问"]
        ];

        const tokenMap = new Map([
            ["graduate", "毕业生"],
            ["internship", "实习"],
            ["intern", "实习生"],
            ["entry", "入门级"],
            ["level", "级别"],
            ["junior", "初级"],
            ["associate", "助理"],
            ["assistant", "助理"],
            ["senior", "高级"],
            ["lead", "负责人"],
            ["principal", "首席"],
            ["manager", "经理"],
            ["specialist", "专员"],
            ["consultant", "顾问"],
            ["coordinator", "协调员"],
            ["administrator", "管理员"],
            ["analyst", "分析师"],
            ["engineer", "工程师"],
            ["developer", "开发工程师"],
            ["designer", "设计师"],
            ["architect", "架构师"],
            ["scientist", "科学家"],
            ["technician", "技术员"],
            ["officer", "专员"],
            ["representative", "代表"],
            ["advisor", "顾问"],
            ["data", "数据"],
            ["business", "业务"],
            ["software", "软件"],
            ["hardware", "硬件"],
            ["backend", "后端"],
            ["frontend", "前端"],
            ["mobile", "移动端"],
            ["web", "网页"],
            ["cloud", "云"],
            ["network", "网络"],
            ["security", "安全"],
            ["cyber", "网络安全"],
            ["digital", "数字化"],
            ["product", "产品"],
            ["project", "项目"],
            ["program", "项目"],
            ["operations", "运营"],
            ["marketing", "市场"],
            ["sales", "销售"],
            ["finance", "金融"],
            ["financial", "财务"],
            ["accounting", "会计"],
            ["account", "客户"],
            ["customer", "客户"],
            ["support", "支持"],
            ["service", "服务"],
            ["risk", "风险"],
            ["compliance", "合规"],
            ["civil", "土木"],
            ["electrical", "电气"],
            ["mechanical", "机械"],
            ["structural", "结构"],
            ["environmental", "环境"],
            ["process", "流程"],
            ["research", "研究"],
            ["development", "开发"],
            ["automation", "自动化"],
            ["quality", "质量"],
            ["assurance", "保障"],
            ["test", "测试"],
            ["testing", "测试"],
            ["systems", "系统"],
            ["system", "系统"],
            ["database", "数据库"],
            ["analytics", "分析"],
            ["intelligence", "智能"],
            ["machine", "机器"],
            ["learning", "学习"],
            ["artificial", "人工"],
            ["ai", "AI"],
            ["ux", "用户体验"],
            ["ui", "用户界面"],
            ["remote", "远程"],
            ["hybrid", "混合办公"],
            ["contract", "合同工"],
            ["casual", "临时工"],
            ["part", "兼职"],
            ["time", "时间"],
            ["full", "全职"]
        ]);

        let phraseText = normalized;
        const phraseTranslations = [];
        for (const [pattern, translation] of phraseRules) {
            pattern.lastIndex = 0;
            if (pattern.test(phraseText)) {
                phraseTranslations.push(translation);
                pattern.lastIndex = 0;
                phraseText = phraseText.replace(pattern, " ");
            }
        }

        const tokenTranslations = phraseText
            .split(/\s+/)
            .map((token) => token.replace(/[^a-z0-9#.+]/g, ""))
            .filter(Boolean)
            .map((token) => tokenMap.get(token) || keepTechnicalToken(token))
            .filter(Boolean);

        const translated = Array.from(new Set([...phraseTranslations, ...tokenTranslations]))
            .join(" · ")
            .replace(/兼职 · 时间/g, "兼职")
            .replace(/全职 · 时间/g, "全职")
            .trim();

        return translated ? `中文参考：${translated}` : "";
    }

    function keepTechnicalToken(token) {
        const known = new Set(["c", "c++", "c#", "java", "javascript", "typescript", "python", "go", "golang", "rust", "sql", "react", "angular", "vue", "node", "nodejs", "aws", "azure", "gcp", "sap", "salesforce"]);
        if (known.has(token)) return token.toUpperCase();
        return "";
    }

    function getJobMeta(card) {
        const company = firstText(card, [
            ".artdeco-entity-lockup__subtitle",
            ".job-card-container__primary-description",
            ".base-search-card__subtitle",
            '[class*="company-name"]'
        ]);
        const location = firstText(card, [
            ".artdeco-entity-lockup__caption",
            ".job-card-container__metadata-item",
            ".base-search-card__metadata",
            '[class*="metadata"]'
        ]);
        const listedAt = firstText(card, [
            "time",
            ".job-card-container__listed-time",
            '[class*="listed-time"]'
        ]);

        return {
            company: company || "Unknown company",
            location: location || "Unknown location",
            listedAt: listedAt || ""
        };
    }

    function firstText(root, selectors) {
        for (const selector of selectors) {
            const el = root.querySelector(selector);
            const text = textOf(el);
            if (text) return text.replace(/\s+/g, " ").trim();
        }
        return "";
    }

    function textOf(el) {
        return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";
    }

    function classifyJob(job, targetRules, excludeRules) {
        const haystack = normalizeText(`${job.title} ${job.company} ${job.location}`);
        const matchedKeywords = targetRules.length
            ? targetRules.filter((keyword) => haystack.includes(keyword))
            : ["全部职位"];
        const excludedKeywords = excludeRules.filter((keyword) => haystack.includes(keyword));

        return {
            hasTarget: matchedKeywords.length > 0,
            matchedKeywords,
            primaryKeyword: matchedKeywords[0] || "未归类",
            excludedKeywords
        };
    }

    function findJobScroller() {
        const preferred = [
            ".jobs-search-results-list",
            ".jobs-search-results__list",
            ".scaffold-layout__list",
            ".jobs-search-results"
        ];
        for (const selector of preferred) {
            const el = document.querySelector(selector);
            const scrollable = findScrollableAncestor(el || null, 3);
            if (scrollable) return scrollable;
        }

        const sample = document.querySelector(".job-card-container, .jobs-search-results__list-item, [data-job-id]");
        const fromSample = findScrollableAncestor(sample || null, 10);
        if (fromSample) return fromSample;

        return document.scrollingElement || document.documentElement;
    }

    function findScrollableAncestor(el, depth) {
        let current = el;
        let remaining = depth;
        while (current && remaining >= 0) {
            if (current.scrollHeight > current.clientHeight + 80) {
                const style = window.getComputedStyle(current);
                if (/auto|scroll|overlay/i.test(style.overflowY) || current === document.scrollingElement) {
                    return current;
                }
            }
            current = current.parentElement;
            remaining -= 1;
        }
        return null;
    }

    function findNextButton() {
        const paginationRoots = Array.from(document.querySelectorAll([
            ".jobs-search-pagination",
            "#jobs-search-results-footer",
            ".artdeco-pagination",
            "nav[aria-label*='pagination' i]",
            "nav[aria-label*='分页' i]"
        ].join(",")));

        const roots = paginationRoots.length ? paginationRoots : [document];
        const buttons = roots.flatMap((root) => Array.from(root.querySelectorAll("button")));
        return buttons.find((button) => {
            if (button.disabled || button.getAttribute("aria-disabled") === "true") return false;
            const label = normalizeText(`${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`);
            return /\bnext\b/.test(label) || label.includes("下一页");
        }) || null;
    }

    function getPageState() {
        return {
            url: location.href,
            activePage: getActivePaginationLabel(),
            signature: getPageSignature()
        };
    }

    function getPageSignature() {
        const scroller = findJobScroller();
        const root = scroller || document;
        const cards = Array.from(root.querySelectorAll('a[href*="/jobs/view"], a[href*="currentJobId"]')).slice(0, 12);
        return cards.map((anchor) => {
            const id = getJobId(anchor.href || anchor.getAttribute("href") || "", anchor);
            const text = normalizeText(anchor.textContent || "");
            return id || text;
        }).filter(Boolean).join("|");
    }

    function getActivePaginationLabel() {
        const candidates = Array.from(document.querySelectorAll([
            "button[aria-current='page']",
            "button[aria-current='true']",
            "[aria-current='page'] button",
            "[aria-current='true'] button",
            ".artdeco-pagination__indicator--number.active button",
            ".artdeco-pagination__indicator--number--active button",
            ".active button"
        ].join(",")));

        const current = candidates.find((el) => {
            const text = normalizeText(el.textContent || el.getAttribute("aria-label") || "");
            return text && /\d+/.test(text);
        });
        if (current) return normalizeText(current.textContent || current.getAttribute("aria-label") || "");

        const selected = Array.from(document.querySelectorAll("button")).find((button) => {
            const label = normalizeText(`${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`);
            const pressed = button.getAttribute("aria-pressed") === "true";
            const selectedAttr = button.getAttribute("aria-selected") === "true";
            return (pressed || selectedAttr) && /\d+/.test(label);
        });
        return selected ? normalizeText(selected.textContent || selected.getAttribute("aria-label") || "") : "";
    }

    async function waitForPageChange(beforeState, timeoutMs) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs && scanState.running) {
            await sleep(500);
            const currentState = getPageState();
            if (currentState.url !== beforeState.url) return true;
            if (beforeState.activePage && currentState.activePage && currentState.activePage !== beforeState.activePage) return true;
            if (currentState.signature && currentState.signature !== beforeState.signature) return true;
        }
        return false;
    }

    function finishWithSummary(targetRules, excludeRules) {
        const results = Array.from(scanState.resultMap.values()).sort(compareResults);
        scanState.collected = results.length;

        if (results.length && settings.autoMarkSeen) {
            for (const result of results) markSeen(result, "summary-generated");
            saveHistory(historyStore);
            log(`已把本次 ${results.length} 个汇总结果写入已看记录。`);
        }

        updateCounters();
        void agentReportSummary({
            results,
            stats: {
                page: scanState.page,
                scanned: scanState.scanned,
                matched: scanState.matched,
                collected: results.length,
                skippedSeen: scanState.skippedSeen,
                excluded: scanState.excluded,
                duplicates: scanState.duplicates
            }
        });
        if (agentTask) {
            setStatus(`正在向 Job Agent 上传 ${results.length} 个职位...`);
            agentShowOverlay("正在上传职位", `已完成扫描，正在上传 ${results.length} 个职位。请勿关闭或操作此窗口。`);
            log(`扫描完成，正在向 Job Agent 上传 ${results.length} 个职位。`);
            return;
        }
        openSummaryPage(results, targetRules, excludeRules);
        log(`汇总页已生成。结果 ${results.length} 个，已看跳过 ${scanState.skippedSeen} 个。`);
    }

    function compareResults(a, b) {
        const locale = navigator.language || "zh-Hans-CN";
        return String(a.primaryKeyword || "").localeCompare(String(b.primaryKeyword || ""), locale)
            || String(a.title || "").localeCompare(String(b.title || ""), locale)
            || String(a.company || "").localeCompare(String(b.company || ""), locale);
    }

    function openSummaryPage(results, targetRules, excludeRules) {
        const payload = {
            appVersion: APP_VERSION,
            generatedAt: new Date().toISOString(),
            settings: {
                targetRules,
                excludeRules,
                autoMarkSeen: settings.autoMarkSeen
            },
            stats: {
                page: scanState.page,
                scanned: scanState.scanned,
                matched: scanState.matched,
                collected: results.length,
                skippedSeen: scanState.skippedSeen,
                excluded: scanState.excluded,
                duplicates: scanState.duplicates,
                historyCount: historyCount(),
                startedAt: scanState.startedAt,
                endedAt: scanState.endedAt
            },
            results
        };

        rememberSummaryPayload(payload);
        openSummaryPayload(payload);
    }

    function openSummaryPayload(payload) {
        const html = buildSummaryHtml(payload);
        const blob = new Blob([html], { type: "text/html;charset=utf-8" });
        const url = URL.createObjectURL(blob);

        try {
            GM_openInTab(url, { active: true, insert: true });
        } catch (err) {
            const opened = window.open(url, "_blank", "noopener,noreferrer");
            if (!opened) showTextModal("汇总页被浏览器拦截，请复制下面地址手动打开", url);
        }
    }

    function buildSummaryHtml(payload) {
        const dataJson = JSON.stringify(payload)
            .replace(/</g, "\\u003c")
            .replace(/\u2028/g, "\\u2028")
            .replace(/\u2029/g, "\\u2029");

        return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LinkedIn 职位筛选汇总</title>
<style>
    :root {
        color-scheme: light;
        --ink: #111827;
        --muted: #64748b;
        --line: #d7dde7;
        --surface: #ffffff;
        --soft: #f6f8fb;
        --accent: #0f766e;
        --accent-soft: #ccfbf1;
    }
    * { box-sizing: border-box; }
    body {
        margin: 0;
        color: var(--ink);
        background: #eef2f7;
        font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
        padding: 28px max(24px, calc((100vw - 1120px) / 2)) 18px;
        background: #ffffff;
        border-bottom: 1px solid var(--line);
    }
    h1 {
        margin: 0 0 8px;
        font-size: clamp(22px, 3vw, 34px);
        line-height: 1.15;
        letter-spacing: 0;
    }
    .subtle { color: var(--muted); }
    .wrap {
        width: min(1120px, calc(100vw - 32px));
        margin: 18px auto 40px;
    }
    .stats {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: 8px;
        margin-top: 18px;
    }
    .stat {
        padding: 10px;
        background: var(--soft);
        border: 1px solid var(--line);
        border-radius: 7px;
    }
    .stat b {
        display: block;
        font-size: 20px;
        line-height: 1.1;
    }
    .stat span {
        display: block;
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
        white-space: nowrap;
    }
    .toolbar {
        display: grid;
        grid-template-columns: minmax(220px, 1fr) auto auto;
        gap: 8px;
        align-items: center;
        margin: 0 0 12px;
    }
    input[type="search"] {
        width: 100%;
        min-height: 38px;
        padding: 8px 11px;
        color: var(--ink);
        background: #ffffff;
        border: 1px solid var(--line);
        border-radius: 6px;
        font: inherit;
    }
    button {
        min-height: 38px;
        padding: 8px 12px;
        border: 1px solid var(--line);
        border-radius: 6px;
        color: var(--ink);
        background: #ffffff;
        cursor: pointer;
        font: 700 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button:hover { background: var(--soft); }
    .keyword-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 16px;
    }
    .keyword-bar button.is-active {
        color: #064e3b;
        background: var(--accent-soft);
        border-color: #5eead4;
    }
    section {
        margin-top: 18px;
    }
    section h2 {
        display: flex;
        align-items: baseline;
        gap: 8px;
        margin: 0 0 8px;
        font-size: 18px;
        letter-spacing: 0;
    }
    section h2 span {
        color: var(--muted);
        font-size: 12px;
        font-weight: 600;
    }
    .job {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: start;
        padding: 13px 14px;
        margin-bottom: 8px;
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 7px;
    }
    .title {
        color: #0f3f8c;
        font-size: 16px;
        font-weight: 800;
        text-decoration: none;
    }
    .title:hover { text-decoration: underline; }
    .title-zh {
        margin-top: 3px;
        color: #334155;
        font-size: 14px;
        font-weight: 700;
    }
    .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 5px;
        color: var(--muted);
        font-size: 13px;
    }
    .tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 8px;
    }
    .tag {
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 3px 7px;
        color: #155e75;
        background: #e0f2fe;
        border: 1px solid #bae6fd;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
    }
    .open-link {
        white-space: nowrap;
        color: #ffffff;
        background: var(--accent);
        border-color: var(--accent);
        text-decoration: none;
        padding: 8px 11px;
        border-radius: 6px;
        font-weight: 800;
    }
    .open-link:hover { background: #115e59; }
    .empty {
        padding: 24px;
        text-align: center;
        color: var(--muted);
        background: #ffffff;
        border: 1px solid var(--line);
        border-radius: 7px;
    }
    @media (max-width: 780px) {
        header { padding-top: 22px; }
        .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .toolbar { grid-template-columns: 1fr; }
        .job { grid-template-columns: 1fr; }
        .open-link { justify-self: start; }
    }
</style>
</head>
<body>
<header>
    <h1>LinkedIn 职位筛选汇总</h1>
    <div class="subtle" id="summary-line"></div>
    <div class="stats" id="stats"></div>
</header>
<main class="wrap">
    <div class="toolbar">
        <input id="search" type="search" placeholder="搜索 title、company、location 或关键词">
        <button id="copy-links">复制链接</button>
        <button id="download-json">下载 JSON</button>
    </div>
    <div class="keyword-bar" id="keywords"></div>
    <div class="subtle" id="count-line"></div>
    <div id="results"></div>
</main>
<script>
const payload = ${dataJson};
const state = { keyword: "all", query: "" };
const resultRoot = document.getElementById("results");
const keywordRoot = document.getElementById("keywords");
const searchInput = document.getElementById("search");
const countLine = document.getElementById("count-line");

function formatDate(value) {
    if (!value) return "";
    try { return new Date(value).toLocaleString(); } catch (err) { return value; }
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function stat(label, value) {
    const box = el("div", "stat");
    box.appendChild(el("b", "", String(value)));
    box.appendChild(el("span", "", label));
    return box;
}

function initHeader() {
    const stats = payload.stats || {};
    const generated = formatDate(payload.generatedAt);
    const mode = payload.settings && payload.settings.autoMarkSeen ? "本次结果已写入已看记录" : "本次结果未自动写入已看记录";
    document.getElementById("summary-line").textContent = "生成时间：" + generated + "。" + mode + "。";

    const root = document.getElementById("stats");
    root.appendChild(stat("页数", stats.page || 0));
    root.appendChild(stat("扫描", stats.scanned || 0));
    root.appendChild(stat("命中", stats.matched || 0));
    root.appendChild(stat("汇总", stats.collected || 0));
    root.appendChild(stat("已看跳过", stats.skippedSeen || 0));
    root.appendChild(stat("排除", stats.excluded || 0));
}

function keywordCounts() {
    const counts = new Map();
    for (const item of payload.results || []) {
        const keywords = item.matchedKeywords && item.matchedKeywords.length ? item.matchedKeywords : ["未归类"];
        for (const keyword of keywords) counts.set(keyword, (counts.get(keyword) || 0) + 1);
    }
    return Array.from(counts.entries()).sort(function(a, b) {
        return b[1] - a[1] || String(a[0]).localeCompare(String(b[0]));
    });
}

function renderKeywords() {
    keywordRoot.replaceChildren();
    const all = buttonForKeyword("all", "全部", (payload.results || []).length);
    keywordRoot.appendChild(all);
    for (const pair of keywordCounts()) {
        keywordRoot.appendChild(buttonForKeyword(pair[0], pair[0], pair[1]));
    }
}

function buttonForKeyword(value, label, count) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.keyword = value;
    button.textContent = label + " (" + count + ")";
    if (state.keyword === value) button.classList.add("is-active");
    return button;
}

function matches(item) {
    const query = state.query.trim().toLowerCase();
    if (state.keyword !== "all") {
        const keywords = item.matchedKeywords || [];
        if (!keywords.includes(state.keyword)) return false;
    }
    if (!query) return true;
    const text = [item.title, item.titleZh, item.company, item.location, (item.matchedKeywords || []).join(" ")].join(" ").toLowerCase();
    return text.includes(query);
}

function render() {
    resultRoot.replaceChildren();
    renderKeywords();

    const list = (payload.results || []).filter(matches);
    countLine.textContent = "当前显示 " + list.length + " / " + (payload.results || []).length + " 个结果。";
    if (!list.length) {
        resultRoot.appendChild(el("div", "empty", "没有符合当前筛选条件的结果。"));
        return;
    }

    const groups = new Map();
    for (const item of list) {
        const key = item.primaryKeyword || "未归类";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }

    for (const pair of groups.entries()) {
        const section = document.createElement("section");
        const title = document.createElement("h2");
        title.appendChild(document.createTextNode(pair[0]));
        title.appendChild(el("span", "", pair[1].length + " 个"));
        section.appendChild(title);

        for (const item of pair[1]) section.appendChild(jobCard(item));
        resultRoot.appendChild(section);
    }
}

function jobCard(item) {
    const card = el("article", "job");
    const main = document.createElement("div");
    const title = el("a", "title", item.title || "(无标题)");
    title.href = item.link;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
    main.appendChild(title);

    if (item.titleZh) {
        main.appendChild(el("div", "title-zh", item.titleZh));
    }

    const meta = el("div", "meta");
    const metaParts = [
        item.company || "Unknown company",
        item.location || "Unknown location",
        item.listedAt || "",
        item.jobId ? "Job ID " + item.jobId : "",
        item.page ? "第 " + item.page + " 页" : ""
    ].filter(Boolean);
    meta.textContent = metaParts.join(" · ");
    main.appendChild(meta);

    const tags = el("div", "tags");
    for (const keyword of item.matchedKeywords || []) tags.appendChild(el("span", "tag", keyword));
    main.appendChild(tags);

    const open = el("a", "open-link", "打开职位");
    open.href = item.link;
    open.target = "_blank";
    open.rel = "noopener noreferrer";

    card.appendChild(main);
    card.appendChild(open);
    return card;
}

function copyLinks() {
    const lines = (payload.results || []).map(function(item) {
        return [item.title || "", item.titleZh || "", item.company || "", item.location || "", item.link || ""].join("\\t");
    }).join("\\n");
    navigator.clipboard.writeText(lines).then(function() {
        document.getElementById("copy-links").textContent = "已复制";
        setTimeout(function() { document.getElementById("copy-links").textContent = "复制链接"; }, 1200);
    });
}

function downloadJson() {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "linkedin-summary-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

keywordRoot.addEventListener("click", function(event) {
    const button = event.target.closest("button[data-keyword]");
    if (!button) return;
    state.keyword = button.dataset.keyword || "all";
    render();
});
searchInput.addEventListener("input", function() {
    state.query = searchInput.value || "";
    render();
});
document.getElementById("copy-links").addEventListener("click", copyLinks);
document.getElementById("download-json").addEventListener("click", downloadJson);

initHeader();
render();
</script>
</body>
</html>`;
    }

    function markSeen(job, source) {
        const keys = historyKeysForJob(job);
        if (!keys.length) return;

        let canonical = "";
        for (const key of keys) {
            const resolved = resolveHistoryKey(key);
            if (resolved) {
                canonical = resolved;
                break;
            }
        }
        if (!canonical) canonical = keys[0];

        const now = new Date().toISOString();
        const existing = historyStore.jobs[canonical] || {};
        historyStore.jobs[canonical] = {
            key: canonical,
            title: job.title || existing.title || "",
            company: job.company || existing.company || "",
            location: job.location || existing.location || "",
            link: job.link || existing.link || "",
            jobId: job.jobId || existing.jobId || "",
            firstSeen: existing.firstSeen || now,
            lastSeen: now,
            source: source || existing.source || "manual"
        };

        for (const key of keys) historyStore.aliases[key] = canonical;
        historyStore.aliases[canonical] = canonical;
    }

    function isSeen(job) {
        return historyKeysForJob(job).some((key) => Boolean(resolveHistoryKey(key)));
    }

    function resolveHistoryKey(key) {
        const clean = normalizeHistoryKey(key);
        if (!clean) return "";
        if (historyStore.jobs[clean]) return clean;
        const aliasTarget = historyStore.aliases[clean];
        if (aliasTarget && historyStore.jobs[aliasTarget]) return aliasTarget;
        return "";
    }

    function canonicalSessionKey(job) {
        const keys = historyKeysForJob(job);
        return keys[0] || "";
    }

   function historyKeysForJob(job) {
        return strongHistoryKeysForJob(job);
    }

    function strongHistoryKeysForJob(job) {
        const keys = [];
        if (job.jobId) keys.push(`job:${normalizeText(job.jobId)}`);
        const linkKey = historyLinkKey(job.link);
        if (linkKey) keys.push(linkKey);
        return Array.from(new Set(keys.map(normalizeHistoryKey).filter(Boolean)));
    }

    function historyLinkKey(link) {
        const canonical = canonicalJobLink(link || "", "");
        const normalized = normalizeText(canonical);
        return normalized ? `url:${normalized}` : "";
    }

    function fingerprintForJob(job) {
        const company = normalizeText(job.company || "unknown company");
        const title = normalizeText(job.title);
        if (!title) return "";
        return `${company}|${title}`;
    }

    function normalizeHistoryKey(value) {
        const text = normalizeText(value);
        if (!text) return "";
        if (text.startsWith("job:") || text.startsWith("url:") || text.startsWith("fp:")) return text;
        return `fp:${text}`;
    }

    function getJobId(href, card) {
        const fromCard = card && (
            card.getAttribute("data-job-id")
            || card.getAttribute("data-occludable-job-id")
            || card.getAttribute("data-id")
        );
        const cleanCardId = String(fromCard || "").match(/\d{5,}/);
        if (cleanCardId) return cleanCardId[0];

        try {
            const url = new URL(href, location.href);
            const pathMatch = url.pathname.match(/\/jobs\/view\/(\d+)/);
            if (pathMatch) return pathMatch[1];
            const queryId = url.searchParams.get("currentJobId") || url.searchParams.get("jobId");
            if (queryId && /^\d+$/.test(queryId)) return queryId;
        } catch (err) {
            const fallback = String(href || "").match(/(?:currentJobId=|\/jobs\/view\/)(\d+)/);
            if (fallback) return fallback[1];
        }
        return "";
    }

    function canonicalJobLink(href, jobId) {
        if (jobId) return `https://www.linkedin.com/jobs/view/${jobId}/`;
        try {
            const url = new URL(href, location.href);
            for (const key of ["refId", "trackingId", "trk", "position", "pageNum"]) url.searchParams.delete(key);
            return url.href;
        } catch (err) {
            return href;
        }
    }

    function splitKeywordAlternatives(text) {
        return Array.from(new Set(String(text || "")
            .split(/[\n,，]+|\s+\bOR\b\s+/i)
            .map((line) => line.replace(/\/\/.*$/, "").trim())
            .filter(Boolean)));
    }

    function parseRules(text) {
        return splitKeywordAlternatives(text).map(normalizeText);
    }

    function agentSearchKeyword(value) {
        return splitKeywordAlternatives(value)[0] || String(value || "").trim();
    }

    function agentIncludeKeywordText(value) {
        return splitKeywordAlternatives(value).join("\n");
    }

    function normalizeText(value) {
        return String(value || "")
            .normalize("NFKC")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
    }

    function escapeHtml(value) {
        return String(value || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function updateCounters() {
        if (!ui) return;
        ui.page.textContent = String(scanState.page);
        ui.scanned.textContent = String(scanState.scanned);
        ui.collected.textContent = String(scanState.collected);
        ui.skipped.textContent = String(scanState.skippedSeen);
        ui.excluded.textContent = String(scanState.excluded);
        ui.history.textContent = String(historyCount());
        updateSummaryButtons();
    }

    function updateSummaryButtons() {
        if (!ui?.openLatestSummary || !ui?.summaryHistory) return;
        const count = summaryHistory.length;
        ui.summaryHistory.textContent = `汇总历史(${count})`;
        setButtonEnabled(ui.openLatestSummary, count > 0);
        setButtonEnabled(ui.summaryHistory, count > 0);
    }

    function setButtonEnabled(button, enabled) {
        button.disabled = !enabled;
        setImportantStyles(button, enabled
            ? {
                "opacity": "1",
                "cursor": "pointer"
            }
            : {
                "opacity": "0.5",
                "cursor": "not-allowed"
            });
    }

    function setRunningUI(isRunning) {
        setImportantStyles(ui.start, {
            "display": isRunning ? "none" : "inline-flex"
        });
        setImportantStyles(ui.stop, {
            "display": isRunning ? "inline-flex" : "none",
            "grid-column": isRunning ? "span 2" : "auto"
        });
        setStatus(isRunning ? "运行中" : "已停止");
    }

    function setStatus(text) {
        ui.status.textContent = text;
        ui.status.classList.toggle("is-running", text !== "已停止");
        setImportantStyles(ui.status, text === "已停止"
            ? { "color": "#991b1b", "background": "#fee2e2" }
            : { "color": "#166534", "background": "#dcfce7" });
    }

    function log(message) {
        if (!ui) return;
        const row = (ui.doc || document).createElement("div");
        const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
        row.textContent = `[${time}] ${message}`;
        ui.log.appendChild(row);
        ui.log.scrollTop = ui.log.scrollHeight;
    }

    function clearLog() {
        if (ui) ui.log.replaceChildren();
    }

    function getScrollTop(scroller) {
        if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
            return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
        }
        return scroller.scrollTop;
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function randomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function jitterMs(baseSeconds, spreadRatio) {
        const safeBase = Math.max(0.1, toFloat(baseSeconds, 1));
        const spread = Math.max(0, toFloat(spreadRatio, 0.5));
        const min = Math.round(safeBase * 1000);
        const max = Math.round(safeBase * (1 + spread) * 1000);
        return randomInt(min, Math.max(min, max));
    }

    function formatSeconds(ms) {
        return Math.max(1, Math.round(ms / 1000));
    }

    function toInt(value, fallback) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function toFloat(value, fallback) {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function clampInt(value, min, max, fallback) {
        const parsed = toInt(value, fallback);
        return Math.min(max, Math.max(min, parsed));
    }

    function clampFloat(value, min, max, fallback) {
        const parsed = toFloat(value, fallback);
        return Math.min(max, Math.max(min, parsed));
    }

    function agentIsManagedWorkerWindow() {
        return window.name.startsWith("job-agent-worker-");
    }

    function agentIsManagedPreflightWindow() {
        return window.name.startsWith("job-agent-preflight-");
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
        return { scanned: scanState.scanned, found: scanState.resultMap.size };
    }

    function agentAccessState() {
        const now = Date.now();
        const stored = GM_getValue(AGENT.accessThrottleKey, null) || {};
        if (Number(stored.cooldownUntil || 0) && now >= Number(stored.cooldownUntil)) {
            const reset = { count: 0, cooldownUntil: 0, updatedAt: now };
            GM_setValue(AGENT.accessThrottleKey, reset);
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
            GM_setValue(AGENT.accessThrottleKey, access);
            const hadHeartbeat = Boolean(agentHeartbeatTimer);
            agentStopHeartbeat();
            let lastProgressAt = 0;
            while (Date.now() < access.cooldownUntil) {
                const remaining = access.cooldownUntil - Date.now();
                const detail = `已连续完成 ${agentTiming.accessLimit} 次 LinkedIn 平台访问，为降低访问压力暂停 ${agentTiming.cooldownMinutes} 分钟；${agentCooldownText(remaining)} 后自动继续 ${label}。`;
                agentShowOverlay(`访问节流休息中 · ${agentCooldownText(remaining)}`, detail);
                setStatus?.(`访问节流休息中 · ${agentCooldownText(remaining)}`);
                if (Date.now() - lastProgressAt >= 2500) {
                    lastProgressAt = Date.now();
                    await agentProgress("cooldown", detail, { ...agentProgressStats(), accessCount: access.count, accessLimit: agentTiming.accessLimit, cooldownUntil: new Date(access.cooldownUntil).toISOString(), cooldownReason: `已连续访问 ${agentTiming.accessLimit} 次 LinkedIn，暂停 ${agentTiming.cooldownMinutes} 分钟后自动继续。` });
                }
                await sleep(Math.min(1000, remaining));
            }
            if (agentStopRequested) return;
            access = { count: 0, cooldownUntil: 0, updatedAt: Date.now() };
            GM_setValue(AGENT.accessThrottleKey, access);
            agentShowOverlay("LinkedIn 正在继续", `访问节流休息已结束，继续 ${label}。`);
            if (hadHeartbeat) agentStartHeartbeat();
        }
        access.count += 1;
        access.updatedAt = Date.now();
        if (access.count >= agentTiming.accessLimit) access.cooldownUntil = Date.now() + agentTiming.cooldownMinutes * 60 * 1000;
        GM_setValue(AGENT.accessThrottleKey, access);
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
        void agentProgress("scanning", "LinkedIn 正在扫描职位列表。");
        agentHeartbeatTimer = setInterval(() => { void agentProgress("scanning", "LinkedIn 正在扫描职位列表。"); }, 2500);
    }

    function agentStopHeartbeat() {
        clearInterval(agentHeartbeatTimer);
        agentHeartbeatTimer = null;
    }

    function agentResetLocalRecords() {
        historyStore = emptyHistory();
        saveHistory(historyStore);
        summaryHistory = [];
        saveSummaryHistory();
        GM_setValue(LEGACY_HISTORY_KEY, []);
        GM_setValue(AGENT.taskKey, null);
        GM_setValue(AGENT.pauseKey, "");
        GM_setValue(AGENT.preflightKey, null);
        GM_setValue(AGENT.accessThrottleKey, { count: 0, cooldownUntil: 0, updatedAt: Date.now() });
        setStatus("Worker 历史记录已清空");
        log("Job Agent 已清空 LinkedIn Worker 历史记录。");
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
        agentShowOverlay("正在清理 LinkedIn Worker 历史", "清理完成后会自动继续下一个平台，请勿操作此窗口。");
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
        let workerId = String(GM_getValue(AGENT.workerKey, "") || "");
        if (!workerId) {
            workerId = (typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `worker-${Date.now()}-${Math.random()}`).slice(0, 120);
            GM_setValue(AGENT.workerKey, workerId);
        }
        return workerId;
    }

    function agentStoredTask() {
        const stored = GM_getValue(AGENT.taskKey, null);
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
        const url = new URL("https://www.linkedin.com/jobs/search/");
        url.searchParams.set("keywords", agentSearchKeyword(task.keyword));
        url.searchParams.set("location", task.location);
        if (Number(task.postedWithinDays) > 0) url.searchParams.set("f_TPR", `r${Number(task.postedWithinDays) * 86400}`);
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
            GM_setValue(AGENT.taskKey, agentTask);
            GM_setValue(AGENT.pauseKey, "");
            if (agentOnTaskPage(agentTask)) await agentStartTask();
            else location.assign(agentTaskUrl(agentTask));
        } catch (error) {
            console.warn("Job Agent worker claim failed", error);
            agentScheduleClaim(runId, 10000);
        } finally {
            agentClaiming = false;
        }
    }

    async function agentStartTask() {
        if (!agentTask || agentStartedTaskId === agentTask.id || scanState.running) return;
        const humanReason = agentHumanBlockReason();
        if (humanReason) return agentPause(humanReason);
        const deadline = Date.now() + 16000;
        while (!ui && Date.now() < deadline) await sleep(300);
        if (!ui) return agentSubmit("failed", "Job results did not load in the worker tab.", { results: [] });
        agentStartedTaskId = agentTask.id;
        const includeKeywords = agentIncludeKeywordText(agentTask.keyword);
        ui.target.value = includeKeywords;
        const excludeKeywords = Array.isArray(agentTask.exclusionKeywords) ? agentTask.exclusionKeywords.join("\n") : "";
        ui.exclude.value = excludeKeywords;
        settings = { ...settings, target: includeKeywords, exclude: excludeKeywords, scrollDelaySeconds: agentTiming.scrollDelaySeconds, pageDelaySeconds: agentTiming.pageDelaySeconds };
        log(`Job Agent 访问节奏：连续访问 ${agentTiming.accessLimit} 次后休息 ${agentTiming.cooldownMinutes} 分钟；滚动 ${agentTiming.scrollDelaySeconds} 秒，翻页 ${agentTiming.pageDelaySeconds} 秒，每份 JD ${agentTiming.jdIntervalSeconds} 秒。`);
        agentShowOverlay("LinkedIn 正在运行", `平台搜索“${agentSearchKeyword(agentTask.keyword)}” · 包含 ${parseRules(agentTask.keyword).join("、")} · ${agentTask.location}。请勿操作此窗口。`);
        await agentBeforePlatformAccess("搜索结果页");
        agentStartHeartbeat();
        await startScan();
    }

    function agentJobs(payload) {
        return (payload.results || []).map((job) => ({
            source: AGENT.platform,
            sourceJobId: job.jobId || job.id || null,
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

    function agentCleanDescription(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
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
                    else reject(new Error(`LinkedIn JD request failed (HTTP ${response.status}).`));
                },
                onerror() { reject(new Error("LinkedIn JD request failed due to a network error.")); },
                ontimeout() { reject(new Error("LinkedIn JD request timed out.")); }
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

    function agentDescriptionText(element) {
        return agentCleanDescription(element?.innerText || element?.textContent || "")
            .replace(/^about the job\s*/i, "")
            .replace(/\s*(?:\u2026|\.\.\.)?\s*more\s*$/i, "")
            .trim();
    }

    function agentDescriptionHeadings(root) {
        return Array.from(root.querySelectorAll("h1,h2,h3,h4,[role='heading']")).filter((element) => (
            agentCleanDescription(element.textContent).toLowerCase() === "about the job"
        ));
    }

    function agentDescriptionDiagnostics(root, descriptionLength = 0) {
        const headingCount = agentDescriptionHeadings(root).length;
        const moreCount = Array.from(root.querySelectorAll("button,[role='button']")).filter((element) => {
            const label = agentCleanDescription(`${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`);
            return /^(?:show\s+)?(?:\u2026|\.\.\.)?\s*more$/i.test(label)
                || /show more.*(?:job|description)/i.test(label);
        }).length;
        return `About the job heading: ${headingCount ? "found" : "missing"}; extracted text: ${descriptionLength} characters; More control: ${moreCount ? "found" : "missing"}.`;
    }

    function agentExtractDescriptionFromDocument(root) {
        const selectors = [
            ".jobs-description-content__text",
            ".jobs-box__html-content",
            '[class*="jobs-description__content"]',
            ".show-more-less-html__markup",
            "#job-details",
            '[data-testid*="job-description"]',
            '[data-test*="job-description"]'
        ];
        const candidates = [];
        for (const selector of selectors) {
            for (const element of root.querySelectorAll(selector)) {
                const text = agentDescriptionText(element);
                if (text.length >= 120) candidates.push(text);
            }
        }

        for (const heading of agentDescriptionHeadings(root)) {
            let section = heading.parentElement;
            for (let depth = 0; section && depth < 7; depth += 1, section = section.parentElement) {
                const text = agentDescriptionText(section);
                if (text.length >= 120 && text.length <= 60000) candidates.push(text);
                if (section.matches?.("main,body")) break;
            }
        }

        for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
            try {
                const posting = agentJsonLdJobPosting(JSON.parse(script.textContent || "null"));
                if (!posting?.description) continue;
                const parsedDescription = new DOMParser().parseFromString(String(posting.description), "text/html");
                const description = agentCleanDescription(parsedDescription.body?.textContent || "");
                if (description.length >= 120) return { description };
            } catch {}
        }

        if (candidates.length) {
            candidates.sort((left, right) => left.length - right.length);
            return { description: candidates[0] };
        }

        const pageText = agentCleanDescription(root.body?.innerText || root.body?.textContent || "");
        const pageTitle = agentCleanDescription(root.title || "");
        const path = root === document ? location.pathname.toLowerCase() : "";
        const blockedPath = /(captcha|challenge|checkpoint|authwall|login)/.test(path);
        const blockedContent = /captcha|verify you are human|unusual traffic|security check|robot check|sign in to (?:view|continue|linkedin)/i.test(`${pageTitle} ${pageText}`);
        if (blockedPath || blockedContent) {
            return { humanReason: "LinkedIn 在获取职位 JD 时要求登录或人工验证。请处理页面后重新获取 JD。" };
        }

        throw new Error(`LinkedIn detail page did not contain a complete job description. ${agentDescriptionDiagnostics(root)}`);
    }

    function agentExtractDescription(html) {
        const parsed = new DOMParser().parseFromString(html, "text/html");
        return agentExtractDescriptionFromDocument(parsed);
    }

    async function agentExpandJobDescription() {
        const headings = agentDescriptionHeadings(document);
        const heading = headings.find(agentVisible) || headings[0];
        if (!heading) return { headingFound: false, buttonFound: false, clicked: false };
        try { heading.scrollIntoView({ block: "center", behavior: "auto" }); } catch {}
        await sleep(250);

        const roots = [];
        let section = heading.parentElement;
        for (let depth = 0; section && depth < 6; depth += 1, section = section.parentElement) {
            roots.push(section);
            if (section.matches?.("main,body")) break;
        }
        const direct = agentFirst([
            ".jobs-description__footer-button",
            ".show-more-less-html__button--more",
            'button[aria-label*="Show more"][aria-label*="description"]'
        ]);
        const localButtons = roots.flatMap((root) => Array.from(root.querySelectorAll("button,[role='button']")));
        const button = direct || localButtons.find((element) => {
            if (!agentVisible(element) || element.disabled || element.getAttribute("aria-disabled") === "true") return false;
            const text = agentCleanDescription(element.textContent || "");
            const aria = agentCleanDescription(element.getAttribute("aria-label") || "");
            return /^(?:\u2026|\.\.\.)?\s*more$/i.test(text)
                || /show more.*(?:job|description)/i.test(`${aria} ${text}`);
        });
        if (!button) return { headingFound: true, buttonFound: false, clicked: false };
        button.click();
        await sleep(850);
        return { headingFound: true, buttonFound: true, clicked: true };
    }

    async function agentFetchDescription(job) {
        let directError = null;
        try {
            const html = await agentRequestJobPage(job.jobUrl);
            const directResult = agentExtractDescription(html);
            if (!directResult.humanReason) return directResult;
            directError = new Error(directResult.humanReason);
        } catch (error) {
            directError = error;
        }
        if (typeof GM_openInTab !== "function") throw directError;
        await agentBeforePlatformAccess("JD 详情页保底标签");
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const resultKey = `job-agent:jd-result:linkedin:${requestId}`;
        const detailUrl = new URL(job.jobUrl, location.href);
        detailUrl.hash = new URLSearchParams({ jobAgentJdRequest: requestId }).toString();
        GM_setValue(resultKey, null);
        const childTab = GM_openInTab(detailUrl.href, { active: true, insert: true, setParent: true });
        let keepChildOpen = false;
        try {
            const deadline = Date.now() + agentTiming.jdPageTimeoutSeconds * 1000;
            while (Date.now() < deadline) {
                await sleep(350);
                const result = GM_getValue(resultKey, null);
                if (!result) continue;
                keepChildOpen = Boolean(result.humanReason);
                if (result.error) throw new Error(`${directError?.message || "Direct HTML extraction failed."} Rendered fallback: ${result.error}`);
                return result;
            }
            throw new Error(`${directError?.message || "Direct HTML extraction failed."} LinkedIn rendered job description did not load within 10 seconds.`);
        } finally {
            GM_setValue(resultKey, null);
            if (!keepChildOpen) {
                try { childTab?.close?.(); } catch {}
            }
        }
    }

    async function agentRunJdChild(requestId) {
        await agentRefreshTiming();
        const resultKey = `job-agent:jd-result:linkedin:${requestId}`;
        const deadline = Date.now() + agentTiming.jdPageTimeoutSeconds * 1000 - 1000;
        let lastError = "LinkedIn rendered job description did not become available.";
        let lastHumanReason = null;
        let expansionAttempts = 0;
        while (Date.now() < deadline) {
            const currentHumanReason = agentHumanBlockReason();
            if (currentHumanReason) {
                lastHumanReason = currentHumanReason;
                lastError = currentHumanReason;
                await sleep(600);
                continue;
            }
            try {
                if (expansionAttempts < 4) {
                    expansionAttempts += 1;
                    await agentExpandJobDescription();
                }
                const result = agentExtractDescriptionFromDocument(document);
                if (result.humanReason) {
                    lastHumanReason = result.humanReason;
                    lastError = result.humanReason;
                } else {
                    GM_setValue(resultKey, result);
                    setTimeout(() => window.close(), 150);
                    return;
                }
            } catch (error) {
                lastError = error.message || String(error);
            }
            await sleep(500);
        }
        if (lastHumanReason) {
            GM_setValue(resultKey, { humanReason: lastHumanReason });
            return;
        }
        GM_setValue(resultKey, { error: `${lastError} Final page: ${location.pathname}.` });
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
        agentShowOverlay("LinkedIn 正在获取完整 JD", "读取完成后会传回 Job Agent 并自动进行 AI 审阅。请勿操作此窗口。");
        const deadline = Date.now() + agentTiming.jdPageTimeoutSeconds * 1000;
        let lastError = "LinkedIn rendered job description did not become available.";
        let lastHumanReason = null;
        let expansionAttempts = 0;
        while (Date.now() < deadline) {
            const currentHumanReason = agentHumanBlockReason();
            if (currentHumanReason) {
                lastHumanReason = currentHumanReason;
                lastError = currentHumanReason;
                await sleep(600);
                continue;
            }
            try {
                if (expansionAttempts < 4) {
                    expansionAttempts += 1;
                    await agentExpandJobDescription();
                }
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
            agentShowOverlay("需要人工处理 LinkedIn", "页面持续要求登录或安全验证。请完成处理后回到 Job Agent 再次获取 JD。");
            if (typeof GM_notification === "function") GM_notification({ title: "Job Agent needs help", text: lastHumanReason, timeout: 0 });
            return;
        }
        try {
            await agentRequest("POST", "/api/worker/job-jd", { jobId, platform: AGENT.platform, batchId, error: `${lastError} Final page: ${location.pathname}.` });
        } catch (error) {
            lastError = `${lastError} ${error.message || error}`;
        }
        if (await agentContinueJdBatch(batchId)) return;
        agentShowOverlay("未能获取 LinkedIn JD", `${lastError} 请回到 Job Agent 重试。`);
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
            log(`Job Agent 标题初筛：需获取 ${response.counts.fetch} 份 JD，复用 ${response.counts.reuse} 份，标题拒绝 ${response.counts.rejected} 份。`);
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
            const action = planByIndex.get(index)?.action || "fetch";
            if (action === "reject") {
                job.descriptionFetchStatus = "skipped-rejected";
                continue;
            }
            if (action === "reuse") {
                job.descriptionFetchStatus = "reused";
                continue;
            }
            completed += 1;
            const message = `正在获取完整 JD ${completed}/${fetchIndexes.length}：${job.title}`;
            agentShowOverlay("LinkedIn 正在获取完整 JD", `${message}。请勿操作此窗口。`);
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
                GM_setValue(AGENT.pauseKey, task.id);
                agentHideOverlay();
                agentNotify(`LinkedIn: ${reason}`);
                agentScheduleClaim(task.runId, 8000);
                return;
            }
            GM_setValue(AGENT.taskKey, null);
            GM_setValue(AGENT.pauseKey, "");
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
        if (!agentTask || GM_getValue(AGENT.pauseKey, "") === agentTask.id) return agentScheduleClaim(agentTask?.runId);
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

    function agentLinkedInSearchState() {
        const keyword = agentFirst(["#job-search-bar-keywords", "input[aria-label*='Search by title' i]", "input[placeholder*='Search by title' i]", "input[aria-label*='Search jobs' i]", "input[aria-label*='搜索职位']"]);
        const location = agentFirst(["#job-search-bar-location", "input[aria-label*='City, state, or zip code' i]", "input[placeholder*='City, state, or zip code' i]", "input[aria-label*='location' i]", "input[aria-label='地点']"]);
        return { keyword: keyword?.value?.trim() || "", location: location?.value?.trim() || "" };
    }

    function agentLinkedInPrimarySearchState() {
        const keyword = agentFirst(LINKEDIN_KEYWORD_INPUT_SELECTORS);
        const location = agentFirst(LINKEDIN_LOCATION_INPUT_SELECTORS);
        return { keyword: keyword?.value?.trim() || "", location: location?.value?.trim() || "" };
    }

    function agentLinkedInSearchMatches(validation) {
        const current = agentLinkedInPrimarySearchState();
        return current.keyword.toLowerCase() === agentSearchKeyword(validation.keyword).toLowerCase()
            && current.location.toLowerCase() === validation.location.trim().toLowerCase();
    }

    async function agentAssertSearchResults(validation) {
        const deadline = Date.now() + 10000;
        log("预检：正在确认搜索结果不为空。");
        while (Date.now() < deadline) {
            if (document.querySelector(".job-card-container, .jobs-search-results__list-item, [data-job-id]")) return;
            const text = (document.body?.innerText || "").slice(0, 30000);
            if (/\b0\s+results?\b|no matching jobs|no jobs found|没有找到.*职位/i.test(text)) {
                throw new Error(`没有搜索到职位。请检查关键词“${validation.keyword}”和地点“${validation.location}”是否输入正确。`);
            }
            await sleep(300);
        }
        throw new Error(`10 秒内无法确认搜索结果。请检查关键词“${validation.keyword}”和地点“${validation.location}”，然后重新预检。`);
    }

    function agentPreflightState(validation) {
        const stored = GM_getValue(AGENT.preflightKey, null);
        const preflightAttempt = Number(validation.preflightAttempt || 1);
        return stored?.validationId === validation.id && stored?.preflightAttempt === preflightAttempt
            ? stored
            : { validationId: validation.id, preflightAttempt, stage: "search" };
    }

    function agentClearPreflight() {
        GM_setValue(AGENT.preflightKey, null);
        const url = new URL(location.href);
        url.searchParams.delete("jobAgentPreflight");
        url.searchParams.delete("jobAgentValidation");
        history.replaceState(null, "", url.href);
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
            agentNotify(`LinkedIn: ${reason}`);
            agentClearPreflight();
            agentHideOverlay();
            return;
        }
        agentClearPreflight();
        setTimeout(() => void agentContinuePreflightQueue(), 300);
    }

    async function agentApplyLinkedInDateFilter(validation) {
        const days = Number(validation.postedWithinDays);
        if (!days) return;
        const labels = {
            1: /past 24 hours|近 24 小时/i,
            7: /past week|近 1 周/i,
            30: /past month|近 1 个月/i
        };
        const labelNames = { 1: "Past 24 hours", 7: "Past week", 30: "Past month" };
        if (!labels[days]) throw new Error("Date posted 不支持所选时间范围。LinkedIn 仅支持过去 24 小时、过去 7 天或过去 30 天。");
        setStatus("Job Agent: 正在打开 Date posted...");
        log(`预检：正在选择 Date posted = ${labelNames[days]}`);
        const trigger = await agentWaitFor(["#searchFilter_timePostedRange", "button[aria-label*='Date posted filter' i]", "button[aria-label*='Date posted' i]"], 6000);
        if (!trigger) throw new Error("未找到 LinkedIn 的 Date posted 筛选器。");
        if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
        const openedAt = Date.now();
        while (Date.now() - openedAt < 2500) {
            const currentTrigger = document.querySelector("#searchFilter_timePostedRange") || trigger;
            if (currentTrigger.getAttribute("aria-expanded") === "true") break;
            await sleep(120);
        }
        if ((document.querySelector("#searchFilter_timePostedRange") || trigger).getAttribute("aria-expanded") !== "true") {
            throw new Error("已点击 Date posted，但筛选面板没有打开。请检查 LinkedIn 页面是否被其他弹层遮挡。");
        }
        setStatus("Job Agent: 正在等待 Date posted 选项...");
        log("预检：等待 Date posted 下拉选项加载。");
        if (!await agentWaitAndClickText(labels[days])) throw new Error(`Date posted 已打开，但 7 秒内未找到可点击的“${labelNames[days]}”选项。`);
        log(`预检：已选择 Date posted = ${labelNames[days]}`);
        // LinkedIn keeps the radio choice pending until its dynamic
        // "Show N result(s)" action is pressed. This differs from Indeed and SEEK.
        const apply = await agentWaitFor(["button[aria-label*='Apply current filter to show' i]", "button.filter__submit-button[form='jserp-filters']", "button.filter__submit-button"], 3500);
        const showResultsClicked = apply ? false : await agentWaitAndClickText(/^show(?:\s+.+)?\s+results?$/i, 3500);
        if (!apply && !showResultsClicked) throw new Error("已选择 Date posted，但未找到 LinkedIn 的“Show ... result”确认按钮。");
        setStatus("Job Agent: 正在显示筛选结果...");
        log("预检：正在点击 LinkedIn 的 Show result 确认按钮。");
        if (apply) apply.click();
        await agentActionDelay(0.9);
    }

    async function agentStartLinkedInOfficialSearch(validation) {
        const searchKeyword = agentSearchKeyword(validation.keyword);
        const keywordInput = await agentWaitFor(LINKEDIN_KEYWORD_INPUT_SELECTORS);
        const locationInput = await agentWaitFor(LINKEDIN_LOCATION_INPUT_SELECTORS);
        if (!keywordInput || !locationInput) throw new Error("LinkedIn primary search inputs were not found.");
        if (!agentSetInput(keywordInput, searchKeyword)) throw new Error("Keyword input could not retain its value.");
        log(`预检：平台搜索关键词 = ${searchKeyword}；本地包含规则 = ${parseRules(validation.keyword).join("、")}`);
        await agentActionDelay();
        if (!agentSetInput(locationInput, validation.location)) throw new Error("Location input could not retain its value.");
        log(`预检：已填写地点 = ${validation.location}`);
        await agentActionDelay();
        GM_setValue(AGENT.preflightKey, {
            validationId: validation.id,
            preflightAttempt: Number(validation.preflightAttempt || 1),
            stage: "date"
        });
        setStatus("Job Agent: 正在提交搜索条件...");
        log("预检：正在打开 LinkedIn 官方搜索结果页。");
        const searchUrl = new URL("https://www.linkedin.com/jobs/search/");
        searchUrl.searchParams.set("keywords", searchKeyword);
        searchUrl.searchParams.set("location", validation.location.trim());
        searchUrl.searchParams.set("origin", "JOB_SEARCH_PAGE_SEARCH_BUTTON");
        searchUrl.searchParams.set("refresh", "true");
        window.location.assign(searchUrl.href);
        return true;
    }

    async function agentRunPreflight(validationIdOverride = "") {
        const params = new URL(location.href).searchParams;
        const validationId = validationIdOverride || params.get("jobAgentValidation") || GM_getValue(AGENT.preflightKey, null)?.validationId;
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
            if (state.stage === "search") return agentStartLinkedInOfficialSearch(validation);
            if (state.stage === "__legacy_search__") {
                const keyword = await agentWaitFor(["#job-search-bar-keywords", "input[aria-label*='Search by title' i]", "input[placeholder*='Search by title' i]", "input[aria-label*='Search jobs' i]", "input[aria-label*='搜索职位']"]);
                const location = await agentWaitFor(["#job-search-bar-location", "input[aria-label*='City, state, or zip code' i]", "input[placeholder*='City, state, or zip code' i]", "input[aria-label*='location' i]", "input[aria-label='地点']"]);
                const submit = await agentWaitFor(["button.jobs-search-box__submit-button", "button[aria-label='Search']", "button[aria-label='搜索']", "button[type='submit']"]);
                const primaryKeyword = await agentWaitFor(LINKEDIN_KEYWORD_INPUT_SELECTORS);
                const primaryLocation = await agentWaitFor(LINKEDIN_LOCATION_INPUT_SELECTORS);
                if (!primaryKeyword || !primaryLocation || !submit) throw new Error("LinkedIn primary search controls were not found.");
    const searchKeyword = agentSearchKeyword(validation.keyword);
    if (!agentSetInput(primaryKeyword, searchKeyword)) throw new Error("Keyword input could not retain its value.");
    log(`预检：平台搜索关键词 = ${searchKeyword}；本地包含规则 = ${parseRules(validation.keyword).join("、")}`);
    await agentActionDelay();
    if (!agentSetInput(primaryLocation, validation.location)) throw new Error("Location input could not retain its value.");
    log(`预检：已填写地点 = ${validation.location}`);
                await agentActionDelay();
                GM_setValue(AGENT.preflightKey, { validationId: validation.id, preflightAttempt: Number(validation.preflightAttempt || 1), stage: "date" });
                setStatus("Job Agent: 正在提交搜索条件...");
                submit.click();
                await agentActionDelay(1.1);
            }
            if (!agentLinkedInSearchMatches(validation)) {
                const current = agentLinkedInPrimarySearchState();
                throw new Error(`关键词或地点未正确应用。页面当前显示：关键词“${current.keyword || "空"}”、地点“${current.location || "空"}”。`);
            }
            log("预检：关键词和地点已确认。");
            if ((agentPreflightState(validation).stage || "date") === "date") {
                GM_setValue(AGENT.preflightKey, { validationId: validation.id, preflightAttempt: Number(validation.preflightAttempt || 1), stage: "verify" });
                await agentApplyLinkedInDateFilter(validation);
                await agentActionDelay(0.8);
            }
            const appliedDays = Number(validation.postedWithinDays);
            const current = new URL(location.href).searchParams;
            if (appliedDays && current.get("f_TPR") !== `r${appliedDays * 86400}`) {
                throw new Error("Date posted 未确认生效。已尝试选择所需时间范围，但 LinkedIn 没有写入对应筛选条件。");
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
        if (params.get("jobAgentReset") === "1") {
            agentRunHistoryReset(params);
            return;
        }
        const preflightMode = params.get("jobAgentPreflight") === "1" || agentIsManagedPreflightWindow();
        const workerMode = params.get("jobAgentWorker") === "1" || agentIsManagedWorkerWindow();
        if (!preflightMode && !workerMode) return;
        if (preflightMode) {
            agentShowOverlay("正在验证 LinkedIn 搜索条件", "Job Agent 正在填写关键词、地点和时间范围。请勿操作此窗口。");
            if (await agentRunPreflight()) return;
            if (agentIsManagedPreflightWindow()) await agentRunPendingPreflight();
            return;
        }
        let runId = params.get("jobAgentRun") || agentStoredTask()?.runId;
        agentTask = agentStoredTask();
        if (agentTask && runId && agentTask.runId !== runId) {
            GM_setValue(AGENT.taskKey, null);
            agentTask = null;
        }
        const humanReason = agentHumanBlockReason();
        if (agentTask && humanReason) return agentPause(humanReason);
        if (agentTask && GM_getValue(AGENT.pauseKey, "") === agentTask.id) return agentScheduleClaim(agentTask.runId, 4000);
        if (agentTask) {
            agentApplyTiming(agentTask.workerTiming);
            await agentRefreshTiming(agentTask.runId);
            agentTask.workerTiming = { ...agentTiming };
            GM_setValue(AGENT.taskKey, agentTask);
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
    } else if (location.pathname.startsWith("/jobs/search/")) {
        initUI();
        void agentBoot();
    }
})();
