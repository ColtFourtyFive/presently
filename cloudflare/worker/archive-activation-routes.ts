import { Hono, type Context } from 'hono';
import { ARCHIVE_FORMAT_V2, ARCHIVE_LIMITS, type ArchiveManifest, type ArchiveReference } from '../shared/archive-format';
import { openArchiveManifest } from './archive-codec';
import { startCompactMonthlyPublication, advanceCompactMonthlyPublication } from './archive-compact-publication';
import { startMonthlySemanticVerification, advanceMonthlySemanticVerification, type MonthlySemanticRunHandle } from './archive-semantic-runner';
import { D1ArchiveSemanticStaging, type FrozenBaseIdentity } from './archive-semantic-store';
import { advanceHistoryBackfill } from './history-lookup';
import type { AppEnv } from './types';
import { ApiProblem, centerId, requireRole } from './util';

type Job = { id: string; center_id: string; status: string; format_version: number; manifest_key: string | null; manifest_sha256: string | null; manifest_json: string | null };
type Session = { verification_id: string; generation: string; status: string; commit_token: string | null; graph_sha256: string | null };
type Run = { run_id: string; status: string; phase: string; revision: number };
type Build = { publication_id: string; state: string; phase: string; revision: number };
type ArchiveContext = Context<AppEnv>;

function configured(c: ArchiveContext) {
  requireRole(c, ['owner']);
  if (c.env.ARCHIVE_V2_ENABLED !== 'true') throw new ApiProblem(503, 'ARCHIVE_V2_DISABLED', 'Version 2 archive activation is disabled.');
  if (!c.env.BACKUP_BUCKET || typeof c.env.BACKUP_KEY !== 'string' || !c.env.BACKUP_KEY) {
    throw new ApiProblem(503, 'ARCHIVE_NOT_CONFIGURED', 'Configure private R2 storage and the recovery key first.');
  }
}

async function jobFor(c: ArchiveContext): Promise<Job> {
  const job = await c.env.CRM_DB.prepare(`SELECT id,center_id,status,format_version,manifest_key,manifest_sha256,manifest_json
    FROM archive_jobs WHERE id=? AND center_id=?`).bind(c.req.param('id'), centerId(c)).first<Job>();
  if (!job) throw new ApiProblem(404, 'ARCHIVE_JOB_NOT_FOUND', 'Historical copy was not found.');
  if (job.status !== 'complete' || job.format_version !== 2 || !job.manifest_key || !job.manifest_sha256 || !job.manifest_json) {
    throw new ApiProblem(409, 'ARCHIVE_V2_NOT_READY', 'A complete version 2 historical copy is required.');
  }
  return job;
}

function reference(job: Job): ArchiveReference {
  return { archiveId: job.id, kind: 'monthly', manifestObjectKey: job.manifest_key!, manifestSha256: job.manifest_sha256! };
}

async function readObject(c: ArchiveContext, key: string, maximum: number): Promise<Uint8Array> {
  const object = await c.env.BACKUP_BUCKET!.get(key);
  if (!object) throw new ApiProblem(503, 'ARCHIVE_OBJECT_MISSING', 'An encrypted archive object is missing.');
  if (object.size > maximum) { await object.body.cancel(); throw new ApiProblem(503, 'ARCHIVE_OBJECT_TOO_LARGE', 'An archive object exceeds its bound.'); }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== object.size || bytes.length > maximum) throw new ApiProblem(503, 'ARCHIVE_OBJECT_SIZE', 'Archive object size changed.');
  return bytes;
}

async function sessionFor(c: ArchiveContext, job: Job): Promise<Session> {
  const row = await c.env.CRM_DB.prepare(`SELECT s.verification_id,s.generation,s.status,s.commit_token,s.graph_sha256
    FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
    WHERE s.verification_id=? AND s.root_archive_id=? AND s.root_manifest_sha256=? AND s.status!='invalid'`)
    .bind(job.id, job.id, job.manifest_sha256).first<Session>();
  if (!row) throw new ApiProblem(409, 'ARCHIVE_SEMANTIC_NOT_STARTED', 'Start semantic verification for this historical copy.');
  return row;
}

function frozen(session: Session): FrozenBaseIdentity {
  if (!session.commit_token || !session.graph_sha256 || !['frozen', 'verified'].includes(session.status)) {
    throw new ApiProblem(409, 'ARCHIVE_SEMANTIC_NOT_FROZEN', 'Stage every encrypted part and freeze the complete copy first.');
  }
  return { verificationId: session.verification_id, generation: session.generation, commitToken: session.commit_token, graphSha256: session.graph_sha256 };
}

async function runFor(c: ArchiveContext, identity: FrozenBaseIdentity): Promise<{ handle: MonthlySemanticRunHandle; row: Run }> {
  const row = await c.env.CRM_DB.prepare(`SELECT run_id,status,phase,revision FROM archive_semantic_runs
    WHERE verification_id=? AND generation=? AND snapshot_commit_token=? AND graph_sha256=? AND validator_version=1 AND status!='invalid'`)
    .bind(identity.verificationId, identity.generation, identity.commitToken, identity.graphSha256).first<Run>();
  if (!row) throw new ApiProblem(409, 'ARCHIVE_SEMANTIC_RUN_MISSING', 'Start semantic verification first.');
  return { handle: { ...identity, runId: row.run_id }, row };
}

export const semanticArchiveRouter = new Hono<AppEnv>();
semanticArchiveRouter.use('*', async (c, next) => { configured(c); await next(); });

semanticArchiveRouter.post('/maintenance/backfill/advance', async c => c.json(await advanceHistoryBackfill(c.env.CRM_DB)));

semanticArchiveRouter.get('/:id', async c => {
  const job = await jobFor(c);
  const session = await c.env.CRM_DB.prepare(`SELECT s.verification_id,s.generation,s.status,s.commit_token,s.graph_sha256
    FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
    WHERE s.verification_id=? AND s.root_archive_id=? AND s.root_manifest_sha256=?`)
    .bind(job.id, job.id, job.manifest_sha256).first<Session>();
  const run = session?.commit_token ? await c.env.CRM_DB.prepare('SELECT run_id,status,phase,revision FROM archive_semantic_runs WHERE verification_id=? AND generation=? AND snapshot_commit_token=? AND validator_version=1')
    .bind(session.verification_id, session.generation, session.commit_token).first<Run>() : null;
  const publication = session ? await c.env.CRM_DB.prepare('SELECT publication_id,state,phase,revision FROM archive_compact_builds WHERE publication_id=? AND generation=?')
    .bind(job.id, session.generation).first<Build>() : null;
 const policy = await c.env.CRM_DB.prepare('SELECT enabled FROM history_source_eviction_policies WHERE center_id=?')
 .bind(centerId(c)).first<{ enabled: number }>();
 const partCount = (JSON.parse(job.manifest_json!) as ArchiveManifest).parts.length;
 const staged = session ? (await c.env.CRM_DB.prepare(`SELECT part_index FROM archive_semantic_parts
   WHERE verification_id=? AND generation=? AND archive_id=? ORDER BY part_index`)
   .bind(session.verification_id, session.generation, job.id).all<{ part_index: number }>()).results : [];
 const stagedIndices = new Set(staged.map(row => row.part_index));
 let nextPart: number | null = null;
 for (let index = 0; index < partCount; index++) {
   if (!stagedIndices.has(index)) { nextPart = index; break; }
 }
 return c.json({ archiveId: job.id,
  session: session ? { verificationId: session.verification_id, generation: session.generation, status: session.status } : null,
  run, publication, staging: { partCount, stagedParts: stagedIndices.size, nextPart }, sourceEvictionEnabled: policy?.enabled === 1 });
});

semanticArchiveRouter.post('/:id/start', async c => {
  const job = await jobFor(c);
  const expected = reference(job);
  const envelope = await readObject(c, expected.manifestObjectKey, ARCHIVE_LIMITS.encryptedManifestBytes);
  const manifest = await openArchiveManifest(c.env.BACKUP_KEY as string, envelope, expected);
  if (manifest.format !== ARCHIVE_FORMAT_V2 || manifest.archiveId !== job.id || JSON.stringify(manifest) !== job.manifest_json) {
    throw new ApiProblem(409, 'ARCHIVE_MANIFEST_DRIFT', 'The encrypted manifest does not match the completed job.');
  }
  const existing = await c.env.CRM_DB.prepare(`SELECT s.verification_id,s.generation,s.status FROM archive_semantic_sessions s
    JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
    WHERE s.verification_id=? AND s.root_archive_id=? AND s.root_manifest_sha256=? AND s.status!='invalid'`)
    .bind(job.id, job.id, job.manifest_sha256).first<{ verification_id: string; generation: string; status: string }>();
  if (existing && existing.status !== 'staging') {
    return c.json({ archiveId: job.id, verificationId: existing.verification_id, generation: existing.generation, parts: manifest.parts.length, status: existing.status }, 202);
  }
  const staging = existing
    ? await D1ArchiveSemanticStaging.resume(c.env.CRM_DB, c.env.BACKUP_KEY as string, { verificationId: existing.verification_id, generation: existing.generation })
    : await D1ArchiveSemanticStaging.create(c.env.CRM_DB, c.env.BACKUP_KEY as string, expected, job.id);
  await staging.registerManifest(expected, envelope);
  return c.json({ archiveId: job.id, verificationId: staging.handle.verificationId, generation: staging.handle.generation, parts: manifest.parts.length }, 202);
});

semanticArchiveRouter.post('/:id/parts/:index', async c => {
  const job = await jobFor(c);
  const index = Number(c.req.param('index'));
  if (!Number.isInteger(index) || index < 0 || index >= ARCHIVE_LIMITS.parts) throw new ApiProblem(400, 'ARCHIVE_PART_INDEX', 'Choose a valid encrypted part.');
  const manifest = JSON.parse(job.manifest_json!) as ArchiveManifest;
  const part = manifest.parts[index];
  if (!part) throw new ApiProblem(404, 'ARCHIVE_PART_MISSING', 'This archive part does not exist.');
  const session = await sessionFor(c, job);
  if (session.status !== 'staging') throw new ApiProblem(409, 'ARCHIVE_SEMANTIC_FROZEN', 'This historical copy is already frozen for verification.');
  const staging = await D1ArchiveSemanticStaging.resume(c.env.CRM_DB, c.env.BACKUP_KEY as string, { verificationId: session.verification_id, generation: session.generation });
  const envelope = await readObject(c, part.objectKey, ARCHIVE_LIMITS.encryptedPartBytes);
  const commitToken = await staging.stageEncryptedPart(job.id, index, envelope);
  return c.json({ archiveId: job.id, index, commitToken });
});

semanticArchiveRouter.post('/:id/freeze', async c => {
  const job = await jobFor(c);
  const session = await sessionFor(c, job);
  const staging = await D1ArchiveSemanticStaging.resume(c.env.CRM_DB, c.env.BACKUP_KEY as string, { verificationId: session.verification_id, generation: session.generation });
  const snapshot = await staging.freeze();
  const handle = await startMonthlySemanticVerification(c.env.CRM_DB, { ...staging.handle, commitToken: snapshot.commitToken, graphSha256: snapshot.graphSha256 });
  return c.json({ archiveId: job.id, runId: handle.runId, status: 'pending' }, 202);
});

semanticArchiveRouter.post('/:id/verify/advance', async c => {
  const job = await jobFor(c);
  const identity = frozen(await sessionFor(c, job));
  const { handle } = await runFor(c, identity);
  return c.json(await advanceMonthlySemanticVerification(c.env.CRM_DB, handle));
});

semanticArchiveRouter.post('/:id/publish/start', async c => {
  const job = await jobFor(c);
  const identity = frozen(await sessionFor(c, job));
  const { handle } = await runFor(c, identity);
  const publication = await startCompactMonthlyPublication(c.env.CRM_DB, handle, job.id);
  return c.json({ archiveId: job.id, publicationId: publication.publicationId, state: 'building' }, 202);
});

semanticArchiveRouter.post('/:id/publish/advance', async c => {
  const job = await jobFor(c);
  const identity = frozen(await sessionFor(c, job));
  const build = await c.env.CRM_DB.prepare('SELECT publication_id,state,phase,revision FROM archive_compact_builds WHERE publication_id=? AND generation=?')
    .bind(job.id, identity.generation).first<Build>();
  if (!build) throw new ApiProblem(409, 'ARCHIVE_PUBLICATION_NOT_STARTED', 'Start publication after semantic verification.');
  if (build.state !== 'building') return c.json({ state: build.state, phase: build.phase, revision: build.revision, processed: 0 });
  return c.json(await advanceCompactMonthlyPublication(c.env.CRM_DB, { publicationId: build.publication_id, generation: identity.generation }, { expectedRevision: build.revision }));
});
