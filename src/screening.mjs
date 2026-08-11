import { newId } from "./storage.mjs";
import { matchingPreferenceSignal } from "./learning.mjs";

const DIRECT_MATCHES = [
  ["software engineering", /\b(software engineer|software developer|developer graduate|programmer)\b/i],
  ["data and analytics", /\b(data (analyst|scientist|engineer)|analytics?)\b/i],
  ["AI and machine learning", /\b(ai engineer|artificial intelligence|machine learning|ml engineer)\b/i],
  ["technology graduate program", /\b(technology|digital|it) graduate\b/i],
  ["technology consulting", /\b(technology|digital|it) consultant\b/i],
  ["web development", /\b(front[- ]?end|back[- ]?end|full[- ]?stack)\b/i],
  ["technology internship", /\b(software|data|ai|machine learning|technology|it) (engineer )?intern(ship)?\b/i],
  ["systems and automation", /\b(systems? analyst|automation engineer|cloud engineer|devops)\b/i]
];

const DIRECT_REJECTS = [
  ["health or care role", /\b(nurs(e|ing)|midwi(f|v)ery|medical|dentist|pharmacist|physiotherapist)\b/i],
  ["teaching or education role", /\b(teacher|teaching|educator|education|school principal)\b/i],
  ["construction or non-software engineering", /\b(civil|mechanical|structural|electrical|construction|mining) engineer\b/i],
  ["accounting or finance role", /\b(accountant|accounting|taxation|auditor|financial adviser)\b/i],
  ["legal role", /\b(lawyer|legal counsel|solicitor|paralegal)\b/i],
  ["senior leadership role", /\b(head of|director|senior manager|general manager|vice president|principal)\b/i]
];

const AREA_TERMS = {
  "software engineering": ["software engineer", "software development", "programming", "application development"],
  "AI and machine learning": ["machine learning", "artificial intelligence", " ai ", "generative ai"],
  "data and analytics": ["data analysis", "data analytics", "data science", "analytics", "sql"],
  "web development": ["frontend", "front-end", "backend", "back-end", "full-stack", "full stack"],
  cloud: ["cloud", "aws", "azure", "gcp", "devops"],
  databases: ["database", "databases", "postgres", "mysql", "mongodb"],
  automation: ["automation", "workflow", "scripting", "ci/cd"]
};

const TECHNOLOGY_TERMS = [
  "python", "java", "javascript", "typescript", "c++", "c#", "react", "node",
  "sql", "aws", "azure", "gcp", "docker", "kubernetes", "git"
];

const normalizeText = (value, fallback = "") =>
  String(value ?? fallback).replace(/\s+/g, " ").trim();

const unique = (items) => [...new Set(items.filter(Boolean))];

export function categoryForScore(score, thresholds) {
  if (score >= thresholds.strongMatch) return "STRONG_MATCH";
  if (score >= thresholds.goodMatch) return "GOOD_MATCH";
  if (score >= thresholds.maybe) return "MAYBE";
  if (score >= thresholds.lowMatch) return "LOW_MATCH";
  return "REJECTED";
}

export function screenTitle(title, { thresholds, preferenceModel = null }) {
  const cleanTitle = normalizeText(title);
  const reject = DIRECT_REJECTS.find(([, expression]) => expression.test(cleanTitle));
  if (reject) {
    return {
      titleClassification: "CLEAR_REJECT",
      score: 5,
      category: "REJECTED",
      reason: `Title indicates a ${reject[0]} outside the configured technology focus.`,
      matchedAreas: [],
      concerns: [reject[0]],
      jdReviewed: false,
      screeningStatus: "TITLE_SCREENED",
      engine: "local-rules"
    };
  }

  const matchedAreas = DIRECT_MATCHES
    .filter(([, expression]) => expression.test(cleanTitle))
    .map(([area]) => area);
  const learnedAvoid = matchingPreferenceSignal(cleanTitle, preferenceModel, "avoid");
  const learnedTarget = matchingPreferenceSignal(cleanTitle, preferenceModel, "target");

  if (matchedAreas.length) {
    const score = Math.max(0, Math.min(96, 86 + (matchedAreas.length - 1) * 4 + (learnedTarget ? 8 : 0) - (learnedAvoid ? 40 : 0)));
    return {
      titleClassification: learnedAvoid ? "AMBIGUOUS" : "CLEAR_MATCH",
      score,
      category: categoryForScore(score, thresholds),
      reason: learnedAvoid
        ? `Title aligns with ${matchedAreas.join(" and ")}, but prior human review flagged “${learnedAvoid}” as unhelpful.`
        : `Title directly aligns with ${matchedAreas.join(" and ")}${learnedTarget ? ` and the learned preference “${learnedTarget}”` : ""}.`,
      matchedAreas,
      concerns: learnedAvoid ? [`human-review preference: ${learnedAvoid}`] : [],
      jdReviewed: false,
      screeningStatus: learnedAvoid ? "NEEDS_JD_REVIEW" : "TITLE_SCREENED",
      engine: learnedAvoid || learnedTarget ? "local-rules+feedback" : "local-rules",
      preferenceVersion: learnedAvoid || learnedTarget ? Number(preferenceModel?.version) || 0 : null
    };
  }

  const earlyCareer = /\b(graduate|intern|junior|entry[- ]?level|cadet|associate)\b/i.test(cleanTitle);
  const score = Math.max(0, Math.min(100, (earlyCareer ? 58 : 45) + (learnedTarget ? 18 : 0) - (learnedAvoid ? 40 : 0)));
  return {
    titleClassification: "AMBIGUOUS",
    score,
    category: categoryForScore(score, thresholds),
    reason: learnedAvoid
      ? `Prior human review flagged “${learnedAvoid}” as unhelpful, so this title was deprioritized.`
      : learnedTarget
        ? `Title contains the learned preference “${learnedTarget}”; review the job description to confirm the fit.`
        : earlyCareer
          ? "Early-career title is broad; review the job description before deciding."
          : "Title does not establish a clear technology fit; review the job description.",
    matchedAreas: [],
    concerns: ["role focus is not explicit in the title", ...(learnedAvoid ? [`human-review preference: ${learnedAvoid}`] : [])],
    jdReviewed: false,
    screeningStatus: learnedAvoid && score < thresholds.lowMatch ? "TITLE_SCREENED" : "NEEDS_JD_REVIEW",
    engine: learnedAvoid || learnedTarget ? "local-rules+feedback" : "local-rules",
    preferenceVersion: learnedAvoid || learnedTarget ? Number(preferenceModel?.version) || 0 : null
  };
}

export function normalizeJob(input, { thresholds, runId = null, duplicateOf = null, preferenceModel = null } = {}) {
  const source = ["linkedin", "indeed", "seek", "manual"].includes(String(input.source).toLowerCase())
    ? String(input.source).toLowerCase()
    : "manual";
  const title = normalizeText(input.title);
  if (!title) throw new Error("Each job needs a title.");

  const jobUrl = normalizeText(input.jobUrl || input.link) || null;
  const sourceJobId = normalizeText(input.sourceJobId || input.jobId || input.id) || null;
  const postedWithinDays = Number(input.searchPostedWithinDays);
  return {
    id: newId("job"),
    source,
    sourceJobId,
    title,
    company: normalizeText(input.company) || null,
    location: normalizeText(input.location) || null,
    jobUrl,
    description: normalizeText(input.description) || null,
    postedAt: normalizeText(input.postedAt) || null,
    discoveredAt: new Date().toISOString(),
    searchKeyword: normalizeText(input.searchKeyword || input.keyword) || null,
    searchLocation: normalizeText(input.searchLocation) || null,
    searchPostedWithinDays: Number.isFinite(postedWithinDays) && postedWithinDays >= 0 ? postedWithinDays : null,
    runTaskId: normalizeText(input.runTaskId || input.taskId) || null,
    routineTaskId: normalizeText(input.routineTaskId) || null,
    runId,
    duplicateOf,
    screening: screenTitle(title, { thresholds, preferenceModel }),
    feedback: null
  };
}

export function strongSourceKey(job) {
  if (job.sourceJobId) return `${job.source}:id:${job.sourceJobId}`;
  if (job.jobUrl) return `${job.source}:url:${job.jobUrl.toLowerCase().replace(/[?#].*$/, "")}`;
  return null;
}

export function localProfileDraft(resumeText, sourceName = "resume") {
  const text = normalizeText(resumeText);
  const lower = ` ${text.toLowerCase()} `;
  const skills = TECHNOLOGY_TERMS.filter((skill) => lower.includes(` ${skill} `));
  const areas = Object.entries(AREA_TERMS)
    .filter(([, terms]) => terms.some((term) => lower.includes(term)))
    .map(([area]) => area);
  const education = /\b(bachelor|master|university|graduate diploma|phd)\b/i.test(text)
    ? ["Higher education mentioned in resume; confirm degree and graduation window."]
    : [];
  const inferredRoles = unique([
    areas.includes("software engineering") && "Graduate Software Engineer",
    areas.includes("AI and machine learning") && "Machine Learning Intern",
    areas.includes("data and analytics") && "Graduate Data Analyst",
    areas.includes("web development") && "Junior Full-stack Developer",
    "Technology Graduate Program"
  ]);

  return {
    name: sourceName.replace(/\.[^.]+$/, "") || "Career profile",
    headline: inferredRoles[0] || "Early-career technology candidate",
    summary: text
      ? "Draft generated locally from the uploaded resume. Review and approve before using it for JD screening."
      : "Add resume text before generating a profile.",
    targetRoles: inferredRoles,
    focusAreas: unique(areas.length ? areas : ["software engineering", "technology graduate programs"]),
    skills: unique(skills),
    education,
    preferences: {
      locations: [],
      workTypes: [],
      exclusions: []
    },
    candidateItems: [],
    source: "local-rules"
  };
}

const stringArray = (value, limit = 30) =>
  unique((Array.isArray(value) ? value : []).map((item) => normalizeText(item)).filter(Boolean)).slice(0, limit);

const PROFILE_SUGGESTION_SECTIONS = new Set([
  "targetRoles",
  "focusAreas",
  "skills",
  "education",
  "locations",
  "workTypes",
  "exclusions"
]);

export function suggestProfileSection(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return "focusAreas";
  if (/\b(bachelor|master|phd|doctorate|degree|diploma|certificate|university|college|unsw|rmit|monash)\b|\b(19|20)\d{2}\b/i.test(text)) return "education";
  if (/\b(developer|engineer|analyst|consultant|intern|graduate program|specialist|architect)\b/i.test(text)) return "targetRoles";
  if (/\b(remote|hybrid|on[- ]?site|full[- ]?time|part[- ]?time|contract|casual|internship)\b/i.test(text)) return "workTypes";
  if (/\b(avoid|exclude|not interested|do not target|no sales|no support)\b/i.test(text)) return "exclusions";
  if (/\b(melbourne|sydney|brisbane|perth|adelaide|canberra|australia|victoria|new south wales|queensland|nsw|vic|qld|wa|sa|act)\b/i.test(text)) return "locations";
  if (/\b(python|java(script)?|typescript|react|next\.?js|node\.?js|sql|firebase|tensorflow|pytorch|scikit|git|aws|azure|gcp|docker|kubernetes|c\+\+|c#)\b/i.test(text)) return "skills";
  return "focusAreas";
}

export function normalizeEducationEntries(value) {
  const entries = stringArray(value, 60);
  const normalized = [];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    normalized.push(pending.join(" | "));
    pending = [];
  };

  for (const entry of entries) {
    const hasDegree = /\b(bachelor|master|phd|doctorate|degree|diploma|certificate|bsc|msc|mba|mit)\b/i.test(entry);
    const hasInstitution = /\b(university|college|institute|school|unsw|rmit|monash)\b/i.test(entry);
    const hasDate = /\b(?:19|20)\d{2}(?:\s*[-/]\s*(?:19|20)?\d{2}|\s*(?:to|present|current))?\b/i.test(entry);

    if (hasDegree) {
      flush();
      pending = [entry];
      if (hasInstitution && hasDate) flush();
      continue;
    }
    if (pending.length && (hasInstitution || hasDate)) {
      pending.push(entry);
      if (hasDate) flush();
      continue;
    }
    flush();
    normalized.push(entry);
  }
  flush();
  return unique(normalized);
}

function normalizeCandidateItems(input) {
  const suppliedSuggestions = input?.candidateSuggestions && typeof input.candidateSuggestions === "object"
    ? input.candidateSuggestions
    : {};
  const rows = Array.isArray(input?.candidateItems) ? input.candidateItems : [];
  const items = [];
  const suggestions = {};
  for (const row of rows) {
    const value = normalizeText(typeof row === "string" ? row : row?.value ?? row?.label);
    if (!value || items.some((item) => item.toLowerCase() === value.toLowerCase())) continue;
    const suppliedSection = typeof row === "object" ? row?.suggestedSection ?? row?.suggestedCategory : suppliedSuggestions[value];
    const section = PROFILE_SUGGESTION_SECTIONS.has(suppliedSection) ? suppliedSection : suggestProfileSection(value);
    items.push(value);
    suggestions[value] = section;
    if (items.length >= 80) break;
  }
  return { items, suggestions };
}

export function validateProfileDraft(input) {
  if (!input || typeof input !== "object") throw new Error("Profile draft must be an object.");
  const candidates = normalizeCandidateItems(input);
  const profile = {
    name: normalizeText(input.name) || "Career profile",
    headline: normalizeText(input.headline) || "Early-career technology candidate",
    summary: normalizeText(input.summary),
    targetRoles: stringArray(input.targetRoles),
    focusAreas: stringArray(input.focusAreas),
    skills: stringArray(input.skills, 60),
    education: normalizeEducationEntries(input.education),
    preferences: {
      locations: stringArray(input.preferences?.locations),
      workTypes: stringArray(input.preferences?.workTypes),
      exclusions: stringArray(input.preferences?.exclusions)
    },
    candidateItems: candidates.items
  };
  if (candidates.items.length) profile.candidateSuggestions = candidates.suggestions;
  if (!profile.summary) throw new Error("Profile summary is required.");
  return profile;
}

export function localJdScreen(job, profile, thresholds, preferenceModel = null) {
  const description = normalizeText(job.description);
  if (!description) throw new Error("A job description is required for JD review.");
  const lower = ` ${description.toLowerCase()} `;
  const matchedAreas = Object.entries(AREA_TERMS)
    .filter(([, terms]) => terms.some((term) => lower.includes(term)))
    .map(([area]) => area);
  const profileSkills = (profile?.skills ?? []).filter((skill) => lower.includes(skill.toLowerCase()));
  const concerns = [];
  if (/\b([5-9]|10)\+? years?\b|\bextensive leadership\b/i.test(description)) concerns.push("experience requirement may exceed an early-career role");
  if (/\b(permanent resident|citizen(ship)? required|security clearance)\b/i.test(description)) concerns.push("eligibility requirement needs confirmation");
  if (/\b(nursing|teaching|civil engineering|accounting|construction)\b/i.test(description)) concerns.push("JD contains a potential non-technology discipline mismatch");
  const learnedAvoid = matchingPreferenceSignal(job.title, preferenceModel, "avoid");
  const learnedTarget = matchingPreferenceSignal(job.title, preferenceModel, "target");
  if (learnedAvoid) concerns.push(`human-review preference: ${learnedAvoid}`);

  let score = 50 + Math.min(30, matchedAreas.length * 8) + Math.min(15, profileSkills.length * 3) - concerns.length * 12
    + (learnedTarget ? 10 : 0) - (learnedAvoid ? 20 : 0);
  if (!matchedAreas.length) score -= 20;
  score = Math.max(0, Math.min(100, score));
  const category = categoryForScore(score, thresholds);

  return {
    titleClassification: job.screening?.titleClassification ?? "AMBIGUOUS",
    score,
    category,
    reason: matchedAreas.length
      ? `JD aligns with ${matchedAreas.join(", ")}${profileSkills.length ? ` and mentions ${profileSkills.slice(0, 3).join(", ")}` : ""}.`
      : "JD does not provide enough technology alignment for a stronger match.",
    matchedAreas: unique([...matchedAreas, ...profileSkills]),
    concerns,
    jdReviewed: true,
    screeningStatus: "JD_SCREENED",
    engine: learnedAvoid || learnedTarget ? "local-rules+feedback" : "local-rules",
    preferenceVersion: learnedAvoid || learnedTarget ? Number(preferenceModel?.version) || 0 : null
  };
}

export function validateScreening(input, { thresholds }) {
  const classification = ["CLEAR_MATCH", "CLEAR_REJECT", "AMBIGUOUS"].includes(input?.titleClassification)
    ? input.titleClassification
    : "AMBIGUOUS";
  const score = Number(input?.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error("AI screening score must be between 0 and 100.");
  const reason = normalizeText(input.reason);
  if (!reason) throw new Error("AI screening reason is required.");
  return {
    titleClassification: classification,
    score: Math.round(score),
    category: categoryForScore(Math.round(score), thresholds),
    reason,
    matchedAreas: stringArray(input.matchedAreas),
    concerns: stringArray(input.concerns),
    jdReviewed: Boolean(input.jdReviewed),
    screeningStatus: "JD_SCREENED",
    engine: "ai"
  };
}
