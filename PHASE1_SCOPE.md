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

1. Add one daily task at a time with its platform, keyword, location,
   posted-within range, and supported platform job type. LinkedIn currently
   keeps job type unrestricted; Indeed and SEEK expose their native choices.
2. Before the task exists in the routine, open that platform's worker to fill
   its real search controls, select the platform's date control, and submit a
   test search. Unsupported or unapplied date choices fail validation.
   Comma-separated keyword alternatives use the first term for the platform
   query and all terms as local include rules; raw boolean `OR` is normalized
   to this representation for backward compatibility.
3. Select an approved career profile and start a run from only the validated
   daily tasks. The run stores an immutable profile and preference snapshot,
   and tasks run strictly in sequence across all platforms.
4. Open one normal browser Worker tab for the run. The tab navigates between
   platforms in task order, applies each keyword, location, and optional date
   range, then uses that platform helper's existing collection logic.
5. Persist every discovered card as a run-scoped occurrence in one Agent-owned
   local history before the Worker fetches any full JD.
6. Compare the occurrence with the unified LinkedIn, Indeed, and SEEK history.
   Exact same-source IDs and conservative high-confidence cross-platform
   matches skip repeated JD and AI work while retaining the occurrence.
7. Classify each remaining title and available card snippet locally. Clear
   mismatches remain recorded but do not enter the JD queue.
8. Fetch and screen the full JD only for non-duplicate jobs that remain
   plausible or uncertain, optionally through an OpenAI-compatible endpoint.
9. Review, filter, sort, and open the retained jobs manually. The system
   stops before any application action.
10. Generate an optional English cover letter from a reviewed JD and the
    selected profile, revise it with user guidance, and print it to PDF.
11. Mark helpful or unhelpful results during the review, optionally identifying an
    over-optimistic classification or an unrelated role, then complete the
    day's review to consolidate those explicit signals into the selected
    profile's learning context for later runs.

## What This First Build Includes

- A local dashboard for the daily run, combined jobs, routine settings, and
  multiple independently approved career profiles.
- Resume upload and text extraction for `.txt`, `.docx`, and text-based PDF
  files.
- Career-profile drafts generated either by a configured AI endpoint or a
  transparent local fallback. An optional external GPT profile can be pasted
  in a fixed JSON format; the agent reconciles it with the uploaded resume,
  with resume facts taking precedence. When the local endpoint is unavailable,
  a valid external JSON profile remains usable as a draft. Profiles must be
  explicitly activated. Profiles may be named, selected per run, edited, or
  deleted without changing the immutable snapshots stored by earlier runs.
- Profile-scoped preference learning, enabled exclusion keywords, and pending
  exclusion suggestions. Signals learned while reviewing casual work do not
  alter a separate professional-career profile.
- Named profile creation from a blank record, a copy of an existing profile,
  or a new resume extraction. Copying profile content never copies learning,
  exclusions, or pending suggestions.
- Individually managed daily tasks. A task is added only after a browser
  preflight succeeds, then can be deleted individually or cleared together.
  Existing runs retain their own task snapshots.
- The current run queue supports individual removal and clearing. A task
  already held by a worker is cancelled, hidden from the queue, and its later
  result submission is acknowledged but discarded.
- Platform-aware preflight for LinkedIn `Date posted`, Indeed `Date posted`,
  and SEEK `Listing time`. The preflight uses the actual search form rather
  than treating a constructed URL as proof of a valid filter.
- Platform-aware job type filtering for Indeed and SEEK. The chosen value is
  validated by the Agent, included in task identity and run snapshots, and
  applied through each platform's native filter control by its Worker.
- Preflight records can be edited, retried, or deleted. Editing and retrying
  withdraws any linked daily task until the fresh platform check succeeds;
  deleting a record leaves an already validated daily task intact.
- A worker-start heartbeat distinguishes an active browser preflight from an
  absent or disabled Worker, so the dashboard can surface a clear response
  instead of leaving the record silently waiting.
- Workers recover from platforms that remove custom URL parameters by checking
  the local Agent for a recent pending preflight or active platform run after
  the search page finishes loading.
- Platform preflight adapters keep their own filter-application semantics:
  LinkedIn confirms Date posted with its dynamic `Show N result(s)` action,
  while Indeed and SEEK apply their date controls directly.
- A dashboard installation page with per-platform Worker code, copy buttons,
  and Tampermonkey setup instructions. The frozen helpers remain separate and
  are never overwritten by a Worker install.
- Separate LinkedIn, Indeed, and SEEK worker copies under `workers/`. A Worker
  reports its summary to the local dashboard, then hands the same browser tab
  to the next queued platform.
- A queue API that enforces one active or paused task globally. No platform or
  task runs concurrently with another task in the same run.
- A normalized job contract, title screening, configurable match thresholds,
  JD review, structured AI JSON validation, run status, filters, and sorting.
- One Agent-owned local history for all three platforms. Updated Workers use a
  dedicated setup action to migrate their previous local history without
  claiming or running a task, then defer managed task deduplication to the
  Agent. Each new run still stores its own occurrence
  so deletion can roll back that run and rebuild remaining duplicate links.
- The default review list contains only the newest run. Starting another run
  moves previous jobs into a searchable history view with a run-batch filter;
  it never deletes those saved jobs or their review results.
- Each job can be marked `NOT_HELPFUL` with an optional reason and note. A
  completed run can then produce a versioned review reflection, through the
  configured AI endpoint or a conservative local fallback. The current
  preference model informs future title and JD screening without deleting
  jobs. Feedback can be withdrawn and the run reflected again so obsolete
  preferences stop influencing later results.
- Versioned cover-letter drafts generated from a completed JD review and one
  selected profile. The user can revise the English letter with additional
  guidance, edit and save it locally, and export through the browser's PDF
  print flow. Maximum pages and the base prompt are user-configurable.
- Local JSON storage under `data/`; secrets remain in environment variables.

## Deliberate Boundaries

- No auto-apply, application-form filling, resume tailoring, email automation,
  interview tracking, cloud scheduler, or account bypass. Cover letters stop
  at local drafting, editing, and user-initiated PDF export.
- Login, CAPTCHA, and anti-bot checks are not solved or bypassed. A worker
  should report `needs_user_action`; the user finishes the browser action and
  then resumes the run.
- The worker scripts deliberately use a different Tampermonkey identity from
  the frozen helpers, so they do not overwrite them.
- The Agent never merges jobs from fuzzy title similarity. Cross-platform
  deduplication requires the same normalized full title and company plus a
  compatible specific city or state. Broad Australia-only locations, different
  years, different titles, and same-platform reposts with new IDs remain
  separate. Uncertain cases are retained.
- A duplicate is not deleted: the run-scoped occurrence remains in local
  history with a link to the earlier record. This preserves task statistics and
  allows deletion of a mistaken run to rebuild the remaining history.

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
  "searchJobType": "full-time",
  "profileId": "profile_...",
  "screening": null
}
```

Worker result submissions use `{ runId, taskId, workerId, jobs, status,
reason }`. The server verifies the worker assignment and normalizes every
submitted item. Partial results are retained even if a worker fails or pauses
for manual action; a retry may be marked as a duplicate, never discarded.

## Screening Rules

Stage A is local and costs no AI tokens:

- Direct technology, software, AI/ML, data, IT, and graduate-program titles
  are `CLEAR_MATCH`.
- Obvious unrelated professions, senior leadership, and non-technology
  disciplines are `CLEAR_REJECT`.
- Broad titles such as `Graduate Analyst` are `AMBIGUOUS`.
- An ambiguous title can still be rejected when its card snippet clearly
  identifies an unrelated profession and contains no conflicting technology
  signal.

Stage B runs only after unified-history and Stage A checks. It considers the
run's selected profile snapshot, its profile-scoped preferences, technology
terms, eligibility/seniority concerns, and the full JD. A saved JD can be
reused across profiles, but an AI score can be reused only when the profile
basis matches. If an AI endpoint is configured, job title and JD are explicitly sent as
untrusted data and the returned JSON is validated before it is saved. A failed
AI response becomes `AI_ERROR`; it never stops the full run.

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
Worker card scan --> Agent run occurrence --> unified local history check
                                              |
                                  local title + card-snippet rules
                                              |
                                      selected JD retrieval
                                              |
Resume upload --> approved career profiles --> selected run snapshot
                                             --> AI JD review --> review dashboard
                                                                  |
                                                        optional cover letter
```

## File Map

- `config/job-search-routine.json`: first-run execution and screening defaults.
- `src/storage.mjs`: local atomic JSON persistence.
- `src/job-identity.mjs`: conservative same-source and cross-platform identity
  matching for the unified history.
- `src/screening.mjs`: normalized jobs, title rules, local JD assessment, and
  validation.
- `src/ai.mjs`: optional OpenAI-compatible structured profile/JD evaluation
  and cover-letter drafting.
- `tools/extract_resume.py`: isolated `.docx`/PDF text extractor.
- `workers/`: independently installable LinkedIn, Indeed, and SEEK worker
  scripts. These are the only scripts that talk to the local Agent API.
- `server.mjs`: local HTTP API, per-platform serialized queue, static-file server.
- `public/`: dashboard application.
- `test/`: focused rule and data-contract tests.

## Run and Test

```powershell
npm start
npm test
```

Open `http://127.0.0.1:4317`. Copy `.env.example` to `.env` only when an AI
endpoint is wanted; leaving it absent keeps all processing local.

For the optional external-GPT profile flow, upload the same resume in GPT,
copy the dashboard's profile prompt, then paste its JSON-only response into
the `GPT 画像 JSON` field before generating a draft. The profile request limits
that optional context with `JOB_AGENT_AI_MAX_EXTERNAL_PROFILE_CHARS` (default
`6000`) in addition to the resume-input and output-token limits.

## Worker Installation and Daily Run

1. Install the three scripts in `workers/linkedin/`, `workers/indeed/`, and
   `workers/seek/` in Tampermonkey. Keep the frozen helper scripts installed;
   disable them on worker tabs if their duplicate panels are distracting.
2. Start this local server on port `4317`, then open the dashboard.
3. Add each daily task from the dashboard. Its preflight tab fills the platform
   search form, applies its own date filter, and submits a test search. Only a
   successful preflight adds that task to the ready list.
4. Delete ready daily tasks from that list whenever they are no longer wanted;
   previous runs stay intact.
5. Choose the execution mode in settings, then start a run. The direct button
   click opens one worker tab for every platform represented in ready tasks.
6. Each worker navigates with the target query in its URL, preserves the
   original scan's delays/scroll behavior, uploads its summary to the local
   dashboard, and proceeds to its next platform task.
7. If a site requires login, CAPTCHA, or another security action, the worker
   pauses that platform, sends a Tampermonkey/browser notification, and marks
   the task `needs_user_action` in the dashboard. Complete the site action in
   that same tab, then choose `继续` in the dashboard. No challenge is solved
   or bypassed by the software.
