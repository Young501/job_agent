# Batch Title Triage

Newly imported jobs use neutral, unscored screening instead of the legacy technology-specific title and preview rules. Existing stored reviews are not rewritten.

Workers scan their search results, then register candidates in chunks of 50. The Agent persists and deduplicates discoveries, honors enabled exclusion keywords, and queues title triage for remaining candidates. Workers poll the persisted result before retrieving JDs. A failed planning request never defaults to fetching every JD.

The queue groups up to 50 jobs by run and profile. It uses the run's profile and preference snapshots, not subsequent profile edits. It sends titles, IDs, available job types and compact profile context, not full JDs. Its output is strictly `KEEP` or `EXCLUDE`, never a match score. Soft preferences and ambiguity must remain `KEEP`. Each exclusion requires a Chinese reason; English identifiers, titles and keywords remain unchanged.

Every supplied ID must occur exactly once in a valid response. Missing, duplicate, unknown or malformed decisions invalidate the batch without excluding any job. At most two attempts are made. Jobs remain in `TITLE_ERROR` on failure, with explicit retry and bypass controls. The title queue reuses the connection pool and preflight checks; attempts count toward the run's AI-call ceiling. Its output budget is separately configurable in AI Service > Token Settings (default 6,000 tokens).

Job decisions and batch metadata are stored in local state. In-flight titles are requeued after process restart. Duplicate discoveries for the same profile do not receive a second title call when an existing occurrence already owns processing. A different profile is evaluated independently. Completed JD reviews remain reusable only under the existing same-profile rules.

The title-triage dialog provides search, selection, confirmation, retry and restore. Restoring a rejected title records an explicit rejection correction for the corresponding profile, removes pending exclusion suggestions from that job, and bypasses title triage for that occurrence. Missing JDs are handed to the existing Worker retrieval queue; available JDs enter detailed AI review. If popup opening is blocked, restored jobs remain available for the missing-JD action. AI exclusions never directly enable permanent exclusion keywords.

Batch calls and reported tokens are shown separately. Missing provider usage after errors is not assumed to be zero billed usage. Title prefilter scores remain unset until JD review. With AI disabled, title triage and automatic JD AI review do not run.

## Verification

API tests cover 55-job splitting, conservative retention, exclusion, malformed/missing ID handling, bounded retries, recovery actions and JD gating. Unit tests cover response validation, compact inputs, language boundaries and bypassing the old career-specific rules. Isolated Chromium tests cover persisted restart recovery, desktop/mobile dialog layout, selection/restoration and the title-token field. A live Grok sample checked software-career versus cafe-part-time profiles; third-party job websites were not live-scanned as part of this change.
