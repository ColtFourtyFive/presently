# Observation correction checkpoint — September 21, 2026

Schema 37 adds manager corrections for the effective time of an unmatched `exceptional_departure`. The accepted attendance event remains immutable: `attendance_events.observed_at`, its payload hash, `visit_id=NULL`, and the sealed JSON `null` receipt do not change. A correction cannot create a visit or arrival.

The feature uses immutable `observation_corrections`, an effective-time projection created only after the first accepted correction, and a permanent `observation_correction_request_keys` namespace. Exact retries return the accepted correction; changed payload, center, event, or request type conflicts. The client retains unresolved request identity across access renewal and blocks actor or navigation changes until the result is resolved.

Operational front-desk lists and attendance exports use effective time. Original-observation history continues to use the original time and displays the effective time, version, and complete correction chain. Every correction invalidates the old and new UTC date epochs plus the center-wide report epoch, covering center timezone and daylight-saving boundary changes.

Corrected observations remain live. Archive membership, publication, and compact-publication admission are fenced until a later archive format carries and verifies the full correction graph. Uncorrected unmatched observations retain the schema 36 archive behavior.

Backup inventory is 95 tables and includes the projection, immutable correction chain, and permanent request registry. Backup locks fence every mutation. Recovery uses the normal full D1 export and retains all three tables; recovery tests inventory and round-trip the full table set.

Focused evidence covers manager authorization, exact replay, changed reuse, cross-type reuse, concurrent version conflicts, lost responses, backup locks, archive fencing, immutable tables, unchanged receipts, no fabricated visit, effective-date report membership, complete CSV evidence, and a Los Angeles daylight-saving date boundary.

The sealed candidate passed **852/852 tests across 79 files** in 508.15 seconds with one Vitest worker. TypeScript, the production build, and Wrangler 4.100.0 dry-run packaging passed. The dry run packaged 60 static assets and a 595.79 KiB Worker upload, 130.61 KiB compressed. Release fingerprint `bc7cf08f9ce29f149ade1e99193bbef11912eb625b2f57c62d6af036f37e77c1` covers 315 files; migration 37 SHA-256 is `b44133c33dad6fba647effe487bad09ca328606b25ddbbe51ab81ecfee297733`.

The recovery test now creates a real unmatched-departure correction, decrypts and restores the full backup, and verifies the original sealed receipt, immutable event, effective-time projection, correction row, request registry, and effective time before and after two access resets. Reverse request-type reuse also returns an explicit 409 and rolls the attempted attendance insert back.

This checkpoint authorizes local release-tree promotion only. It did not deploy code, apply remote migrations, mutate live data, enable source eviction, delete R2 objects, change Railway, or authorize a paid plan. Production release still requires Worker-driven backup delivery, populated independent cloud restoration, deployed capacity measurements, staff and iPad acceptance, cutover and rollback rehearsal, and customer-owned handover.

The promoted root reproduced the 315-file candidate fingerprint exactly. TypeScript, build, and Wrangler dry-run packaging passed again. The promoted observation, recovery, correction-checkpoint, and staging-cleanup suites passed 49/49 tests in isolated runs. An initial combined promoted run encountered 13 process-level Miniflare fetch failures after repeated full-suite runtime creation; every affected observation and recovery test then passed individually against the unchanged fingerprint.
