import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { configureAi, evaluateTitlesWithAi } from "../src/ai.mjs";
import { normalizeJob } from "../src/screening.mjs";

test("title triage validates every ID and isolates the supplied profile without requesting JDs", async () => {
  let output;
  let received;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ output_text: JSON.stringify(output) }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const jobs = [{ id: "one", title: "Software Architect", description: "PRIVATE FULL JD NOT NEEDED" }, { id: "two", title: "Barista" }];
  try {
    configureAi({ baseUrl: `http://127.0.0.1:${server.address().port}`, model: "title-test", apiKeys: [], wireApi: "responses",
      budget: { maxTitleOutputTokens: 4321 } });
    output = { decisions: [{ id: "one", decision: "KEEP", reason: "" }, { id: "two", decision: "KEEP", reason: "" }] };
    const profile = { profileLayout: { purpose: "part-time" }, jobPreferences: { notes: "Part-time cafe work near home" }, skills: ["Customer service"] };
    assert.equal((await evaluateTitlesWithAi(jobs, profile)).decisions.length, 2);
    assert.equal(received.max_output_tokens, 4321);
    const input = JSON.parse(received.input);
    assert.equal(input.candidateProfile.purpose, "part-time");
    assert.equal(input.candidateProfile.jobPreferences, profile.jobPreferences.notes);
    assert.equal(received.input.includes("PRIVATE FULL JD"), false);
    assert.match(received.instructions, /Soft dislikes/);
    assert.match(received.instructions, /Software Architect is not a building architect/);
    assert.match(received.instructions, /Simplified Chinese/);
    for (const decisions of [[], [{ id: "unknown", decision: "EXCLUDE", reason: "No" }],
      [{ id: "one", decision: "KEEP" }, { id: "one", decision: "KEEP" }],
      [{ id: "one", decision: "EXCLUDE", reason: "" }, { id: "two", decision: "KEEP" }],
      [{ id: "one", decision: "MAYBE" }, { id: "two", decision: "KEEP" }]]) {
      output = { decisions };
      await assert.rejects(evaluateTitlesWithAi(jobs, profile), /title triage|Title triage/);
    }
  } finally {
    configureAi(null);
    await new Promise(resolve => server.close(resolve));
  }
});

test("AI-title workflow does not apply career-specific hardcoded title or preview exclusions", () => {
  const thresholds = { strongMatch: 85, goodMatch: 70, maybe: 50, lowMatch: 30 };
  for (const title of ["Barista", "Software Architect", "Registered Nurse", "Civil Engineer"]) {
    const job = normalizeJob({ title, source: "seek", description: "patient care" }, { thresholds, titleTriage: true });
    assert.equal(job.screening.screeningStatus, "TITLE_QUEUED");
    assert.equal(job.screening.titleClassification, "AMBIGUOUS");
    assert.equal(job.screening.score, null);
  }
});
