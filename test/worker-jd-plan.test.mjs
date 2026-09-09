import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

for (const platform of ["linkedin", "indeed", "seek"]) {
  const script = await readFile(new URL(`../workers/${platform}/${platform}-agent-worker.user.js`, import.meta.url), "utf8");
  const start = script.indexOf("    async function agentEnrichJobs(jobs, task) {");
  const end = script.indexOf("    function agentNotify(message)", start);
  assert.ok(start > 0 && end > start);
  const source = script.slice(start, end);

  async function execute(actions, { poll, initial, disabled = false, failFetch = false } = {}) {
    const fetched = [], messages = [], logs = [];
    const jobs = actions.map((_, index) => ({ title: `Job ${index}` }));
    let offset = 0;
    const context = {
      agentStopRequested: false,
      agentRequest: async (method, path, payload) => {
        if (payload.jobIds) return { plan: poll(payload.jobIds) };
        const current = offset;
        offset += payload.jobs.length;
        return { plan: initial ? initial(payload.jobs) : payload.jobs.map((_, index) => ({
          index, jobId: `id-${current + index}`, action: actions[current + index]
        })) };
      },
      sleep: async () => {}, setStatus: () => {}, log: message => logs.push(message),
      agentShowOverlay: (title, message) => messages.push(message),
      agentProgress: async () => {}, agentProgressStats: () => ({}), agentJdInterval: async () => {},
      agentFetchDescription: async job => {
        fetched.push(job.title);
        if (failFetch) throw new Error("Synthetic JD failure");
        return { description: "Complete description" };
      }
    };
    const enrich = runInNewContext(source + "\nagentEnrichJobs", context);
    await enrich(jobs, { id: "task", runId: "run", aiReviewEnabled: !disabled });
    return { jobs, fetched, messages, logs };
  }

  test(`${platform}: only explicit fetch actions retrieve JDs and totals match`, async () => {
    const result = await execute(["future_state", "reject", "reuse", "skip_seen", "skip_ai", "title_error", "fetch", "fetch"]);
    assert.deepEqual(result.fetched, ["Job 6", "Job 7"]);
    assert.match(result.messages[0], /1\/2/);
    assert.match(result.messages[1], /2\/2/);
    assert.equal(result.jobs[0].descriptionFetchStatus, "pending-title");
    assert.match(result.logs.at(-1), /2 份 JD/);
    const zero = await execute(["future_state", "title_error", "reuse"]);
    assert.equal(zero.fetched.length, 0);
    assert.equal(zero.messages.length, 0);
    const disabled = await execute(["fetch"], { disabled: true });
    assert.equal(disabled.fetched.length, 0);
    const failure = await execute(["fetch", "fetch"], { failFetch: true });
    assert.match(failure.messages[1], /2\/2/);
  });

  test(`${platform}: polling preserves indexes and counts across batches`, async () => {
    const result = await execute(Array(55).fill("title_pending"), {
      poll: ids => ids.map(jobId => ({ jobId, index: 999,
        action: ["id-0", "id-50", "id-54"].includes(jobId) ? "fetch" : "reject" }))
    });
    assert.deepEqual(result.fetched, ["Job 0", "Job 50", "Job 54"]);
    assert.match(result.messages.at(-1), /3\/3/);
  });

  test(`${platform}: malformed plans and missing polling results never fetch by default`, async () => {
    for (const initial of [() => [], () => [{ index: 0, jobId: "one", action: "fetch" }, { index: 0, jobId: "two", action: "fetch" }]]) {
      const result = await execute(["fetch", "fetch"], { initial });
      assert.equal(result.fetched.length, 0);
    }
    const incomplete = await execute(["title_pending"], { poll: () => [] });
    assert.equal(incomplete.fetched.length, 0);
    assert.equal(incomplete.jobs[0].descriptionFetchStatus, "pending-title");
  });
}
