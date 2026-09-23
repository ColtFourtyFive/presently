# Kumon-owned CRM delivery and migration proposal

Prepared September 14, 2026. Proposed scope for discussion, not a completed feature list or a claim of Kumon corporate approval. The existing Railway workspace remains empty; this proposal does not change its configuration or data.

Scope update: data import is deferred until Kumon's export format is available. Prepare the existing Railway installation for ownership transfer independently of migration. The focused next plan is [Railway handover](railway-handover-plan.md); the migration recommendations below remain future work.

## Recommendation

Sell a one-time software implementation and handover package. Include deployment, the first migration from an agreed source, staff onboarding, documentation, and a defined post-launch defect warranty. Kumon controls the source code, infrastructure accounts, data, administrator access, and decisions about future changes.

Separate the software purchase from infrastructure expenses. Railway hosting, database storage, backups, domains, and any email/SMS or external identity services can incur ongoing charges paid directly by Kumon. There should be no recurring CRM license fee, license-server dependency, or loss of access if Kumon declines optional maintenance. Define ongoing patching and incident responsibility even when no support retainer is purchased. Later enhancements or support can be separately scoped projects or time-and-materials work.

The ownership agreement should specify the custom code and documentation transferred, deployment rights, support obligations, and treatment of pre-existing and third-party components. Open-source dependencies retain their own licenses. Delivering code alone does not transfer the cloud accounts or operating knowledge.

## Ownership and operating model

The legal buyer and operator still need confirmation: Kumon corporate, a multi-center franchisee, or an individual center. This changes access governance and deployment scope.

Use one maintained codebase with center configuration, not a separate code fork for each center. For an independent operator, provision a dedicated deployment and database under that operator's approved ownership. For corporate ownership across centers, design a central administration layer, explicit center membership, delegated administration, and center-scoped access before rollout. The current app has center-scoped server checks, but does not yet provide the full multi-center product or prove corporate-scale performance.

Railway remains the recommended initial host because the current app already runs there. Provide a portable container build and documented PostgreSQL deployment as an exit path. Kumon should not need our personal GitHub, Railway, container registry, or email account to run or restore the software.

## What the purchase should include

| Deliverable | Required handover evidence |
| --- | --- |
| Application and source | Kumon-owned private repository, tagged release, dependency/license inventory, schema migrations, build and test instructions, and portable container artifact |
| Hosting and accounts | Kumon-controlled Railway workspace, production and test environments, domain, billing, recovery contacts, secrets, and backup storage; temporary implementer access can be removed |
| Installation package | Versioned deployment recipe or template for app plus PostgreSQL, generated secrets, health checks, environment configuration, and first-owner activation |
| Center onboarding | Resumable center setup, roster review, staff roles and MFA, recurring schedules, verified pickup relationships, and opening review |
| Initial migration | Source discovery, a reviewed mapping, rehearsal, exception resolution, final import, reconciliation receipt, and agreed cutover support |
| Operations | Backup and restore procedures, retention controls, monitoring and alert recipients, update/rollback procedures, and data export documentation |
| Training | Short role-specific guides and walkthroughs for owner/manager, attendance staff, and instructors; designated Kumon administrator can train the next staff member |
| Acceptance and warranty | Documented acceptance scenarios, known limitations, ownership/access checklist, a defined defect-warranty period, and an escalation contact |

Scope the included migration by actual source system, supported export version, entities, history coverage, number of centers, and reconciliation criteria. Do not promise unlimited conversion of arbitrary files as part of an undefined fixed fee.

## Easy installation and onboarding

Prefer assisted initial installation in Kumon's own account, followed by self-service center setup. The center should not be asked to edit environment files or run database commands.

1. An authorized administrator connects or creates the Kumon-owned hosting account and selects the approved release.
2. The deployment recipe provisions the app, PostgreSQL connection, domain configuration, secrets, and health checks. Backup policies and alerts are explicitly configured and verified; deployment success alone does not establish them.
3. The first owner activates a named account through a short-lived invitation or an approved identity provider, sets up MFA, and confirms recovery access. No shared default password is shipped.
4. The owner confirms center name, time zone, hours, and whether this is an existing or new center.
5. Existing centers use the guided migration flow below. New centers can enter their first family manually.
6. The owner assigns staff roles, confirms schedules and pickup rules, and completes a practical opening check.

For later releases, provide versioned updates, release notes, a pre-update backup, staging verification, and a documented compatibility/rollback plan. Database changes need explicit versioned migrations; blindly rolling application code backward is not always safe after a schema change.

## Migration experience

The user experience should be: select the source, upload an authorized export or connect an approved API, review a small set of unresolved items, approve the preview, and receive a reconciliation receipt. Keep repeated mapping and cleanup work inside reusable source profiles.

### Establish the actual source first

We have not verified which Kumon system holds the center's data, whether it permits API access, or which exports are available. The attached attendance requirements and vendor reference list do not establish any of those capabilities.

Start with the system name, an export's column headers, and a small de-identified sample that preserves useful relationships. Do not request the full student roster just to discover the schema. Inspect supported export/API permissions and map the real source before promising a direct integration.

CSV and XLSX are proposed first import formats, subject to what the source can actually provide. Build an API adapter only when an authorized, supported interface is confirmed. A downloadable standard template is the fallback, not a requirement to retype every student. Do not use routine screen scraping or shared staff credentials as the migration architecture.

### Preserve meaning, not just rows

| Data | Migration rule |
| --- | --- |
| Students | Preserve the original source reference alongside an internal UUID. Retain active/inactive state. Do not match identity solely by name. |
| Families and guardians | Resolve households, students, guardians, and relationship rows independently. Suggest sibling links for review; shared phone/email alone must not merge families. |
| Pickup authorization | Import explicit verified authority and its provenance where available. Unknown authority stays unverified and does not authorize release. A contact is not automatically an authorized pickup person. |
| Math and Reading | Import each enrollment separately, with known status and start/end dates. Unknown historical dates stay unknown instead of being replaced with today. |
| Recurring schedules | Map subject, center-local time, day, duration, and applicable dates. Flag conflicts or unsupported closures. Never turn schedules into attendance. |
| Attendance history | Preserve source event IDs, original time text, timezone/offset, normalized timestamp, source attribution, importing staff, and receipt time. Imported historical visits never populate the current presence roster. |
| Incomplete history | Retain the known facts, flag missing or ambiguous times for review, and support an incomplete historical state. Do not fabricate the missing side of a visit or silently discard it. |
| Inquiries and notes | Import supported fields and follow-up status with source attribution. Preview potentially sensitive free text and exclude unsupported fields explicitly. |

### Proposed technical pipeline

1. **Stage.** Store the encrypted source file, checksum, source identity, mapping version, and importing user. Parse into staging records without changing the live workspace. Set a defined retention/deletion period for uploaded files and temporary migration copies.
2. **Validate.** Detect invalid rows, unknown subjects, broken relationships, duplicates, missing identifiers, conflicting enrollment dates, and ambiguous timestamps. Treat daylight-saving ambiguities as decisions requiring evidence, not guesses.
3. **Resolve.** Use saved source profiles to prefill mappings. Ask the owner only about ambiguous matches or data that affects safety and meaning. Remember approved mappings and matching decisions.
4. **Preview.** Show creates, updates, unchanged matches, rejected rows, and unresolved records. Bind approval to that preview version; changed mappings or conflicting live edits require a refreshed preview.
5. **Commit.** Import bounded roster batches transactionally. Import large histories in resumable chunks with checkpoints, kept out of operational views until reconciliation finishes. Stable source IDs and row hashes make retries and repeat exports idempotent.
6. **Reconcile.** Compare entities and date coverage against the source, not just spreadsheet-row counts. Every source row needs a disposition. Produce counts for students, guardians, relationships, enrollments, visits, events, duplicates, and exclusions, plus unresolved items.

Before operational use, an unused import can be reversed using recorded changes. Once staff have edited records or recorded new attendance, a blanket rollback can erase legitimate work. Detect downstream changes and use a reviewed reversal or correction process. A database restore is an emergency recovery operation, not a routine "undo import" button.

## Cutover and acceptance

Run one full rehearsal against the actual export format in an isolated migration environment. Review representative sibling families, students taking both subjects, inactive students, pickup restrictions, timezone boundaries, and incomplete attendance history.

Then agree on an after-hours cutover: retain a final source export, freeze or otherwise control changes to the source, import the final delta or deduplicated export, reconcile, and designate the new system for operational entries. Keep the previous records accessible according to the agreed retention and access policy. Do not split active attendance recording across two systems. Begin current presence with a physical roster check and staff-observed events.

Acceptance should demonstrate that:

- Every source record is accounted for as imported, unchanged, deliberately excluded, or unresolved with a reason.
- Re-uploading or retrying an import creates no duplicates.
- Student identities, family relationships, Math/Reading enrollments, and applicable pickup restrictions are correct.
- Historical attendance remains historically attributed and does not create current presence.
- Staff can perform actual arrival, authorized pickup, exceptional departure, correction, and history/export workflows.
- Kumon's administrator can restore into a clean environment, deploy an approved update, export relational data, and remove implementer access without disabling the system.
- Attendance remains reviewable for at least two years, and outage access/preservation and recovery procedures have been tested. These are separate controls; a backup retention window is not the same as attendance retention in the application.

## Work needed in the existing app

The current app already supplies manual student/guardian entry, subject enrollment, recurring schedules, inquiries, staff sessions, attendance, corrections, event CSV exports, and a Railway/PostgreSQL deployment. It now starts empty.

It does not yet supply the packaged installer, customer-owned account handover, center administration wizard, staff invitations/MFA, bulk import, external source IDs, mapping profiles, duplicate review, import receipts, full relational export, or the complete tested backup/offline/retention system.

The importer must not reuse manual entry blindly. Manual entry currently creates a new household and guardian for each student and defaults the guardian relationship to pickup-authorized. That behavior needs explicit verification controls before importing real data. Enrollment helpers currently assign current dates, and the attendance API stamps new events with the current time. Dedicated import paths and a historical incomplete-visit model are necessary.

Recommended delivery sequence:

1. Confirm the buyer/operator, source system, export schema, ownership terms, and acceptance scope.
2. Build identity mappings, the household/guardian model, and the import rehearsal with source-based test fixtures.
3. Build onboarding, staff identity/MFA, the installation package, full export, and operating controls.
4. Pilot with one center, resolve migration exceptions, verify recovery and attendance procedures, then accept the first release.
5. Hand over accounts, code, documentation, training, and the agreed warranty. Roll out further centers using the same maintained release and saved source profiles.

## Verified hosting references

Checked September 14, 2026:

- [Railway project transfers](https://docs.railway.com/projects): project administrators can transfer to another eligible account/workspace. A transfer to another user requires recipient acceptance; destination plan requirements apply. This is a handover option, not proof that the current project has been transferred.
- [Railway template creation](https://docs.railway.com/templates/create): templates can contain services, reference variables, generated secrets, health checks, and volumes. Use Kumon-owned repositories or registries and keep secrets out of distributable configuration.
- [Railway volume backups](https://docs.railway.com/volumes/backups): scheduled backups have platform-defined retention windows and restore restrictions. Current daily/weekly/monthly windows are 6/27/89 days; this does not remove the application's separate requirement to retain attendance for two years. Provide and test an independent PostgreSQL export/restore path for portability.
- [Railway point-in-time recovery](https://docs.railway.com/volumes/point-in-time-recovery): available PostgreSQL recovery tooling can restore into a sibling service; storage/network charges and cutover steps apply. It has not been enabled or acceptance-tested for this project by this proposal.

The attendance baseline comes from the user-provided PDF and is traced in the existing BRD/FRD/FDR. Packaging, commercial terms, and migration design here are recommendations. Source-system API access and exact export support remain unverified until Kumon identifies the source.
