const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const unique = (items) => [...new Set(items.map(normalizeText).filter(Boolean))];

function stringList(value, limit = 30) {
  return unique(Array.isArray(value) ? value : []).slice(0, limit);
}

function machineSignalList(value, limit) {
  return stringList(value, limit).filter((item) => /[a-z]/i.test(item) && !/[\u3400-\u9fff]/.test(item));
}

const exclusionKeywordStopwords = new Set([
  "act", "adelaide", "associate", "australia", "australian", "brisbane", "business", "canberra", "career",
  "cadet", "consultant", "coordinator", "darwin", "developer", "development", "digital", "director", "early",
  "engineer", "engineering", "entry", "experience", "full", "general", "graduate", "graduates", "graduation",
  "head", "hobart", "hybrid", "intern", "internship", "internships", "job", "junior", "launceston", "lead",
  "level", "manager", "melbourne", "member", "nsw", "nt", "officer", "onsite", "opportunity", "part",
  "non", "people", "perth", "position", "professional", "program", "programme", "qld", "queensland", "remote", "role",
  "sa", "scheme", "senior", "software", "specialist", "start", "support", "sydney", "systems", "tasmania",
  "team", "technology", "time", "trainee", "vic", "victoria", "wa"
]);

const exclusionKeywordAliases = new Map([
  ["mentors", "mentor"],
  ["pathologists", "pathologist"],
  ["surveyors", "surveyor"],
  ["therapists", "therapist"]
]);

const preferredExclusionKeywords = [
  "pathologist", "therapist", "surveyor", "nurse", "civil", "architect", "hydropower",
  "merchandising", "mentor", "sales", "retail", "accounting", "auditor", "teacher",
  "medical", "legal", "construction", "mining", "mechanical", "electrical", "surveying",
  "survey", "therapy", "mentorship", "marine", "offshore", "geospatial", "geomatics"
];

export function compactExclusionKeyword(value) {
  const title = normalizeText(value)
    .split(/\s+[|\-–—]\s+|\s*\|\s*|,/)[0]
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase();
  const words = title.match(/[a-z][a-z+#.]*/g) ?? [];
  const preferred = preferredExclusionKeywords.find((keyword) => words.includes(keyword));
  const candidate = preferred || words.reverse().find((word) => word.length >= 3 && !exclusionKeywordStopwords.has(word));
  if (!candidate) return null;
  return exclusionKeywordAliases.get(candidate) || candidate;
}

function compactMachineKeywords(value, limit) {
  return unique((Array.isArray(value) ? value : [])
    .map(compactExclusionKeyword)
    .filter(Boolean))
    .slice(0, limit);
}

export function validatePreferenceModel(input = {}, metadata = {}) {
  return {
    version: Math.max(0, Number(metadata.version ?? input.version) || 0),
    summary: normalizeText(input.summary) || "尚未形成稳定的人工审阅偏好。",
    targetSignals: machineSignalList(input.targetSignals, 24),
    deprioritizeSignals: compactMachineKeywords(input.deprioritizeSignals, 24),
    avoidSignals: compactMachineKeywords(input.avoidSignals, 36),
    titleExclusions: machineSignalList(input.titleExclusions, 50),
    screeningGuidance: stringList(input.screeningGuidance, 16),
    feedbackCount: Math.max(0, Number(metadata.feedbackCount ?? input.feedbackCount) || 0),
    positiveFeedbackCount: Math.max(0, Number(metadata.positiveFeedbackCount ?? input.positiveFeedbackCount) || 0),
    rejectedSignalCount: Math.max(0, Number(metadata.rejectedSignalCount ?? input.rejectedSignalCount) || 0),
    sourceRunId: metadata.sourceRunId ?? input.sourceRunId ?? null,
    engine: normalizeText(metadata.engine ?? input.engine) || "local-rules",
    updatedAt: metadata.updatedAt ?? input.updatedAt ?? null
  };
}

function isHumanNegativeEvidence(job) {
  const helpfulness = job?.feedback?.helpfulness;
  const reason = job?.feedback?.reason;
  return (helpfulness === "HELPFUL" && reason === "REJECTION_CORRECT")
    || (helpfulness === "NOT_HELPFUL" && reason === "NOT_RELEVANT");
}

function signalCoversTitle(signal, title) {
  const normalizedSignal = normalizeText(signal).toLowerCase();
  const normalizedTitle = normalizeText(title).toLowerCase();
  return normalizedSignal && normalizedTitle
    && (normalizedTitle.includes(normalizedSignal) || normalizedSignal.includes(normalizedTitle));
}

export function ensurePreferenceModelNegativeCoverage(input = {}, jobs = []) {
  const model = validatePreferenceModel(input);
  const titleExclusions = [...model.titleExclusions];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!isHumanNegativeEvidence(job)) continue;
    const [title] = machineSignalList([job?.title], 1);
    if (!title || titleExclusions.some((signal) => signalCoversTitle(signal, title))) continue;
    titleExclusions.push(title);
  }
  return validatePreferenceModel({ ...model, titleExclusions });
}

export function validatePreferenceSignals(input = {}) {
  return {
    targetKeywords: machineSignalList(input.targetKeywords, 12).filter((item) => item.length >= 2 && item.length <= 80),
    exclusionKeywords: machineSignalList(input.exclusionKeywords, 8).filter((item) => item.length >= 3 && item.length <= 80),
    exclusionReason: normalizeText(input.exclusionReason).slice(0, 240)
  };
}

export function localPreferenceReflection(input, metadata = {}) {
  const legacy = Array.isArray(input);
  const suppliedUseful = legacy ? [] : Array.isArray(input?.helpfulJobs) ? input.helpfulJobs : [];
  const rejected = legacy ? [] : Array.isArray(input?.rejectedJobs) ? input.rejectedJobs : [];
  const suppliedLegacy = legacy ? input : Array.isArray(input?.legacyNotHelpfulJobs) ? input.legacyNotHelpfulJobs : [];
  const correctedLegacy = suppliedLegacy.filter((item) => item.feedback?.reason === "CLASSIFICATION_WRONG");
  const useful = [...suppliedUseful, ...correctedLegacy];
  const oldNegative = suppliedLegacy.filter((item) => item.feedback?.reason !== "CLASSIFICATION_WRONG");
  const explicitExclusions = oldNegative.filter((item) => item.feedback?.reason === "NOT_RELEVANT");
  const deprioritized = oldNegative.filter((item) => item.feedback?.reason !== "NOT_RELEVANT");
  const notes = unique([...useful, ...oldNegative].map((item) => item.feedback?.note)).slice(0, 8);
  const targetSignals = unique(useful.flatMap((item) => [
    ...(item.learningSignals?.targetKeywords ?? []),
    item.title
  ])).slice(0, 24);
  const deprioritizeSignals = compactMachineKeywords(deprioritized.flatMap((item) => [
    ...(item.learningSignals?.targetKeywords ?? []),
    item.title
  ]), 24);
  const avoidSignals = compactMachineKeywords([
    ...rejected.flatMap((item) => item.learningSignals?.exclusionKeywords ?? []),
    ...explicitExclusions.map((item) => item.title)
  ], 36);
  const confirmedRejected = rejected.filter((item) => item.feedback?.reason === "REJECTION_CORRECT");
  const titleExclusions = unique([
    ...explicitExclusions.map((item) => item.title),
    ...confirmedRejected.map((item) => item.title)
  ]).slice(0, 50);
  const evidenceCount = useful.length + rejected.length + oldNegative.length;
  const details = [
    useful.length ? `${useful.length} 条明确有用` : "",
    rejected.length ? `${rejected.length} 条 AI 或人工确认的不匹配` : "",
    oldNegative.length ? `${oldNegative.length} 条明确没用` : ""
  ].filter(Boolean);
  return validatePreferenceModel({
    summary: evidenceCount
      ? `已从 ${evidenceCount} 条人工与 AI 审阅证据中整理偏好：${details.join("，")}。`
      : "尚未收到可用于复盘的审阅证据。",
    targetSignals,
    deprioritizeSignals,
    avoidSignals,
    titleExclusions,
    screeningGuidance: evidenceCount
      ? [
          "优先参考用户明确标记为有用的职位特征。",
          "AI 排除信号只用于辅助匹配；脚本排除词必须由用户在搜索设置中批准。",
          ...notes.map((note) => `用户补充：${note}`)
        ]
      : []
  }, {
    ...metadata,
    feedbackCount: metadata.feedbackCount ?? evidenceCount,
    positiveFeedbackCount: metadata.positiveFeedbackCount ?? useful.length,
    rejectedSignalCount: metadata.rejectedSignalCount ?? rejected.length
  });
}

function normalizedSignal(value) {
  return normalizeText(value).toLowerCase().replace(/^["']|["']$/g, "");
}

export function matchingPreferenceSignal(text, preferenceModel, kind = "avoid") {
  const haystack = ` ${normalizedSignal(text)} `;
  const exact = kind === "avoid" ? preferenceModel?.titleExclusions : [];
  const signals = kind === "avoid"
    ? preferenceModel?.avoidSignals
    : kind === "deprioritize"
      ? preferenceModel?.deprioritizeSignals
      : preferenceModel?.targetSignals;
  const exactMatch = stringList(exact, 50).find((item) => normalizedSignal(item) === normalizedSignal(text));
  if (exactMatch) return exactMatch;
  return stringList(signals, 40).find((item) => {
    const signal = normalizedSignal(item);
    return signal.length >= 3 && haystack.includes(` ${signal} `);
  }) ?? null;
}
