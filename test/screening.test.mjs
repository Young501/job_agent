import assert from "node:assert/strict";
import test from "node:test";

import {
  categoryForScore,
  localJdScreen,
  localProfileDraft,
  normalizeEducationEntries,
  normalizeJob,
  screenTitle,
  suggestProfileSection,
  strongSourceKey,
  validateProfileDraft,
  validateScreening
} from "../src/screening.mjs";
import {
  compactExclusionKeyword,
  ensurePreferenceModelNegativeCoverage,
  localPreferenceReflection,
  matchingPreferenceSignal,
  validatePreferenceModel,
  validatePreferenceSignals
} from "../src/learning.mjs";

const thresholds = { strongMatch: 85, goodMatch: 70, maybe: 50, lowMatch: 30 };

test("exclusion suggestions collapse job titles to one reusable English keyword", () => {
  assert.equal(compactExclusionKeyword("Occupational Therapist - Graduate Program 2027"), "therapist");
  assert.equal(compactExclusionKeyword("Graduate Speech Pathologist | Hobart"), "pathologist");
  assert.equal(compactExclusionKeyword("Hydrographic Surveyor"), "surveyor");
  assert.equal(compactExclusionKeyword("Career Mentor"), "mentor");
  assert.equal(compactExclusionKeyword("Dams & Hydropower"), "hydropower");
  assert.equal(compactExclusionKeyword("People Graduate"), null);
});

test("direct technology titles are clear matches", () => {
  const result = screenTitle("Graduate Software Engineer", { thresholds });
  assert.equal(result.titleClassification, "CLEAR_MATCH");
  assert.equal(result.category, "STRONG_MATCH");
  assert.equal(result.jdReviewed, false);
  assert.match(result.reason, /职位标题/);
  assert.deepEqual(result.matchedAreas, ["软件工程"]);
});

test("clear non-technology titles are rejected without JD review", () => {
  const result = screenTitle("Senior Civil Engineer", { thresholds });
  assert.equal(result.titleClassification, "CLEAR_REJECT");
  assert.equal(result.category, "REJECTED");
  assert.match(result.reason, /不属于当前设置的技术求职方向/);
});

test("explicitly unrelated early-career titles do not consume JD or AI review", () => {
  for (const title of [
    "Occupational Therapist - Graduate Program 2027",
    "Graduate Speech Pathologist | Hobart",
    "Digital Marketing Intern",
    "Graduate Recruitment Consultant",
    "Retail Sales Assistant"
  ]) {
    const result = screenTitle(title, { thresholds });
    assert.equal(result.titleClassification, "CLEAR_REJECT", title);
    assert.equal(result.screeningStatus, "TITLE_SCREENED", title);
    assert.equal(result.jdReviewed, false, title);
  }
});

test("an ambiguous title can be rejected from a clearly unrelated card snippet", () => {
  const job = normalizeJob({
    source: "seek",
    sourceJobId: "preview-reject",
    title: "Graduate Program 2027",
    description: "Join our allied health team to deliver occupational therapy and patient care in a clinical practice."
  }, { thresholds });
  assert.equal(job.screening.titleClassification, "CLEAR_REJECT");
  assert.equal(job.screening.screeningStatus, "PREVIEW_SCREENED");
  assert.equal(job.screening.engine, "local-preview");
});

test("broad early-career titles request JD review", () => {
  const result = screenTitle("Graduate Analyst", { thresholds });
  assert.equal(result.titleClassification, "AMBIGUOUS");
  assert.equal(result.screeningStatus, "NEEDS_JD_REVIEW");
});

test("human feedback deprioritizes a repeated title without deleting it", () => {
  const preferenceModel = {
    version: 2,
    titleExclusions: [],
    avoidSignals: [],
    deprioritizeSignals: ["backend"],
    targetSignals: []
  };
  const result = screenTitle("Graduate Backend Developer", { thresholds, preferenceModel });
  assert.equal(result.category, "GOOD_MATCH");
  assert.equal(result.screeningStatus, "NEEDS_JD_REVIEW");
  assert.equal(result.engine, "local-rules+feedback");
  assert.equal(result.preferenceVersion, 2);
  assert.match(result.reason, /低优先级/);
});

test("local reflection uses only active not-helpful feedback", () => {
  const model = localPreferenceReflection([{
    title: "Retail Sales Graduate",
    feedback: { reason: "NOT_RELEVANT", note: "This is a sales role." }
  }], { version: 1, feedbackCount: 1, sourceRunId: "run_1" });
  assert.deepEqual(model.titleExclusions, ["Retail Sales Graduate"]);
  assert.deepEqual(model.avoidSignals, ["sales"]);
  assert.deepEqual(model.deprioritizeSignals, []);
  assert.equal(matchingPreferenceSignal("Retail Sales Graduate", model, "avoid"), "Retail Sales Graduate");
  assert.match(model.summary, /1 条/);
});

test("soft negative feedback creates a short deprioritize keyword without excluding the title", () => {
  const model = localPreferenceReflection([{
    title: "Technical Documentation Graduate",
    feedback: { reason: "ROLE_NOT_INTERESTED", note: "Still reviewable, but not a preferred direction." }
  }]);
  assert.deepEqual(model.deprioritizeSignals, ["documentation"]);
  assert.deepEqual(model.avoidSignals, []);
  assert.deepEqual(model.titleExclusions, []);
  assert.equal(matchingPreferenceSignal("Graduate Documentation Specialist", model, "deprioritize"), "documentation");
});

test("local reflection clears guidance when all feedback is removed", () => {
  const model = localPreferenceReflection([], { version: 2, feedbackCount: 0 });
  assert.deepEqual(model.titleExclusions, []);
  assert.deepEqual(model.screeningGuidance, []);
  assert.match(model.summary, /尚未收到/);
});

test("local reflection separates useful targets from AI exclusion suggestions", () => {
  const model = localPreferenceReflection({
    helpfulJobs: [{
      title: "Junior Backend Developer",
      feedback: { note: "I would apply for this role." },
      learningSignals: { targetKeywords: ["backend APIs", "Python"] }
    }],
    rejectedJobs: [{
      title: "Retail Store Assistant",
      learningSignals: { exclusionKeywords: ["retail sales"] }
    }],
    legacyNotHelpfulJobs: []
  });
  assert.deepEqual(model.targetSignals, ["backend APIs", "Python", "Junior Backend Developer"]);
  assert.deepEqual(model.avoidSignals, ["sales"]);
  assert.equal(model.positiveFeedbackCount, 1);
  assert.equal(model.rejectedSignalCount, 1);
  assert.match(model.screeningGuidance.join(" "), /用户在搜索设置中批准/);
});

test("a human-confirmed rejection becomes exclusion evidence, not a target", () => {
  const model = localPreferenceReflection({
    helpfulJobs: [],
    rejectedJobs: [{
      title: "Graduate Retail Merchandiser",
      feedback: { helpfulness: "HELPFUL", reason: "REJECTION_CORRECT" },
      learningSignals: { exclusionKeywords: ["retail merchandising"] }
    }],
    legacyNotHelpfulJobs: []
  });
  assert.deepEqual(model.targetSignals, []);
  assert.deepEqual(model.avoidSignals, ["merchandising"]);
  assert.deepEqual(model.titleExclusions, ["Graduate Retail Merchandiser"]);
  assert.equal(model.positiveFeedbackCount, 0);
  assert.equal(model.rejectedSignalCount, 1);
});

test("human-confirmed negative evidence cannot be omitted by an AI reflection", () => {
  const model = ensurePreferenceModelNegativeCoverage({
    summary: "The AI omitted negative signals.",
    titleExclusions: ["Speech Pathologist"]
  }, [
    {
      title: "Graduate Speech Pathologist | Hobart",
      feedback: { helpfulness: "HELPFUL", reason: "REJECTION_CORRECT" }
    },
    {
      title: "Career Mentor",
      feedback: { helpfulness: "NOT_HELPFUL", reason: "NOT_RELEVANT" }
    },
    {
      title: "Graduate Software Developer",
      feedback: { helpfulness: "NOT_HELPFUL", reason: "CLASSIFICATION_WRONG" }
    }
  ]);
  assert.deepEqual(model.titleExclusions, ["Speech Pathologist", "Career Mentor"]);
});

test("machine matching signals remain English and discard translated keywords", () => {
  const signals = validatePreferenceSignals({
    targetKeywords: ["backend APIs", "后端开发"],
    exclusionKeywords: ["retail merchandising", "零售陈列"],
    exclusionReason: "该岗位属于零售陈列，不符合技术方向。"
  });
  assert.deepEqual(signals.targetKeywords, ["backend APIs"]);
  assert.deepEqual(signals.exclusionKeywords, ["retail merchandising"]);
  assert.match(signals.exclusionReason, /零售陈列/);
  const model = validatePreferenceModel({
    summary: "中文摘要",
    targetSignals: ["software engineering", "软件工程"],
    deprioritizeSignals: ["technical documentation", "技术文档"],
    avoidSignals: ["retail sales", "零售销售"],
    titleExclusions: ["Graduate Retail Assistant", "毕业生零售助理"],
    screeningGuidance: ["中文筛选说明"]
  });
  assert.deepEqual(model.targetSignals, ["software engineering"]);
  assert.deepEqual(model.deprioritizeSignals, ["documentation"]);
  assert.deepEqual(model.avoidSignals, ["sales"]);
  assert.deepEqual(model.titleExclusions, ["Graduate Retail Assistant"]);
  assert.equal(model.summary, "中文摘要");
});

test("legacy classification-wrong feedback becomes positive correction evidence", () => {
  const model = localPreferenceReflection([{
    title: "Occupational Therapist Graduate Program",
    feedback: { reason: "CLASSIFICATION_WRONG", note: "Do not reject this role automatically." }
  }]);
  assert.deepEqual(model.targetSignals, ["Occupational Therapist Graduate Program"]);
  assert.deepEqual(model.titleExclusions, []);
  assert.equal(model.positiveFeedbackCount, 1);
});

test("normalization preserves source keys and missing optional data", () => {
  const job = normalizeJob({
    source: "seek",
    jobId: "987",
    title: "Junior Systems Analyst",
    company: "Example Pty Ltd",
    runTaskId: "task_123",
    routineTaskId: "routine_456",
    description: "A complete job description.",
    descriptionSource: "detail-page",
    descriptionFetchStatus: "fetched",
    searchPostedWithinDays: 7
  }, { thresholds });
  assert.equal(job.source, "seek");
  assert.equal(job.location, null);
  assert.equal(job.runTaskId, "task_123");
  assert.equal(job.routineTaskId, "routine_456");
  assert.equal(job.searchPostedWithinDays, 7);
  assert.equal(job.descriptionSource, "detail-page");
  assert.equal(job.descriptionFetchStatus, "fetched");
  assert.equal(job.viewedAt, null);
  assert.equal(strongSourceKey(job), "seek:id:987");
});

test("local JD review uses relevant text and caps the score", () => {
  const job = normalizeJob({
    source: "indeed",
    title: "Graduate Analyst",
    description: "Use Python and SQL for data analytics projects on AWS cloud services."
  }, { thresholds });
  const screening = localJdScreen(job, { skills: ["Python", "SQL"], focusAreas: ["data and analytics"] }, thresholds);
  assert.equal(screening.jdReviewed, true);
  assert.ok(screening.score >= 70);
  assert.ok(screening.matchedAreas.includes("数据与分析"));
  assert.equal(screening.workRights.assessment, "UNCERTAIN");
});

test("AI data is validated and category is derived from the configured threshold", () => {
  const screening = validateScreening({
    titleClassification: "AMBIGUOUS",
    score: 84.4,
    reason: "The JD focuses on entry-level data engineering.",
    matchedAreas: ["data engineering"],
    concerns: [],
    jdReviewed: true
  }, { thresholds });
  assert.equal(screening.score, 84);
  assert.equal(screening.category, "GOOD_MATCH");
  assert.equal(screening.workRights.assessment, "UNCERTAIN");
  assert.equal(categoryForScore(29, thresholds), "REJECTED");
});

test("AI work-rights conclusions reject only explicit incompatibility", () => {
  const screening = validateScreening({
    titleClassification: "CLEAR_MATCH",
    score: 91,
    reason: "The role is a strong technical match.",
    matchedAreas: ["software engineering"],
    concerns: [],
    jdReviewed: true,
    workRights: {
      assessment: "INELIGIBLE",
      reason: "The role explicitly requires Australian citizenship and the candidate holds a student visa.",
      requirements: ["Australian citizenship required"]
    }
  }, { thresholds });
  assert.equal(screening.score, 91);
  assert.equal(screening.roleFitScore, 91);
  assert.equal(screening.category, "REJECTED");
  assert.equal(screening.workRights.assessment, "INELIGIBLE");
});

test("AI visa override preserves the role-fit category", () => {
  const screening = validateScreening({
    titleClassification: "CLEAR_MATCH",
    score: 78,
    reason: "The role aligns with the candidate's backend experience.",
    matchedAreas: ["software engineering"],
    concerns: [],
    jdReviewed: true,
    workRights: {
      assessment: "OVERRIDE_KEEP",
      reason: "Permanent-resident roles are in the user's forced-retention list.",
      requirements: ["Australian citizen or permanent resident"]
    }
  }, { thresholds });
  assert.equal(screening.category, "GOOD_MATCH");
  assert.equal(screening.workRights.assessment, "OVERRIDE_KEEP");
});

test("education fragments are combined into complete qualification records", () => {
  assert.deepEqual(normalizeEducationEntries([
    "Master of Information Technology in Artificial Intelligence",
    "University of Melbourne",
    "2025-2026",
    "Bachelor of Science in Computer Science",
    "UNSW",
    "2022-2024"
  ]), [
    "Master of Information Technology in Artificial Intelligence | University of Melbourne | 2025-2026",
    "Bachelor of Science in Computer Science | UNSW | 2022-2024"
  ]);
});

test("legacy tag profiles migrate into the structured candidate record", () => {
  const profile = validateProfileDraft({
    name: "Candidate",
    headline: "Graduate developer",
    summary: "Evidence-based profile summary.",
    candidateItems: [
      { value: "Python", suggestedSection: "skills" },
      { value: "Backend API projects", suggestedSection: "focusAreas" }
    ]
  });
  assert.equal(profile.schemaVersion, 2);
  assert.equal(profile.basicInfo.name, "Candidate");
  assert.equal(profile.customSections[0].title, "求职方向");
  assert.deepEqual(profile.customSections.at(-1).entries[0].highlights, ["Python", "Backend API projects"]);
  assert.equal(suggestProfileSection("Graduate Software Engineer"), "targetRoles");
});

test("structured profiles preserve complete optional experience records", () => {
  const profile = validateProfileDraft({
    schemaVersion: 2,
    basicInfo: { name: "Candidate", email: "candidate@example.com", visaType: "Student visa", visaDetails: "Limited work rights" },
    visa: { visaName: "Subclass 500", grantedDate: "2025-02", expiryDate: "2027-03", forceKeepRequirements: ["Australian permanent resident"] },
    education: [{ institution: "University of Melbourne", location: "Melbourne", degree: "Master of IT", field: "AI", startDate: "2025", endDate: "2026" }],
    projectExperience: [{ name: "Job Agent", role: "Developer", technologies: ["JavaScript", "Node.js"], highlights: ["Automated JD review"] }],
    skills: ["JavaScript", "Node.js"]
  });
  assert.equal(profile.basicInfo.phone, "");
  assert.equal(profile.basicInfo.websiteUrl, "");
  assert.equal(profile.basicInfo.visaType, undefined);
  assert.equal(profile.visa.visaType, "Student visa");
  assert.equal(profile.visa.visaName, "Subclass 500");
  assert.equal(profile.visa.details, "Limited work rights");
  assert.deepEqual(profile.visa.forceKeepRequirements, ["Australian permanent resident"]);
  assert.equal(profile.education[0].institution, "University of Melbourne");
  assert.equal(profile.education[0].degree, "Master of IT");
  assert.deepEqual(profile.projectExperience[0].technologies, ["JavaScript", "Node.js"]);
});

test("local resume extraction separates personal, LinkedIn, and GitHub URLs", () => {
  const profile = localProfileDraft([
    "Candidate Name",
    "https://linkedin.com/in/candidate",
    "https://github.com/candidate",
    "https://candidate.example/portfolio"
  ].join("\n"), "Candidate Resume.pdf");
  assert.equal(profile.basicInfo.linkedinUrl, "https://linkedin.com/in/candidate");
  assert.equal(profile.basicInfo.githubUrl, "https://github.com/candidate");
  assert.equal(profile.basicInfo.websiteUrl, "https://candidate.example/portfolio");
});
