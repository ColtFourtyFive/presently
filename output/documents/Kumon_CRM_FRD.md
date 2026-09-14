# Kumon center CRM functional requirements document

Version 0.1 | 14 September 2026 | Draft for operations and delivery review

Prepared for the center manager, frontline staff, product owner, developers, and testers.

## Purpose and requirement conventions

This document defines the proposed behavior of an in-house Kumon center CRM. The first release covers staff access, inquiry follow-up, families and students, enrollment, scheduling, attendance, records, and operating controls. The companion BRD contains the business case, vendor findings, source register, and decisions. The companion FDR describes the proposed implementation.

Source item references mean the eight baseline checklist items on page 1 of the supplied Student Check-In and Check-Out System Requirements and Non-Exhaustive Informational Vendor List. The source is undated and states annual certification will be expected once requirements are finalized and implemented. Current policy status must be confirmed. CRM features and numerical service targets are proposals, not statements from Kumon. [SRC01]

M1 means required for the proposed first release. P2 means proposed for a separately approved second release. Future means contingent on a further business decision or external access. Each functional requirement has a unique ID, expected behavior, acceptance condition, and traceability to a business requirement and design section. "Shall" describes the proposed contractual behavior if this draft is approved.

Assumptions are one center initially, staff-operated workflows, up to 500 active students, 50 concurrent sessions, and 30 arrival events in five minutes. These loads need validation. FDR means Functional Design Report. No child login, corporate API, payment processor, or messaging provider is selected.

## Actors and permission boundaries

| Actor | Allowed first-release actions | Boundary |
| --- | --- | --- |
| Owner | Configure center, staff access, policies, reports and exports | Access only assigned center data; privileged actions are audited |
| Manager | Maintain student records, oversee attendance, approve corrections and imports, manage training | Cannot erase retained event history |
| Front desk | Leads, tasks, contacts, schedules, supervised attendance and permitted reports | No retention policy change, role administration, or unrestricted bulk export |
| Instructor | View assigned center roster and minimum student context; record permitted attendance if assigned | No lead exports, billing access, or private family details by default |
| Attendance station | Accept explicit attendance actions under a managed device session | No general CRM browsing; staff confirmation is required at launch |
| Technical maintainer | Deploy, monitor and restore using separate administrative access | No routine use of student records; exceptional access is time limited and audited |
| Guardian | Supplies information through center processes | Portal access is P2 and restricted to verified relationships |

The owner may combine operational roles for a small center, but permissions remain explicit. Custody or pickup restrictions require a narrowly scoped operational alert visible to authorized attendance staff, with detailed documents restricted to the manager. Roles are enforced by the server, not only by hidden controls.

## Access and CRM requirements

### FR01 Staff authentication and center isolation

M1. The system shall authenticate named staff, require multifactor authentication, enforce assigned roles and center scope, support account revocation, and expire unattended staff sessions after 15 minutes of inactivity. Privileged actions require recent authentication. Shared staff credentials are prohibited; a managed station has a device identity plus the acting staff identity.

Acceptance. An unassigned staff member cannot retrieve or change another center's records through screens, APIs, export jobs, or object links. Revocation blocks new actions within five minutes while online. The offline device policy in FR17 applies during disconnection. Role changes and failed privileged attempts are audited.

### FR02 Staff and device administration

M1. Authorized owners shall invite, deactivate, and assign staff; enroll and revoke attendance devices; and identify the center's designated contingency station. Device enrollment shall bind a device to one center and display its connection and synchronization state.

Acceptance. A revoked online device cannot submit events. A replacement device requires explicit enrollment. A contingency session records the manager, device, start time, and handover or closure. Changing the designated device does not silently transfer an offline queue.

### FR03 Inquiry capture and duplicate review

M1. Staff shall create inquiries with a contact name, at least one permitted contact method, source, interested subjects if known, owner, stage, and creation time. The system shall flag possible duplicate contact details without automatically merging people or students.

Acceptance. A matching normalized phone or email produces a review suggestion. Staff can link to an existing household, keep a distinct record with a reason, or cancel. The system preserves the origin and interaction history of converted inquiries.

### FR04 Pipeline and follow-up tasks

M1. Staff shall move inquiries through New, Contacted, Assessment scheduled, Assessment completed, Enrolled, Closed lost, or Do not contact, with stage history, an owner, and next action. Assessments are appointments and staff-entered outcomes. A task records due time, assignee, status, and completion.

Acceptance. A converted inquiry links to an enrollment. Closed lost requires a reason. Do not contact blocks future outbound messaging if enabled and preserves the preference. Overdue tasks remain visible until completed, reassigned, or canceled with a reason.

### FR05 Households and guardian relationships

M1. The CRM shall maintain households, guardians, student relationships, permitted contact methods, communication preferences, and effective pickup authorization. A student can have multiple guardians and a guardian can relate to multiple students. Separate households do not automatically share access or contact details.

Acceptance. Siblings can share a guardian without sharing student IDs. Removing one guardian relationship does not remove another. Updating pickup authority records who made the change and when; the center verifies authority through its approved process.

### FR06 Student identity and enrollment

M1. Every student shall have a stable, nonreusable internal ID, display name, center, status, and necessary relationship links. Enrollment shall identify subject, start date, status, and optional end date. Math and reading are configurable subjects. Required identity fields shall be minimized; date of birth and photos are optional only if an approved purpose exists.

Acceptance. Two students with identical names remain distinguishable to authorized staff. Inactivating a student prevents routine new enrollment activity while preserving retained attendance and its identity link. Changing a name or merging a reviewed duplicate does not orphan history.

### FR07 Scheduling and appointments

M1. Staff shall manage recurring visit slots, effective dates, cancellations, and one-time appointments in the center's local time zone. The system shall flag overlaps and configured capacity limits; a manager can override a scheduling warning with a reason.

Acceptance. Rescheduling changes expected attendance without modifying actual visit events. A canceled slot is excluded from the expected roster. An unscheduled student can check in after staff confirmation. Subject changes within one visit do not automatically check a student out.

### FR08 Authorization and operational alerts

M1. Authorized staff shall record guardian and pickup permissions, independent departure rules if permitted, restrictions, review dates, and manager instructions. Attendance views shall show a minimum actionable alert without exposing unnecessary family details.

Acceptance. A disallowed pickup attempt produces a staff escalation and no authorized release. If the student remains at the center, no departure is recorded. If a student actually leaves without authorization, FR12 records that fact with an incident. A QR code or PIN alone never establishes pickup authority. The manager's approved exception procedure records the verifying staff member and reason. Policy and terminology are confirmed before pilot.

### FR09 Controlled import and master data export

M1. Managers shall import approved CSV data through a preview and validation stage with field mapping, source IDs, row errors, and duplicate review. Committing requires confirmation of accepted and rejected row counts. Authorized exports shall preserve IDs and honor role and center scope.

Acceptance. An invalid row is reported without partial unexplained changes. Repeating the same import batch does not create duplicates. Imported historical visits are labeled as imported, keep source timestamps, and never become current live events merely because they were imported.

## Attendance requirements

### FR10 Student identification at the station

M1. Staff shall identify a student through an opaque QR token or a staff-only search by name or ID. The system shall require explicit selection when a name matches multiple students. Scannable tokens shall contain no name, contact details, or pickup permission, and shall be replaceable.

Acceptance. A revoked or unknown token gives a neutral failure with staff assistance. Identical names require disambiguation. A valid token identifies one student but does not perform an automatic check-in or check-out. No public searchable student list is available.

### FR11 Actual arrival recording

M1. Staff shall submit an explicit check-in when the student actually arrives. The event shall identify student, center, action, actual occurrence time, server receipt time, actor, device, and capture mode. A saved confirmation shall appear only after durable server or approved local storage succeeds.

Acceptance. On a successful online check-in, one open visit exists and the student appears on the roster within the NFR01 target. Failed persistence produces a visible failure and no success message. Scheduled time is never used to generate an arrival automatically.

### FR12 Actual departure and staff oversight

M1. Staff shall submit an explicit check-out when the student actually leaves. Normal release follows the approved authorization check. A separate observed exceptional departure action shall record an actual unauthorized or unexpected departure, open an incident, and escalate to the manager. Recording that fact does not authorize release. The system shall record the acting staff member and release basis or exception, using only necessary identifying details.

Acceptance. Check-out closes the correct open visit, preserves the actual departure time, and updates the roster. An observed departure without an open visit is retained as an unmatched event for manager review and does not fabricate a prior arrival. An exceptional actual departure marks the student absent with an incident, rather than leaving the student falsely present. A token scan cannot dismiss a release concern.

### FR13 Current roster and status

M1. Authorized staff shall see currently recorded present students, expected students separately, students whose presence needs verification, open exceptions, latest update time, and the source and freshness of the displayed data. Uncertain presence remains visible and is excluded from a falsely precise present count. Offline or stale views shall show a persistent warning.

Acceptance. Two online stations see consistent committed presence within five seconds under the agreed load. At more than 30 seconds without a successful connection, the station displays a connection warning. A schedule change never changes actual presence. Staff can access the protected contingency roster during an outage.

### FR14 Historical attendance and exports

M1. Authorized users shall retrieve visits and underlying events by student and date range, with local times, time zone, recorded duration where valid, corrections, capture mode, and exception status. Managers shall export human-readable and CSV records with attribution and export time.

Acceptance. A retained visit from at least two years earlier can be retrieved from a seeded test dataset and exported. Exported record counts match the selected history. Corrected values are identified and the original event remains inspectable. Unresolved visits are not reported as verified durations.

### FR15 Attributed corrections

M1. Managers shall correct factual errors through a new correction record containing the affected event or visit, original and corrected values, actual event time if known, reason, supporting reference if available, correcting actor, and correction time. Routine staff can flag an issue for review.

Acceptance. The original event remains unchanged and retrievable. The system distinguishes occurrence time from correction time. Corrections that change current presence trigger a roster refresh and staff notice. Unknown departure times remain unknown until resolved; the system never substitutes closing time.

### FR16 Duplicate and exceptional attendance

M1. The attendance service shall detect duplicate requests and invalid transitions, support multiple visits in a day, and maintain an exception queue for conflicting scans, missing events, improbable times, and open visits at closing. Absence is a separate staff-marked or unresolved expected-attendance status.

Acceptance. Retrying one event key stores one event and returns the same result. Two simultaneous check-ins with different keys create no more than one open visit and flag the second attempt. A later check-in after a valid check-out starts a new visit. No automatic end-of-day check-out occurs.

### FR17 Contingency capture and local access

M1. The system shall support one designated, managed contingency station with an encrypted minimum roster snapshot and durable local event queue. Its staff operator shall record actual arrivals and departures with explicit local confirmation while disconnected. Other devices shall direct staff to that station instead of independently recording offline attendance.

Acceptance. With network access removed, the designated device can retrieve the last synchronized roster, display its age, record arrivals and departures, survive an application restart, and show unsubmitted events. It displays a local-save confirmation only after durable storage. If storage, power, identity verification, or the device fails, staff invoke the approved emergency procedure and record the incident. Local capability must pass on the actual device and browser combination.

### FR18 Recovery and reconciliation

M1. On reconnection, staff shall synchronize queued events with stable event IDs, preserve occurrence and receipt times, and review conflicts before declaring the roster reconciled. The manager shall reconcile any temporary emergency records as exceptional later transcription with original observed times and source attribution.

Acceptance. Repeated synchronization does not duplicate events. Uncertain ordering, clock drift beyond two minutes, overlapping visits, revoked-device events, or contradictory actions enter review. An expired grant at upload does not discard an event validly captured within its grant period. A successful upload alone does not clear the reconciliation warning. Closure requires queue acknowledgement, resolution of attendance effects, and staff verification of who is physically present.

## Records and operating requirements

### FR19 Attendance retention and holds

M1. The system shall retain reviewable attendance for at least two calendar years from each event's occurrence. A visit and its corrections, minimal identity links, and required audit evidence shall remain available until all linked attendance retention periods have elapsed. Holds and a longer approved policy extend retention. Unresolved attendance issues shall not be automatically purged.

Acceptance. Changing policy or deleting a student cannot remove protected attendance. Tests immediately before and after the two-year boundary, including leap-day behavior, enforce the floor. A hold blocks eligible deletion. Deletion after eligibility follows the approved policy and is audited. Other CRM data has a separate purpose-based schedule.

### FR20 Backup and tested restoration

M1. The system shall back up the primary database, required attachments, and recovery configuration with encryption and restricted access. The technical maintainer shall test restoration, compare counts and sample records, and document results. Backups do not replace the historical archive or contingency roster.

Acceptance. A restore drill meets NFR06, recovers accessible records and required keys, and identifies the recovery point. Replayed local events remain idempotent. Retention tombstones and holds are reapplied before restored production data becomes accessible.

### FR21 Staff procedures and training evidence

M1. The center shall maintain versioned attendance, release, correction, and outage procedures, with staff acknowledgements and training completion dates. The application shall make the current procedure accessible to authorized staff and provide a launch readiness list.

Acceptance. A manager can identify every scheduled staff member who has not completed the current required training. A staff member demonstrates check-in, checkout, a release concern, a missing checkout, and an outage response. Recording an acknowledgement alone is not the demonstration.

### FR22 Review readiness and conditional certification

M1. Managers shall assemble a dated evidence package containing the applicable checklist version, control ownership, training status, sample records, retention configuration, outage and restore drill results, and open issues. Annual reminders and submission workflow shall be configured only after current requirements and dates are confirmed.

Acceptance. The package can be generated for review without claiming external approval or completed certification. A manager records an actual review date and outcome manually. No corporate submission endpoint is assumed. [SRC01 p1]

### FR23 Audit history

M1. The system shall record actors, center, action, affected identifiers, result, timestamp, and permitted change detail for access changes, attendance corrections, imports, exports, policy changes, privacy actions, and exceptional support access. Application users cannot modify audit records.

Acceptance. A sampled correction, export, role change, and retention action can each be traced to an actor and time. Audit logs exclude passwords, tokens, message bodies, and unnecessary child details. Operational log access is restricted separately from routine CRM access.

### FR24 Communication history and preferences

M1. Staff shall log calls, meetings, and messages sent through existing approved channels with date, channel, staff member, subject, outcome, and optional brief notes. Contact preferences and do-not-contact status shall be visible before outreach. Notes shall discourage unnecessary sensitive information.

Acceptance. An authorized staff member can retrieve the contact timeline for the correct family. Preference changes are attributed. The first release records interactions without sending external messages. Automated delivery requires FR26 approval.

### FR25 Operational reports

M1. Managers shall view current presence, attendance by date, unresolved visits, expected versus actual attendance, active students by subject, overdue tasks, inquiry cohorts, enrollment conversion, and training readiness. Reports shall state filter scope, period, time zone, data freshness, and metric definition.

Acceptance. Every aggregate reconciles to a permitted detailed view. A student in two subjects counts once in unique students and twice in subject enrollments, labeled accordingly. A canceled slot is excluded from no-show calculations. Pending offline data produces an incompleteness warning.

### FR31 Privacy administration

M1. Authorized managers shall record data-access, correction, and deletion requests, verify the requester's authority, review applicable retention or custody restrictions, and document disposition. Exported information shall be limited to the verified person's entitlement.

Acceptance. A guardian linked to one child cannot receive another child's record. A deletion request cannot bypass the attendance retention floor or hold; the manager records the reason for restricted deletion. Data is removed or deidentified only under the approved policy, with recoverable backups handled by their lifecycle and restoration controls.

### FR32 Monitoring and incident handling

M1. The system shall monitor attendance writes, roster freshness, synchronization backlog, database health, backup success, and elevated errors. Staff shall see a clear operational state; technical alerts shall route to named support owners with a documented escalation path.

Acceptance. Simulated write failure, stale roster, failed backup, and a growing offline queue produce the expected staff indication and support alert. Logs support diagnosis without exposing unnecessary student data. Incident closure records the effect on attendance and any reconciliation performed.

## Requirements for later releases

### FR26 Outbound messaging

P2. After separate approval, the system shall send templated guardian messages through an approved provider, enforce channel-specific permission and opt-out rules, and retain delivery status. Operational and marketing purposes shall be distinct.

Acceptance. A retry cannot send a duplicate message for the same event and recipient. Suppressed or opted-out recipients receive no prohibited message. Delivery failure is visible; provider delivery does not prove guardian acknowledgement. Pending or disputed attendance does not trigger an unqualified arrival or departure claim.

### FR27 Guardian portal

P2. Verified guardians shall access only their authorized student relationships and permitted history. Authorization changes shall revoke affected access promptly. No child account is proposed.

Acceptance. Cross-household and changed-custody tests block unauthorized access. Enrollment in the portal does not itself grant pickup authority. Privacy and identity verification review is complete before live use.

### FR28 Payment linkage

P2. Staff may link external billing references and approved payment status through a hosted payment or accounting provider. Card numbers and security codes shall not enter the CRM.

Acceptance. Signed provider events are verified, deduplicated, and reconciled. Failed or overdue payment does not block recording a student's actual arrival or departure. Refund and financial reconciliation behavior requires a separate approved specification.

### FR29 Instructor progress summaries

P2. Authorized instructors may record concise, dated progress summaries and next follow-up actions using approved fields. The center shall define the relationship to any corporate academic record before implementation.

Acceptance. Author and date remain visible after an edit. Guardian visibility is separately controlled. The feature does not reproduce restricted curriculum or silently overwrite an external academic record.

### FR30 Approved external interfaces and multiple centers

Future. Any corporate interface or multi-center operating workflow shall require documented permission, supported contracts, source-of-truth rules, center-scoped authorization, and failure handling. Vendor API availability is research evidence only, not proof of a Kumon API.

Acceptance. Contract tests verify scope, identifiers, retries, revocation, and reconciliation against the actual approved interface. A migration or transfer preserves identity and history while applying the receiving center's access rules. A separate design review precedes enabling this feature.

## Nonfunctional requirements

All numerical targets below are proposed engineering targets and require confirmation against center conditions.

| ID | Requirement and measurable target | Validation |
| --- | --- | --- |
| NFR01 | Online attendance response at the 95th percentile at or below 2 seconds; committed roster update within 5 seconds; common history query within 5 seconds | Measure on supported devices and representative network with 500 active students, 50 concurrent sessions, 30 arrivals per five minutes and two years of seeded history |
| NFR02 | At least 99.5 percent primary-service availability during configured operating hours per month | Track successful attendance probes divided by scheduled probes; report planned and unplanned downtime separately and include both in the target |
| NFR03 | No duplicate accepted event IDs and no concurrent open visits for one student at one center | Transaction, concurrency, retry and crash-recovery tests; reconciliation exceptions remain explicit |
| NFR04 | Encryption in transit and at rest, managed keys, MFA, server-side authorization, secret rotation, no production data in lower environments | Security configuration review, cross-role tests, credential revocation, restore access test and targeted application security assessment |
| NFR05 | Staff workflows target WCAG 2.2 AA, keyboard access, visible focus, labeled controls, adequate contrast and text alternatives for status | Automated checks plus keyboard and screen-reader walkthroughs; final legal accessibility duties remain jurisdiction dependent |
| NFR06 | Proposed primary-service recovery point at most 15 minutes and recovery time at most 4 hours; current local attendance remains available through contingency procedure | Quarterly restore and outage drills; identify any lost server interval explicitly and reconcile using available contemporaneous evidence. A snapshot cannot reconstruct every online event. Owner must accept this disaster loss window or fund stronger recovery |
| NFR07 | Support A03 load without failed or lost accepted events; proposed seed size of at least 250000 attendance events | Load and concurrency test, including history and export work running alongside attendance |
| NFR08 | Documented deployment, migration, rollback, monitoring and restore runbooks; exportable data in documented formats | A second maintainer completes a supervised deployment and restore; exported sample can be independently interpreted |
| NFR09 | Designated device saves an offline event within 3 seconds at the 95th percentile and preserves queue across restart; no unbounded offline operation | Test up to one approved operating day, maximum 24 hours, on actual device; expiry causes visible escalation, never silent data loss |
| NFR10 | Attendance views and local caches contain only necessary data; two-year floor enforced; short-lived exports and local caches have defined expiry | Field inventory review, retention and purge tests, cache inspection and authorization tests |

## Acceptance scenarios and release evidence

Test with synthetic households, siblings, identical names, two subjects, a restricted guardian, an inactive student, an unscheduled arrival, and a second synthetic center. Include at least two years of synthetic attendance and leap-day cases. Never present seeded timestamps as actual live attendance.

| Test | Scenario and pass condition |
| --- | --- |
| T01 | Test every role, center boundary, device revocation and export route; unauthorized reads and writes fail |
| T02 | Create and convert an inquiry, resolve a duplicate, reassign an overdue task, and preserve stage history |
| T03 | Distinguish identical names and siblings; update a guardian restriction; preserve retained identity on inactivation |
| T04 | Reschedule a student and record an unscheduled visit; expected attendance changes while actual attendance remains factual |
| T05 | Observe a normal arrival and authorized departure; explicit events, timestamps, actor and roster match the observation |
| T06 | Retry an event, race two stations, and re-enter after departure; one open visit and correct separate visits result |
| T07 | Attempt unauthorized pickup, then simulate an actual unauthorized departure, re-entry and an unmatched departure; block release permission, close a known visit, preserve observed facts, record the return and escalate without inventing an arrival |
| T08 | Disconnect the designated device, record events, restart it, simulate local storage failure and stale roster; state and failures are visible |
| T09 | Reconnect with conflicting ordering, clock drift and repeated uploads; review resolves discrepancies without overwriting originals |
| T10 | Correct a missed departure and retrieve two-year history; original values, corrected values and attribution remain reviewable |
| T11 | Test retention boundaries, leap day, a hold, student deletion and restored deleted data; the approved floor and policy hold |
| T12 | Restore database and attachments, recover configuration and keys, replay local events and verify counts within recovery targets |
| T13 | Conduct staff demonstrations and generate readiness evidence; incomplete training and conditional certification state remain clear |
| T14 | Import valid, invalid and duplicate rows; repeat the batch; verify control totals and record audit events |
| T15 | Process a verified guardian request and a restricted deletion request; scoped disclosure and retention decisions are attributed |
| T16 | Reconcile reports and manual communication history; confirm canceled slots, subject counts and incomplete offline data are handled |
| T17 | Run representative load, accessibility walkthrough and fault injection; NFR targets and operational alerts pass |
| T18 | P2 only, test message permissions, retries and delivery failures; disputed attendance never sends false confirmation |
| T19 | P2 only, test portal relationship revocation, billing webhook replay and progress visibility |
| T20 | Future only, test the approved external contract and cross-center transfer permissions |

For each test, retain the requirement version, environment, device, dataset, steps, expected result, actual result, evidence, tester and date. The release owner accepts a passed test or records a noncritical exception with an owner and deadline. Critical safety, identity, data-loss or access failures block pilot and release. T18 to T20 are outside first-release acceptance.

## Traceability matrix

FD references name design sections in the companion FDR. BR references name business requirements in the BRD. SRC01 item numbers identify source obligations; "Proposal" identifies added CRM or engineering behavior.

| Requirement | Business | Origin | Design | Test |
| --- | --- | --- | --- | --- |
| FR01 | BR04 | Item 7 and proposal | FD06 | T01 |
| FR02 | BR03 BR10 | Items 4 and 6 and proposal | FD05 FD06 | T01 T08 |
| FR03 | BR06 | Proposal | FD02 FD03 | T02 |
| FR04 | BR06 | Proposal | FD02 FD03 | T02 |
| FR05 | BR07 | Proposal | FD03 FD06 | T03 |
| FR06 | BR01 BR07 | Item 2 and proposal | FD03 | T03 |
| FR07 | BR07 | Proposal | FD02 FD03 | T04 |
| FR08 | BR01 BR07 | Proposed release control | FD02 FD06 | T03 T07 |
| FR09 | BR07 BR10 | Proposal | FD07 FD10 | T14 |
| FR10 | BR01 | Item 2 and proposal | FD02 FD04 | T03 T05 |
| FR11 | BR01 | Items 1 and 3 | FD04 | T05 T06 |
| FR12 | BR01 | Item 3 and proposed release control | FD04 FD06 | T05 T07 |
| FR13 | BR02 | Item 5 | FD02 FD04 FD05 | T05 T08 |
| FR14 | BR02 BR04 | Items 5 and 8 | FD07 | T10 |
| FR15 | BR01 BR04 | Items 3 and 8 and proposal | FD04 FD07 | T10 |
| FR16 | BR01 BR02 | Items 3 and 5 and proposal | FD04 | T06 T07 |
| FR17 | BR03 | Item 6 and proposal | FD05 | T08 |
| FR18 | BR01 BR03 | Items 3 and 6 and proposal | FD05 | T09 |
| FR19 | BR04 | Items 7 and 8 | FD07 | T11 |
| FR20 | BR03 BR10 | Item 6 and proposal | FD09 | T12 |
| FR21 | BR05 | Item 4 | FD10 | T13 |
| FR22 | BR05 | Conditional source review statement | FD07 FD10 | T13 |
| FR23 | BR04 BR05 | Proposed evidence control | FD06 FD07 | T10 T14 |
| FR24 | BR08 | Proposal | FD02 FD03 | T16 |
| FR25 | BR09 | Item 5 and proposal | FD07 | T16 |
| FR26 | BR08 BR11 | Proposal for P2 | FD08 | T18 |
| FR27 | BR07 BR11 | Proposal for P2 | FD06 FD08 | T19 |
| FR28 | BR11 | Proposal for P2 | FD08 | T19 |
| FR29 | BR11 | Proposal for P2 | FD03 FD08 | T19 |
| FR30 | BR10 BR11 | Future proposal | FD08 | T20 |
| FR31 | BR04 | Item 7 and proposed privacy process | FD06 FD07 | T15 |
| FR32 | BR03 BR10 | Proposed operating control | FD05 FD09 | T17 |
| NFR01 NFR02 NFR07 | BR01 BR02 BR10 | Proposed service targets | FD01 FD09 | T17 |
| NFR03 | BR01 BR04 | Proposed integrity target | FD03 FD04 | T06 T09 |
| NFR04 NFR05 NFR10 | BR04 BR10 | Item 7 and proposed controls | FD02 FD06 FD07 | T01 T11 T15 T17 |
| NFR06 NFR08 NFR09 | BR03 BR10 | Item 6 and proposed targets | FD05 FD09 FD10 | T08 T12 T17 |

## Source and unresolved decisions

SRC01 is the user-supplied two-page Student Check-In and Check-Out System Requirements and Non-Exhaustive Informational Vendor List, undated, reviewed 14 September 2026. Page 1 contains the eight checklist items and conditional review statement. Page 2 contains the non-endorsed vendor examples and illustrative pricing. The BRD contains the complete vendor and government source register.

The owner must resolve BRD decisions D01 to D09 before their first-release gates. D10 governs later-release planning. In particular, confirm current Kumon requirements, jurisdiction, pickup rules, hosting, support coverage, retention policy, devices and data volumes. Scope changes must update this document, the FDR, and linked tests together.
