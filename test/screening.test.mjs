import assert from "node:assert/strict";
import test from "node:test";

import {
  categoryForScore,
  localJdScreen,
  normalizeJob,
  screenTitle,
  strongSourceKey,
  validateScreening
} from "../src/screening.mjs";

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

test("normalization preserves source keys and missing optional data", () => {
  const job = normalizeJob({
    source: "seek",
    jobId: "987",
    title: "Junior Systems Analyst",
    company: "Example Pty Ltd"
  }, { thresholds });
  assert.equal(job.source, "seek");
  assert.equal(job.location, null);
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
