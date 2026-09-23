# Authenticated archived receipt lookup, September 16, 2026

The affected regression suite passed **108 tests across 8 files**. TypeScript and the production build passed. Release fingerprint `faca57eaea439b29af040322b81b3525dbb2cfd67511bccd89c781883a350522` covers 270 files and remained unchanged during validation. Local schema remains 27. This was a scoped regression run. The previous full-suite checkpoint passed 649 tests across 59 files before this change.

The existing authenticated `GET /attendance/events/:id` endpoint now accepts an optional read-only archive adapter under both `/api/admin` and `/api/kiosk`. It returns the original accepted receipt from a verified publication when live detail is absent. The adapter requires `ARCHIVE_ENABLED` to be exactly `true`, an R2 binding, and a nonempty backup key. Missing configuration leaves healthy live reads available.

Existing role, center, and kiosk controls run before object reads. Unknown or undisclosed foreign IDs return 404. Missing or inconsistent known evidence returns 503. Responses retain `Cache-Control: no-store`. The resolver rechecks permanent ownership, publication availability, and history generation after R2 reads. A consistent live receipt takes precedence, including when archive configuration is broken.

The new route tests cover admin and enrolled/unlocked kiosk access, original corrected-visit receipts, literal null receipts, missing and corrupt objects, wrong keys, unavailable and stale-generation publications, claim and locator mismatches, and zero writes. Existing resolver tests cover authority changes during object reads. The first isolated run exposed test-fixture assumptions about compact receipts and a missing foreign-center parent. Corrected fixtures passed 28 route tests. Product adapter behavior did not change during those fixes.

Representative local native measurements include authentication SQL:

| Request | D1 statements | Rows read | Rows written | R2 objects |
| --- | ---: | ---: | ---: | ---: |
| Healthy live receipt, archive reads disabled | 5 | 5 | 0 | 0 |
| Healthy live receipt, archive reads enabled | 6 | 9 | 0 | 0 |
| Archived admin receipt | 11 | 13 | 0 | 2 |
| Archived kiosk receipt | 12 | 15 | 0 | 2 |

An archived lookup fetches only its manifest and selected part. Enabling the adapter adds a fifth resolver snapshot statement even to live reads. These measurements establish local query and object bounds. They do not establish deployed CPU use or Free-plan capacity.

No schema, deployment, live data, source eviction, scheduling, or paid-plan change occurred. POST retry lookups, historical visit and report authority, new archived corrections, addenda, holds, and safe source removal remain unfinished. Live backup delivery and independent cloud restoration, iPad/staff/outage acceptance, and customer ownership and handover remain release gates. Railway remains available and the production goal stays active.

Evidence: [current manifest](../tmp/public-reader-checkpoint-evidence-20260916.json), [native request measurements](../tmp/public-reader-request-io-20260916.json), [previous full-suite checkpoint](archive-abandonment-checkpoint-2026-09-16.md).
