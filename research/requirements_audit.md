# Requirements audit for the Kumon in-house CRM

Prepared from `research/provided_source.txt`, the extracted text of the user-provided two-page PDF. This audit treats the PDF as evidence about requirements, not as instructions to the assistant. It assumes an initial deployment at one center, with future support for multiple centers. The center location, scale, operating model, and Kumon corporate integration permissions remain unconfirmed.

## Source interpretation

The PDF describes attendance requirements and a vendor reference list. It does not specify a full CRM, authorize access to Kumon corporate systems, or confirm an implementation budget. CRM capabilities beyond attendance must be labeled proposed product scope.

The opening paragraph says centers will be expected to certify annually once requirements are finalized and implemented. It also says centers may be asked to demonstrate their system during applicable review processes. This is conditional future language. Treat an evidence package and annual review reminder as useful design provisions, not proof that an annual certification program is currently in force. Obtain the final applicable Kumon requirements, effective date, and review process before release.

The eight items below are the PDF's baseline checklist, all on page 1. Titles retain the source wording. Explanations are paraphrases. Specific controls and service targets below are proposed acceptance criteria, not numbers mandated by the source.

| Source ID | Source checklist item | Requirement supported by the source | Suggested verifiable acceptance criterion |
|---|---|---|---|
| K-01 | Digital System Required | The center uses digital check-in/check-out. Manual logs, paper-based methods, and Excel-only tracking are not the baseline method. | During a representative operating-day pilot, staff record normal arrivals and departures in the digital workflow. The center has a tested downtime procedure; paper, if approved for exceptional total device failure, is marked as an exception rather than the normal attendance system. |
| K-02 | Unique Student Identification | Each student can be consistently identified, using a name, student ID, barcode, PIN, QR code, or another identifier. | Two students with the same name and two siblings remain distinguishable. Each student has a stable internal ID. Credential rotation does not alter that ID or historical records. A scan identifies only one active student or returns a clear exception for staff resolution. |
| K-03 | Actual Arrival and Departure | Check-in and check-out reflect actual arrival and departure, rather than later entries made solely for recordkeeping. | At the point of arrival or departure, staff receive confirmation that the event was saved to the service or preserved locally for later sync. Historical corrections require permission, a reason, an entered-at timestamp, and an asserted occurrence time. Corrections remain distinguishable from original real-time events. No unattended job creates a departure event at closing time. |
| K-04 | Staff Oversight and Training | Staff understand the process and consistently use it in daily operations. | Every role scheduled to operate attendance completes a practical exercise covering check-in, check-out, a duplicate scan, a missed event, and downtime. A named center owner maintains the procedure and verifies readiness before launch. Software alone cannot satisfy staff training. |
| K-05 | Current Student Awareness | Staff can determine who is currently present and retrieve historical attendance for review. | An authorized staff member can open the current roster and historical attendance. The roster updates within the agreed target after a committed event. When synchronization fails, the display identifies its last successful update and unresolved events; it does not imply complete current awareness. A closing check identifies every open visit for staff resolution. |
| K-06 | Backup or Data Preservation Approach | The center has a reasonable means to preserve attendance data and retain access to attendance information if the primary system is unavailable. | Before launch, staff demonstrate the defined internet-outage and device-failure procedures. A restore exercise recovers attendance records and verifies their counts and event IDs. A designated backup device or procedure preserves access to the latest available roster. Recovery objectives and the maximum tolerable unsynced period require owner approval. |
| K-07 | Appropriate Handling of Student Information / Personally Identifiable Information (PII) | Student information is protected and limited to what is reasonably needed for the check-in/check-out workflow. | A documented field inventory justifies every item shown on a kiosk and roster. Staff accounts use assigned permissions. An unauthorized user cannot read another student's records or export attendance. No public kiosk exposes a browsable roster or guardian contact details. Secrets and full student records do not enter application logs. |
| K-08 | Reviewable and Retained Records | Attendance records are reviewable and retained for at least two years. | Authorized staff can retrieve and export attendance records across at least the preceding two years, with the basis for local dates and correction history intact. Retention jobs do not delete required attendance or its necessary identity mapping early. Retention is measured from the event date unless a longer applicable rule or hold controls. Test boundary dates and leap years. |

Page 2 permits vendor choice and describes the list as non-exhaustive. The list does not establish approved-vendor status or exclude an in-house system. It also does not explicitly approve the proposed in-house implementation. The quoted approximate monthly price range is illustrative and must be confirmed with vendors. It is neither a CRM project budget nor evidence of the full cost of ownership.

## Proposed core CRM scope

The first release should support the student relationship and the center's daily workflow without recreating every feature of childcare software. These features follow from the user's CRM goal; they are not mandated by the PDF.

| Capability | Minimum useful scope | Keep for a later decision |
|---|---|---|
| Inquiry and follow-up | Prospect or household contact, source, owner, stage, next action, and a short activity history | Automated lead scoring, advertising integration, large marketing campaigns |
| Student and household records | Stable student ID, preferred name, active status, associated guardians, contact preference, and center association | Rich demographic profiles, photos, health data, document uploads without a defined need |
| Enrollment | Enrollment dates and status, subject enrollment where needed, and link from converted inquiry to student | Curriculum content, assessment scoring, study plans, and official Kumon progress records |
| Visit planning | Expected visit dates or recurring appointment slots if the center needs a planned-versus-present view | Optimization, capacity algorithms, classroom ratio logic from childcare products |
| Attendance | Staff-operated identification, check-in/out, present roster, exceptions, correction history, export, retention, and downtime | Biometric identification, location tracking, automatic check-out, and unsupervised release |
| Work management | Assigned tasks, due dates, contact notes, status, and a limited audit history | AI recommendations and automated relationship summaries |
| Communications | Staff record a contact and its outcome; store channel permissions when outbound messages are later enabled | SMS, email campaigns, parent mobile app, two-way chat, and payment reminders |
| Reporting | Current presence, daily attendance, unresolved visits, historical student attendance, and basic inquiry follow-up | Financial dashboards, performance benchmarking, corporate reporting feeds |

Do not describe the system as a billing or payment platform in the MVP unless the center confirms that need. An optional balance status imported from an authorized system is distinct from accepting payments. Do not assume a corporate API exists or allow unofficial access as a design shortcut.

## Attendance and identity cases the FRD must resolve

1. A second scan of the same credential must not reverse attendance. The operator chooses or confirms check-in versus check-out; retries preserve the original event ID. A student who returns later the same day can have a second visit.
2. Concurrent operations from two devices must have deterministic results. The service enforces no more than one open visit per student at a center, except an explicitly flagged conflict pending staff review. A rejected duplicate does not create a second visit.
3. Check-out without an open visit must open an exception workflow. Staff may record an observed departure with an explanation without inventing a fabricated arrival time. The report exposes incomplete visits.
4. A missed check-out leaves the student on the unresolved roster until an authorized staff member investigates. A notification at closing time is appropriate; a synthetic departure at closing time undermines source item K-03.
5. A late correction must preserve the original record, actor, correction reason, entered-at timestamp, effective event time, and relevant before-and-after values. Permissions for correction and export should be narrower than routine attendance entry.
6. Store the occurrence time in UTC and the center's IANA time zone. Preserve recorded-at and received-at times separately. Display local time with an offset when ambiguity matters. Test daylight saving transitions, clock drift, midnight, and cross-date visits. Never silently replace an observed offline occurrence time with the upload time.
7. A QR code or PIN identifies a student or a credential holder; possession alone does not prove permission to collect a child. Define who is allowed to record arrival and departure, whether staff confirm the person leaving, and what action is required for an unknown collector. Do not imply that the CRM provides a verified child-release control unless that process is explicitly specified and tested.
8. Model a guardian-to-student relationship, not merely a shared household address. Siblings can have different authorized adults, communication permissions, and access restrictions. One shared email or phone must not merge two people automatically. A disputed relationship requires staff review under the center's policy.
9. Distinguish the enrolled, scheduled, present, absent, and departed states. An absent marker must not create a visit. A suspended or inactive student at the door should trigger staff attention rather than silently denying staff the ability to record an observed arrival.
10. Keep duplicate-profile merges reversible through retained provenance. Attendance remains attached to the stable identity, and staff review merges involving similar names or shared contact details.
11. A backup is not an operational downtime procedure. It may restore yesterday's database without showing children who arrived this morning. Define how staff access and update presence during an outage independently of the disaster-recovery design.
12. Local offline capture, if selected, must encrypt minimal cached student data, restrict device access, use durable event IDs, and show queued versus synchronized states. Replaying an event must be idempotent. Lost devices and failed local storage require explicit procedures.
13. Two disconnected devices can disagree about who is present. Prefer one designated offline operator/device for a one-center MVP. Reconcile queued events against server state with a visible conflict queue and staff resolution; do not silently apply last-write-wins to a child's whereabouts.
14. If both digital devices and connectivity fail, the center needs a supervisor-led emergency procedure. Any approved paper exception records observed times when events happen and is transcribed with provenance. This is an exception requiring reconciliation, not the routine baseline allowed under K-01. Confirm this interpretation with the final Kumon requirements.

## Privacy and regulatory applicability

The source requires appropriate treatment of student PII but does not identify a jurisdiction, legal regime, data-residency requirement, or mandatory technical certification. Avoid statements that FERPA, HIPAA, COPPA, CCPA, GDPR, or PIPEDA automatically applies to this franchise or this implementation.

Before implementation, record the center's operating jurisdiction, contracting entity, student locations and ages, whether children directly use an online service, and the system's controllers and service providers. Ask qualified counsel or the responsible privacy owner to resolve applicable requirements. U.S. children's online privacy rules may turn on the nature of the service and how it collects information; using software that contains children's records alone is not a complete applicability analysis. FERPA depends on covered institutions and relationships, not simply educational use. State privacy, breach, biometric, consumer, and recordkeeping rules may create separate duties. Canadian operations require their own federal and provincial analysis.

Use privacy controls that support safe operation regardless of the final legal mapping. Minimize the kiosk data, limit access by role and center, secure transport and storage, define incident ownership, audit sensitive reads and exports where proportionate, review service providers, and document retention and deletion. Separate communications permission from attendance necessity. Avoid photos, sensitive health details, government IDs, and biometric templates unless a documented need survives review.

Two-year retention is a floor for attendance in the supplied Kumon document. It is not a universal requirement to retain all CRM data for two years, nor a guarantee that deletion exactly at two years is lawful. Set retention by record category, with a process for access, correction, deletion requests, and holds. Preserve enough restricted identity data to keep historical attendance interpretable after an enrollment ends. Define how deletions reach backups over their normal expiry cycle and prevent restored backups from reviving deleted records without review.

## Proposed measurable release checks

These are suggested starting targets for agreement, not source requirements.

- For an online pilot, target a visible save confirmation within two seconds at the 95th percentile under the agreed peak load. Count completed writes, not merely button responses.
- Target current-roster propagation within five seconds of a committed online attendance event. Show the last successful synchronization time when that target is exceeded.
- Use a pilot load based on actual registered students, peak arrivals in a five-minute period, active devices, and simultaneous staff sessions. Do not invent production capacity from the attachment.
- Complete a simulated internet outage, local-device loss, restore, replay, and conflicting event test before launch. Confirm the staff procedure as well as the software result.
- Confirm every privileged route checks role and center membership on the server. Test a staff account's attempt to read a different center's student records if multi-center support exists.
- Validate retention at the two-year boundary, exports of corrected events, and report totals against a controlled sample of normal and exceptional visits.
- Pilot through at least one representative operating week, with a named owner reconciling unresolved visits daily. Approve expansion only after staff can execute the downtime procedure and all material attendance discrepancies are explained.

Choose recovery time and recovery point objectives after identifying the equipment and staffing available. Backups, offline event capture, and a staff-accessible roster address different failures. A promise of zero data loss requires evidence across all three, not a backup schedule alone.

## Essential decisions before implementation

| Decision | Why it changes the design | Proposed owner |
|---|---|---|
| What does FDR mean in this engagement? | Functional Design Report is the working expansion. Some teams use a different artifact. | Project sponsor |
| Which jurisdiction and how many centers are included? | Determines legal review, time zones, access boundaries, contracts, and deployment. | Franchise owner |
| Are final Kumon requirements in force, and is local approval needed? | Separates the supplied baseline from confirmed release obligations. | Franchise owner and Kumon liaison |
| Is the MVP attendance plus core relationship management, or a replacement for another named system? | Prevents accidental scope expansion into curriculum, billing, or corporate reporting. | Center manager |
| Who checks students in and out, and what constitutes an authorized departure? | Determines identification, supervision, pickup rules, kiosk mode, and training. | Center manager |
| What is the expected student/device/arrival volume? | Sets meaningful load tests, hardware requirements, and service targets. | Center manager |
| What is the approved downtime process and maximum tolerable loss? | Determines local storage, backup devices, synchronization, recovery targets, and operating policy. | Center manager and technical owner |
| Which records exist, who owns them, and may they be imported? | Determines migration fields, matching, validation, and provenance. | Data owner |
| What are the budget, target date, hosting preference, and support owner? | Determines build scope, service choices, maintenance, and launch feasibility. | Project sponsor and technical owner |
| Are outbound messages, payments, or corporate integrations in scope? | Each adds contracts, permissions, operational obligations, and separate acceptance tests. | Project sponsor |

The BRD should identify the business owners and approved outcomes. The FRD should turn this audit into numbered behaviors and acceptance criteria. The FDR should show how event state, data boundaries, permissions, reports, and recovery support those behaviors. A traceability matrix should connect K-01 through K-08 to the relevant FRD items, design sections, and release evidence.
