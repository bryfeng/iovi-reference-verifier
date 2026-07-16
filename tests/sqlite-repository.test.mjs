import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeSemanticLayerTransition } from '@bryaniovi/sldk';
import {
  IoviReferenceVerifier,
  ZERO_HASH,
  buildSemanticLayerRegistration,
  startReferenceVerifierServer
} from '../dist/index.js';
import {
  REFERENCE_VERIFIER_SQLITE_SCHEMA_VERSION,
  SqliteReferenceVerifierRepository
} from '../dist/sqlite.js';

const LAYER_ADDRESS = `0x${'bb'.repeat(32)}`;
const LEGACY_SL_ID = '00010002';

test('SQLite restores registration, accepted head, receipts, submissions, and payload bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'iovi-verifier-sqlite-'));
  const databasePath = join(directory, 'verifier.sqlite');
  try {
    const firstRepository = new SqliteReferenceVerifierRepository(databasePath);
    const firstVerifier = new IoviReferenceVerifier({
      verifierId: 'sqlite-reference-verifier',
      repository: firstRepository
    });
    firstVerifier.registerSemanticLayer(sampleRegistration(), {
      registeredAt: '2026-07-12T00:00:00.000Z'
    });
    const payload = samplePayload({
      sequence: 1,
      prevStateHash: ZERO_HASH,
      newStateHash: hash('11')
    });
    const accepted = firstVerifier.verifyPayload({
      payloadHex: payload.payloadHex,
      idempotencyKey: 'sqlite-first',
      postingId: 'posting-sqlite-1',
      timestamp: '2026-07-12T00:00:01.000Z'
    });
    const stateBeforeClose = firstVerifier.getState(LAYER_ADDRESS);
    const recordsBeforeClose = await readStoredHttpRecords(
      firstVerifier,
      payload.payloadHash,
      accepted.checkpointId
    );
    assert.deepEqual(firstVerifier.getState(LAYER_ADDRESS), stateBeforeClose);
    firstVerifier.close();

    const secondRepository = new SqliteReferenceVerifierRepository(databasePath);
    const secondVerifier = new IoviReferenceVerifier({
      verifierId: 'sqlite-reference-verifier',
      repository: secondRepository
    });
    assert.deepEqual(secondVerifier.getState(LAYER_ADDRESS), stateBeforeClose);
    assert.deepEqual(secondVerifier.getReceiptById(accepted.receiptId), accepted);
    assert.deepEqual(
      await readStoredHttpRecords(secondVerifier, payload.payloadHash, accepted.checkpointId),
      recordsBeforeClose
    );
    assert.deepEqual(secondRepository.getPayload(payload.payloadHash), {
      payloadHash: payload.payloadHash,
      payloadHex: payload.payloadHex,
      payloadSize: payload.payloadSize
    });
    assert.equal(secondVerifier.listRegistrationVersions(LAYER_ADDRESS).length, 1);

    const duplicate = secondVerifier.verifyPayload({
      payloadHex: payload.payloadHex,
      idempotencyKey: 'sqlite-second-source',
      postingId: 'posting-sqlite-duplicate',
      timestamp: '2026-07-12T00:00:02.000Z'
    });
    assert.deepEqual(duplicate, accepted);
    assert.equal(secondVerifier.listReceipts().length, 1);
    assert.equal(secondVerifier.listSubmissions().length, 2);

    const rejected = secondVerifier.verifyPayload({
      payloadHex: samplePayload({
        sequence: 3,
        prevStateHash: hash('11'),
        newStateHash: hash('33')
      }).payloadHex,
      idempotencyKey: 'sqlite-rejected',
      timestamp: '2026-07-12T00:00:03.000Z'
    });
    assert.equal(rejected.verdict, 'rejected');
    assert.equal(rejected.checkpointId, undefined);
    assert.equal(secondVerifier.getState(LAYER_ADDRESS).checkpointId, accepted.checkpointId);
    secondVerifier.close();

    const thirdRepository = new SqliteReferenceVerifierRepository(databasePath);
    const thirdVerifier = new IoviReferenceVerifier({
      verifierId: 'sqlite-reference-verifier',
      repository: thirdRepository
    });
    assert.equal(thirdVerifier.getState(LAYER_ADDRESS).checkpointId, accepted.checkpointId);
    assert.equal(thirdVerifier.listReceipts().length, 2);
    assert.equal(thirdVerifier.listSubmissions().length, 3);
    assert.deepEqual(thirdRepository.getCheckpoint(accepted.checkpointId), {
      checkpointId: accepted.checkpointId,
      semanticLayerAddress: LAYER_ADDRESS,
      registrationHash: accepted.registrationHash,
      sequence: 1,
      payloadHash: accepted.payloadHash,
      stateRootBefore: ZERO_HASH,
      stateRootAfter: hash('11'),
      receiptId: accepted.receiptId,
      timestamp: accepted.timestamp
    });
    thirdVerifier.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function readStoredHttpRecords(verifier, payloadHash, checkpointId) {
  const server = await startReferenceVerifierServer(verifier);
  try {
    const payloadResponse = await fetch(
      `${server.url}/payloads/${encodeURIComponent(payloadHash)}`
    );
    const checkpointResponse = await fetch(
      `${server.url}/checkpoints/by-id/${encodeURIComponent(checkpointId)}`
    );
    return {
      payload: {
        status: payloadResponse.status,
        body: await payloadResponse.text()
      },
      checkpoint: {
        status: checkpointResponse.status,
        body: await checkpointResponse.text()
      }
    };
  } finally {
    await server.close();
  }
}

test('SQLite transactions roll back partial writes', () => {
  const repository = new SqliteReferenceVerifierRepository(':memory:');
  try {
    assert.throws(() =>
      repository.transaction(() => {
        repository.savePayload({
          payloadHash: hash('99'),
          payloadHex: '0x0102',
          payloadSize: 2
        });
        throw new Error('force rollback');
      })
    );
    assert.equal(repository.getPayload(hash('99')), undefined);
  } finally {
    repository.close();
  }
});

test('two verifier instances cannot fork the same accepted sequence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'iovi-verifier-conflict-'));
  const databasePath = join(directory, 'verifier.sqlite');
  try {
    const firstRepository = new SqliteReferenceVerifierRepository(databasePath);
    const firstVerifier = new IoviReferenceVerifier({
      verifierId: 'sqlite-reference-verifier',
      repository: firstRepository
    });
    firstVerifier.registerSemanticLayer(sampleRegistration(), {
      registeredAt: '2026-07-12T00:00:00.000Z'
    });
    const secondRepository = new SqliteReferenceVerifierRepository(databasePath);
    const secondVerifier = new IoviReferenceVerifier({
      verifierId: 'sqlite-reference-verifier',
      repository: secondRepository
    });

    const accepted = firstVerifier.verifyPayload({
      payloadHex: samplePayload({
        sequence: 1,
        prevStateHash: ZERO_HASH,
        newStateHash: hash('11')
      }).payloadHex,
      idempotencyKey: 'first-writer',
      timestamp: '2026-07-12T00:00:01.000Z'
    });
    const conflict = secondVerifier.verifyPayload({
      payloadHex: samplePayload({
        sequence: 1,
        prevStateHash: ZERO_HASH,
        newStateHash: hash('22')
      }).payloadHex,
      idempotencyKey: 'second-writer',
      timestamp: '2026-07-12T00:00:02.000Z'
    });

    assert.equal(accepted.verdict, 'accepted');
    assert.equal(conflict.verdict, 'rejected');
    assert.match(conflict.reason, /sequence mismatch/);
    assert.equal(firstVerifier.getState(LAYER_ADDRESS).stateRoot, hash('11'));
    assert.equal(secondVerifier.getState(LAYER_ADDRESS).stateRoot, hash('11'));
    assert.equal(secondVerifier.getState(LAYER_ADDRESS).checkpointId, accepted.checkpointId);
    firstVerifier.close();
    secondVerifier.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite schema version is explicit', () => {
  assert.equal(REFERENCE_VERIFIER_SQLITE_SCHEMA_VERSION, 1);
});

function sampleRegistration() {
  return buildSemanticLayerRegistration({
    semanticLayerAddress: LAYER_ADDRESS,
    legacySlId: LEGACY_SL_ID,
    name: 'SQLite Persistence Layer',
    codec: 'iovi-payload-v1',
    proofStandard: 'declared-state-root'
  });
}

function samplePayload({ sequence, prevStateHash, newStateHash }) {
  return encodeSemanticLayerTransition({
    slId: LEGACY_SL_ID,
    sequence,
    prevStateHash,
    newStateHash,
    actions: [{ type: 'sqlite-persistence-test', sequence }]
  });
}

function hash(byte) {
  return `0x${byte.repeat(32)}`;
}
