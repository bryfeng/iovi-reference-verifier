import { DatabaseSync } from 'node:sqlite';

import type { SemanticLayerRegistrationV1, VerifierReceiptV1 } from './index.js';
import {
  ReferenceVerifierRepositoryConflictError,
  type AcceptedHeadUpdateV1,
  type ReferenceVerifierRepository,
  type StoredCheckpointV1,
  type StoredPayloadV1,
  type StoredRegistrationVersionV1,
  type StoredSemanticLayerV1,
  type StoredSubmissionV1
} from './repository.js';

export const REFERENCE_VERIFIER_SQLITE_SCHEMA_VERSION = 1;

export class SqliteReferenceVerifierRepository implements ReferenceVerifierRepository {
  private readonly database: DatabaseSync;
  private transactionDepth = 0;
  private closed = false;

  constructor(databasePath: string) {
    if (!databasePath.trim()) throw new Error('databasePath is required');
    this.database = new DatabaseSync(databasePath);
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.database.exec('PRAGMA synchronous = FULL');
    this.database.exec('PRAGMA journal_mode = WAL');
    this.applyMigrations();
  }

  transaction<T>(operation: () => T): T {
    this.assertOpen();
    if (this.transactionDepth > 0) return operation();
    this.database.exec('BEGIN IMMEDIATE');
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  insertSemanticLayer(layer: StoredSemanticLayerV1): void {
    this.assertOpen();
    const existingVersion = this.database
      .prepare(
        'SELECT registration_json, is_active FROM registration_versions WHERE registration_hash = ?'
      )
      .get(layer.registrationHash) as RegistrationVersionIdentityRow | undefined;
    if (existingVersion !== undefined) {
      if (
        existingVersion.registration_json !== stableJson(layer.registration) ||
        Number(existingVersion.is_active) !== 1
      ) {
        throw new ReferenceVerifierRepositoryConflictError(
          `registration hash ${layer.registrationHash} has conflicting contents`
        );
      }
      return;
    }

    const activeAddress = this.database
      .prepare(
        'SELECT registration_hash FROM registration_versions WHERE semantic_layer_address = ? AND is_active = 1'
      )
      .get(layer.registration.semanticLayerAddress) as { registration_hash: string } | undefined;
    if (activeAddress !== undefined) {
      throw new ReferenceVerifierRepositoryConflictError(
        `semantic layer ${layer.registration.semanticLayerAddress} already has an active registration`
      );
    }

    if (layer.registration.legacySlId !== undefined) {
      const activeLegacy = this.database
        .prepare(
          'SELECT semantic_layer_address FROM registration_versions WHERE legacy_sl_id = ? AND is_active = 1'
        )
        .get(layer.registration.legacySlId) as { semantic_layer_address: string } | undefined;
      if (activeLegacy !== undefined) {
        throw new ReferenceVerifierRepositoryConflictError(
          `legacy slId ${layer.registration.legacySlId} is already registered`
        );
      }
    }

    this.database
      .prepare(
        `INSERT INTO registration_versions (
          registration_hash,
          semantic_layer_address,
          legacy_sl_id,
          registration_json,
          is_active,
          registered_at
        ) VALUES (?, ?, ?, ?, 1, ?)`
      )
      .run(
        layer.registrationHash,
        layer.registration.semanticLayerAddress,
        layer.registration.legacySlId ?? null,
        stableJson(layer.registration),
        layer.registeredAt
      );
    this.database
      .prepare(
        `INSERT INTO semantic_layer_heads (
          semantic_layer_address,
          registration_hash,
          sequence,
          state_root,
          checkpoint_id,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        layer.registration.semanticLayerAddress,
        layer.registrationHash,
        layer.sequence,
        layer.stateRoot,
        layer.checkpointId ?? null,
        layer.registeredAt
      );
  }

  getSemanticLayer(semanticLayerAddress: string): StoredSemanticLayerV1 | undefined {
    const row = this.database
      .prepare(
        `SELECT
          rv.registration_hash,
          rv.registration_json,
          rv.registered_at,
          h.sequence,
          h.state_root,
          h.checkpoint_id
        FROM registration_versions rv
        JOIN semantic_layer_heads h
          ON h.registration_hash = rv.registration_hash
        WHERE rv.semantic_layer_address = ? AND rv.is_active = 1`
      )
      .get(semanticLayerAddress) as SemanticLayerRow | undefined;
    return row === undefined ? undefined : semanticLayerFromRow(row);
  }

  getSemanticLayerByLegacySlId(legacySlId: string): StoredSemanticLayerV1 | undefined {
    const row = this.database
      .prepare(
        `SELECT
          rv.registration_hash,
          rv.registration_json,
          rv.registered_at,
          h.sequence,
          h.state_root,
          h.checkpoint_id
        FROM registration_versions rv
        JOIN semantic_layer_heads h
          ON h.registration_hash = rv.registration_hash
        WHERE rv.legacy_sl_id = ? AND rv.is_active = 1`
      )
      .get(legacySlId) as SemanticLayerRow | undefined;
    return row === undefined ? undefined : semanticLayerFromRow(row);
  }

  listSemanticLayers(): StoredSemanticLayerV1[] {
    const rows = this.database
      .prepare(
        `SELECT
          rv.registration_hash,
          rv.registration_json,
          rv.registered_at,
          h.sequence,
          h.state_root,
          h.checkpoint_id
        FROM registration_versions rv
        JOIN semantic_layer_heads h
          ON h.registration_hash = rv.registration_hash
        WHERE rv.is_active = 1
        ORDER BY rv.semantic_layer_address`
      )
      .all() as SemanticLayerRow[];
    return rows.map(semanticLayerFromRow);
  }

  listRegistrationVersions(semanticLayerAddress: string): StoredRegistrationVersionV1[] {
    const rows = this.database
      .prepare(
        `SELECT registration_hash, registration_json, is_active, registered_at
         FROM registration_versions
         WHERE semantic_layer_address = ?
         ORDER BY registered_at, registration_hash`
      )
      .all(semanticLayerAddress) as RegistrationVersionRow[];
    return rows.map((row) => ({
      registration: parseJson<SemanticLayerRegistrationV1>(row.registration_json),
      registrationHash: row.registration_hash,
      active: Number(row.is_active) === 1,
      registeredAt: row.registered_at
    }));
  }

  updateAcceptedHead(update: AcceptedHeadUpdateV1): void {
    const result = this.database
      .prepare(
        `UPDATE semantic_layer_heads
         SET sequence = ?, state_root = ?, checkpoint_id = ?, updated_at = ?
         WHERE semantic_layer_address = ?
           AND registration_hash = ?
           AND sequence = ?
           AND state_root = ?
           AND checkpoint_id IS ?`
      )
      .run(
        update.sequence,
        update.stateRoot,
        update.checkpointId,
        new Date().toISOString(),
        update.semanticLayerAddress,
        update.expectedRegistrationHash,
        update.expectedSequence,
        update.expectedStateRoot,
        update.expectedCheckpointId ?? null
      );
    if (Number(result.changes) !== 1) {
      throw new ReferenceVerifierRepositoryConflictError(
        `accepted head changed for semantic layer ${update.semanticLayerAddress}`
      );
    }
  }

  savePayload(payload: StoredPayloadV1): void {
    const existing = this.getPayload(payload.payloadHash);
    if (existing !== undefined) {
      if (stableJson(existing) !== stableJson(payload)) {
        throw new ReferenceVerifierRepositoryConflictError(
          `payload hash ${payload.payloadHash} has conflicting bytes`
        );
      }
      return;
    }
    this.database
      .prepare(
        'INSERT INTO payloads (payload_hash, payload_bytes, payload_size) VALUES (?, ?, ?)'
      )
      .run(
        payload.payloadHash,
        Buffer.from(payload.payloadHex.slice(2), 'hex'),
        payload.payloadSize
      );
  }

  getPayload(payloadHash: string): StoredPayloadV1 | undefined {
    const row = this.database
      .prepare('SELECT payload_hash, payload_bytes, payload_size FROM payloads WHERE payload_hash = ?')
      .get(payloadHash) as PayloadRow | undefined;
    if (row === undefined) return undefined;
    return {
      payloadHash: row.payload_hash,
      payloadHex: `0x${Buffer.from(row.payload_bytes).toString('hex')}`,
      payloadSize: Number(row.payload_size)
    };
  }

  saveSubmission(submission: StoredSubmissionV1): void {
    const existing = this.database
      .prepare('SELECT submission_json FROM submissions WHERE submission_id = ?')
      .get(submission.submissionId) as { submission_json: string } | undefined;
    if (existing !== undefined) {
      if (existing.submission_json !== stableJson(submission)) {
        throw new ReferenceVerifierRepositoryConflictError(
          `submission ${submission.submissionId} has conflicting contents`
        );
      }
      return;
    }
    if (submission.idempotencyKey !== undefined) {
      const existingKey = this.getSubmissionByIdempotencyKey(submission.idempotencyKey);
      if (existingKey !== undefined) {
        throw new ReferenceVerifierRepositoryConflictError(
          `idempotency key ${submission.idempotencyKey} is already in use`
        );
      }
    }
    this.database
      .prepare(
        `INSERT INTO submissions (
          submission_id,
          idempotency_key,
          request_fingerprint,
          semantic_layer_address,
          payload_hash,
          posting_id,
          tx_hash,
          metadata_json,
          timestamp,
          receipt_id,
          submission_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        submission.submissionId,
        submission.idempotencyKey ?? null,
        submission.requestFingerprint,
        submission.semanticLayerAddress,
        submission.payloadHash,
        submission.postingId ?? null,
        submission.txHash ?? null,
        submission.metadata === undefined ? null : stableJson(submission.metadata),
        submission.timestamp,
        submission.receiptId,
        stableJson(submission)
      );
  }

  getSubmissionByIdempotencyKey(idempotencyKey: string): StoredSubmissionV1 | undefined {
    const row = this.database
      .prepare('SELECT submission_json FROM submissions WHERE idempotency_key = ?')
      .get(idempotencyKey) as { submission_json: string } | undefined;
    return row === undefined ? undefined : parseJson<StoredSubmissionV1>(row.submission_json);
  }

  listSubmissions(input: { semanticLayerAddress?: string } = {}): StoredSubmissionV1[] {
    const rows = input.semanticLayerAddress === undefined
      ? (this.database
          .prepare('SELECT submission_json FROM submissions ORDER BY ordinal')
          .all() as Array<{ submission_json: string }>)
      : (this.database
          .prepare(
            'SELECT submission_json FROM submissions WHERE semantic_layer_address = ? ORDER BY ordinal'
          )
          .all(input.semanticLayerAddress) as Array<{ submission_json: string }>);
    return rows.map((row) => parseJson<StoredSubmissionV1>(row.submission_json));
  }

  saveReceipt(receipt: VerifierReceiptV1): void {
    const existing = this.getReceiptById(receipt.receiptId);
    if (existing !== undefined) {
      if (stableJson(existing) !== stableJson(receipt)) {
        throw new ReferenceVerifierRepositoryConflictError(
          `receipt ${receipt.receiptId} has conflicting contents`
        );
      }
      return;
    }
    this.database
      .prepare(
        `INSERT INTO receipts (
          receipt_id,
          semantic_layer_address,
          registration_hash,
          payload_hash,
          sequence,
          verdict,
          checkpoint_id,
          timestamp,
          receipt_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        receipt.receiptId,
        receipt.semanticLayerAddress,
        receipt.registrationHash ?? null,
        receipt.payloadHash,
        receipt.sequence,
        receipt.verdict,
        receipt.checkpointId ?? null,
        receipt.timestamp,
        stableJson(receipt)
      );
  }

  getReceiptById(receiptId: string): VerifierReceiptV1 | undefined {
    const row = this.database
      .prepare('SELECT receipt_json FROM receipts WHERE receipt_id = ?')
      .get(receiptId) as { receipt_json: string } | undefined;
    return row === undefined ? undefined : parseJson<VerifierReceiptV1>(row.receipt_json);
  }

  getReceiptByPayloadHash(
    payloadHash: string,
    input: { semanticLayerAddress?: string } = {}
  ): VerifierReceiptV1 | undefined {
    const row = input.semanticLayerAddress === undefined
      ? (this.database
          .prepare(
            `SELECT receipt_json FROM receipts
             WHERE payload_hash = ?
             ORDER BY CASE verdict WHEN 'accepted' THEN 0 ELSE 1 END, ordinal DESC
             LIMIT 1`
          )
          .get(payloadHash) as { receipt_json: string } | undefined)
      : (this.database
          .prepare(
            `SELECT receipt_json FROM receipts
             WHERE payload_hash = ? AND semantic_layer_address = ?
             ORDER BY CASE verdict WHEN 'accepted' THEN 0 ELSE 1 END, ordinal DESC
             LIMIT 1`
          )
          .get(payloadHash, input.semanticLayerAddress) as { receipt_json: string } | undefined);
    return row === undefined ? undefined : parseJson<VerifierReceiptV1>(row.receipt_json);
  }

  getAcceptedReceipt(input: {
    semanticLayerAddress: string;
    registrationHash: string;
    payloadHash: string;
  }): VerifierReceiptV1 | undefined {
    const row = this.database
      .prepare(
        `SELECT receipt_json FROM receipts
         WHERE semantic_layer_address = ?
           AND registration_hash = ?
           AND payload_hash = ?
           AND verdict = 'accepted'
         ORDER BY ordinal
         LIMIT 1`
      )
      .get(
        input.semanticLayerAddress,
        input.registrationHash,
        input.payloadHash
      ) as { receipt_json: string } | undefined;
    return row === undefined ? undefined : parseJson<VerifierReceiptV1>(row.receipt_json);
  }

  listReceipts(input: { semanticLayerAddress?: string } = {}): VerifierReceiptV1[] {
    const rows = input.semanticLayerAddress === undefined
      ? (this.database
          .prepare('SELECT receipt_json FROM receipts ORDER BY ordinal')
          .all() as Array<{ receipt_json: string }>)
      : (this.database
          .prepare(
            'SELECT receipt_json FROM receipts WHERE semantic_layer_address = ? ORDER BY ordinal'
          )
          .all(input.semanticLayerAddress) as Array<{ receipt_json: string }>);
    return rows.map((row) => parseJson<VerifierReceiptV1>(row.receipt_json));
  }

  saveCheckpoint(checkpoint: StoredCheckpointV1): void {
    const existing = this.getCheckpoint(checkpoint.checkpointId);
    if (existing !== undefined) {
      if (stableJson(existing) !== stableJson(checkpoint)) {
        throw new ReferenceVerifierRepositoryConflictError(
          `checkpoint ${checkpoint.checkpointId} has conflicting contents`
        );
      }
      return;
    }
    this.database
      .prepare(
        `INSERT INTO checkpoints (
          checkpoint_id,
          semantic_layer_address,
          registration_hash,
          sequence,
          payload_hash,
          state_root_before,
          state_root_after,
          receipt_id,
          previous_checkpoint_id,
          timestamp,
          checkpoint_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        checkpoint.checkpointId,
        checkpoint.semanticLayerAddress,
        checkpoint.registrationHash,
        checkpoint.sequence,
        checkpoint.payloadHash,
        checkpoint.stateRootBefore,
        checkpoint.stateRootAfter,
        checkpoint.receiptId,
        checkpoint.previousCheckpointId ?? null,
        checkpoint.timestamp,
        stableJson(checkpoint)
      );
  }

  getCheckpoint(checkpointId: string): StoredCheckpointV1 | undefined {
    const row = this.database
      .prepare('SELECT checkpoint_json FROM checkpoints WHERE checkpoint_id = ?')
      .get(checkpointId) as { checkpoint_json: string } | undefined;
    return row === undefined ? undefined : parseJson<StoredCheckpointV1>(row.checkpoint_json);
  }

  private applyMigrations(): void {
    this.database.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`
    );
    const row = this.database
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
      .get() as { version: number | bigint };
    const currentVersion = Number(row.version);
    if (currentVersion > REFERENCE_VERIFIER_SQLITE_SCHEMA_VERSION) {
      throw new Error(
        `SQLite schema version ${currentVersion} is newer than supported version ${REFERENCE_VERIFIER_SQLITE_SCHEMA_VERSION}`
      );
    }
    if (currentVersion === 0) this.applyMigrationV1();
  }

  private applyMigrationV1(): void {
    this.transaction(() => {
      this.database.exec(
        `CREATE TABLE registration_versions (
          registration_hash TEXT PRIMARY KEY,
          semantic_layer_address TEXT NOT NULL,
          legacy_sl_id TEXT,
          registration_json TEXT NOT NULL,
          is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
          registered_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX registration_versions_one_active_address
          ON registration_versions (semantic_layer_address)
          WHERE is_active = 1;
        CREATE UNIQUE INDEX registration_versions_one_active_legacy_sl_id
          ON registration_versions (legacy_sl_id)
          WHERE is_active = 1 AND legacy_sl_id IS NOT NULL;

        CREATE TABLE semantic_layer_heads (
          semantic_layer_address TEXT PRIMARY KEY,
          registration_hash TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence >= 0),
          state_root TEXT NOT NULL,
          checkpoint_id TEXT,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (registration_hash) REFERENCES registration_versions (registration_hash)
        );

        CREATE TABLE payloads (
          payload_hash TEXT PRIMARY KEY,
          payload_bytes BLOB NOT NULL,
          payload_size INTEGER NOT NULL CHECK (payload_size >= 0)
        );

        CREATE TABLE receipts (
          ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
          receipt_id TEXT NOT NULL UNIQUE,
          semantic_layer_address TEXT NOT NULL,
          registration_hash TEXT,
          payload_hash TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          verdict TEXT NOT NULL CHECK (verdict IN ('accepted', 'rejected')),
          checkpoint_id TEXT UNIQUE,
          timestamp TEXT NOT NULL,
          receipt_json TEXT NOT NULL
        );
        CREATE INDEX receipts_by_layer ON receipts (semantic_layer_address, ordinal);
        CREATE INDEX receipts_by_payload ON receipts (payload_hash, ordinal);
        CREATE UNIQUE INDEX receipts_one_accepted_payload
          ON receipts (semantic_layer_address, registration_hash, payload_hash)
          WHERE verdict = 'accepted';

        CREATE TABLE submissions (
          ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
          submission_id TEXT NOT NULL UNIQUE,
          idempotency_key TEXT UNIQUE,
          request_fingerprint TEXT NOT NULL,
          semantic_layer_address TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          posting_id TEXT,
          tx_hash TEXT,
          metadata_json TEXT,
          timestamp TEXT NOT NULL,
          receipt_id TEXT NOT NULL,
          submission_json TEXT NOT NULL,
          FOREIGN KEY (receipt_id) REFERENCES receipts (receipt_id)
        );
        CREATE INDEX submissions_by_layer ON submissions (semantic_layer_address, ordinal);
        CREATE INDEX submissions_by_payload ON submissions (payload_hash, ordinal);

        CREATE TABLE checkpoints (
          checkpoint_id TEXT PRIMARY KEY,
          semantic_layer_address TEXT NOT NULL,
          registration_hash TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          payload_hash TEXT NOT NULL,
          state_root_before TEXT NOT NULL,
          state_root_after TEXT NOT NULL,
          receipt_id TEXT NOT NULL UNIQUE,
          previous_checkpoint_id TEXT,
          timestamp TEXT NOT NULL,
          checkpoint_json TEXT NOT NULL,
          UNIQUE (semantic_layer_address, sequence),
          FOREIGN KEY (registration_hash) REFERENCES registration_versions (registration_hash),
          FOREIGN KEY (receipt_id) REFERENCES receipts (receipt_id),
          FOREIGN KEY (previous_checkpoint_id) REFERENCES checkpoints (checkpoint_id)
        );

        INSERT INTO schema_migrations (version, applied_at)
        VALUES (1, '${new Date().toISOString()}')`
      );
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SQLite verifier repository is closed');
  }
}

type RegistrationVersionIdentityRow = {
  registration_json: string;
  is_active: number | bigint;
};

type RegistrationVersionRow = RegistrationVersionIdentityRow & {
  registration_hash: string;
  registered_at: string;
};

type SemanticLayerRow = {
  registration_hash: string;
  registration_json: string;
  registered_at: string;
  sequence: number | bigint;
  state_root: string;
  checkpoint_id: string | null;
};

type PayloadRow = {
  payload_hash: string;
  payload_bytes: Uint8Array;
  payload_size: number | bigint;
};

function semanticLayerFromRow(row: SemanticLayerRow): StoredSemanticLayerV1 {
  return {
    registration: parseJson<SemanticLayerRegistrationV1>(row.registration_json),
    registrationHash: row.registration_hash,
    sequence: Number(row.sequence),
    stateRoot: row.state_root,
    checkpointId: row.checkpoint_id ?? undefined,
    registeredAt: row.registered_at
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)])
    );
  }
  return value;
}
