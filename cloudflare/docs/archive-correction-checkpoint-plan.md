# Correction addendum checkpoint plan

Updated September 18, 2026. This plan defines schema 34. It does not authorize D1 source eviction or R2 deletion.

## Problem

Schema 32 publishes one immutable correction addendum for each accepted correction. Each addendum references the preceding publication. The authenticated archive format caps reference depth at 16, so a visit with a sufficiently long correction history eventually blocks later publication. A production release must fail closed without imposing that old graph-depth limit on future corrections.

## Authority model

A checkpoint is a new immutable addendum archive that references the original monthly publication directly. It contains the current visit plus every correction and matching audit row from the monthly visit version through one exact resulting version. The correction sequence is therefore complete inside the checkpoint; resetting the external reference depth does not discard provenance.

The D1 checkpoint publication pins:

- center, visit, month, timezone, generation, base publication, and base reference;
- starting and resulting visit versions;
- ordered correction membership with the original addendum publication and manifest for each correction;
- the exact archive reference, header, part descriptors, record-set digest, and timestamps; and
- current-generation availability or a fresh reconciliation receipt after recovery.

Checkpoint rows, members, and reconciliation receipts are immutable. Availability is revoked when the history generation changes. A later correction may use a ready checkpoint as its parent, so its reference depth starts again at two. Original correction publications remain readable and pinned; schema 34 removes no R2 object and marks nothing eligible for deletion.

## Bounds

- Build when a ready correction chain reaches depth 12.
- Include at most 64 ordered corrections for one visit.
- Write at most one checkpoint operation per scheduler invocation.
- Read and verify every source addendum and the monthly base before upload.
- Read back and authenticate every uploaded part and the manifest before committing D1 authority.
- Recheck the history generation, base authority, visit head, correction membership, and source publication availability after R2 awaits and inside the commit transaction.

A visit exceeding the supported 64-correction bound remains in D1 and requires explicit operator review. The bound never permits partial history or source removal.

## Recovery and maintenance

Backups include build, publication, member, availability, reconciliation-job, and receipt tables and pin checkpoint roots. Restoration makes checkpoints unavailable and invalidates unfinished work. Reconciliation authenticates the monthly base, every checkpoint object, ordered membership, all correction transitions, audits, and the final visit before making a checkpoint ready in the new generation.

Scheduled maintenance handles one operation in this order: checkpoint reconciliation, checkpoint publication, ordinary addendum reconciliation, ordinary addendum publication. A dependent addendum cannot reconcile until its checkpoint parent is ready.

## Required evidence

- A 17th correction publishes through a checkpoint without relaxing archive graph limits.
- Missing, corrupt, reordered, substituted, duplicated, or cross-visit correction evidence fails closed.
- Base, source, head, generation, maintenance, and concurrent checkpoint races commit no authority.
- Lost replies replay the same immutable checkpoint and do not upload a second authoritative publication.
- Restoration revokes both checkpoint and dependent addendum availability and requires parent-first reconciliation.
- Backup round trips preserve every checkpoint table and R2 reference.
- No D1 source row or R2 object is deleted.
