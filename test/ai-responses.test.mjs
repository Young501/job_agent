import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { generateProfile, reflectOnJobFeedback, testAiConnection } from "../src/ai.mjs";

const externalProfile = {
  name: "Candidate",
  headline: "Graduate Developer",
  summary: "Evidence-based external career profile.",
  targetRoles: ["Graduate Software Engineer"],
  focusAreas: ["software engineering"],
  skills: ["Python"],
  education: ["Bachelor degree in progress"],
  preferences: { locations: ["Melbourne VIC"], workTypes: [], exclusions: [] },
  candidateItems: []
};

test("Responses API adapter sends a bounded low-reasoning structured request", async () => {
  let received = null;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = { url: request.url, body: JSON.parse(body) };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      output_text: JSON.stringify({
        name: "Candidate",
        headline: "Graduate Developer",
        summary: "Early-career technology candidate.",
        targetRoles: ["Graduate Software Engineer"],
        focusAreas: ["software engineering"],
        skills: ["Python"],
        education: [],
        preferences: { locations: [], workTypes: [], exclusions: [] },
        candidateItems: ["Automation projects", "Backend API development"]
      }),
      usage: { input_tokens: 42, output_tokens: 18, total_tokens: 60 }
    }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const original = {
    baseUrl: process.env.JOB_AGENT_AI_BASE_URL,
    model: process.env.JOB_AGENT_AI_MODEL,
    wireApi: process.env.JOB_AGENT_AI_WIRE_API,
    effort: process.env.JOB_AGENT_AI_REASONING_EFFORT,
    output: process.env.JOB_AGENT_AI_MAX_PROFILE_OUTPUT_TOKENS
  };

  try {
    process.env.JOB_AGENT_AI_BASE_URL = "http://127.0.0.1:" + port;
    process.env.JOB_AGENT_AI_MODEL = "test-model";
    process.env.JOB_AGENT_AI_WIRE_API = "responses";
    process.env.JOB_AGENT_AI_REASONING_EFFORT = "low";
    process.env.JOB_AGENT_AI_MAX_PROFILE_OUTPUT_TOKENS = "321";
    const externalText = JSON.stringify(externalProfile);
    const result = await generateProfile("Python projects and software coursework.", "resume.txt", externalText);

    assert.equal(result.engine, "ai-with-external");
    assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 18, totalTokens: 60 });
    assert.equal(received.url, "/responses");
    assert.equal(received.body.reasoning.effort, "low");
    assert.equal(received.body.max_output_tokens, 321);
    assert.equal(received.body.text.format.type, "json_object");
    assert.match(received.body.instructions, /resume is the primary factual record/i);
    assert.match(received.body.instructions, /10-20 candidateItems/i);
    const input = JSON.parse(received.body.input);
    assert.equal(input.externalCareerAnalysis, externalText);
    assert.deepEqual(result.profile.candidateItems, ["Automation projects", "Backend API development"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(original)) {
      const environmentKey = {
        baseUrl: "JOB_AGENT_AI_BASE_URL",
        model: "JOB_AGENT_AI_MODEL",
        wireApi: "JOB_AGENT_AI_WIRE_API",
        effort: "JOB_AGENT_AI_REASONING_EFFORT",
        output: "JOB_AGENT_AI_MAX_PROFILE_OUTPUT_TOKENS"
      }[key];
      if (value === undefined) delete process.env[environmentKey];
      else process.env[environmentKey] = value;
    }
  }
});

test("validated external GPT JSON remains usable when no agent endpoint is configured", async () => {
  const original = {
    baseUrl: process.env.JOB_AGENT_AI_BASE_URL,
    model: process.env.JOB_AGENT_AI_MODEL
  };
  try {
    delete process.env.JOB_AGENT_AI_BASE_URL;
    delete process.env.JOB_AGENT_AI_MODEL;
    const result = await generateProfile("Candidate completed Python and JavaScript university projects with a technology focus.", "resume.txt", JSON.stringify(externalProfile));
    assert.equal(result.engine, "external-gpt");
    assert.deepEqual(result.profile, externalProfile);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      const environmentKey = key === "baseUrl" ? "JOB_AGENT_AI_BASE_URL" : "JOB_AGENT_AI_MODEL";
      if (value === undefined) delete process.env[environmentKey];
      else process.env[environmentKey] = value;
    }
  }
});

test("AI connection test uses the supplied unsaved configuration", async () => {
  let received = null;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = { url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      output_text: JSON.stringify({ ok: true }),
      usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await testAiConnection({
      baseUrl: "http://127.0.0.1:" + server.address().port,
      model: "connection-test-model",
      wireApi: "responses",
      apiKey: "test-api-key"
    });
    assert.equal(result.ok, true);
    assert.equal(result.usage.totalTokens, 12);
    assert.equal(received.url, "/responses");
    assert.equal(received.authorization, "Bearer test-api-key");
    assert.equal(received.body.model, "connection-test-model");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("review reflection sends active feedback and returns a bounded preference model", async () => {
  let received = null;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      output_text: JSON.stringify({
        summary: "用户不希望销售导向的技术职位。",
        targetSignals: ["software engineering"],
        avoidSignals: ["technical sales"],
        titleExclusions: ["Graduate Sales Engineer"],
        screeningGuidance: ["技术销售职位降低优先级，但保留记录。"]
      }),
      usage: { input_tokens: 55, output_tokens: 24, total_tokens: 79 }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const original = {
    baseUrl: process.env.JOB_AGENT_AI_BASE_URL,
    model: process.env.JOB_AGENT_AI_MODEL,
    wireApi: process.env.JOB_AGENT_AI_WIRE_API,
    output: process.env.JOB_AGENT_AI_MAX_REFLECTION_OUTPUT_TOKENS,
    input: process.env.JOB_AGENT_AI_MAX_INPUT_CHARS
  };
  try {
    process.env.JOB_AGENT_AI_BASE_URL = "http://127.0.0.1:" + server.address().port;
    process.env.JOB_AGENT_AI_MODEL = "reflection-test-model";
    process.env.JOB_AGENT_AI_WIRE_API = "responses";
    process.env.JOB_AGENT_AI_MAX_REFLECTION_OUTPUT_TOKENS = "444";
    process.env.JOB_AGENT_AI_MAX_INPUT_CHARS = "4000";
    const result = await reflectOnJobFeedback({
      profile: externalProfile,
      previousModel: null,
      feedback: [
        { title: "Graduate Sales Engineer", feedbackReason: "NOT_RELEVANT" },
        ...Array.from({ length: 80 }, (_, index) => ({ title: "Long feedback " + index, userNote: "x".repeat(400) }))
      ]
    });
    assert.equal(received.max_output_tokens, 444);
    assert.match(received.instructions, /complete replacement model/i);
    assert.ok(received.input.length <= 4_000);
    assert.equal(JSON.parse(received.input).activeNotHelpfulFeedback[0].feedbackReason, "NOT_RELEVANT");
    assert.deepEqual(result.preferenceModel.avoidSignals, ["technical sales"]);
    assert.equal(result.usage.totalTokens, 79);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const keys = {
      baseUrl: "JOB_AGENT_AI_BASE_URL",
      model: "JOB_AGENT_AI_MODEL",
      wireApi: "JOB_AGENT_AI_WIRE_API",
      output: "JOB_AGENT_AI_MAX_REFLECTION_OUTPUT_TOKENS",
      input: "JOB_AGENT_AI_MAX_INPUT_CHARS"
    };
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[keys[key]];
      else process.env[keys[key]] = value;
    }
  }
});
