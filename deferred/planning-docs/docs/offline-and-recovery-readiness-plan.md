# Offline attendance and recovery readiness

Prepared September 14, 2026. This is an implementation and acceptance plan, not a statement that offline operation or recovery is ready. Railway and PostgreSQL remain the production architecture. Data import remains deferred, and the default workspace remains empty.

## What was verified

- Railway reports the PostgreSQL volume as Ready and mounted at `/var/lib/postgresql/data`.
- The production Postgres service's Backups page displays **No Backups** and states that backups and point-in-time recovery require the Pro plan. No backup settings, billing, or production data were changed during this assessment.
- The browser calls the live API and keeps application data in React memory. No service worker, durable browser database, offline authorization, or synchronization queue exists.
- The attendance endpoint timestamps events when the server processes them. Current request deduplication and transaction handling help with online retries but are insufficient for delayed observations and reconciliation.
- Existing local snapshots and application tests do not demonstrate a complete production restore. The project also needs versioned database migrations and a deployment path independent of this development machine.

Code references: `client/api.ts`, `client/App.tsx`, `client/AttendanceDialog.tsx`, `server/app.ts`, `server/auth.ts`, `server/schema.ts`, and `server/db.ts`.

## Recommended first release

Provide offline attendance on one designated, managed iPad per center. Its home-screen web app should open without a network connection after successful online preparation. Staff can inspect the last downloaded attendance roster and relevant pickup information, record observed arrivals and departures, and see records awaiting synchronization or manager review. Other CRM edits continue to require a connection.

PostgreSQL remains the authoritative history. The iPad holds the minimum protected data needed for attendance and a durable journal of observations. It is not the two-year archive or an independent backup of the whole CRM.

Use a stable, customer-controlled application domain before enrolling production devices where possible. Browser storage belongs to an origin; a later domain change requires a supported transition that drains and reconciles device journals before retiring the old origin.

## Implementation work

### 1. Establish the server event contract

Add a dedicated observation intake and reconciliation flow. Each observation needs a stable event ID, enrolled device and local sequence, center, named staff member, student, explicit arrival or departure action, observed time and offset, server receipt time, snapshot/grant versions, and any release or exception evidence.

Preserve original evidence. Store server receipt time separately from the device's claimed observation time. Clock drift, changed clocks, impossible ordering, competing events, and questionable authority must remain visible for review. Manager corrections must retain the original observation and attribution.

Deduplicate repeated uploads using durable identities. The same ID with a different payload must not overwrite an earlier observation. A transaction should persist the observation, its application or review status, and the receipt. Return a per-event result such as applied, already received, or retained for review. Quarantine questionable submissions with bounded intake rules; do not grant attendance authority merely because an event reached the server.

Add versioned migrations for these tables, device enrollment, synchronization receipts, and recovery metadata. Test changes against PostgreSQL as well as local development storage.

### 2. Build durable storage and offline startup

Cache versioned application files through a service worker. Store the protected attendance snapshot and journal in IndexedDB, separately from ordinary HTTP caching. Do not broadly cache authenticated API responses or the full CRM bootstrap.

Every attendance action should first commit its observation and local roster update in one local transaction. Display "Saved on this iPad, waiting to sync" only after that succeeds. A timeout, full storage, or failed encryption must never produce a success message. Reuse the stored event ID for all retries, including after a reload or restart.

Record the last successful download, pending-event count, review count, available storage, and offline authorization expiry. Request persistent browser storage where supported and inspect the result. A persistence grant does not protect against clearing site data or losing the device.

Protect local data with an approved key and unlock design. Encryption alone is insufficient if its key is stored beside the data without access protection. Verify key availability after device restart and staff locking on the actual supported iPad. If the web implementation cannot satisfy these requirements, retain the backend and use a managed native companion.

### 3. Add staff and device readiness

Enroll the iPad online to one center. Require a named staff identity and issue a signed, device-bound offline authorization grant with a limited lifetime. The existing design proposes a maximum one-day grant capped at 24 hours and a 15-minute inactivity lock; validate those operating limits with Kumon.

Provide an opening check that confirms a recent roster, staff access, storage health, and resolved pending records. Show an explicit failure when the device is not prepared. Define the manual attendance and pickup procedure for that case and for outages that exceed the grant lifetime.

Offline devices cannot immediately learn about revoked staff access or changed pickup authority. Display the age of cached information and route stale, missing, or disputed authorization through the agreed manager procedure. Recording an actual departure must remain distinct from authorizing release.

Staff activation, MFA or approved SSO, recovery, role administration, and device revocation are prerequisites for production enrollment. The current bootstrap owner account is not the finished ownership process.

### 4. Synchronize and reconcile

Synchronize while the app is open, on reopening, when connectivity returns, and through an explicit retry control. Do not rely on iPad background execution. Network connectivity alone does not establish that the API accepted an event.

Retry safely, preserve local sequence, and use bounded batches with durable per-event receipts. Authentication expiry or a partial response must leave unresolved observations recoverable. Preserve attribution to the staff member who made the observation, even if another staff member is signed in during upload.

Mark local presence as based on a dated snapshot plus this device's observations. It cannot represent a globally current roster while disconnected. Conflicting observations must reach a manager review queue and a physical roster check rather than silently overwrite one another.

Use one designated offline station initially. Train staff on that assignment because network partitions can leave one device offline while another continues online. A server setting alone cannot prevent competing activity during that split.

Make app updates and browser database migrations compatible with pending observations. Never activate an update that discards a journal or leaves its records unreadable.

### 5. Make restoration compatible with device journals

A backup restored to an earlier time may omit events for which an iPad already received acknowledgements. Do not delete every acknowledged observation immediately. Define a limited journal retention period covering the supported restore window, with device privacy and capacity limits.

During restoration, place the application in recovery mode and create a new recovery generation. Devices with an old generation must refresh and reconcile stable event IDs before ordinary synchronization resumes. Compare retained journals and available recovery evidence; do not blindly replay old check-in commands.

Reapply staff/device revocations and relevant retention or deletion decisions made after the recovery point before reopening access. Explicitly identify any unrecoverable interval. Device journals cannot reconstruct online records that were never stored there, and server backups cannot recover observations that never left a lost iPad.

Maintain a protected recovery ledger outside the database being restored for current staff/device revocations, deletion tombstones, and holds. Define durable capture and reconcile that ledger before enabling normal access. If current access decisions cannot be established, keep normal access closed and use the approved attendance contingency procedure. Restoring the database must not silently restore an old permission or deleted record to active use.

## Backup configuration and ownership

The first decision is whether to use the Railway plan that enables native backups and point-in-time recovery, or provide an equivalent managed PostgreSQL backup mechanism. Native Railway recovery is the simplest fit with the current deployment, subject to the customer's approved hosting budget.

Enable and verify native recovery after that decision. Railway documents daily, weekly, and monthly volume schedules with retention of 6, 27, and 89 days respectively. Its PITR documentation describes a separate rolling recovery window of approximately four weeks. Confirm the actual earliest and latest recoverable timestamps after the first successful base backup; enabling PITR does not recover earlier history.

Enabling PITR on single-node PostgreSQL redeploys that service, so schedule and verify the change. A PITR restore creates a sibling PostgreSQL service and requires an explicit application connection cutover. The restored service does not automatically have PITR enabled; re-establish backup coverage and confirm it before closing the incident. Monitor transaction-log archive lag because asynchronous archiving can leave a loss window.

Also schedule encrypted PostgreSQL logical backups to storage controlled by Kumon outside the Railway project, with independent access and recoverable encryption keys. A daily copy is a reasonable starting proposal for provider/account-loss recovery, but it permits up to a day's loss in that scenario. Increase frequency or use independently archived transaction logs if the agreed loss target is shorter. A shared administrator whose compromise can erase both copies is not adequate separation.

Capture the complete relational database, schema, required extensions and roles, plus the application release, migration version, configuration inventory, and secure secret-recovery procedure. Capture external files separately if file attachments are introduced. An attendance CSV is useful for inspection but cannot restore the CRM.

Monitor backup failures, stale backups, PITR archive lag, independent-copy delivery, storage capacity, and overdue restore drills. Name a primary and backup recipient, with a response procedure. Keep student data and secrets out of alert messages and general application logs.

The source document requires at least two years of reviewable attendance. Preserve that history and its linked evidence in the application, with an agreed retention and hold policy. Operational history retention, backup retention, device-cache retention, and diagnostic-log retention serve different purposes.

## Restore drill

Use isolated environments and synthetic fixtures for destructive scenarios. Preserve the empty production workspace. A real production backup can be restored into a restricted destination for verification without writing fixtures into production.

1. Establish a recovery fixture with students, guardians, pickup restrictions, open and closed visits, an exceptional departure, corrections, audit records, staff roles, and a device journal. Record IDs, record digests, relationships, original timestamps, correction history, and expected report results.
2. Take the relevant backup and create later fixture changes. Record the recovery target and the expected included and excluded records.
3. Exercise native recovery against a disposable Railway test service. Railway volume snapshots are constrained to their original project and environment; test that path on disposable infrastructure. Do not assume a production snapshot can be restored directly into a separate staging environment.
4. If PITR is configured, restore to a chosen time around the later changes and verify the selected recovery boundary. Record archive lag and the usable recovery window.
5. Restore the independent logical backup into fresh PostgreSQL using the handed-over application release, migrations, configuration, and key-recovery instructions. Verify this without relying on the production database or the developer's personal credentials.
6. Compare records and relationships, inspect attendance/corrections/reports, verify roles and center isolation, and confirm the system can resume permitted writes. Treat digest, integrity, or permission mismatches as failures.
7. Reconnect a device containing pending and previously acknowledged events to the restored test database. Verify recovery-generation detection, duplicate handling, clock/order conflict review, retained evidence, and physical roster reconciliation.
8. Measure time from declaring the incident through restored and reconciled operation. Record the actual data-loss boundary, missing records if any, operator actions, failures, and final acceptance evidence.

Railway snapshot restore stages a replacement volume and requires redeployment. Its documented rollback procedure does not make restoration a no-downtime operation. Rehearse the maintenance window and the center's attendance fallback.

## Release acceptance

| Scenario | Required evidence |
| --- | --- |
| Actual supported iPad in airplane mode | Prepared app launches; named staff can unlock within grant limits; attendance persists across app and device restart |
| Quota failure, denied persistence, cleared storage | No false success; readiness failure is visible; fallback and replacement-device procedure work |
| Lost response after server commit | Retrying produces one observation and one correct attendance effect |
| Multiple or reordered uploads | Each observation has a durable outcome; conflicts retain evidence for manager review |
| Clock changes and midnight boundaries | Original observation and receipt times remain distinct; questionable time claims are visible |
| Stale pickup data, staff lock, grant expiry, revocation | Unauthorized release is not silently granted; actual departures remain recordable through the approved contingency procedure |
| App update with pending records | Existing journal remains readable and synchronizes without loss |
| Native backup and PITR, if selected | Restore succeeds with verified data and measured recovery boundary |
| Independent backup and key recovery | Fresh deployment restores full CRM relationships without personal developer access |
| Older database plus newer iPad journal | No silent event loss, duplicate visits, or automatic reinstatement of revoked access |
| Backup/queue failure | Named operator receives the alert and can follow the recovery instructions |

Proposed initial service targets are no more than 15 minutes of loss for data already synchronized to the server under the primary recovery mechanism, and restoration plus reconciliation within four hours. These are planning targets, not current guarantees. The independent daily-copy path has a different potential loss window, and offline device loss needs its own contingency policy. Agree on all three before accepting the backup design.

Complete the first restore drill before production use. Repeat at an agreed interval, proposed quarterly, and after material changes to database versions, backup tooling, migrations, or synchronization behavior.

Offline and recovery acceptance is only part of production approval. Staff identity, authorized pickup controls, security review, retention procedures, training, and ownership handover remain release dependencies listed in `docs/implementation-status.md`.

## Delivery order

1. Agree recovery targets and hosting/backup ownership. Add versioned migrations and create isolated recovery fixtures.
2. Configure backups and prove a baseline independent restore before adding offline complexity.
3. Build device enrollment, bounded staff access, observation intake, durable iPad storage, and attendance-only offline screens.
4. Add synchronization, manager conflict review, and recovery-generation reconciliation.
5. Run actual-iPad outage tests and the combined restoration drill. Deliver the operating and recovery runbooks with recorded acceptance results.

## Sources

- Supplied Kumon checklist, extracted in `research/provided_source.txt`, for attendance preservation, contingency access, and two-year history.
- [Current Railway Postgres backup page](https://railway.com/project/83fb1c4c-5246-4250-8e00-a4fc4053c5ff/service/1d4f3962-df06-4068-893b-11107881a8aa/backups?environmentId=2bf92d06-224d-419f-b737-df8c204b094a), inspected September 14, 2026, for the No Backups state and displayed Pro-plan requirement.
- [Railway volume backups](https://docs.railway.com/volumes/backups), for schedules, retention, restore behavior, and project/environment constraints.
- [Railway point-in-time recovery](https://docs.railway.com/volumes/point-in-time-recovery), for base backups and recoverable windows.
- [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/) and [MDN browser storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria), for browser storage limits and persistence caveats.
