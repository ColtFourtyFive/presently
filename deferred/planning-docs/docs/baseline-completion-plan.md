# Baseline completion plan

Prepared September 14, 2026. Status: planned work; implementation has not started under this plan.

## Objective and scope

Close the remaining gaps against the eight baseline requirements on page 1 of the supplied Kumon check-in/check-out document. Produce a working release and evidence that the adopting center can operate it, preserve attendance, recover from failure, and handle student information appropriately.

Keep Railway and PostgreSQL, with one designated iPad per center for the first offline attendance release. Kumon owns the delivered product and its operating accounts. Keep new/default workspaces empty. Use synthetic records only in isolated test environments. Data import remains deferred until the export format is known.

The checklist specifies outcomes. The iPad companion, point-in-time recovery, encryption design, and identity controls below are our proposed means of meeting them. The checklist does not prescribe those technologies or a particular Railway plan. A successful software test alone does not establish staff training or consistent center practice.

## Starting position

| Baseline | Current evidence | Remaining acceptance |
| --- | --- | --- |
| 1. Digital system | Deployed digital attendance application | Center adopts it as its daily baseline method |
| 2. Unique student identification | Stable IDs and center-unique student numbers | Staff demonstrate correct student selection |
| 3. Actual arrival and departure | Explicit online observations, preserved originals and attributed corrections | Verify timely staff use and outage handling |
| 4. Staff oversight and training | Workflow available | Training, observed demonstration, daily procedure |
| 5. Current student awareness | Online presence roster and history | Verify physical roster agreement and contingency use |
| 6. Backup or data preservation approach | Persistent PostgreSQL volume; no configured Railway backups at the last inspection | Scheduled recoverable backups, outage access, successful restoration |
| 7. Appropriate handling of student information / PII | Authentication, role and center restrictions, protected sessions | Minimum-data review, managed staff access, device controls and operational security review |
| 8. Reviewable records retained at least two years | History, corrections, exports and older-record query capability | Documented retention safeguards and tested preservation/recovery |

## Responsibilities

- Implementation team builds the controls, automates verification, records evidence, and prepares operating instructions.
- Kumon's designated technical administrator owns hosting, backup storage, recovery keys, alerts, approved releases, and future recovery operations. Name a backup administrator too.
- The center manager owns staff training, opening and closing checks, pickup and outage procedures, physical roster reconciliation, and operating acceptance.
- Kumon's designated privacy or policy owner confirms the applicable data, access, retention and incident-handling rules. The exact receiving entity and jurisdiction remain to be established.

These are roles to assign, not contacts already appointed. Planning does not transfer accounts or authorize billing changes.

## Phase 1. Establish acceptance criteria and an isolated test environment

Owner: implementation team, with the center manager and technical administrator.

1. Identify the adopting entity, initial center, technical owner, backup contact, and privacy/policy owner. Confirm the center timezone and supported iPad/iPadOS version.
2. Agree the operating procedure during loss of internet, application service, database, or the designated iPad. Define when staff must use an independent contingency record and how it is reconciled. Paper can serve as a temporary fallback while the digital system remains the normal baseline.
3. Choose backup service and ownership. Recommend Railway native backups/PITR on an eligible plan plus independent encrypted exports. Confirm the costs and storage destination before enabling billable services.
4. Set recovery and offline limits. Use the proposed values below for design until the responsible owners accept or revise them.
5. Create a restricted test environment and synthetic fixtures containing students, guardians, pickup restrictions, current presence, historical visits, corrections, exceptions, and staff roles. Include records older than two years and leap-day/date-boundary cases. Production remains empty.

Proposed operating values, not existing guarantees:

| Decision | Starting proposal | Qualification |
| --- | --- | --- |
| Primary database recovery | At most 15 minutes of lost server data; usable and reconciled operation within four hours | Must be demonstrated using the chosen backup mechanism |
| Independent recovery copy | Daily encrypted export | Allows up to a day's loss if this is the only surviving copy; increase frequency if that is unacceptable |
| Offline device | One designated iPad per center | Staff procedures must handle another device remaining online during a partial outage |
| Offline authorization | One operating day, capped at 24 hours; lock after 15 minutes of inactivity | Confirm staff unlock, grant expiry, and replacement-device procedures |
| Snapshot readiness | Successful refresh before the center opens; visible snapshot age throughout use | Agree an explicit maximum acceptable age and manager procedure for stale pickup information |
| Attendance history | At least two years, including required linked evidence | Confirm any longer applicable obligation and how calendar boundaries are calculated |
| Restore exercises | Before launch, then quarterly and after material recovery changes | Reassess frequency with the technical owner |

Acceptance: a named owner accepts each operating decision; the test environment is isolated; no unresolved choice prevents a safe implementation. We can prepare code and fixtures while these choices are pending. No live plan upgrade, account transfer, or production cutover occurs merely from creating this plan.

## Phase 2. Establish backups and prove a baseline restore

Owner: implementation team, then Kumon's technical administrator. Baselines: 6 and 8.

1. Add numbered, checksummed database migrations, a migration lock, and application/schema compatibility checks. Verify upgrades on both empty and populated test databases, with a defined recovery path for a failed upgrade. Record the application commit and PostgreSQL version with recovery evidence.
2. Configure the chosen scheduled backups and PITR if selected. Verify successful base backups and actual recoverable timestamps. Schedule any database redeployment required to enable them.
3. Create encrypted full relational exports in independently controlled storage. Include required roles/extensions, application release, configuration inventory, and a secure recovery path for secrets and encryption keys. Attendance CSV is not a complete backup.
4. Add alerts for failed or stale backups, transaction-log archive lag if applicable, failed independent-copy delivery, storage exhaustion, and overdue restore verification. Route alerts to the primary and backup technical contacts.
5. Restore the independent copy into fresh PostgreSQL and start the matching application. Rehearse the native recovery path on disposable Railway infrastructure. Respect Railway's snapshot restore restrictions; use the existing recovery plan for the detailed procedure.
6. Verify expected records, relationships, original observations, corrections, audit evidence, permissions, historical exports, and resumed writes. Measure actual data loss and time to usable operation.

Acceptance: both selected recovery paths have successful evidence; the operator can recover the system and its keys without the developer's personal access; alerts have reached the designated recipients in a controlled test. A successful backup job or a service restart alone does not pass this phase.

## Phase 3. Complete privacy and staff access controls

Owner: implementation team, with the privacy/policy owner. Baseline: 7. Can run alongside Phase 2 after Phase 1.

1. Inventory data fields, screens, API responses, exports, logs, backups, and future device caches. Record each field's purpose and the roles that need access. Review the broader CRM fields separately from the minimum attendance snapshot.
2. Reduce unnecessary collection and disclosure. The offline snapshot should contain only the identifiers, presence state, and approved pickup/contact information needed for attendance. Exclude unrelated inquiry and family notes.
3. Build named-owner activation and recovery, staff creation or invitation, role changes, deactivation, and session revocation. Protect the last usable owner account. Apply the privileged authentication control selected in the security review, such as MFA or approved SSO.
4. Audit staff/device access changes and privileged exports. Preserve existing password hashing, session expiry, secure cookies, role enforcement, and center isolation. Review logs and error messages for unnecessary student data or credentials.
5. Define managed-iPad custody, screen locking, staff unlock, encryption key handling, lost-device response, and device revocation. Run a small storage/unlock/restart prototype on the actual supported iPad before completing the offline screens. Verify local protection without storing an unprotected key beside the data. If the browser cannot meet the required results, select a managed native companion while keeping Railway/PostgreSQL.
6. Review foreseeable misuse through API authorization, role changes, stale sessions, exports, and cross-center access. Repair material findings before release.

Acceptance: the field/access inventory is approved, staff access can be provisioned and revoked, reviewed authorization tests pass, device/key procedures work, and no unresolved finding permits inappropriate disclosure or modification of student data. A new training module or enterprise SSO integration is not automatically required by the PDF.

## Phase 4. Establish retention and historical review safeguards

Owner: implementation team, with the privacy/policy owner and technical administrator. Baseline: 8. Can run alongside Phases 2 and 3.

1. Document at least two years of reviewable attendance retention. Keep required linked student identity, visits, original observations, corrections, and relevant audit evidence together.
2. Ensure student inactivation, maintenance scripts, schema migrations, and eventual deletion workflows cannot remove records that remain within their retention period. Keep original attendance evidence immutable through ordinary app operations.
3. Separate attendance retention from backup, device-cache, and diagnostic-log retention. Apply holds and controlled disposition where the agreed policy requires them. Automated deletion is not necessary for the first baseline release; any deletion must follow the approved procedure.
4. Verify date-range retrieval and exports using older synthetic records, timezone boundaries, leap days, corrected times, and inactive students. Confirm authorized staff can actually find and interpret that history.
5. Define a protected recovery ledger outside the database being restored for current revocations and any deletion or hold decisions. Reconcile it before reopening a restored system so recovery cannot silently reinstate obsolete access or deleted data.

Acceptance: records and linked evidence remain reviewable across the required period, routine actions cannot defeat retention, and Phase 2 restoration preserves that history. We do not need to wait two years to validate the design, but an old fixture alone does not prove ongoing preservation.

## Phase 5. Build offline attendance and reconciliation

Owner: implementation team. Baselines: 3, 5 and 6, with controls from 7 and 8. Requires migration and identity foundations from Phases 2 and 3. Use the detailed [offline and recovery readiness plan](offline-and-recovery-readiness-plan.md).

1. Add device enrollment and a signed, device-bound, time-limited staff authorization grant. Prefer the intended production domain before enrollment because browser data belongs to an origin.
2. Add a service worker for offline startup and a protected IndexedDB roster and event journal. Save each observation and local presence update atomically before confirming success to staff.
3. Store a permanent event ID, device sequence, named observer, student, action, original observation time, snapshot/grant versions, and relevant release evidence. Record the server receipt time separately.
4. Add bounded upload batches and durable receipts. Retries after timeouts, reloads, or partial responses must not duplicate observations. Preserve disputed timing, authority, or event order for manager review. Distinguish an actual exceptional departure from authorized release.
5. Show offline readiness, snapshot age, unsent records, review-needed records, and authorization expiry. Retry when the app is open or resumes; do not depend on iPad background synchronization.
6. Handle stale pickup information and split connectivity through the agreed staff procedure. Make clear that an offline roster reflects a dated snapshot plus that device's observations.
7. Keep recent acknowledged observations through the supported recovery window. Add a recovery generation and a reconciliation flow for devices connecting after database restoration. Prevent app updates or local schema migrations from stranding pending records.

Acceptance: the actual supported iPad can record during an outage, retain observations across restart, and synchronize each with a durable outcome. Storage failure never produces false success. Clock discrepancies and conflicting observations remain reviewable. A lost iPad cannot be recovered from server backups if its observations never uploaded; the approved contingency procedure must address that exposure.

## Phase 6. Run integrated release acceptance

Owner: implementation team, witnessed by the technical administrator and center manager. Requires Phases 2 through 5.

| Exercise | Required result |
| --- | --- |
| Existing online attendance | Unique student selection, observed arrivals/departures, authorized and exceptional departures, corrections, current presence and history still work |
| Actual-iPad outage and restart | Prepared app launches offline; data survives app/device restart; staff access and expiry follow policy |
| Failed storage and updates | No false save confirmation; pending records survive compatible app/database updates; fallback works when readiness fails |
| Uncertain network responses | Lost acknowledgements, repeated uploads, partial batches and reconnects produce one durable outcome per observation |
| Stale or disputed information | Staff can identify stale pickup data, clock drift and competing events; manager review preserves the original evidence |
| Restore behind acknowledged events | Device reconciliation recovers available evidence, identifies any gap, and avoids duplicate visits |
| Permissions after restoration | Current revocations and relevant privacy decisions are reconciled before normal access opens |
| History and recovery | Older records, corrections and linked evidence remain reviewable after restoration; recovery objectives are measured |
| Alerts and response | A designated operator receives a test failure alert and follows the documented procedure |
| Attendance usability | Staff can complete the critical workflow on the supported iPad, and review/export history on the intended staff workstation |

Acceptance: retain a report tied to the application release, database migration, backup reference, device/iPadOS version, and test date. Record expected and actual results, timings, and corrective actions. Every required exercise must pass; a material failure affecting identity, attendance evidence, access, or recovery blocks production release until corrected and retested.

Run synthetic drills only in isolated environments. Protect a restored production copy like production data if one is used later for verification. Complete a restricted pilot only after technical acceptance and trained staff are ready, with the agreed contingency method available.

## Phase 7. Train staff and complete operating handover

Owner: center manager for staff practice; technical administrator for operations; implementation team for preparation. Baseline: 4 and operational confirmation of 1, 2, 3 and 5.

1. Deliver short opening, arrival/departure, pickup exception, correction, outage, synchronization, and closing procedures. Include a current physical roster check and a response to unresolved events.
2. Have staff demonstrate student selection, timely capture, current-presence lookup, historical review appropriate to their role, an outage, and escalation of an exception. Record completion and retraining needs. Observe routine use during the restricted pilot and resolve deviations from the procedure. A walkthrough document alone is insufficient evidence of staff understanding or consistent use.
3. Have the technical administrator perform or witness backup retrieval, key recovery, restoration, alert response, and an approved deployment using customer-controlled access.
4. Deliver source and build/deployment instructions through Kumon's approved repository or equivalent package. Hand over infrastructure, backup storage, domain, administrative access, and recovery credentials through the agreed secure process. Use the existing [Railway handover plan](railway-handover-plan.md); do not remove temporary access until acceptance.
5. Assemble the eight-item baseline evidence matrix, test report, retention/access policies, training record, recovery runbook, support contacts, and release acceptance record. Record any separate legal or corporate review required by the adopting entity.

Acceptance: the center manager accepts the operating procedures and staff demonstration; the technical administrator can operate and recover the product; the applicable privacy review is complete; all eight baseline outcomes have evidence. Prepare for annual certification when Kumon's final requirements make it applicable, without representing this plan as a certification.

## Delivery sequence and release gate

Phase 1 establishes the decisions and safe test environment. Phases 2, 3 and 4 can then progress together. Phase 5 follows the migration and identity foundations. Phase 6 combines the completed software and operating procedures. Phase 7 records staff acceptance and completes handover; its training materials and account inventory can be prepared earlier.

Release requires all of the following:

- Working digital attendance and student identification, demonstrated by staff.
- Staff training and documented daily use procedures.
- Current-presence and historical review verified in normal operation.
- Proven preservation, outage access, restoration, and post-restore reconciliation.
- Approved minimum-data handling and functioning access/device controls.
- At least two years of protected, reviewable attendance and linked evidence.
- Named owners for technical operation, recovery, privacy and center procedures.
- Completed acceptance evidence for the exact release being adopted.

The next implementation increment should establish the migration ledger, isolated recovery fixtures, backup/export tooling, and a baseline restore. Privacy and retention work can start in parallel. The live backup configuration follows the hosting/storage decision; it is not enabled by this planning task.

## Deferred scope

Data import, QR/PIN convenience features, broader scheduling improvements, outbound messaging, billing, guardian portals, and corporate integrations are outside this baseline completion plan. They can be planned separately without obscuring the attendance release criteria.

## References

- Supplied PDF, page 1: `Student Check-In Check-Out System RequirementsÂ and Non-Exhaustive Informational Vendor List.pdf`. Source extraction: [provided_source.txt](../research/provided_source.txt).
- [Current implementation status](implementation-status.md), including broader CRM requirements that are outside this baseline plan.
- [Offline and recovery readiness plan](offline-and-recovery-readiness-plan.md), including provider documentation and detailed restore constraints.
- [Railway handover plan](railway-handover-plan.md).
