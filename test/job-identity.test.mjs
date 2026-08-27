import assert from "node:assert/strict";
import test from "node:test";

import { duplicateMatch, findDuplicate, strongIdentityKeys } from "../src/job-identity.mjs";

test("same-platform job IDs are exact duplicates even when URLs differ", () => {
  const previous = {
    id: "job_previous",
    source: "seek",
    sourceJobId: "12345",
    jobUrl: "https://www.seek.com.au/job/12345?tracking=old"
  };
  const candidate = {
    id: "job_candidate",
    source: "seek",
    sourceJobId: "12345",
    jobUrl: "https://www.seek.com.au/job/12345?tracking=new"
  };
  assert.match(strongIdentityKeys(candidate)[0], /^seek:id:12345$/);
  assert.equal(duplicateMatch(candidate, previous).type, "same-source-id");
});

test("cross-platform duplicates require exact company, title, and compatible location", () => {
  const linkedin = {
    id: "job_linkedin",
    source: "linkedin",
    title: "Graduate Software Developer 2027",
    company: "Example Technology Pty Ltd",
    location: "Melbourne, Victoria, Australia"
  };
  const indeed = {
    id: "job_indeed",
    source: "indeed",
    title: "Graduate Software Developer 2027",
    company: "Example Technology Limited",
    location: "Victoria, Australia"
  };
  const result = findDuplicate(indeed, [linkedin]);
  assert.equal(result.type, "cross-platform-exact-role");
  assert.equal(result.existing.id, linkedin.id);
});

test("cross-platform matching stays conservative when year or location is uncertain", () => {
  const previous = {
    id: "job_previous",
    source: "linkedin",
    title: "Graduate Software Developer 2026",
    company: "Example Technology",
    location: "Australia"
  };
  assert.equal(duplicateMatch({
    id: "job_next_year",
    source: "seek",
    title: "Graduate Software Developer 2027",
    company: "Example Technology",
    location: "Melbourne VIC"
  }, previous), null);
  assert.equal(duplicateMatch({
    id: "job_same_title",
    source: "seek",
    title: "Graduate Software Developer 2026",
    company: "Example Technology",
    location: "Melbourne VIC"
  }, previous), null);
});

test("same-platform reposts with new IDs are retained", () => {
  assert.equal(duplicateMatch({
    id: "job_new",
    source: "indeed",
    sourceJobId: "new-id",
    title: "Graduate Data Analyst",
    company: "Example",
    location: "Melbourne VIC"
  }, {
    id: "job_old",
    source: "indeed",
    sourceJobId: "old-id",
    title: "Graduate Data Analyst",
    company: "Example",
    location: "Melbourne VIC"
  }), null);
});

test("opaque legacy fingerprints only collapse the same migrated key", () => {
  const legacy = {
    id: "legacy_history_one",
    source: "linkedin",
    title: "Graduate Software Developer",
    company: "Example",
    legacyKey: "fp:example|graduate software developer",
    opaque: true,
    origin: "tampermonkey-history-migration"
  };
  const sameLegacyKey = { ...legacy, id: "legacy_history_two" };
  assert.equal(duplicateMatch(sameLegacyKey, legacy).type, "same-source-id");
  assert.equal(duplicateMatch({
    id: "job_live",
    source: "linkedin",
    title: legacy.title,
    company: legacy.company,
    location: "Melbourne VIC"
  }, legacy), null);
});
