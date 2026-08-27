import { newId } from "./storage.mjs";
import { matchingPreferenceSignal } from "./learning.mjs";

const DIRECT_MATCHES = [
  ["软件工程", /\b(software engineer|software developer|developer graduate|programmer)\b/i],
  ["数据与分析", /\b(data (analyst|scientist|engineer)|analytics?)\b/i],
  ["AI 与机器学习", /\b(ai engineer|artificial intelligence|machine learning|ml engineer)\b/i],
  ["技术类毕业生项目", /\b(technology|digital|it) graduate\b/i],
  ["技术咨询", /\b(technology|digital|it) consultant\b/i],
  ["Web 开发", /\b(front[- ]?end|back[- ]?end|full[- ]?stack)\b/i],
  ["技术类实习", /\b(software|data|ai|machine learning|technology|it) (engineer )?intern(ship)?\b/i],
  ["系统与自动化", /\b(systems? analyst|automation engineer|cloud engineer|devops)\b/i]
];

const DIRECT_REJECTS = [
  ["医疗、护理或治疗岗位", /\b(nurs(e|ing)|midwi(?:fery|ves?)|medical practitioner|dentist|pharmacist|physio(?:therapist|therapy)|therapist|pathologist|psychologist|radiographer|optometrist|paramedic|clinician|veterinar(?:y|ian)|chiropractor)\b/i],
  ["教学或教育岗位", /\b(teacher|teaching|educator|education officer|school principal|tutor|learning support)\b/i],
  ["建筑或非软件工程岗位", /\b(civil|mechanical|structural|electrical|construction|mining|chemical|geotechnical|hydrographic|environmental)\b.*\b(engineer|survey(?:or|ing))\b|\b(architect|architecture|quantity surveyor)\b/i],
  ["会计或金融岗位", /\b(accountant|accounting|taxation|auditor|financial adviser)\b/i],
  ["法律岗位", /\b(lawyer|legal counsel|solicitor|paralegal)\b/i],
  ["销售、零售或市场岗位", /\b(retail|sales (?:assistant|consultant|executive|representative)|business development|marketing|merchandis(?:e|er|ing)|brand coordinator)\b/i],
  ["招聘或人力资源岗位", /\b(recruit(?:er|ment)|human resources?|people (?:and|&) culture|talent acquisition|career mentor)\b/i],
  ["客户服务或行政岗位", /\b(customer service|customer success|receptionist|administrative? assistant|office administrator|personal assistant)\b/i],
  ["酒店、餐饮或服务岗位", /\b(hospitality|barista|chef|cook|waiter|waitress|food service|housekeeper)\b/i],
  ["资深管理岗位", /\b(head of|director|senior manager|general manager|vice president|principal)\b/i]
];

const PREVIEW_REJECTS = [
  /\b(registered nurse|allied health|patient care|clinical practice|occupational therapy|speech pathology)\b/i,
  /\b(classroom teacher|teaching registration|early childhood education)\b/i,
  /\b(civil construction|structural design|mine site|quantity surveying)\b/i,
  /\b(retail sales|store presentation|customer service counter|hospitality venue)\b/i
];

const PREVIEW_TECH = /\b(software|developer|programming|python|java(?:script)?|typescript|react|node\.?js|sql|data analytics?|machine learning|artificial intelligence|cloud|devops|automation|api|database)\b/i;

const AREA_TERMS = {
  "软件工程": ["software engineer", "software development", "programming", "application development"],
  "AI 与机器学习": ["machine learning", "artificial intelligence", " ai ", "generative ai"],
  "数据与分析": ["data analysis", "data analytics", "data science", "analytics", "sql"],
  "Web 开发": ["frontend", "front-end", "backend", "back-end", "full-stack", "full stack"],
  "云与 DevOps": ["cloud", "aws", "azure", "gcp", "devops"],
  "数据库": ["database", "databases", "postgres", "mysql", "mongodb"],
  "自动化": ["automation", "workflow", "scripting", "ci/cd"]
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
      reason: `职位标题表明这是${reject[0]}，不属于当前设置的技术求职方向。`,
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
  const learnedDeprioritize = matchingPreferenceSignal(cleanTitle, preferenceModel, "deprioritize");
  const learnedTarget = matchingPreferenceSignal(cleanTitle, preferenceModel, "target");
  const preferenceApplied = learnedAvoid || learnedDeprioritize || learnedTarget;

  if (matchedAreas.length) {
    const score = Math.max(0, Math.min(96, 86 + (matchedAreas.length - 1) * 4 + (learnedTarget ? 8 : 0)
      - (learnedAvoid ? 40 : 0) - (learnedDeprioritize ? 12 : 0)));
    return {
      titleClassification: learnedAvoid || learnedDeprioritize ? "AMBIGUOUS" : "CLEAR_MATCH",
      score,
      category: categoryForScore(score, thresholds),
      reason: learnedAvoid
        ? `职位标题符合${matchedAreas.join("、")}方向，但“${learnedAvoid}”属于已确认不相关的职业类别。`
        : learnedDeprioritize
          ? `职位标题符合${matchedAreas.join("、")}方向，但“${learnedDeprioritize}”属于用户仍愿意审阅的低优先级偏好。`
          : `职位标题直接符合${matchedAreas.join("、")}方向${learnedTarget ? `，并命中已学习的偏好“${learnedTarget}”` : ""}。`,
      matchedAreas,
      concerns: learnedAvoid
        ? [`已确认不相关的职业类别：${learnedAvoid}`]
        : learnedDeprioritize ? [`用户偏好中降低优先级：${learnedDeprioritize}`] : [],
      jdReviewed: false,
      screeningStatus: learnedAvoid || learnedDeprioritize ? "NEEDS_JD_REVIEW" : "TITLE_SCREENED",
      engine: preferenceApplied ? "local-rules+feedback" : "local-rules",
      preferenceVersion: preferenceApplied ? Number(preferenceModel?.version) || 0 : null
    };
  }

  const earlyCareer = /\b(graduate|intern|junior|entry[- ]?level|cadet|associate)\b/i.test(cleanTitle);
  const score = Math.max(0, Math.min(100, (earlyCareer ? 58 : 45) + (learnedTarget ? 18 : 0)
    - (learnedAvoid ? 40 : 0) - (learnedDeprioritize ? 12 : 0)));
  return {
    titleClassification: "AMBIGUOUS",
    score,
    category: categoryForScore(score, thresholds),
    reason: learnedAvoid
      ? `“${learnedAvoid}”属于已确认不相关的职业类别，因此该职位不进入常规审阅。`
      : learnedDeprioritize
        ? `“${learnedDeprioritize}”属于用户仍愿意审阅的低优先级偏好，需要读取 JD 再判断。`
        : learnedTarget
          ? `职位标题命中已学习的偏好“${learnedTarget}”，需要读取 JD 确认具体匹配度。`
          : earlyCareer
            ? "初级职位标题范围较宽，需要读取 JD 后再判断。"
            : "职位标题无法确认是否属于目标技术方向，需要读取 JD。",
    matchedAreas: [],
    concerns: [
      "职位标题没有明确说明岗位方向",
      ...(learnedAvoid ? [`已确认不相关的职业类别：${learnedAvoid}`] : []),
      ...(learnedDeprioritize ? [`用户偏好中降低优先级：${learnedDeprioritize}`] : [])
    ],
    jdReviewed: false,
    screeningStatus: learnedAvoid && score < thresholds.lowMatch ? "TITLE_SCREENED" : "NEEDS_JD_REVIEW",
    engine: preferenceApplied ? "local-rules+feedback" : "local-rules",
    preferenceVersion: preferenceApplied ? Number(preferenceModel?.version) || 0 : null
  };
}

function applyPreviewScreen(screening, preview) {
  const text = normalizeText(preview);
  if (!text || screening.titleClassification !== "AMBIGUOUS" || screening.screeningStatus !== "NEEDS_JD_REVIEW") return screening;
  const unrelated = PREVIEW_REJECTS.some((expression) => expression.test(text));
  if (!unrelated || PREVIEW_TECH.test(text)) return screening;
  return {
    ...screening,
    titleClassification: "CLEAR_REJECT",
    score: 8,
    category: "REJECTED",
    reason: "职位卡摘要明确属于非目标专业方向，本地预筛已拦截，无需获取完整 JD 或调用 AI。",
    concerns: unique([...(screening.concerns || []), "职位卡摘要明确属于非目标专业方向"]),
    screeningStatus: "PREVIEW_SCREENED",
    engine: screening.engine.includes("feedback") ? "local-preview+feedback" : "local-preview"
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
    descriptionSource: normalizeText(input.descriptionSource) || null,
    descriptionFetchStatus: normalizeText(input.descriptionFetchStatus) || null,
    descriptionFetchError: normalizeText(input.descriptionFetchError) || null,
    descriptionFetchedAt: normalizeText(input.descriptionFetchedAt) || null,
    postedAt: normalizeText(input.postedAt) || null,
    discoveredAt: new Date().toISOString(),
    searchKeyword: normalizeText(input.searchKeyword || input.keyword) || null,
    searchLocation: normalizeText(input.searchLocation) || null,
    searchPostedWithinDays: Number.isFinite(postedWithinDays) && postedWithinDays >= 0 ? postedWithinDays : null,
    searchJobType: normalizeText(input.searchJobType || input.jobType) || "any",
    profileId: normalizeText(input.profileId) || null,
    runTaskId: normalizeText(input.runTaskId || input.taskId) || null,
    routineTaskId: normalizeText(input.routineTaskId) || null,
    runId,
    duplicateOf,
    screening: applyPreviewScreen(screenTitle(title, { thresholds, preferenceModel }), input.description),
    feedback: null,
    viewedAt: null,
    reviewedAt: null,
    aiReview: null
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
  const email = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0] || "";
  const phone = text.match(/(?:\+?61|0)[\s-]?(?:\d[\s-]?){8,9}/)?.[0] || "";
  const linkedinUrl = text.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s)]+/i)?.[0] || "";
  const githubUrl = text.match(/https?:\/\/(?:www\.)?github\.com\/[^\s)]+/i)?.[0] || "";
  const websiteUrl = [...text.matchAll(/https?:\/\/[^\s)>\]}]+/gi)]
    .map((match) => match[0].replace(/[.,;:]+$/, ""))
    .find((url) => !/(?:linkedin|github)\.com\//i.test(url)) || "";
  const inferredName = sourceName.replace(/\.[^.]+$/, "").replace(/\b(resume|cv)\b/ig, "").replace(/[_-]+/g, " ").trim();

  return validateProfileDraft({
    schemaVersion: 2,
    basicInfo: { name: inferredName, location: "", phone, email, linkedinUrl, githubUrl, websiteUrl },
    visa: { visaType: "", visaName: "", grantedDate: "", expiryDate: "", details: "", forceKeepRequirements: [] },
    workExperience: [],
    projectExperience: [],
    education: [],
    extracurricular: [],
    certifications: [],
    languages: [],
    skills: unique(skills),
    honors: [],
    customSections: []
  });
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

const entryId = (row, prefix, index) => {
  const supplied = normalizeText(row?.id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return supplied || `${prefix}-${index + 1}`;
};

const textField = (row, key, ...aliases) => normalizeText([key, ...aliases]
  .map((field) => row?.[field]).find((value) => value !== undefined));

const rowArray = (value, prefix, limit, mapper) => (Array.isArray(value) ? value : [])
  .slice(0, limit)
  .map((raw, index) => {
    const row = raw && typeof raw === "object" ? raw : { description: raw };
    return { id: entryId(row, prefix, index), ...mapper(row) };
  });

const highlights = (row, ...keys) => stringArray(keys.flatMap((key) => Array.isArray(row?.[key]) ? row[key] : []), 40);

function migrateLegacyProfile(input) {
  const customSections = [];
  const directionHighlights = unique([
    ...stringArray(input.targetRoles),
    ...stringArray(input.focusAreas)
  ]);
  if (input.headline || input.summary || directionHighlights.length) {
    customSections.push({
      id: "legacy-career-direction",
      title: "求职方向",
      entries: [{
        id: "legacy-career-direction-1",
        title: normalizeText(input.headline),
        subtitle: "",
        location: "",
        startDate: "",
        endDate: "",
        description: normalizeText(input.summary),
        highlights: directionHighlights
      }]
    });
  }
  const workTypes = stringArray(input.preferences?.workTypes);
  const exclusions = stringArray(input.preferences?.exclusions).map((value) => `排除：${value}`);
  if (workTypes.length || exclusions.length) {
    customSections.push({
      id: "legacy-job-preferences",
      title: "求职偏好",
      entries: [{ id: "legacy-job-preferences-1", title: "", subtitle: "", location: "", startDate: "", endDate: "", description: "", highlights: [...workTypes, ...exclusions] }]
    });
  }
  const candidates = normalizeCandidateItems(input).items;
  if (candidates.length) {
    customSections.push({
      id: "legacy-candidate-items",
      title: "待整理信息",
      entries: [{ id: "legacy-candidate-items-1", title: "", subtitle: "", location: "", startDate: "", endDate: "", description: "", highlights: candidates }]
    });
  }
  return {
    schemaVersion: 2,
    basicInfo: {
      name: normalizeText(input.name),
      location: stringArray(input.preferences?.locations).join(", "),
      phone: "",
      email: "",
      linkedinUrl: "",
      githubUrl: "",
      websiteUrl: ""
    },
    visa: {
      visaType: normalizeText(input.visaType || input.workRights),
      visaName: "",
      grantedDate: "",
      expiryDate: "",
      details: normalizeText(input.visaDetails || input.workRightsDetails),
      forceKeepRequirements: []
    },
    workExperience: [],
    projectExperience: [],
    education: (Array.isArray(input.education) ? normalizeEducationEntries(input.education) : []).map((description, index) => ({
      id: `legacy-education-${index + 1}`,
      institution: "",
      location: "",
      degree: "",
      field: "",
      startDate: "",
      endDate: "",
      description
    })),
    extracurricular: [],
    certifications: [],
    languages: [],
    skills: stringArray(input.skills, 120),
    honors: [],
    customSections
  };
}

export function validateProfileDraft(input) {
  if (!input || typeof input !== "object") throw new Error("Profile draft must be an object.");
  const source = Number(input.schemaVersion) >= 2 || input.basicInfo || input.workExperience || input.projectExperience || input.customSections
    ? input
    : migrateLegacyProfile(input);
  const basic = source.basicInfo && typeof source.basicInfo === "object" ? source.basicInfo : {};
  const visa = source.visa && typeof source.visa === "object" ? source.visa : {};
  return {
    schemaVersion: 2,
    basicInfo: {
      name: textField(basic, "name"),
      location: textField(basic, "location", "region"),
      phone: textField(basic, "phone", "telephone"),
      email: textField(basic, "email"),
      linkedinUrl: textField(basic, "linkedinUrl", "linkedin"),
      githubUrl: textField(basic, "githubUrl", "github"),
      websiteUrl: textField(basic, "websiteUrl", "website", "personalWebsite", "portfolioUrl")
    },
    visa: {
      visaType: textField(visa, "visaType", "type") || textField(basic, "visaType", "workRights"),
      visaName: textField(visa, "visaName", "name", "subclass"),
      grantedDate: textField(visa, "grantedDate", "grantDate", "issuedDate"),
      expiryDate: textField(visa, "expiryDate", "expires", "endDate"),
      details: textField(visa, "details", "description", "visaDetails") || textField(basic, "visaDetails", "workRightsDetails"),
      forceKeepRequirements: stringArray(visa.forceKeepRequirements || visa.keepRequirements || visa.alwaysKeep, 40)
    },
    workExperience: rowArray(source.workExperience, "work", 40, (row) => ({
      company: textField(row, "company", "organization"), role: textField(row, "role", "title"), location: textField(row, "location"),
      startDate: textField(row, "startDate", "start"), endDate: textField(row, "endDate", "end"),
      description: textField(row, "description", "summary"), highlights: highlights(row, "highlights", "achievements")
    })),
    projectExperience: rowArray(source.projectExperience, "project", 60, (row) => ({
      name: textField(row, "name", "title"), role: textField(row, "role"), startDate: textField(row, "startDate", "start"),
      endDate: textField(row, "endDate", "end"), url: textField(row, "url", "link"), description: textField(row, "description", "summary"),
      technologies: stringArray(row.technologies || row.skills, 40), highlights: highlights(row, "highlights", "achievements")
    })),
    education: rowArray(source.education, "education", 30, (row) => ({
      institution: textField(row, "institution", "school"), location: textField(row, "location"), degree: textField(row, "degree", "qualification"),
      field: textField(row, "field", "major"), startDate: textField(row, "startDate", "start"), endDate: textField(row, "endDate", "end"),
      description: textField(row, "description", "details")
    })),
    extracurricular: rowArray(source.extracurricular, "activity", 40, (row) => ({
      organization: textField(row, "organization", "company"), role: textField(row, "role", "title"), location: textField(row, "location"),
      startDate: textField(row, "startDate", "start"), endDate: textField(row, "endDate", "end"),
      description: textField(row, "description", "summary"), highlights: highlights(row, "highlights", "achievements")
    })),
    certifications: rowArray(source.certifications, "certification", 40, (row) => ({
      name: textField(row, "name", "title"), issuer: textField(row, "issuer", "organization"), issuedDate: textField(row, "issuedDate", "date"),
      expiryDate: textField(row, "expiryDate", "expires"), credentialId: textField(row, "credentialId"), url: textField(row, "url", "link")
    })),
    languages: rowArray(source.languages, "language", 30, (row) => ({
      language: textField(row, "language", "name"), proficiency: textField(row, "proficiency", "level")
    })),
    skills: stringArray(source.skills, 160),
    honors: rowArray(source.honors, "honor", 40, (row) => ({
      title: textField(row, "title", "name"), issuer: textField(row, "issuer", "organization"), date: textField(row, "date"),
      description: textField(row, "description", "details")
    })),
    customSections: rowArray(source.customSections, "section", 20, (section) => ({
      title: textField(section, "title", "name") || "自定义板块",
      entries: rowArray(section.entries, `${entryId(section, "section", 0)}-entry`, 60, (row) => ({
        title: textField(row, "title", "name"), subtitle: textField(row, "subtitle", "organization"), location: textField(row, "location"),
        startDate: textField(row, "startDate", "start"), endDate: textField(row, "endDate", "end"),
        description: textField(row, "description", "summary"), highlights: highlights(row, "highlights", "items")
      }))
    }))
  };
}

export function localJdScreen(job, profile, thresholds, preferenceModel = null) {
  const description = normalizeText(job.description);
  if (!description) throw new Error("A job description is required for JD review.");
  const lower = ` ${description.toLowerCase()} `;
  const jdAreas = Object.entries(AREA_TERMS)
    .filter(([, terms]) => terms.some((term) => lower.includes(term)))
    .map(([area]) => area);
  const profileText = normalizeText(JSON.stringify(profile || {})).toLowerCase();
  const profileAreas = Object.entries(AREA_TERMS)
    .filter(([, terms]) => terms.some((term) => profileText.includes(term)))
    .map(([area]) => area);
  const matchedAreas = jdAreas.filter((area) => profileAreas.includes(area));
  const profileSkills = (profile?.skills ?? []).filter((skill) => lower.includes(skill.toLowerCase()));
  const concerns = [];
  if (/\b([5-9]|10)\+? years?\b|\bextensive leadership\b/i.test(description)) concerns.push("经验年限要求可能超过初级职位范围");
  if (/\b(nursing|teaching|civil engineering|accounting|construction)\b/i.test(description)) concerns.push("JD 可能属于非目标技术领域");
  const learnedAvoid = matchingPreferenceSignal(job.title, preferenceModel, "avoid");
  const learnedDeprioritize = matchingPreferenceSignal(job.title, preferenceModel, "deprioritize");
  const learnedTarget = matchingPreferenceSignal(job.title, preferenceModel, "target");
  const preferenceApplied = learnedAvoid || learnedDeprioritize || learnedTarget;
  if (learnedAvoid) concerns.push(`已确认不相关的职业类别：${learnedAvoid}`);
  if (learnedDeprioritize) concerns.push(`用户偏好中降低优先级：${learnedDeprioritize}`);

  let score = 50 + Math.min(30, matchedAreas.length * 10) + Math.min(20, profileSkills.length * 5) - concerns.length * 12
    + (learnedTarget ? 10 : 0) - (learnedAvoid ? 20 : 0) - (learnedDeprioritize ? 8 : 0);
  if (!matchedAreas.length) score -= 20;
  score = Math.max(0, Math.min(100, score));
  const category = categoryForScore(score, thresholds);

  return {
    titleClassification: job.screening?.titleClassification ?? "AMBIGUOUS",
    score,
    category,
    reason: matchedAreas.length
      ? `JD 与${matchedAreas.join("、")}方向匹配${profileSkills.length ? `，并提到技能 ${profileSkills.slice(0, 3).join("、")}` : ""}。`
      : "JD 中没有足够的目标技术方向证据，暂不判定为更高匹配。",
    matchedAreas: unique([...matchedAreas, ...profileSkills]),
    concerns,
    jdReviewed: true,
    screeningStatus: "JD_SCREENED",
    engine: preferenceApplied ? "local-rules+feedback" : "local-rules",
    preferenceVersion: preferenceApplied ? Number(preferenceModel?.version) || 0 : null,
    roleFitScore: score,
    workRights: {
      assessment: "UNCERTAIN",
      reason: "需要 AI 进行语义审阅后才能判断身份、签证和工作权利是否符合。",
      requirements: []
    }
  };
}

export function validateScreening(input, { thresholds }) {
  const classification = ["CLEAR_MATCH", "CLEAR_REJECT", "AMBIGUOUS"].includes(input?.titleClassification)
    ? input.titleClassification
    : "AMBIGUOUS";
  const suppliedScore = Number(input?.score);
  if (!Number.isFinite(suppliedScore) || suppliedScore < 0 || suppliedScore > 100) throw new Error("AI screening score must be between 0 and 100.");
  const reason = normalizeText(input.reason);
  if (!reason) throw new Error("AI screening reason is required.");
  const suppliedWorkRights = input?.workRights && typeof input.workRights === "object" ? input.workRights : {};
  const validAssessments = new Set(["ELIGIBLE", "INELIGIBLE", "UNCERTAIN", "OVERRIDE_KEEP", "NOT_STATED"]);
  const assessment = validAssessments.has(suppliedWorkRights.assessment) ? suppliedWorkRights.assessment : "UNCERTAIN";
  const workRightsReason = normalizeText(suppliedWorkRights.reason) || "AI 没有给出明确的工作权利结论，保留该职位等待人工确认。";
  const roleFitScore = Math.round(suppliedScore);
  const score = roleFitScore;
  const concerns = stringArray(input.concerns);
  if (assessment === "INELIGIBLE") concerns.push(`工作权利不符合：${workRightsReason}`);
  if (assessment === "UNCERTAIN") concerns.push("工作权利是否符合仍需确认");
  return {
    titleClassification: classification,
    score,
    roleFitScore,
    category: assessment === "INELIGIBLE" ? "REJECTED" : categoryForScore(score, thresholds),
    reason: assessment === "INELIGIBLE" ? workRightsReason : reason,
    matchedAreas: stringArray(input.matchedAreas),
    concerns: unique(concerns),
    jdReviewed: Boolean(input.jdReviewed),
    screeningStatus: "JD_SCREENED",
    engine: "ai",
    workRights: {
      assessment,
      reason: workRightsReason,
      requirements: stringArray(suppliedWorkRights.requirements, 30)
    }
  };
}
