# Optional Job Distance Lookup

Distance lookup is off by default. It works independently of AI review and the
three platform Workers. Installing or updating a Worker is not required.

## Setup and workflow

1. In Search Settings, enable distance lookup and enter a home or other origin
   address, its country, and a Geoapify API key.
2. Choose Save and Locate. The address is sent to Geoapify; select and confirm
   the correct returned location. A suburb-level origin is allowed, but all
   resulting distances will be marked approximate.
3. Before starting tasks, choose whether that run should calculate distance.
   The default is off. When enabled, newly returned non-duplicate jobs are
   queued after they reach the Agent. A manual current-list calculation remains
   available in Job Review, and each batch accepts up to 500 jobs.
4. Distances appear beneath the job location. Choose nearest-distance sorting
   to put known distances first. Missing or ambiguous locations remain in the
   list without a fabricated distance.
5. Click a distance label to inspect the matched location or supply a confirmed
   workplace address. A blank correction restores the source location. The
   individual dialog can also calculate just that job.

## Accuracy and data boundaries

- Kilometres are great-circle (straight-line) distances, not road distances,
  travel times, or a guarantee of walkability.
- Address priority is user correction, structured `workAddress`, an explicitly
  labelled street address in the saved JD, then the listing location.
- Company headquarters, search locations, and arbitrary addresses in the JD
  are never substituted for the workplace. A JD not yet saved is not fetched
  by this feature; existing JD retrieval remains available separately.
- Fully remote locations have no fixed commute unless the user supplies a
  workplace. Multiple destinations, weak geocoder matches, and state/country
  locations produce explicit unavailable or ambiguous results.
- Only a geocoded house-number location at both ends is presented without the
  area-estimate label. Users can inspect the exact address used.

## Storage and requests

`data/distance.json` is ignored by Git. It stores the key, origin, address
corrections, cache, and results locally. The key is never returned by bootstrap
or written into diagnostic messages. Home addresses and distance data are not
added to candidate profiles, AI prompts, or Worker settings.

Only explicit origin searches, manual distance batches, and task runs where the
user enabled automatic distance lookup call Geoapify. The UI tells users that
those actions send address text to that provider. Address candidates
are cached for 30 days, at most 2,000 entries, and identical workplaces share
the cache across platforms. Requests run sequentially, at least 1.1 seconds
apart, with an eight-second timeout. A provider error stops the batch, keeping
completed results; there are no automatic retries or automatic startup resumes.
Cancel or disable aborts the in-flight request and stops subsequent requests.
Changing origin address or country clears the old cache and results and requires
origin confirmation again. Updating a job's source location invalidates its
cached distance. Provider results are attributed to Geoapify and OpenStreetMap.

API documentation: https://apidocs.geoapify.com/docs/geocoding/forward-geocoding/
Get a key: https://myprojects.geoapify.com/

Automated tests use a simulated provider, including failures and cancellation.
A real end-to-end provider query requires the user's configured API key; no key
or home address is bundled with the application.
