# Failed publication cleanup

This internal cleanup releases temporary request claims left by an invalid monthly publication attempt. It retains the failed build, permanent request ownership, operational attendance data, R2 objects, and every committed publication. It adds no public endpoint or unattended dispatcher.

The implementation passed the local [schema 27 checkpoint](archive-abandonment-checkpoint-2026-09-16.md). Production activation remains pending.

## Admission and inventory

`startPublicationAbandonment` pins the complete invalid build and its SHA-256 hash. The database rejects candidates that are still building, are published, or have a committed descriptor, availability record, or reconciliation record. One cleanup job belongs to one invalid publication ID.

The first three phases inventory request claims, record locators, and part descriptors. Each page contains at most eight catalog rows. Request claims must match their permanent owner and locator. Part descriptors must match their stored hashes. The record pass reconstructs the publisher's original locator digest using its original part, byte, and page boundaries. Counts must match the retained build.

The saved inventory includes a separate count and additive SHA-256 sum for each catalog. These sums allow a later recovery to compare the remaining rows with the original inventory minus rows already removed. They are recovery consistency checks, not authentication of externally supplied backups.

## Deletion and interruptions

Deletion follows foreign-key order: request claims, record locators, then part descriptors. Each database-clock lease pins exactly the next eight keys. Native guards reject deletion outside that selection, expired leases, a changed generation, maintenance, and committed publication evidence.

The deletion and its progress checkpoint share one transaction. Native assertions reject an incomplete deletion or a zero-row checkpoint and roll back the transaction. Empty indexed pages advance phases. Completion requires all three catalogs to be empty and the removed counts and sums to match the saved inventory. The original build and immutable diagnostics remain available for inspection.

A recovery reset clears unfinished leases and pauses cleanup. `resumePublicationAbandonment` explicitly binds the job to the current ready generation and restarts all three inventory passes. It cannot delete again until the remaining counts and hashes match the saved inventory and removal history. The original build's generation is unchanged.

## Scope

Cleanup does not delete published archive indexes, remove source attendance records, activate public archive reads, remove R2 objects, or enable a scheduler. A replacement publication uses a new ID and a fresh supported verification proof. It still must satisfy the normal publication and global request-ownership rules.

Backup inventory includes cleanup jobs and diagnostics so a snapshot taken between pages preserves their exact progress. Live activation, deployed resource measurements, independent live recovery, staff and device acceptance, and Kumon-owned handover remain separate release requirements.
