import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { answerJobQuestions, evaluateJdWithAi, generateCoverLetter, generateProfile, reflectOnJobFeedback, testAiConnection } from "../src/ai.mjs";

const externalProfile = {
  schemaVersion: 2,
  basicInfo: { name: "Candidate", location: "Melbourne VIC", phone: "", email: "", linkedinUrl: "", githubUrl: "", websiteUrl: "https://candidate.example" },
  visa: { visaType: "Temporary", visaName: "Student visa", grantedDate: "", expiryDate: "2027-03", details: "Can work subject to visa conditions.", forceKeepRequirements: ["Australian permanent resident"] },
  workExperience: [],
  projectExperience: [],
  education: [{ institution: "Example University", location: "", degree: "Bachelor", field: "Computer Science", startDate: "", endDate: "", description: "" }],
  extracurricular: [],
  certifications: [],
  languages: [],
  skills: ["Python"],
  honors: [],
  customSections: []
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
        schemaVersion: 2,
        basicInfo: { name: "Candidate", location: "", phone: "", email: "", linkedinUrl: "", githubUrl: "", websiteUrl: "" },
        visa: { visaType: "", visaName: "", grantedDate: "", expiryDate: "", details: "", forceKeepRequirements: [] },
        workExperience: [],
        projectExperience: [{ name: "Automation project", role: "Developer", startDate: "", endDate: "", url: "", description: "Backend API development", technologies: ["Python"], highlights: [] }],
        education: [],
        extracurricular: [], certifications: [], languages: [], skills: ["Python"], honors: [], customSections: []
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
    assert.match(received.body.instructions, /workExperience/i);
    assert.match(received.body.instructions, /empty strings and empty arrays/i);
    const input = JSON.parse(received.body.input);
    assert.equal(input.output_format, "json");
    assert.equal(input.externalCareerAnalysis, externalText);
    assert.equal(result.profile.projectExperience[0].name, "Automation project");
    assert.deepEqual(result.profile.projectExperience[0].technologies, ["Python"]);
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
    assert.equal(result.profile.schemaVersion, 2);
    assert.equal(result.profile.basicInfo.name, externalProfile.basicInfo.name);
    assert.equal(result.profile.education[0].institution, "Example University");
    assert.deepEqual(result.profile.skills, ["Python"]);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      const environmentKey = key === "baseUrl" ? "JOB_AGENT_AI_BASE_URL" : "JOB_AGENT_AI_MODEL";
      if (value === undefined) delete process.env[environmentKey];
      else process.env[environmentKey] = value;
    }
  }
});

test("AI JD review semantically compares visa requirements and honors user retention scope", async () => {
  let received = null;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      output_text: JSON.stringify({
        titleClassification: "CLEAR_MATCH",
        score: 78,
        reason: "The role aligns with the candidate's backend engineering experience.",
        matchedAreas: ["software engineering"],
        concerns: [],
        jdReviewed: true,
        workRights: {
          assessment: "OVERRIDE_KEEP",
          reason: "The permanent-resident option matches the user's forced-retention scope.",
          requirements: ["Australian citizen", "Australian permanent resident", "full working rights"]
        }
      }),
      usage: { input_tokens: 110, output_tokens: 80, total_tokens: 190 }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const original = {
    baseUrl: process.env.JOB_AGENT_AI_BASE_URL,
    model: process.env.JOB_AGENT_AI_MODEL,
    wireApi: process.env.JOB_AGENT_AI_WIRE_API
  };
  try {
    process.env.JOB_AGENT_AI_BASE_URL = "http://127.0.0.1:" + server.address().port;
    process.env.JOB_AGENT_AI_MODEL = "visa-review-model";
    process.env.JOB_AGENT_AI_WIRE_API = "responses";
    const result = await evaluateJdWithAi({
      title: "Graduate Software Engineer",
      company: "Example",
      location: "Melbourne",
      description: "Applicants must be an Australian citizen, permanent resident, or hold full working rights."
    }, externalProfile, { strongMatch: 85, goodMatch: 70, maybe: 50, lowMatch: 30 });
    assert.match(received.instructions, /AND, OR, alternatives/i);
    assert.match(received.instructions, /forceKeepRequirements/i);
    assert.match(received.instructions, /Simplified Chinese/i);
    assert.match(received.instructions, /targetKeywords and preferenceSignals\.exclusionKeywords in English only/i);
    const input = JSON.parse(received.input);
    assert.deepEqual(input.candidateProfile.visa.forceKeepRequirements, ["Australian permanent resident"]);
    assert.equal(result.screening.workRights.assessment, "OVERRIDE_KEEP");
    assert.equal(result.screening.category, "GOOD_MATCH");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (original.baseUrl === undefined) delete process.env.JOB_AGENT_AI_BASE_URL;
    else process.env.JOB_AGENT_AI_BASE_URL = original.baseUrl;
    if (original.model === undefined) delete process.env.JOB_AGENT_AI_MODEL;
    else process.env.JOB_AGENT_AI_MODEL = original.model;
    if (original.wireApi === undefined) delete process.env.JOB_AGENT_AI_WIRE_API;
    else process.env.JOB_AGENT_AI_WIRE_API = original.wireApi;
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

test("AI requests retry transient provider and proxy upstream failures", async () => {
  let attempts = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    attempts += 1;
    if (attempts === 1) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Service temporarily unavailable", type: "api_error" } }));
      return;
    }
    if (attempts === 2) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Upstream request failed", type: "upstream_error" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      output_text: JSON.stringify({ ok: true }),
      usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const originalAttempts = process.env.JOB_AGENT_AI_MAX_REQUEST_ATTEMPTS;
  const originalDelay = process.env.JOB_AGENT_AI_RETRY_BASE_DELAY_MS;
  try {
    process.env.JOB_AGENT_AI_MAX_REQUEST_ATTEMPTS = "3";
    process.env.JOB_AGENT_AI_RETRY_BASE_DELAY_MS = "10";
    const result = await testAiConnection({
      baseUrl: "http://127.0.0.1:" + server.address().port,
      model: "retry-test-model",
      wireApi: "responses",
      apiKey: ""
    });
    assert.equal(result.ok, true);
    assert.equal(result.usage.totalTokens, 12);
    assert.equal(attempts, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (originalAttempts === undefined) delete process.env.JOB_AGENT_AI_MAX_REQUEST_ATTEMPTS;
    else process.env.JOB_AGENT_AI_MAX_REQUEST_ATTEMPTS = originalAttempts;
    if (originalDelay === undefined) delete process.env.JOB_AGENT_AI_RETRY_BASE_DELAY_MS;
    else process.env.JOB_AGENT_AI_RETRY_BASE_DELAY_MS = originalDelay;
  }
});

test("job review assistant uses bounded current-job context and preserves valid citations", async () => {
  let received = null;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    const input = JSON.parse(received.input);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      output_text: JSON.stringify({
        answer: "按现有地点文字，Melbourne CBD 的岗位更接近你的所在地；没有路线数据，无法给出精确通勤时间。",
        citedJobIds: [input.jobCatalog[0].id, "not-in-context"]
      }),
      usage: { input_tokens: 85, output_tokens: 30, total_tokens: 115 }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const original = {
    baseUrl: process.env.JOB_AGENT_AI_BASE_URL,
    model: process.env.JOB_AGENT_AI_MODEL,
    wireApi: process.env.JOB_AGENT_AI_WIRE_API,
    input: process.env.JOB_AGENT_AI_MAX_ASSISTANT_INPUT_CHARS,
    output: process.env.JOB_AGENT_AI_MAX_ASSISTANT_OUTPUT_TOKENS
  };
  try {
    process.env.JOB_AGENT_AI_BASE_URL = "http://127.0.0.1:" + server.address().port;
    process.env.JOB_AGENT_AI_MODEL = "assistant-test-model";
    process.env.JOB_AGENT_AI_WIRE_API = "responses";
    process.env.JOB_AGENT_AI_MAX_ASSISTANT_INPUT_CHARS = "5000";
    process.env.JOB_AGENT_AI_MAX_ASSISTANT_OUTPUT_TOKENS = "333";
    const jobs = Array.from({ length: 36 }, (_, index) => ({
      id: "assistant-job-" + index,
      source: index % 2 ? "seek" : "linkedin",
      title: index === 0 ? "Graduate Software Engineer" : "Technology Role " + index,
      company: "Example " + index,
      location: index === 0 ? "Melbourne CBD" : "Sydney NSW",
      description: "Build Python and cloud software systems. ".repeat(35),
      screening: { score: 80 - index, category: "GOOD_MATCH", reason: "技术方向匹配。", matchedAreas: ["Python"], concerns: [] }
    }));
    const profileWithPrivateFields = {
      ...externalProfile,
      basicInfo: { ...externalProfile.basicInfo, phone: "0400000000", email: "private@example.com" }
    };
    const result = await answerJobQuestions({
      question: "哪个工作离我家更近？",
      conversation: [{ role: "user", content: "只看当前列表" }],
      profile: profileWithPrivateFields,
      jobs,
      context: { pane: "current", label: "当前筛选 36 个职位" }
    });
    const input = JSON.parse(received.input);
    assert.match(received.instructions, /Do not invent missing.*distances.*commute times/i);
    assert.match(received.instructions, /Simplified Chinese/i);
    assert.equal(received.max_output_tokens, 333);
    assert.ok(received.input.length <= 5_000);
    assert.equal(input.candidateProfile.location, "Melbourne VIC");
    assert.doesNotMatch(received.input, /0400000000|private@example\.com/);
    assert.equal(input.context.requestedJobCount, 36);
    assert.ok(input.context.includedJobCount < 36);
    assert.ok(input.context.omittedJobCount > 0);
    assert.deepEqual(result.citedJobIds, [input.jobCatalog[0].id]);
    assert.equal(result.usage.totalTokens, 115);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const mapping = {
      baseUrl: "JOB_AGENT_AI_BASE_URL",
      model: "JOB_AGENT_AI_MODEL",
      wireApi: "JOB_AGENT_AI_WIRE_API",
      input: "JOB_AGENT_AI_MAX_ASSISTANT_INPUT_CHARS",
      output: "JOB_AGENT_AI_MAX_ASSISTANT_OUTPUT_TOKENS"
    };
    for (const [key, environmentKey] of Object.entries(mapping)) {
      if (original[key] === undefined) delete process.env[environmentKey];
      else process.env[environmentKey] = original[key];
    }
  }
});

test("cover letter generation uses the selected profile, JD, page limit, and revision context", async () => {
  let received = null;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      output_text: JSON.stringify({
        overview: "这封信以 Python 项目和岗位的自动化需求为主线。",
        subject: "Application for Graduate Software Engineer",
        salutation: "Dear Hiring Manager,",
        body: "I am applying for the Graduate Software Engineer position because its focus on practical automation aligns with my recent work.\n\nIn a university project, I used Python to build a reliable processing workflow, tested the result, and documented the implementation for other contributors. This experience gave me a concrete foundation for the engineering work described in the role.\n\nI would welcome the opportunity to discuss how I could contribute to the team while continuing to grow as an engineer.",
        closing: "Kind regards,",
        applicantName: "Candidate"
      }),
      usage: { input_tokens: 120, output_tokens: 140, total_tokens: 260 }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const original = {
    baseUrl: process.env.JOB_AGENT_AI_BASE_URL,
    model: process.env.JOB_AGENT_AI_MODEL,
    wireApi: process.env.JOB_AGENT_AI_WIRE_API,
    output: process.env.JOB_AGENT_AI_MAX_COVER_LETTER_OUTPUT_TOKENS
  };
  try {
    process.env.JOB_AGENT_AI_BASE_URL = "http://127.0.0.1:" + server.address().port;
    process.env.JOB_AGENT_AI_MODEL = "cover-letter-test-model";
    process.env.JOB_AGENT_AI_WIRE_API = "responses";
    process.env.JOB_AGENT_AI_MAX_COVER_LETTER_OUTPUT_TOKENS = "900";
    const result = await generateCoverLetter({
      job: { title: "Graduate Software Engineer", company: "Example", location: "Melbourne VIC", description: "Build tested Python automation services and collaborate with engineers." },
      profile: externalProfile,
      maxPages: 1,
      customInstructions: "Use a direct Australian English tone.",
      previousDraft: { body: "Previous draft text." },
      revisionRequest: "Make the project evidence more concrete."
    });
    const input = JSON.parse(received.input);
    assert.match(received.instructions, /Never invent/i);
    assert.match(received.instructions, /STAR reasoning/i);
    assert.equal(input.maxPages, 1);
    assert.equal(input.maxWords, 500);
    assert.equal(input.candidateProfile.basicInfo.name, "Candidate");
    assert.equal(input.job.company, "Example");
    assert.equal(input.revisionRequest, "Make the project evidence more concrete.");
    assert.equal(received.max_output_tokens, 900);
    assert.equal(result.coverLetter.applicantName, "Candidate");
    assert.equal(result.usage.totalTokens, 260);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const keys = {
      baseUrl: "JOB_AGENT_AI_BASE_URL",
      model: "JOB_AGENT_AI_MODEL",
      wireApi: "JOB_AGENT_AI_WIRE_API",
      output: "JOB_AGENT_AI_MAX_COVER_LETTER_OUTPUT_TOKENS"
    };
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[keys[key]];
      else process.env[keys[key]] = value;
    }
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
        deprioritizeSignals: ["technical documentation"],
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
      rejectedJobSignals: [{
        title: "Graduate Retail Assistant",
        humanConfirmed: true,
        feedbackReason: "REJECTION_CORRECT"
      }],
      legacyNotHelpfulFeedback: [
        { title: "Graduate Sales Engineer", feedbackReason: "NOT_RELEVANT" },
        ...Array.from({ length: 80 }, (_, index) => ({ title: "Long feedback " + index, userNote: "x".repeat(400) }))
      ],
      implicitInterestSignals: [{
        jobId: "job_clicked_1",
        title: "Junior Backend Developer",
        targetKeywords: ["Python", "backend APIs"],
        externalOpenCount: 3
      }]
    });
    assert.match(received.instructions, /REJECTION_CORRECT/);
    assert.match(received.instructions, /must contain at least one specific English role phrase/i);
    assert.match(received.instructions, /even when the item's exclusionKeywords array is empty/i);
    assert.match(received.instructions, /must acknowledge its evidence count/i);
    assert.match(received.instructions, /targetSignals, deprioritizeSignals, avoidSignals, and titleExclusions item in English only/i);
    assert.match(received.instructions, /avoidSignals item must be exactly one lowercase English occupation or job-function word/i);
    assert.match(received.instructions, /Soft NOT_HELPFUL feedback must affect deprioritizeSignals instead/i);
    assert.match(received.instructions, /weak behavioral evidence only/i);
    assert.match(received.instructions, /link opens never equal HELPFUL feedback/i);
    assert.equal(received.max_output_tokens, 444);
    assert.match(received.instructions, /complete replacement model/i);
    assert.ok(received.input.length <= 4_000);
    assert.equal(JSON.parse(received.input).legacyNotHelpfulFeedback[0].feedbackReason, "NOT_RELEVANT");
    assert.equal(JSON.parse(received.input).confirmedNegativeEvidence[0].title, "Graduate Retail Assistant");
    assert.equal(JSON.parse(received.input).explicitNotHelpfulEvidence[0].title, "Graduate Sales Engineer");
    assert.equal(JSON.parse(received.input).implicitInterestSignals[0].jobId, "job_clicked_1");
    assert.deepEqual(result.preferenceModel.deprioritizeSignals, ["documentation"]);
    assert.deepEqual(result.preferenceModel.avoidSignals, ["sales"]);
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
