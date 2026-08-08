# Personal AI Job Agent - Phase 1

## Purpose

This folder contains a new, local-first job review workspace built around the
already working browser helpers. It is intentionally separate from the
existing scripts:

- `../linkedin/linkedin-helper-summary.user.js`
- `../indeed/indeed-helper-summary.user.js`
- `../seek/seek-helper-summary.user.js`

Those scripts are frozen. This project neither rewrites them nor changes their
platform history, deduplication, page traversal, summary pages, or rate
limiting.

## Phase 1 Outcome

The daily workflow is:

1. Select enabled keyword and location pairs from one shared routine.
2. Create a sequential run plan for LinkedIn, Indeed, and SEEK.
3. Let the browser workers collect only their new platform jobs using their
   existing histories.
4. Import the collected results into one normalized daily list.
5. Classify each title locally as `CLEAR_MATCH`, `CLEAR_REJECT`, or
   `AMBIGUOUS`.
6. Keep clear matches, reject clear mismatches, and place ambiguous jobs in a
   JD review queue.
7. Screen an ambiguous JD with the active career profile, optionally through
   an OpenAI-compatible local or cloud endpoint.
8. Review, filter, sort, and open the retained jobs manually. The system
   stops before any application action.

## What This First Build Includes

- A local dashboard for the daily run, combined jobs, routine settings, and
  career profile versions.
- Resume upload and text extraction for `.txt`, `.docx`, and text-based PDF
  files.
- Career-profile drafts generated either by a configured AI endpoint or a
  transparent local fallback. Profiles must be explicitly activated.
- Shared keyword/location/priority configuration for all three platforms.
- A sequential worker task queue and a small import API for future worker
  copies to submit normalized job results without changing the base scripts.
- A normalized job contract, title screening, configurable match thresholds,
  JD review, structured AI JSON validation, run status, filters, and sorting.
- Local JSON storage under `data/`; secrets remain in environment variables.

## Deliberate Boundaries

- No auto-apply, application-form filling, resume tailoring, cover letters,
  email automation, interview tracking, cloud scheduler, or account bypass.
- Login, CAPTCHA, and anti-bot checks are not solved or bypassed. A worker
  should report `needs_user_action`; the user finishes the browser action and
  then resumes the run.
- The existing userscripts cannot silently share Tampermonkey storage with a
  new userscript. When worker copies are introduced, their platform histories
  need one explicit export/import migration. This keeps the current scripts
  untouched and their data private.
- The dashboard does not remove imported jobs just because they look similar.
  Source history remains the authority for platform-level skipping; a repeated
  import is retained and visibly marked rather than silently lost.

## Data Contracts

All imported jobs are normalized to this shape, with nullable fields where a
platform does not provide data:

```json
{
  "id": "job_...",
  "source": "linkedin",
  "sourceJobId": "123",
  "title": "Graduate Software Engineer",
  "company": "Example Company",
  "location": "Melbourne VIC",
  "jobUrl": "https://...",
  "description": null,
  "postedAt": null,
  "discoveredAt": "2026-08-08T10:00:00.000Z",
  "searchKeyword": "graduate software engineer",
  "searchLocation": "Melbourne VIC",
  "screening": null
}
```

Worker result submissions use `{ runId, taskId, jobs, status, reason }`. The
server normalizes each item and continues the overall run if one source fails.

## Screening Rules

Stage A is local and title-first:

- Direct technology, software, AI/ML, data, IT, and graduate-program titles
  are `CLEAR_MATCH`.
- Obvious unrelated professions, senior leadership, and non-technology
  disciplines are `CLEAR_REJECT`.
- Broad titles such as `Graduate Analyst` are `AMBIGUOUS`.

Stage B only runs for ambiguous titles. It considers the active profile,
technology terms, eligibility/seniority concerns, and the JD. If an AI endpoint
is configured, job title and JD are explicitly sent as untrusted data and the
returned JSON is validated before it is saved. A failed AI response becomes
`AI_ERROR`; it never stops the full run.

Initial score bands are configurable:

| Score | Category |
| --- | --- |
| 85-100 | `STRONG_MATCH` |
| 70-84 | `GOOD_MATCH` |
| 50-69 | `MAYBE` |
| 30-49 | `LOW_MATCH` |
| 0-29 | `REJECTED` |

## First-Version Architecture

```text
Browser helpers (unchanged) --> future worker bridge / manual JSON import
                                         |
Shared routine config --> sequential run queue --> normalized local jobs
                                                        |
Resume upload --> approved career profile --> title rules --> JD review
                                                        |
                                              combined review dashboard
```

## File Map

- `config/job-search-routine.json`: first-run defaults for searches, locations,
  platforms, and thresholds.
- `src/storage.mjs`: local atomic JSON persistence.
- `src/screening.mjs`: normalized jobs, title rules, local JD assessment, and
  validation.
- `src/ai.mjs`: optional OpenAI-compatible structured profile/JD evaluation.
- `tools/extract_resume.py`: isolated `.docx`/PDF text extractor.
- `server.mjs`: local HTTP API, sequential-run queue, static-file server.
- `public/`: dashboard application.
- `test/`: focused rule and data-contract tests.

## Run and Test

```powershell
node server.mjs
node --test
```

Open `http://127.0.0.1:4317`. Copy `.env.example` to `.env` only when an AI
endpoint is wanted; leaving it absent keeps all processing local.
