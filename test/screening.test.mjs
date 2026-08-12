import assert from "node:assert/strict";
import test from "node:test";

import {
  categoryForScore,
  localJdScreen,
  normalizeEducationEntries,
  normalizeJob,
  screenTitle,
  suggestProfileSection,
  strongSourceKey,
  validateProfileDraft,
  validateScreening
} from "../src/screening.mjs";
import { localPreferenceReflection, matchingPreferenceSignal } from "../src/learning.mjs";

const thresholds = { strongMatch: 85, goodMatch: 70, maybe: 50, lowMatch: 30 };

test("direct technology titles are clear matches", () => {
  const result = screenTitle("Graduate Software Engineer", { thresholds });
  assert.equal(result.titleClassification, "CLEAR_MATCH");
  assert.equal(result.category, "STRONG_MATCH");
  assert.equal(result.jdReviewed, false);
});

test("clear non-technology titles are rejected without JD review", () => {
  const result = screenTitle("Senior Civil Engineer", { thresholds });
  assert.equal(result.titleClassification, "CLEAR_REJECT");
  assert.equal(result.category, "REJECTED");
});

test("broad early-career titles request JD review", () => {
  const result = screenTitle("Graduate Analyst", { thresholds });
  assert.equal(result.titleClassification, "AMBIGUOUS");
  assert.equal(result.screeningStatus, "NEEDS_JD_REVIEW");
});

test("human feedback deprioritizes a repeated title without deleting it", () => {
  const preferenceModel = {
    version: 2,
    titleExclusions: ["Graduate Software Engineer"],
    avoidSignals: [],
    targetSignals: []
  };
  const result = screenTitle("Graduate Software Engineer", { thresholds, preferenceModel });
  assert.equal(result.category, "LOW_MATCH");
  assert.equal(result.screeningStatus, "NEEDS_JD_REVIEW");
  assert.equal(result.engine, "local-rules+feedback");
  assert.equal(result.preferenceVersion, 2);
});

test("local reflection uses only active not-helpful feedback", () => {
  const model = localPreferenceReflection([{
    title: "Retail Sales Graduate",
    feedback: { reason: "NOT_RELEVANT", note: "This is a sales role." }
  }], { version: 1, feedbackCount: 1, sourceRunId: "run_1" });
  assert.deepEqual(model.titleExclusions, ["Retail Sales Graduate"]);
  assert.equal(matchingPreferenceSignal("Retail Sales Graduate", model, "avoid"), "Retail Sales Graduate");
  assert.match(model.summary, /1 条/);
});

test("local reflection clears guidance when all feedback is removed", () => {
  const model = localPreferenceReflection([], { version: 2, feedbackCount: 0 });
  assert.deepEqual(model.titleExclusions, []);
  assert.deepEqual(model.screeningGuidance, []);
  assert.match(model.summary, /尚未收到/);
});

test("normalization preserves source keys and missing optional data", () => {
  const job = normalizeJob({
    source: "seek",
    jobId: "987",
    title: "Junior Systems Analyst",
    company: "Example Pty Ltd",
    runTaskId: "task_123",
    routineTaskId: "routine_456",
    searchPostedWithinDays: 7
  }, { thresholds });
  assert.equal(job.source, "seek");
  assert.equal(job.location, null);
  assert.equal(job.runTaskId, "task_123");
  assert.equal(job.routineTaskId, "routine_456");
  assert.equal(job.searchPostedWithinDays, 7);
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
  assert.ok(screening.matchedAreas.includes("data and analytics"));
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
  assert.equal(categoryForScore(29, thresholds), "REJECTED");
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

test("candidate items retain suggested profile destinations", () => {
  const profile = validateProfileDraft({
    name: "Candidate",
    headline: "Graduate developer",
    summary: "Evidence-based profile summary.",
    candidateItems: [
      { value: "Python", suggestedSection: "skills" },
      { value: "Backend API projects", suggestedSection: "focusAreas" }
    ]
  });
  assert.deepEqual(profile.candidateItems, ["Python", "Backend API projects"]);
  assert.deepEqual(profile.candidateSuggestions, {
    Python: "skills",
    "Backend API projects": "focusAreas"
  });
  assert.equal(suggestProfileSection("Graduate Software Engineer"), "targetRoles");
});
