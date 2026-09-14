# Kumon center onboarding proposal

Proposed on September 14, 2026. This is a product proposal, not a claim that the onboarding features below already exist or are required by Kumon corporate.

## Starting point

Start every workspace empty. Preserve the owner's login, then show a resumable setup checklist instead of fabricated students or activity. The owner can explore the workspace and return to setup. Completing setup must depend on saved configuration and verified records, not merely clicking through screens.

The first choice is **Existing center** or **New center**. Existing centers receive a roster migration path. New centers receive manual family entry and inquiry intake. Both use the same data model and attendance controls.

## Proposed flow

| Step | What the center supplies | Result |
| --- | --- | --- |
| 1. Center details | Center name, location, time zone, operating days and hours, center contact | Correct dates, schedule boundaries, and a center identity staff recognize. Ask the owner to confirm defaults; do not invent opening hours. |
| 2. Staff access | Named owner, managers, front-desk staff, and instructors; roles and MFA enrollment | Each action belongs to a staff member. A guardian is a family contact, not a staff user. Invitations remain drafts until the owner sends them. |
| 3. Families and students | Import an approved roster or add families manually; link siblings and guardians; assign each student a unique ID | A reviewed roster with separate student records and explicit guardian relationships. Enrollment in Math and Reading is recorded separately. |
| 4. Weekly learning schedule | Recurring visits, subjects, expected duration, center capacity and closures | The center sees expected arrivals. Scheduled lessons never create actual attendance records. |
| 5. Pickup and attendance procedure | Authorized pickup contacts, documented verification, restrictions, staff escalation, designated attendance device, outage procedure | Staff know how to identify arrivals, verify pickup, record actual departures, and escalate exceptions. Being listed as a contact must not imply pickup authority. |
| 6. Opening review | Owner review of roster, device access, staff training, record retention, and tested backup/contingency arrangements | A concrete readiness report and a recorded opening decision. Missing operational controls remain visible. A completed wizard does not certify compliance. |

For existing centers, the sequence should support reviewing the roster before inviting the rest of the staff. It must save progress so the owner can finish preparation across several sessions.

## Roster import

Provide a downloadable template and a mapping screen for an existing CSV. Show a preview before changing any records, with accepted rows, invalid rows, and possible duplicates. Let the owner correct or exclude rows. Commit only the reviewed rows and retain an import receipt with counts and source references. Repeating the same batch must not create duplicate families or students.

Collect only the initial operational fields: student name, existing student reference if available, optional grade, Math/Reading enrollment, guardian name and relationship, contact details, and verified pickup authority. Keep siblings linked without merging their identities. Do not request date of birth or sensitive family documents simply to complete onboarding.

Historical attendance, if the center chooses to import it, needs a separate reviewed import. Preserve source timestamps and provenance. Importing history must not put students on the current presence roster.

The user-provided requirements document establishes actual arrival/departure recording, unique identification, staff oversight, current attendance awareness, outage access/preservation, limited PII, and at least two years of reviewable attendance history. The proposed CSV, family, scheduling, and role workflows come from the CRM design, rather than being presented as additional corporate mandates.

## First-day experience

The owner reaches a dashboard that shows real counts, including zero. The primary action is adding or importing students until the roster exists. After that, attendance staff see expected students, current presence, and any records needing verification. Staff record the first real arrival when they observe it. A schedule or an onboarding walkthrough must never manufacture an attendance event.

A record that needs review stays distinguishable from confirmed current presence. An actual unexpected departure is recorded as a fact and escalated; it is not treated as permission to release the student.

## Implementation order

1. Build editable center settings and persist onboarding progress. Add a student directly from the empty-state action.
2. Build the import template, mapping, validation, duplicate review, and household/guardian relationships.
3. Add staff invitations, MFA, and owner-managed access changes.
4. Add schedule capacity, dated exceptions, and verified pickup setup.
5. Finish and test protected contingency access, two-year retention enforcement, backup restoration, and the opening review before operational attendance use.

The current app already has manual student/guardian entry, inquiries, recurring schedules, staff sessions, observed attendance, corrections, and reports. Editable center setup, the complete family model, bulk import, staff invitations/MFA, and the full readiness workflow still need implementation. The empty-workspace change does not complete those items.
