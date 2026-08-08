import { newId } from "./storage.mjs";

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

export function screenTitle(title, { thresholds }) {
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

  if (matchedAreas.length) {
    const score = Math.min(96, 86 + (matchedAreas.length - 1) * 4);
    return {
      titleClassification: "CLEAR_MATCH",
      score,
      category: categoryForScore(score, thresholds),
      reason: `Title directly aligns with ${matchedAreas.join(" and ")}.`,
      matchedAreas,
      concerns: [],
      jdReviewed: false,
      screeningStatus: "TITLE_SCREENED",
      engine: "local-rules"
    };
  }

  const earlyCareer = /\b(graduate|intern|junior|entry[- ]?level|cadet|associate)\b/i.test(cleanTitle);
  return {
    titleClassification: "AMBIGUOUS",
    score: earlyCareer ? 58 : 45,
    category: categoryForScore(earlyCareer ? 58 : 45, thresholds),
    reason: earlyCareer
      ? "Early-career title is broad; review the job description before deciding."
      : "Title does not establish a clear technology fit; review the job description.",
    matchedAreas: [],
    concerns: ["role focus is not explicit in the title"],
    jdReviewed: false,
    screeningStatus: "NEEDS_JD_REVIEW",
    engine: "local-rules"
  };
}

export function normalizeJob(input, { thresholds, runId = null, duplicateOf = null } = {}) {
  const source = ["linkedin", "indeed", "seek", "manual"].includes(String(input.source).toLowerCase())
    ? String(input.source).toLowerCase()
    : "manual";
  const title = normalizeText(input.title);
  if (!title) throw new Error("Each job needs a title.");

  const jobUrl = normalizeText(input.jobUrl || input.link) || null;
  const sourceJobId = normalizeText(input.sourceJobId || input.jobId || input.id) || null;
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
    runId,
    duplicateOf,
    screening: screenTitle(title, { thresholds })
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
    source: "local-rules"
  };
}

const stringArray = (value, limit = 30) =>
  unique((Array.isArray(value) ? value : []).map((item) => normalizeText(item)).filter(Boolean)).slice(0, limit);

export function validateProfileDraft(input) {
  if (!input || typeof input !== "object") throw new Error("Profile draft must be an object.");
  const profile = {
    name: normalizeText(input.name) || "Career profile",
    headline: normalizeText(input.headline) || "Early-career technology candidate",
    summary: normalizeText(input.summary),
    targetRoles: stringArray(input.targetRoles),
    focusAreas: stringArray(input.focusAreas),
    skills: stringArray(input.skills, 60),
    education: stringArray(input.education),
    preferences: {
      locations: stringArray(input.preferences?.locations),
      workTypes: stringArray(input.preferences?.workTypes),
      exclusions: stringArray(input.preferences?.exclusions)
    }
  };
  if (!profile.summary) throw new Error("Profile summary is required.");
  return profile;
}

export function localJdScreen(job, profile, thresholds) {
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

  let score = 50 + Math.min(30, matchedAreas.length * 8) + Math.min(15, profileSkills.length * 3) - concerns.length * 12;
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
    engine: "local-rules"
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
