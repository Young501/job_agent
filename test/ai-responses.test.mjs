import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { generateProfile } from "../src/ai.mjs";

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
        preferences: { locations: [], workTypes: [], exclusions: [] }
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
    const result = await generateProfile("Python projects and software coursework.", "resume.txt");

    assert.equal(result.engine, "ai");
    assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 18, totalTokens: 60 });
    assert.equal(received.url, "/responses");
    assert.equal(received.body.reasoning.effort, "low");
    assert.equal(received.body.max_output_tokens, 321);
    assert.equal(received.body.text.format.type, "json_object");
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
