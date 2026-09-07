import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDistanceService, distanceKm, jobPlace, selectDestination } from "../src/distance.mjs";

const home = { lat: -37.818, lon: 144.968, formatted: "Federation Square, Melbourne VIC", result_type: "building", housenumber: "1", rank: { confidence: 1 } };
const destination = { lat: -37.799, lon: 144.979, formatted: "Carlton VIC, Australia", result_type: "suburb", rank: { confidence: 1 } };
const jobs = [
  { id: "cafe", title: "Barista", location: "Carlton VIC" },
  { id: "shop", title: "Retail Assistant", location: "Carlton VIC" }
];
async function fixture(t, fetchImpl) {
  const directory = await mkdtemp(join(tmpdir(), "job-agent-distance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await createDistanceService({ dataDirectory: directory, fetchImpl, intervalMs: 0, timeoutMs: 25 });
  return { service, directory };
}
async function setup(service) {
  await service.saveConfig({ enabled: true, homeAddress: "Federation Square, Melbourne VIC", country: "au", apiKey: "private-test-key" });
  const found = await service.findOrigin();
  assert.equal(found.candidates.length, 1);
  await service.confirmOrigin(0);
}

test("distance is a geodesic in kilometres and preserves zero", () => {
  assert.equal(distanceKm(home, home), 0);
  const km = distanceKm({ lat: -37.8136, lon: 144.9631 }, { lat: -33.8688, lon: 151.2093 });
  assert.ok(km > 710 && km < 720);
  assert.ok(Math.abs(distanceKm(home, destination) - distanceKm(destination, home)) < 1e-8);
});

test("workplace evidence does not use headquarters, remote posts, or multiple cities", () => {
  assert.deepEqual(jobPlace({ location: "Australia (Remote)", workAddress: "Corporate headquarters" }), { status: "REMOTE" });
  assert.deepEqual(jobPlace({ location: "Australia" }), { status: "MISSING" });
  assert.deepEqual(jobPlace({ location: "Melbourne or Sydney" }), { status: "AMBIGUOUS" });
  assert.equal(jobPlace({ location: "Carlton VIC (Hybrid)", description: "Head office: 1 Market Street, Sydney" }).query, "Carlton VIC");
  assert.equal(jobPlace({ location: "Carlton VIC", description: "Work address: 10 Lygon Street, Carlton VIC. Please apply online." }).source, "jd");
  assert.equal(jobPlace({ location: "Remote" }, "10 Lygon Street, Carlton VIC").source, "user");
});

test("geocoder ambiguity and state-level matches never produce misleading distances", () => {
  assert.equal(selectDestination([]).status, "NOT_FOUND");
  assert.equal(selectDestination([{ type: "state", confidence: 1 }]).status, "TOO_BROAD");
  assert.equal(selectDestination([{ ...home, type: "city", confidence: 0.2 }]).status, "AMBIGUOUS");
  assert.equal(selectDestination([{ ...home, type: "city", confidence: 0.95 }, { lat: -33.86, lon: 151.2, confidence: 0.9 }]).status, "AMBIGUOUS");
});

test("opt in, confirmed origin, persistent shared cache, sorting-ready numbers and home invalidation", async (t) => {
  const requests = [];
  const { service, directory } = await fixture(t, async (url) => {
    requests.push(url);
    assert.equal(url.hostname, "api.geoapify.com");
    assert.equal(url.searchParams.get("filter"), "countrycode:au");
    return Response.json({ results: [url.searchParams.get("text").startsWith("Federation") ? home : destination] });
  });
  assert.equal(service.snapshot().enabled, false);
  await assert.rejects(service.start(jobs), /disabled/);
  await assert.rejects(service.findOrigin(), /disabled/);
  assert.equal(requests.length, 0);
  await service.saveConfig({ enabled: true, homeAddress: "Federation Square, Melbourne VIC", country: "au", apiKey: "private-test-key" });
  await assert.rejects(service.start(jobs), /Confirm the home/);
  await service.findOrigin();
  await service.confirmOrigin(0);
  const first = await service.start(jobs);
  await first.completion;
  assert.equal(requests.length, 2);
  let snapshot = service.snapshot(jobs);
  assert.equal(snapshot.batch.status, "COMPLETED");
  assert.equal(snapshot.batch.completed, 2);
  assert.ok(snapshot.results.cafe.km > 2 && snapshot.results.cafe.km < 3);
  assert.equal(snapshot.results.cafe.approximate, true);
  assert.equal(snapshot.results.shop.km, snapshot.results.cafe.km);
  assert.ok(!JSON.stringify(snapshot).includes("private-test-key"));
  assert.ok(!snapshot.results.cafe.origin);
  await (await service.start(jobs)).completion;
  assert.equal(requests.length, 2);
  const restored = await createDistanceService({ dataDirectory: directory, fetchImpl: () => { throw new Error("Cache was not reused"); }, intervalMs: 0 });
  await (await restored.start(jobs)).completion;
  assert.equal(restored.snapshot(jobs).batch.status, "COMPLETED");
  assert.deepEqual(restored.snapshot([{ ...jobs[0], location: "Sydney NSW" }]).results, {});
  await service.saveConfig({ enabled: true, homeAddress: "New origin", country: "au" });
  snapshot = service.snapshot(jobs);
  assert.equal(snapshot.origin, null);
  assert.deepEqual(snapshot.results, {});
  assert.equal(snapshot.hasApiKey, true);
  const disk = JSON.parse(await readFile(join(directory, "distance.json"), "utf8"));
  assert.deepEqual(disk.cache, {});
});

test("source location and manual corrections produce new distances without touching job records", async (t) => {
  const { service } = await fixture(t, async (url) => Response.json({ results: [url.searchParams.get("text").includes("Federation") ? home : destination] }));
  await setup(service);
  const remote = { id: "remote", title: "Remote Support", location: "Remote" };
  await (await service.start([remote])).completion;
  assert.equal(service.snapshot([remote]).results.remote.status, "REMOTE");
  await service.setOverride(remote, "Carlton VIC");
  assert.deepEqual(service.snapshot([remote]).results, {});
  await (await service.start([remote])).completion;
  assert.equal(service.snapshot([remote]).results.remote.status, "READY");
  assert.equal(remote.location, "Remote");
  await service.setOverride(remote, "");
  await (await service.start([remote])).completion;
  assert.equal(service.snapshot([remote]).results.remote.status, "REMOTE");
});

test("provider failures stop the batch, do not poison cache, and never expose keys", async (t) => {
  let calls = 0;
  const { service } = await fixture(t, async () => {
    calls++;
    return calls === 1 ? Response.json({ results: [home] }) : new Response("private-test-key", { status: 429 });
  });
  await setup(service);
  await (await service.start(jobs)).completion;
  const snapshot = service.snapshot(jobs);
  assert.equal(snapshot.batch.status, "FAILED");
  assert.equal(snapshot.batch.completed, 0);
  assert.equal(calls, 2);
  assert.match(snapshot.batch.error, /429/);
  assert.ok(!JSON.stringify(snapshot).includes("private-test-key"));
});

test("disable aborts active lookup, preserves progress and prevents remaining requests", async (t) => {
  let calls = 0;
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const { service } = await fixture(t, async (url, { signal }) => {
    calls++;
    if (calls === 1) return Response.json({ results: [home] });
    notifyStarted();
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  await setup(service);
  const pending = await service.start(jobs);
  await started;
  await assert.rejects(service.start(jobs), /already running/);
  await service.saveConfig({ enabled: false, homeAddress: "Federation Square, Melbourne VIC", country: "au" });
  await pending.completion;
  assert.equal(calls, 2);
  assert.equal(service.snapshot(jobs).batch.status, "CANCELLED");
  assert.deepEqual(service.snapshot(jobs).results, {});
});

test("unresponsive provider times out without retrying the remaining jobs", async (t) => {
  let calls = 0;
  const { service } = await fixture(t, async (url, { signal }) => {
    if (++calls === 1) return Response.json({ results: [home] });
    return new Promise((resolve, reject) => {
      const keepAlive = setTimeout(resolve, 1000);
      signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
    });
  });
  await setup(service);
  await (await service.start(jobs)).completion;
  assert.equal(service.snapshot(jobs).batch.status, "FAILED");
  assert.match(service.snapshot(jobs).batch.error, /timed out/);
  assert.equal(calls, 2);
});
