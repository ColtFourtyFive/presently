# Implementation status

This document tracks the first application build against the proposed requirements dated September 14, 2026. It is a development record, not a release approval or a statement of Kumon certification.

## Built in the first increment

The application provides a staff workspace for student and guardian records, inquiries and follow-up tasks, recurring schedules, attendance, history, reports, and center settings. PostgreSQL stores application data on Railway. PGlite provides persistent local development storage.

The server enforces named staff sessions, roles, and center scope. Sessions expire after 15 minutes of inactivity; background roster polling does not reset that timer. Attendance uses explicit commands and stable event IDs. Accepted arrivals open a visit; authorized departures close it. Exceptional departures preserve what staff observed and open an incident. Corrections retain original attendance events and attribute changes to staff. Manager exports include original and effective event times, correction attribution, and center time zone.

This is partial coverage of FR01, FR03 through FR08, FR10 through FR16, FR23 through FR25, and FR32. The summary below identifies the remaining controls. It should not be read as acceptance of every behavior within those requirements.

## Remaining work before operational use

| Area | Remaining work | References |
| --- | --- | --- |
| Staff identity | Managed authentication, MFA, recent-authentication checks for privileged actions, staff provisioning and revocation procedures | FR01, NFR04 |
| Center opening | Designated contingency device, opening readiness, handover controls | FR02 |
| Family records | Shared household relationships, duplicate review and merge, pickup authority verification and change history, independent-departure policy | FR03, FR05, FR06, FR08 |
| Scheduling | Dated exceptions, appointments, center capacity and complete rescheduling rules. Recurring slot creation checks student overlaps; slots can be canceled. | FR07 |
| Import and identity | CSV preview and validated import batches, duplicate handling, opaque revocable QR tokens | FR09, FR10 |
| Attendance workflow | Device identity, full occurrence-time provenance, historical corrections and unresolved-presence reconciliation | FR11 through FR16 |
| Outages | Designated-device protected roster, durable local queue, offline grants, restart recovery, clock checks, conflict review and physical roster verification | FR17, FR18 |
| Retention and privacy | Two-year retention enforcement, linked-record protection, policy holds, privacy request workflow, controlled disposition | FR19, FR31 |
| Recovery | Scheduled backups, restore drills, tested recovery objectives, recovery keys, reconciliation after restore | FR20, NFR06 |
| Operating readiness | Versioned procedures, staff demonstrations and training evidence, review package and recorded approval | FR21, FR22 |
| Security and audit | Security assessment, restricted operational logs, full policy and access-change audit coverage, secret rotation | FR23, NFR04 |
| Contact preferences | Attributed communication preferences and complete household timeline | FR24 |
| Reporting | Validation of date boundaries across supported time zones, no-show definitions, reconciliation with incomplete attendance, and full history report acceptance | FR14, FR25 |
| Monitoring | Alert routing, backup failure detection, incident closure evidence and measured availability | FR32, NFR02 |
| Validation | Supported-device outage tests, representative load tests, keyboard and screen-reader review, accessibility conformance assessment | NFR01, NFR05, NFR07, T01 through T17 |

Outbound messaging, a guardian portal, payment linkage, and instructor progress summaries belong to a later release. Multi-center operations and corporate integration need an approved interface and a separate design review. These features are not part of this build.

## Verification

On September 14, 2026, `npm test` passed 27 tests across four files. The suite covers authentication and session scope, background polling, role restrictions, attendance retries and concurrency, pickup permissions, exceptional and unmatched departures, correction provenance, inquiry conversion, and report export authorization. It also verifies that the optional fictional demo initializes without duplicating data on restart, and that a new nested local database directory starts successfully and preserves committed data after reopening. Empty-workspace tests cover the default without sample records, preservation of staff and sessions during an authorized demo reset, isolation from other centers, refusal to reset a non-demo center, and a restart that remains empty. Tests use ephemeral PGlite databases without external services or real student data.

`npm run check` and the production build passed on the same date. Eleven local browser workflow checks passed, covering named login, background polling, student and guardian creation, arrival, authorized checkout, correction attribution with original-event preservation, inquiry conversion, recurring lesson creation and cancellation, CSV download, persistence after browser reload, and logout. Desktop and mobile screenshots were inspected. No browser runtime errors or page-width overflow were reported.

Hosted checks confirmed PostgreSQL availability, rejection of anonymous student-data access, staff login with a Secure/HttpOnly session cookie, authenticated sample records, and a saved synthetic interaction that remained available after a new Railway deployment. Production dependency auditing reported zero vulnerabilities. Two moderate advisories remain in the development-only Vitest toolchain; a major-version upgrade remains separate work.

A separate hosted browser pass verified all six workspace pages, mobile navigation and visible attendance actions, report controls, and logout. It found no browser runtime errors or unexpected business-record writes. Browser scripts, fonts, and other loaded resources came from the application's own origin. Screenshot evidence and machine-readable reports are stored locally under `tmp/browser` and `tmp/browser-hosted`, outside Git and deployment uploads.

PostgreSQL remains the production database. Passing PGlite tests does not establish Railway availability, production load performance, browser offline durability, backup recoverability, or certification readiness.

## Railway preview

Project [Kumon CRM](https://railway.com/project/83fb1c4c-5246-4250-8e00-a4fc4053c5ff) contains a `web` service and persistent `Postgres` service. The preview URL is [web-production-ce255.up.railway.app](https://web-production-ce255.up.railway.app). Authentication protects student data; the public health endpoint reports availability only.

At the user's request, the hosted and default local workspaces were cleared of sample business records on September 14, 2026. The hosted reset removed 24 synthetic students, 8 inquiries, 64 recurring schedules, and their related attendance, contacts, tasks, interactions, and sample audit entries. The existing owner account and login sessions were retained, along with one administrative audit entry documenting the reset. Previously invented location and operating hours are now unconfigured. Demo seeding is disabled in both environments and is opt-in in the code and environment template.

The login screen contains no fictional student activity. A new empty Overview directs staff to the existing student directory and center settings. The full proposed setup flow is documented in [Kumon center onboarding](onboarding-proposal.md); the wizard, import flow, invitations, and remaining operational controls still need implementation.

After clearing the workspaces, 13 read-only browser checks passed in each environment. They confirmed empty business collections and demo mode off before and after the checks, owner login/logout, all six pages, the new setup prompts, no fictional login activity, and mobile layout without page overflow. No business records were created and no browser runtime errors occurred. Evidence is under `tmp/empty-workspace`.
