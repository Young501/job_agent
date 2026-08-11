const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const unique = (items) => [...new Set(items.map(normalizeText).filter(Boolean))];

function stringList(value, limit = 30) {
  return unique(Array.isArray(value) ? value : []).slice(0, limit);
}

export function validatePreferenceModel(input = {}, metadata = {}) {
  return {
    version: Math.max(0, Number(metadata.version ?? input.version) || 0),
    summary: normalizeText(input.summary) || "尚未形成稳定的人工审阅偏好。",
    targetSignals: stringList(input.targetSignals, 24),
    avoidSignals: stringList(input.avoidSignals, 36),
    titleExclusions: stringList(input.titleExclusions, 50),
    screeningGuidance: stringList(input.screeningGuidance, 16),
    feedbackCount: Math.max(0, Number(metadata.feedbackCount ?? input.feedbackCount) || 0),
    sourceRunId: metadata.sourceRunId ?? input.sourceRunId ?? null,
    engine: normalizeText(metadata.engine ?? input.engine) || "local-rules",
    updatedAt: metadata.updatedAt ?? input.updatedAt ?? null
  };
}

export function localPreferenceReflection(feedbackJobs, metadata = {}) {
  const feedback = Array.isArray(feedbackJobs) ? feedbackJobs : [];
  const wrong = feedback.filter((item) => item.feedback?.reason === "CLASSIFICATION_WRONG").length;
  const unrelated = feedback.filter((item) => item.feedback?.reason === "NOT_RELEVANT").length;
  const notes = unique(feedback.map((item) => item.feedback?.note)).slice(0, 8);
  const titleExclusions = unique(feedback.map((item) => item.title)).slice(0, 50);
  const details = [
    wrong ? `${wrong} 条被标记为分类偏高` : "",
    unrelated ? `${unrelated} 条被标记为与求职方向无关` : "",
    feedback.length - wrong - unrelated ? `${feedback.length - wrong - unrelated} 条未补充原因` : ""
  ].filter(Boolean);
  return validatePreferenceModel({
    summary: feedback.length
      ? `已从 ${feedback.length} 条“没帮助”反馈中整理偏好：${details.join("，")}。`
      : "尚未收到可用于复盘的“没帮助”反馈。",
    targetSignals: [],
    avoidSignals: [],
    titleExclusions,
    screeningGuidance: feedback.length
      ? [
          "后续出现相同职位名称时降低初筛优先级，但仍保留职位记录。",
          ...notes.map((note) => `用户补充：${note}`)
        ]
      : []
  }, metadata);
}

function normalizedSignal(value) {
  return normalizeText(value).toLowerCase().replace(/^["']|["']$/g, "");
}

export function matchingPreferenceSignal(text, preferenceModel, kind = "avoid") {
  const haystack = ` ${normalizedSignal(text)} `;
  const exact = kind === "avoid" ? preferenceModel?.titleExclusions : [];
  const signals = kind === "avoid" ? preferenceModel?.avoidSignals : preferenceModel?.targetSignals;
  const exactMatch = stringList(exact, 50).find((item) => normalizedSignal(item) === normalizedSignal(text));
  if (exactMatch) return exactMatch;
  return stringList(signals, 40).find((item) => {
    const signal = normalizedSignal(item);
    return signal.length >= 3 && haystack.includes(` ${signal} `);
  }) ?? null;
}
