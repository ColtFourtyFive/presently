# Kumon center CRM functional design report

Version 0.1 | 14 September 2026 | Proposed design for technical and operational review

Prepared for the product owner, center manager, developers, testers, and technical maintainers.

## Purpose and design status

This report proposes an implementation for the in-house Kumon center CRM defined in the BRD and FRD. FDR is interpreted as Functional Design Report. The design supports one center initially, with center-scoped data that can support later expansion. It prioritizes factual attendance, staff oversight, reviewable history, and a usable contingency process.

The eight attendance baseline items come from the supplied two-page checklist, SRC01. The architecture, role model, data structures, performance targets, API contracts, and rollout approach are recommendations. The owner still needs to confirm current Kumon requirements, jurisdiction, data policy, pickup rules, operating volumes, devices, hosting, and support ownership.

A modular application with a relational database is the proposed starting point. Attendance writes, visit state, and audit changes use database transactions. A separate local companion application on one managed contingency computer preserves the minimum roster and captures events during an outage. Third-party messaging and billing stay outside the critical attendance path.

## FD01 Architecture and technology direction

![Proposed application architecture](/Users/ocheng/Documents/ChatGPT/Safu/research/architecture.png)

The staff web application provides inquiry, student, family, schedule, attendance, and reporting screens. A server-side application owns authorization and business rules. PostgreSQL is the proposed database because transactions, uniqueness constraints, and relational history suit student relationships and attendance events. TypeScript with a React web application and a Node service is a reasonable implementation option, subject to the team's experience.

Use a managed identity service for staff accounts and MFA, encrypted object storage for exports and controlled attachments, and a background worker for export jobs, retention tasks, backups, and future notifications. Deploy the application and worker from the same versioned codebase. Separate services are unnecessary at the proposed single-center load.

The contingency station needs stronger local guarantees than an ordinary browser tab. Use a small installed companion application on a center-managed computer, with an encrypted local database and operating-system protected key storage. A web kiosk remains an online client. The companion's framework is an implementation choice to resolve in a device proof of concept; the required persistence, identity, encryption, restart, and sync behavior is fixed by FR17 and FR18.

This choice avoids assuming that a browser cache will preserve critical attendance indefinitely. If the team chooses a browser-based alternative, it must demonstrate equivalent durable storage, key protection, retention, offline access, and restart behavior on the actual managed devices before approval. The first release requires the contingency capability regardless of the chosen framework.

| Component | Responsibility | Failure behavior |
| --- | --- | --- |
| Staff web application | Role-specific workflows and online station interface | Shows failed or stale state; directs staff to the designated contingency station |
| Application service | Authorization, validation, attendance transitions and CRM commands | Returns explicit success, rejection or retryable failure |
| PostgreSQL | Canonical CRM data, events, visit projection, audit and job outbox | Transaction rollback prevents partial accepted attendance |
| Background worker | Exports, retention, reminders if approved and future provider delivery | Retries idempotently; attendance remains available if worker is down |
| Object storage | Scoped temporary exports and approved attachments | Missing exports can be regenerated; missing source documents trigger an incident |
| Contingency companion | Protected local roster, signed offline grant and durable local event queue | Shows snapshot age, local state and pending events; escalates storage or identity failure |
| Identity service | Staff authentication and role-session establishment | Existing approved contingency grant supports bounded offline operation |
| Monitoring and backup services | Detection, recovery points and restore evidence | Failures alert named maintainers and appear in readiness evidence |

All hosting accounts, domains, repositories, keys, and billing should be owned by the center's legal entity or a designated organization account. Use separate development, staging, and production environments. Synthetic data is the default outside production.

## FD02 Staff experience and navigation

The primary navigation is Today, Students and families, Inquiries, Schedule, Reports, and Administration. Attendance actions remain accessible from Today without entering a sales or billing workflow. A staff member can locate a student by ID or name and use an explicit action. Scan input selects the student; it never toggles attendance automatically.

| Screen | Main content and actions | Important states |
| --- | --- | --- |
| Today | Present roster, expected arrivals, unresolved visits, recent events, check-in and check-out | Live, stale, outage, reconciliation pending and write failure are visibly distinct |
| Student attendance confirmation | Minimal student identity, current visit, operational release alert, explicit arrival or departure | Duplicate identity, already present, no open visit, restricted release and inactive student |
| Student and family | Stable student ID, enrollment, schedule, guardian relationships and permitted history | Inactive, restricted detail, duplicate under review and request pending |
| Inquiries | Pipeline, owner, next action, appointments and timeline | Overdue, no next action, potential duplicate, closed lost and do not contact |
| Schedule | Recurring slots, dated exceptions, capacity and appointments | Canceled, changed, overlapping and unscheduled arrival |
| Attendance history | Visits, event details, corrections and scoped export | Unresolved duration, imported record and transcribed emergency record |
| Exceptions | Missing events, clock concerns, sync conflicts and proposed corrections | Open, assigned, resolved with evidence and reopened |
| Administration | Staff, devices, policies, training, privacy requests, backups and readiness evidence | Missing training, revoked device, failed backup and unconfirmed review date |

An attendance confirmation shows the student's name and center-issued ID. Any additional disambiguator needs an approved purpose. Keep guardian phone numbers and other children's details off shared screens. After an action, show "Saved to server" or "Saved on this device, waiting to sync" as appropriate, with an explicit event time. A failed save shows "Not saved" and the next staff action.

The present roster includes a count, last update time, and source. During an outage the local screen says it reflects the last synchronized roster plus events entered at that station. Staff must verify it against the room. The screen never implies that it knows about events entered elsewhere while disconnected.

Use text as well as color for presence and warnings. Provide keyboard navigation, screen-reader labels, visible focus and large touch targets. Sensitive controls require a deliberate confirmation, while ordinary arrival and departure remain short. Validate the workflow with staff during a real busy period using synthetic or approved pilot data.

## FD03 Data model and ownership

Every tenant-owned record carries center_id. Use stable opaque UUIDs for internal identifiers. Public tokens are separate revocable credentials. The student's name can change while student_id remains constant. A reviewed merge preserves old IDs as aliases and records the decision; it does not rewrite immutable event rows.

| Entity | Core fields | Relationships and controls |
| --- | --- | --- |
| Center | id, legal entity reference, name, IANA time zone, operating hours, policy version | Parent scope for business data |
| Staff membership | user_id, center_id, role, status, effective times | Maps identity provider account to center authority |
| Device | id, center_id, public key, status, last_seen, contingency eligibility | One device belongs to one center; revocation is audited |
| Household | id, center_id, display reference | Groups related contact records without assuming legal custody |
| Guardian | id, household_id, name, permitted contacts and preferences | Student links are explicit and independently revocable |
| Student guardian relationship | student_id, guardian_id, relationship, pickup authority, effective dates, restricted alert | Multiple links per student; history retained under policy |
| Student | id, center_id, display name, status, external reference if approved | Attendance identity is preserved through inactivation |
| Enrollment | id, student_id, subject, status, start_date, end_date | Multiple subjects per student; no duplicate active enrollment for the same subject and period |
| Schedule rule and exception | id, student_id, local day and time, duration, effective dates, cancellation or override | Generates expectations, never actual attendance |
| Inquiry | id, contact reference, source, stage, owner, created_at, converted_student_id | Stage transition history is append-only |
| Task and appointment | id, inquiry or student reference, assignee, due_at, status, outcome | Supports follow-up and assessments without curriculum content |
| Interaction | id, household or inquiry reference, actor, channel, occurred_at, summary | Manual history in M1; content minimization and role limits apply |
| Visit and presence projection | id, student_id, center_id, effective arrival, effective departure, visit status, presence state, reconciliation status, revision | Materialized interpretation with presence separate from record quality |
| Attendance event | id, visit reference if known, student_id, action, occurrence and receipt times, actor, device, capture mode, sequence, request hash | Immutable factual submission; event key unique within center |
| Correction and exception | id, target, original reference, proposed change, reason, actor, recorded_at, resolution | Appends interpretation without overwriting source events |
| Outage session and sync receipt | id, device, operator, snapshot revision, local sequence range, acknowledgements, closure | Tracks queue transfer and reconciliation separately |
| Audit event | id, actor, action, target IDs, result, timestamp, permitted change detail | Append-only to application roles; privileged access audited |
| Policy hold and privacy request | id, scope, policy version, reason, owner, dates, disposition | Holds override deletion; request authority must be verified |
| Training acknowledgement | staff_id, procedure version, completion date, demonstrator and evidence | Evidence for staff readiness and future review |
| Export job and outbox item | id, requester, scope, expiry, status, idempotency key | Async work has explicit authorization and delivery state |

Visit state is a projection of accepted events and approved corrections. This allows history to remain immutable while the current roster reflects a reviewed correction. The database enforces a partial unique index for one open visit per student and center. The service also locks the student's attendance state during a transition. Cross-center foreign-key rules and server authorization prevent accidental mixing of records.

Store instants in UTC and retain the center's IANA time zone and the offset observed at capture. Store recurring schedules as local rules with effective dates. Local dates for reports are computed using the recorded center context, and report output includes the time zone. Daylight-saving changes must not alter historical ordering or silently duplicate a recurring slot.

Attendance records contain occurred_at, device_recorded_at, server_received_at, and time_source. Corrections add correction_recorded_at rather than modifying receipt time. Online events use a time-synchronized device observation validated against server time. Drift beyond two minutes creates an exception instead of silently rewriting the observed timestamp. The two-minute limit is a proposed control to verify in pilot.

## FD04 Attendance state and transaction design

Expected attendance is separate from actual presence. Visit status is Open or Closed. Presence state is Present, Absent, or Needs verification. Reconciliation status is Clear or Review needed. A history dispute does not by itself change physical presence or remove a student from the roster. Students needing verification remain visible in a separate roster group, and an unresolved open visit still prevents a second open visit. An observed exceptional departure can establish Absent while the release incident remains under review.

| Current condition | Command | Result |
| --- | --- | --- |
| No open visit | Explicit check-in | Create event and open visit; mark present |
| Open visit | Explicit check-out after release check | Create event and close visit; remove from present roster |
| Open visit | Another check-in | Return already present or conflict; do not create a second open visit |
| No open visit | Observed check-out | Retain unmatched departure, set observed presence absent and create review item; do not fabricate arrival |
| Open visit | Observed unauthorized or unexpected departure | Record actual departure, close the matching open visit, mark absent and open an independent incident; recording does not grant release permission |
| Closed visit | Later check-in | Start a new visit for same-day re-entry |
| Any condition | Same idempotency key and same request | Return original result without a second event |
| Any condition | Same idempotency key with different request | Reject key reuse and record diagnostic evidence |
| Any condition | Schedule, subject or billing change | Actual attendance remains unchanged |
| Open visit at closing | End-of-day review | Keep open and flag; no generated departure |
| Any condition | Approved correction | Append correction, recompute projection and preserve originals |

For a normal online command, authenticate staff and device, resolve center scope and student token, validate release rules if needed, then start a database transaction. Check the idempotency key and request hash. Lock the student's attendance state, validate the transition, write the event, update the visit projection, append audit detail, and insert any outbox record. Commit before responding with success. If a release check fails, staff cannot approve a normal release. A distinct observed exceptional departure command still records a student who actually left, requires an incident reason and alerts the manager.

Roster updates use a push channel or short polling, with the committed revision and server time. Clients reconcile to the latest revision rather than incrementing counters optimistically. If the response is lost after commit, the client retries the same event ID. The original event and result are returned.

The check-in and check-out endpoints are separate commands. Avoid a "toggle attendance" API, because a duplicate scan could reverse the intended action. The system may suggest an action based on current state, but staff must choose or confirm it.

### Interface contracts

The following endpoints are proposed contracts, not existing Kumon or vendor APIs. JSON responses include a request ID. Server-side access checks apply to every endpoint and to background exports.

| Endpoint | Key input | Result or rejection |
| --- | --- | --- |
| POST /v1/attendance/check-ins | event_id, student_id or token, occurred_at, device_id, actor, expected_revision | event_id, visit_id, presence, committed_revision, received_at; conflict if already present |
| POST /v1/attendance/check-outs | Same event fields plus visit_id and release_basis | Closed visit and revision; normal authorized departure |
| POST /v1/attendance/exceptional-departures | observed event fields, student_id, reason, incident details and visit_id if known | Save actual departure, close a known open visit, mark absent and open an independent incident; unmatched arrival remains unknown |
| GET /v1/centers/{id}/presence | permitted center, optional since_revision | Minimal roster, server time, revision and open exceptions |
| POST /v1/attendance/corrections | target, correction, reason, supporting reference, expected_revision | Correction ID and updated projection; manager authorization required |
| POST /v1/sync/batches | outage_id, signed device batch, ordered events and last acknowledgement | Per-event accepted, duplicate or review status; durable acknowledgement cursor |
| POST /v1/imports/preview | approved file, mapping and source identity | Accepted and rejected preview with no business-data mutation |
| POST /v1/imports/{id}/commit | preview version, approval and batch idempotency key | Import result with control totals and row errors |
| POST /v1/exports | permitted report scope and filters | Job ID; later download URL scoped to requester and expiry |

Use 400 for malformed input, 401 for missing authentication, 403 for forbidden action, 409 for a conflicting transition or version, 422 for a domain validation issue, and 503 for temporary unavailability. Clients show a useful staff-facing message and retain the request key for safe retries. They do not expose stack traces or raw student payloads.

## FD05 Outage operation and reconciliation

An outage protocol has four stages: readiness, contingency capture, recovery, and reconciliation. The center manager owns the transition between them. The purpose is to preserve actual observations and maintain local awareness while acknowledging that disconnected records can diverge.

### Readiness before operating hours

The manager assigns the contingency computer and verifies device health, power, available storage, encryption, and local database access. The device synchronizes a minimum roster and the current permitted offline configuration. A signed, device-bound grant identifies the authorized staff operators, center, maximum one-day validity and permitted attendance operations. Staff authenticate with MFA while online before a grant is issued. The maximum offline validity is 24 hours and must be no longer than the approved operating period.

The local application uses operating-system key storage and encrypted database storage. It requires local operator reauthentication after 15 minutes of inactivity through an approved device-local mechanism. Offline roles cannot create staff, change policy, export bulk data, or elevate privilege. Revocation while disconnected cannot take effect instantly; the bounded grant, managed device, custody controls, and reconnect review address that limit explicitly.

The local snapshot contains student IDs, names, current recorded presence, and minimum operational alerts. It excludes the lead pipeline, detailed notes, payment data, and unnecessary guardian information. It refreshes while online and displays its timestamp. Sensitive pickup verification that cannot be established from current information escalates to the manager's approved procedure.

### Contingency capture

When the primary service is unreachable, staff use the single designated computer. Other devices show the contingency direction and do not queue independent offline attendance. The manager announces the change to staff and, if the server remains reachable through another connection, marks the center incident so other online stations stop ordinary attendance entry. A complete network split cannot be solved by a server flag, so the physical staff procedure remains necessary.

The operator verifies the room against the local roster at the start of the outage. Every command creates a stable event ID, increasing local sequence, actor, observed time, device time metadata, and outage ID. One local database transaction appends the queue entry and updates the local roster. The application shows "Saved on this device" only after the transaction is durable.

The queue survives a process or operating-system restart. It is never silently discarded for age, logout, or a failed upload. The app warns about storage pressure, expiring grant, or repeated local failure. If the device is lost, power fails, the grant expires, or identity cannot be verified, staff invoke the approved emergency procedure. A contemporaneous temporary paper record is a possible last-resort exception subject to the owner's current-policy confirmation. It is transcribed later with its actual observed time, source and responsible staff member.

A cached roster only reflects its snapshot and local actions. Staff physically verify presence whenever completeness is uncertain. Backups of the server cannot supply an accurate current roster during a network outage; the local process is a separate control.

### Recovery and reconciliation

On reconnection, the companion authenticates the device, uploads signed batches in local sequence order, and keeps each event until a durable server acknowledgement is stored locally. The server validates that capture occurred within the signed grant's authorized period, plus device status, student scope, request hash, and time plausibility. The grant need not remain unexpired at upload for a valid captured observation to be accepted. Suspect or revoked-device observations are retained for review. The service deduplicates by event ID and processes valid transitions transactionally.

Rejected or contradictory observations are retained as review evidence, not thrown away. Examples include a device revoked during disconnection, clock drift beyond the threshold, an unexpected online check-in, a check-out with no known arrival, or two event sequences with uncertain order. The system does not sort all events by upload time and assume that sequence was the real order.

The manager compares the uploaded timeline with the local queue, any emergency records, and the physically present students. Corrections reference the underlying events. A fully acknowledged upload with outstanding attendance effects is labeled Upload complete and reconciliation pending. The outage becomes Closed and reconciled only when all entries have acknowledged disposition, attendance effects are resolved, and the manager verifies the physical roster. A separate release incident may remain open after attendance facts are settled.

Acknowledged local events are deleted after successful reconciliation and the approved short cache period, proposed at 24 hours. Unacknowledged events are retained until recovery or an audited loss incident. The system records queue age and alerts the manager; it does not sacrifice necessary records to enforce a routine cache expiry.

| Failure test | Expected result |
| --- | --- |
| Network loss before save | No server success; operator uses designated local capture |
| Network loss after commit but before response | Retry returns the same event |
| Application crash during local write | Atomic transaction leaves either one saved event or no success confirmation |
| Restart with queued events | Queue, roster and pending count reappear after authorized unlock |
| Changed device clock | Original timestamp preserved and drift enters review |
| Cloud and local actions conflict | Review item and incomplete-state warning; no silent overwrite |
| Grant expires or local disk is full | New local capture fails visibly; staff use approved emergency process |
| Device destroyed before synchronization | Incident identifies potentially lost local observations; reconstruct from contemporaneous approved evidence where possible |

## FD06 Security and privacy design

Apply least privilege to people, devices, workers, exports, storage objects and support access. The service derives center scope from verified membership and checks requested identifiers against it. An arbitrary center_id in a request never establishes authority. Database row-level restrictions or equivalent scoped repository rules provide an additional boundary, backed by tests.

Staff use named accounts and MFA. A kiosk device token authenticates the device only. The staff session identifies the person who approved an attendance action. Public student QR tokens are random, revocable, rate-limited identifiers stored as hashes on the server. They contain no student PII and do not grant pickup authority. If PIN entry is added, rate limits and staff oversight are mandatory; a short PIN cannot stand alone as strong authentication.

| Resource or action | Owner | Manager | Front desk | Instructor |
| --- | --- | --- | --- | --- |
| Minimum present roster | Yes | Yes | Yes | Yes |
| Supervised attendance | Yes | Yes | Yes | Only if assigned |
| Leads and follow-up | Yes | Yes | Yes | No |
| Guardian contacts | Yes | Yes | Operational need | Minimum operational need |
| Detailed custody documents | Restricted | Restricted | Alert only | Alert only |
| Attendance correction | Yes | Yes | Request review | Request review |
| Bulk export | Yes | Approved scope | No by default | No |
| Staff or retention configuration | Yes | Delegated only | No | No |
| Privacy request disposition | Yes | Delegated only | Intake only | No |

Encrypt database, backups, object storage and local storage. Use TLS for all network traffic. Keep secrets in a managed secret store, with environment-specific keys and documented recovery. Record key rotation and recovery procedures; an encrypted backup without recoverable authorized keys is not a successful backup design.

Log record IDs and operational outcomes rather than full child records. Prohibit student PII in analytics tools, error payloads, tracing attributes and crash uploads unless specifically reviewed and necessary. Restrict support access, require a reason, and retain an audit record. No advertising trackers are proposed.

The two-year attendance floor does not authorize keeping every CRM field forever. Maintain a field inventory showing purpose, source, access, retention, and export behavior. Subject-access and deletion requests require verified authority and consideration of the applicable hold and retention policy. The BRD describes why COPPA and FERPA applicability cannot be determined from "Kumon CRM" alone. [REG01, REG02]

Before release, test cross-center access, object download authorization, revoked roles, ID enumeration, QR replay, export permissions, input injection, session expiry and sensitive log exposure. An independent targeted security assessment should focus on attendance integrity, children's data and privileged workflows. Address critical defects before pilot.

## FD07 Reporting and record lifecycle

The Visit projection powers ordinary history and durations; immutable events and correction records explain the result. Report queries include center scope and permission predicates. Index attendance by center, student and occurred_at, and index open visits separately. Generate large exports in a worker so report generation does not delay attendance writes.

Every export includes the center, date range, time zone, generation time, filters, record count, requestor, and data completeness state. CSV output uses documented columns and escapes formula-leading values so opening a name or note in a spreadsheet cannot execute a formula. Signed download URLs expire, proposed after 15 minutes, and generated files expire after 24 hours unless an approved process needs longer. Recheck authorization when generating and downloading.

| Report | Definition | Limitation shown to staff |
| --- | --- | --- |
| Present now | Students marked Present in the selected center, with Needs verification shown separately | Latest revision, stale state and unresolved effects; disputed records never disappear silently |
| Expected versus actual | Expected student visits after schedule exceptions compared with factual arrivals | Canceled appointments excluded; no auto-generated arrival or absence fact |
| Visit duration | Effective departure minus arrival for a resolved closed visit | Unresolved or implausible visits excluded from verified duration totals |
| Active students | Distinct active student IDs in selected period or snapshot | Count basis is explicit |
| Subject enrollments | Active enrollment records by subject | A student in two subjects contributes to each subject |
| Inquiry conversion | Enrolled inquiries divided by eligible inquiries in a defined creation cohort | Period, exclusions and observation window displayed |
| Follow-up backlog | Open tasks with due_at before now in the center time context | Canceled and completed tasks excluded |
| Readiness evidence | Checklist version, controls, training, sample records, drills and issues | No claim of external certification or approval |

### Retention algorithm

Attendance becomes eligible for deletion only after the end of the local anniversary date two calendar years after occurrence, so deletion cannot precede the original event's time of day. To avoid early deletion in leap-year edge cases, a 29 February record becomes eligible only after the end of 1 March two years later. A visit cannot be purged until the latest protected attendance event in it has passed its minimum period and its associated corrections and identity context can be handled under the approved policy. A longer policy or hold extends the date.

A scheduled retention job selects eligible records, excludes holds and unresolved issues, produces a reviewable deletion plan, and applies the approved policy. It preserves an appropriate deletion audit and does not allow broad student deletion to cascade into protected attendance. Minimal identity links remain for as long as necessary to make retained records interpretable.

Production archives preserve at least two years of queryable attendance. Operational backups have a separate rolling lifecycle, proposed at 35 days, with point-in-time recovery where supported. The archive meets historical retention; the backup supports disaster recovery. Neither substitutes for the other.

A deletion ledger records records removed under policy without retaining the deleted sensitive payload. On restoration, the maintainer reapplies deletion instructions and holds before granting application access. Document the expiration of old backup copies and keys under the approved policy. The appropriate retention for leads, communication notes, audit logs, and attachments is a separate decision; it is not inferred from the attendance minimum.

## FD08 Integration and expansion boundaries

The first release needs only approved imports, exports, identity, hosting, and monitoring services. Corporate Kumon interfaces, vendor migration APIs, financial tools, messaging providers, and a guardian portal are not assumed to exist or be available. The BRD research includes vendor API evidence where found, with scope and plan details still to verify.

Use a transactional outbox for later messages and provider operations. The application transaction writes the business event and outbox item together. The worker sends using a stable idempotency key, records provider references and status, and retries transient failures with bounded backoff. Permanent failures enter an action queue. Neither a slow provider nor a failed payment changes physical attendance.

Guardian messaging needs channel permission, recipient relationship checks, template approval, opt-out handling and privacy review. Use messages that minimize information. A provider's delivered status is distinct from guardian acknowledgement. Hold automatic attendance messages while the underlying event is disputed or awaiting reconciliation.

A portal requires verified guardian relationships and prompt access revocation. A payment integration uses hosted provider pages and tokenized references, with signed webhooks, deduplication and reconciliation. A progress module stores approved instructor summaries without assuming it can reproduce proprietary Kumon materials or update corporate academic records.

| Data area | Proposed source of truth in first release | Future interface condition |
| --- | --- | --- |
| Inquiries and follow-up | In-house CRM | External intake preserves origin and duplicate review |
| Center-maintained contacts and schedule | In-house CRM after reviewed migration | Resolve conflict rules before bidirectional synchronization |
| Attendance events and corrections | In-house attendance service plus reconciled contingency observations | Preserve immutable IDs, capture origin and timestamps |
| Corporate enrollment or academic records | Existing authorized system if applicable | Owner confirms authoritative fields and permitted interface |
| Payments | Existing payment or accounting system | CRM stores references and approved status only |

## FD09 Deployment and operating design

Deploy first to staging with synthetic data, then a controlled pilot environment or explicitly scoped production pilot. Use versioned database migrations with preflight checks. Prefer additive schema changes followed by a later cleanup so the previous application version can continue operating during rollback. Take and verify a recovery point before risky changes.

Proposed service targets are those in FRD NFR01 to NFR10. Availability is measured during configured operating hours and includes both planned and unplanned service interruptions. Hosting maintenance should happen outside operating hours where possible. The proposed primary recovery point is 15 minutes and recovery time is four hours; local contingency access addresses the immediate operating need.

A catastrophic restore can lose up to 15 minutes of already accepted server events under this target. The local snapshot and offline-only queue cannot reconstruct every online transition. The maintainer must identify the affected interval and reconcile available contemporaneous evidence with the manager; unresolved facts stay marked unknown. The owner must explicitly accept this disaster recovery limit before production, or fund and test stronger independent event preservation with a lower recovery point. Do not equate a successful backup restore with zero event loss.

| Signal | Proposed trigger | Owner response |
| --- | --- | --- |
| Attendance write failure | Repeated failure or durable-save error | Staff switch procedure; maintainer investigates immediately during operating hours |
| Roster freshness | No successful connection for 30 seconds | Visible staff warning and contingency direction |
| Offline queue | Any queue after reconnect; oldest item exceeds agreed sync window | Manager reconciles; maintainer investigates transport failure |
| Backup failure | Any failed scheduled backup or missing recovery point | Maintainer repairs and confirms usable recovery point |
| Unauthorized access patterns | Repeated denied privilege attempts or unusual export volume | Restrict access if appropriate and investigate |
| Storage or key failure | Local save failure, low capacity or decryption failure | Stop false confirmation; use emergency procedure and support escalation |
| Error or latency rise | NFR01 target breached under normal load | Investigate app, database and network; report impact |

Name primary and backup maintainers, on-call coverage during operating hours, escalation contacts, and an owner for incidents outside those hours. Support coverage is a funding dependency, not a capability supplied automatically by hosting.

Back up the database, object records and recovery configuration. Restrict backup deletion separately from routine application administration. Test restoration before pilot and quarterly thereafter. Validate record counts, sampled historical visits, corrections, holds, exports, encryption keys, and a local queue replay. Document the actual recovery point, elapsed recovery time and any discrepancies.

A serious incident record identifies affected periods and students where known, service status, containment, recovery, attendance reconciliation and follow-up actions. Any required external notification depends on the confirmed jurisdiction and agreements. The system should support the process without hard-coding an unverified deadline.

## FD10 Migration and release plan

### Discovery and design proof

Observe center workflows and resolve BRD decisions D01 to D09. Confirm exactly which records the center may import and which systems remain authoritative. Validate the contingency application on the selected hardware, including encrypted restart, a one-day disconnected scenario, clock drift, full disk and synchronization conflict. A browser-only prototype that has not passed these checks cannot satisfy FR17.

### Data migration

Inventory source files and definitions. Map students, guardian links, subjects, schedules and lead stages. Keep source record IDs and import batch IDs. Normalize phone and email only for matching assistance; do not automatically merge families. Dry-run the import with error reports and have the manager review identical names, siblings and restricted relationships.

For historical attendance, preserve source occurrence times, available attribution and source labels. Missing fields stay unknown rather than being filled with invented times. Imported past records never create a current open visit unless explicitly reviewed for a real ongoing attendance condition. Reconcile counts by entity, subject and date, then spot-check relationships and visits with the manager.

At cutover, freeze changes to the migrating source for an agreed short window or record and apply a reviewed delta. Keep an authorized recovery copy and import audit. Do not discard the former source until reconciliation, retention and rollback needs are satisfied under policy.

### Test and pilot gates

Execute FRD T01 to T17 with evidence before launch. Automated tests should cover authorization, transaction integrity, idempotency, time calculations and retention. Human walkthroughs cover identity selection, pickup escalation, accessibility, training and emergency procedures. A second maintainer demonstrates recovery from the runbook.

Pilot for at least five representative operating days as a proposed planning duration. Use independent staff observation to reconcile sample arrivals and departures. The baseline attendance method remains digital. Any temporary comparison or emergency record has a controlled purpose, minimal data, and an approved disposal or retention rule.

Block launch for critical student misidentification, unauthorized data access, unresolved release-control failure, silent event loss, or inability to recover required history. Resolve defects and rerun the affected tests. Record any accepted noncritical issue with a responsible owner and due date.

### Cutover and rollback

The owner approves business readiness, the manager approves procedures and training, and the technical lead approves security and recovery evidence. Deploy the approved version, verify staff access and contingency readiness, and monitor arrival and departure closely during the initial operating period.

If rollback is required, preserve every accepted event after cutover. Roll back application code against compatible schema where possible. Do not restore an older database over newer attendance without first preserving and reconciling the intervening events. If trustworthy operation cannot continue, invoke the contingency process while maintainers recover the service.

## Design decisions and remaining work

| Decision | Proposed choice | Reason and validation needed |
| --- | --- | --- |
| Architecture | Modular application and relational database | Transactional attendance with a small operating footprint; validate team skills |
| Attendance interaction | Explicit staff-confirmed commands | Avoid accidental toggles and preserve oversight |
| Identification | Stable student ID and revocable opaque QR token | Distinguish people without exposing PII; pickup verification remains separate |
| History | Immutable events with attributed corrections and a visit projection | Reviewable originals and usable current roster |
| Offline operation | One managed companion station with durable queue | Controls divergent records; prove hardware and staff procedure |
| Retention | Two-calendar-year floor with holds and policy extensions | Implements source item 8 while avoiding arbitrary retention of all CRM data |
| External services | Async boundaries and approved interfaces | Attendance continues when optional providers fail |
| Hosting and support | Center-owned managed services with two named maintainers | Reduces dependency on one developer; pricing and provider selection remain open |

Before implementation begins, convert this approved design into a delivery backlog using FR and NFR IDs. Confirm the technology choices, database schema, device proof, API details, test dataset and provider contracts. Any departure from the eight source requirements requires confirmation against the current applicable Kumon policy, rather than a software-team assumption.

## References

SRC01. User-supplied Student Check-In and Check-Out System Requirements and Non-Exhaustive Informational Vendor List. Undated, two pages, reviewed 14 September 2026. Page 1 supplies the eight baseline attendance requirements and conditional future certification statement; page 2 supplies vendor examples and qualifications.

REG01. US Federal Trade Commission. Complying with COPPA frequently asked questions. Reviewed 14 September 2026. https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions

REG02. US Department of Education. To which educational agencies or institutions does FERPA apply. Reviewed 14 September 2026. https://studentprivacy.ed.gov/faq/which-educational-agencies-or-institutions-does-ferpa-apply

The companion BRD includes the full vendor research and source register. The FRD contains the acceptance criteria and requirement-to-design traceability matrix. Public vendor pages are evidence of documented product claims and do not establish a Kumon corporate integration or a tested compliance result.
