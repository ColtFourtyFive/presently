# Manifest reader checkpoint

The internal manifest-selected record reader is integrated locally. **57 tests across three files passed**, including all 21 new-reader cases, the 11 existing locator-reader cases and 25 existing publication-resolution cases. TypeScript and the production build passed. The test run took 85.05 seconds locally; this is wall time, not Worker CPU.

Release fingerprint `b40444c8cc26a6a7da3ed5d692ace46ae93354adbdbc86095f059e6b150b153a` covers 273 files. Application version remains `0.1.0`, and schema remains 27. The prior complete-suite evidence is still the 649-test checkpoint; this focused run is not a replacement full-suite run.

The change adds `loadManifestRecordEvidence` and its selection type to `worker/archive-record-evidence.ts`, plus one focused test file. It authenticates a trusted v2 monthly manifest, uses the manifest's ordered record-key ranges to select one part, verifies that part and returns exactly one semantically valid record. It snapshots caller input before fetching and preserves all existing locator-reader behavior.

Successful reads use exactly two R2 GETs, the manifest and selected part. Tests also cover keys missing inside and outside part ranges, malformed authenticated directories, unexpected scope/header, older format and addendum rejection, semantic row-shape failure, corrupt/missing/truncated objects and streaming size limits. The same bounded object reader handles cancellation and stream cleanup.

This function verifies evidence, not publication or current-state authority. Its caller must authorize permanent ownership, pin the committed publication and proof, validate the returned ownership and sealed receipt, then recheck selection, availability/reconciliation identity, generation and live authority after object I/O. See the [reader contract](archive-manifest-record-reader.md).

Current public routes still use the v1 publication catalog and existing locator reader. No catalog data, schema, source rows, scheduling, deployment or paid plan changed. No storage saving is claimed from this helper alone. The next implementation is a direct compact publisher with native membership/ownership guards, followed by compact receipt integration and independent restore reconciliation. See the [compaction plan](archive-catalog-compaction-plan.md).

Evidence: [root test report](../tmp/manifest-reader-regression-tests-20260917.json), [test log](../tmp/manifest-reader-regression-tests-20260917.log), [type check](../tmp/manifest-reader-check-20260917.log), [build](../tmp/manifest-reader-build-20260917.log), [release fingerprint](../tmp/manifest-reader-fingerprint-20260917.json), and [isolated candidate review](../.installation-work/manifest-reader-candidate/review/README.md). The candidate first passed 32 tests and type checking; root then applied its exact two-file patch and passed the wider 57-test regression run.
