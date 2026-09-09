import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
function extract(name, next) {
  return source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`));
}

test("default review list includes title exclusions while respecting explicit filters", () => {
  const jobs = ["EXCLUDED", "RULE_EXCLUDED", "KEPT", "ERROR"].map((status, id) => ({
    id, title: `Title ${id}`, source: "seek", titleTriage: { status },
    screening: { category: status.includes("EXCLUDED") ? "REJECTED" : "MAYBE", screeningStatus: `TITLE_${status}` }
  }));
  const filters = { "#job-viewed": "unviewed" };
  const visible = runInNewContext(extract("visibleJobs", "jobAssistantReviewContext") + "\nvisibleJobs", {
    el: id => ({ value: filters[id] || "" }), jobsInSelectedPane: () => jobs,
    effectiveJobCategory: job => job.screening.category, sortJobs: value => value
  });
  assert.equal(visible().length, 4);
  filters["#job-category"] = "REJECTED";
  assert.equal(visible().length, 2);
  jobs[0].viewedAt = "2026-09-09";
  assert.equal(visible().length, 1);
});

test("title exclusions show their reason and do not imply a pending JD score", () => {
  const escapeHtml = value => String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const row = runInNewContext(extract("jobRow", "renderOverview") + "\njobRow", {
    escapeHtml, isRejectionCorrection: () => false, feedbackBadge: () => "", jobDistanceBadge: () => "",
    names: {}, badge: () => "", effectiveJobCategory: () => "REJECTED", screeningMethodBadge: () => "",
    workRightsBadge: () => "", actionButtons: () => ""
  });
  const html = row({ id: "one", title: "Nurse", titleTriage: { status: "EXCLUDED", reason: "Not relevant <script>" }, screening: { score: null } });
  assert.match(html, /无需 JD 评分/);
  assert.doesNotMatch(html, /待 JD 评分/);
  assert.match(html, /Not relevant &lt;script&gt;/);
});
