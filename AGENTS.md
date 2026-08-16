# Project Language Policy

This policy applies to every new or modified source file, prompt, API contract, stored record, test, document, and generated artifact in this repository.

## Default Language

English is the canonical and default language of the system. Use English for:

- Source code, identifiers, comments, filenames, configuration, and documentation.
- API routes, request and response fields, database keys, schema names, enums, status values, event names, and error codes.
- Logs, diagnostics, internal errors, developer messages, test fixtures, and test assertions, unless a test specifically verifies user-facing Chinese analysis.
- Search keywords, include and exclude keywords, job-title rules, preference signals, learned signals, classification labels, and all other machine-matching values.
- Stored job data, including job titles, company names, locations, skills, qualifications, technologies, credentials, visa subclasses, work-rights categories, and legal-status wording.
- AI structured-output keys and machine-consumed values.

Do not translate machine-readable English content into Chinese. Prefer exact wording from the source job description or user profile when it is already in English.

## Allowed Chinese Content

Use Simplified Chinese only for natural-language analysis that is presented directly to the user, including:

- A job-match explanation or score explanation.
- Matched strengths, concerns, gaps, and application guidance.
- A work-rights or visa assessment explanation.
- Review feedback summaries, daily reflection summaries, and screening guidance.

Chinese analysis may contain embedded English terms. Preserve job titles, employer names, locations, technologies, skills, qualifications, credentials, visa subclasses, work-rights phrases, legal statuses, and quoted source wording in English when translating them could reduce precision.

Existing Chinese navigation labels and static interface copy are legacy product text and may remain until a dedicated interface-language change is requested. Do not treat them as permission to store Chinese machine data or generate Chinese internal values.

## Boundary Examples

- `reason`: Chinese, because the user reads it as analysis.
- `matchedAreas[]` and `concerns[]`: Chinese explanations, with exact English technical terms preserved.
- `workRights.reason`: Chinese analysis; `workRights.requirements[]`: preserve authoritative English visa and legal terms.
- `targetKeywords[]`, `exclusionKeywords[]`, `targetSignals[]`, `avoidSignals[]`, and `titleExclusions[]`: English only.
- `classification`, `screeningStatus`, `feedbackType`, API fields, and persisted enum values: English only.
- A visible Chinese label may render an English internal enum, but the stored enum must remain English.

## Implementation Requirements

- Prompts that return both analysis and machine signals must state the language requirement separately for each field.
- Validate machine-signal arrays locally. Reject Chinese machine keywords instead of silently translating or storing them.
- Do not add an AI or translation API call solely to translate system data.
- Keep canonical data in English and translate only at the final user-facing presentation boundary when translation is actually needed.
- Add or update tests whenever a change could blur this boundary. Tests should verify that Chinese analysis is accepted and Chinese machine signals are rejected.

When uncertain, choose English. Chinese is an explicit presentation-layer exception, not the system default.
