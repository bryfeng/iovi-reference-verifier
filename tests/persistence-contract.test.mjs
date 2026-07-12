import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeSemanticLayerTransition } from '@bryaniovi/sldk';
import {
  IoviReferenceVerifier,
  ReferenceVerifierIdempotencyConflictError,
  ReferenceVerifierRepositoryConflictError,
  ZERO_HASH,
  buildSemanticLayerRegistration
} from '../dist/index.js';

const LAYER_ADDRESS = `0x${'aa'.repeat(32)}`;
const LEGACY_SL_ID = '00010001';

test('an accepted duplicate returns the canonical receipt without advancing state', () => {
  const verifier = verifierWithRegistration();
  const payload = samplePayload({
    sequence: 1,
    prevStateHash: ZERO_HASH,
    newStateHash: hash('11')
  });

  const accepted = verifier.verifyPayload({
    payloadHex: payload.payloadHex,
    idempotencyKey: 'accepted-first',
    timestamp: '2026-07-12T00:00:00.000Z'
  });
  const duplicate = verifier.verifyPayload({
    payloadHex: payload.payloadHex,
    idempotencyKey: 'accepted-second-source',
    timestamp: '2026-07-12T00:00:01.000Z'
  });

  assert.equal(accepted.verdict, 'accepted');
  assert.match(accepted.receiptId, /^0x[0-9a-f]{64}$/);
  assert.match(accepted.checkpointId, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(duplicate, accepted);
  assert.equal(verifier.listReceipts().length, 1);
  assert.equal(verifier.listSubmissions().length, 2);
  assert.deepEqual(verifier.getState(LAYER_ADDRESS), {
    semanticLayerAddress: LAYER_ADDRESS,
    legacySlId: LEGACY_SL_ID,
    registrationHash: accepted.registrationHash,
    sequence: 1,
    stateRoot: hash('11'),
    checkpointId: accepted.checkpointId
  });
});

test('a rejected attempt remains auditable without replacing the accepted checkpoint', () => {
  const verifier = verifierWithRegistration();
  const acceptedPayload = samplePayload({
    sequence: 1,
    prevStateHash: ZERO_HASH,
    newStateHash: hash('11')
  });
  const accepted = verifier.verifyPayload({
    payloadHex: acceptedPayload.payloadHex,
    idempotencyKey: 'accepted',
    timestamp: '2026-07-12T00:00:00.000Z'
  });
  const invalidPayload = samplePayload({
    sequence: 3,
    prevStateHash: hash('11'),
    newStateHash: hash('33')
  });
  const rejected = verifier.verifyPayload({
    payloadHex: invalidPayload.payloadHex,
    idempotencyKey: 'rejected',
    timestamp: '2026-07-12T00:00:01.000Z'
  });

  assert.equal(rejected.verdict, 'rejected');
  assert.equal(rejected.checkpointId, undefined);
  assert.match(rejected.receiptId, /^0x[0-9a-f]{64}$/);
  assert.match(rejected.reason, /sequence mismatch/);
  assert.equal(verifier.getState(LAYER_ADDRESS).checkpointId, accepted.checkpointId);
  assert.equal(verifier.getState(LAYER_ADDRESS).sequence, 1);
  assert.equal(verifier.listReceipts().length, 2);
});

test('a state-dependent rejection can be reevaluated after the accepted head changes', () => {
  const verifier = verifierWithRegistration();
  const secondPayload = samplePayload({
    sequence: 2,
    prevStateHash: hash('11'),
    newStateHash: hash('22')
  });
  const early = verifier.verifyPayload({
    payloadHex: secondPayload.payloadHex,
    idempotencyKey: 'second-too-early',
    timestamp: '2026-07-12T00:00:00.000Z'
  });
  assert.equal(early.verdict, 'rejected');

  const firstPayload = samplePayload({
    sequence: 1,
    prevStateHash: ZERO_HASH,
    newStateHash: hash('11')
  });
  assert.equal(
    verifier.verifyPayload({
      payloadHex: firstPayload.payloadHex,
      idempotencyKey: 'first',
      timestamp: '2026-07-12T00:00:01.000Z'
    }).verdict,
    'accepted'
  );
  const acceptedSecond = verifier.verifyPayload({
    payloadHex: secondPayload.payloadHex,
    idempotencyKey: 'second-after-first',
    timestamp: '2026-07-12T00:00:02.000Z'
  });

  assert.equal(acceptedSecond.verdict, 'accepted');
  assert.equal(acceptedSecond.sequence, 2);
  assert.equal(verifier.getState(LAYER_ADDRESS).stateRoot, hash('22'));
  assert.equal(verifier.listReceipts().length, 3);
});

test('an idempotency key cannot be reused for different verifier input', () => {
  const verifier = verifierWithRegistration();
  const firstPayload = samplePayload({
    sequence: 1,
    prevStateHash: ZERO_HASH,
    newStateHash: hash('11')
  });
  verifier.verifyPayload({
    payloadHex: firstPayload.payloadHex,
    idempotencyKey: 'same-key',
    timestamp: '2026-07-12T00:00:00.000Z'
  });

  assert.throws(
    () =>
      verifier.verifyPayload({
        payloadHex: samplePayload({
          sequence: 2,
          prevStateHash: hash('11'),
          newStateHash: hash('22')
        }).payloadHex,
        idempotencyKey: 'same-key',
        timestamp: '2026-07-12T00:00:01.000Z'
      }),
    (error) =>
      error instanceof ReferenceVerifierIdempotencyConflictError &&
      error.code === 'VERIFIER_IDEMPOTENCY_CONFLICT'
  );
  assert.equal(verifier.listReceipts().length, 1);
  assert.equal(verifier.getState(LAYER_ADDRESS).sequence, 1);
});

test('active registrations are immutable and exact registration retries are idempotent', () => {
  const registration = sampleRegistration();
  const verifier = new IoviReferenceVerifier();
  verifier.registerSemanticLayer(registration, {
    registeredAt: '2026-07-12T00:00:00.000Z'
  });
  assert.deepEqual(verifier.registerSemanticLayer(registration), registration);
  assert.equal(verifier.listRegistrationVersions(LAYER_ADDRESS).length, 1);

  assert.throws(
    () =>
      verifier.registerSemanticLayer({
        ...registration,
        name: 'Conflicting registration'
      }),
    (error) =>
      error instanceof ReferenceVerifierRepositoryConflictError &&
      error.code === 'VERIFIER_REPOSITORY_CONFLICT'
  );
  assert.equal(verifier.getRegistration(LAYER_ADDRESS).name, registration.name);
});

function verifierWithRegistration() {
  const verifier = new IoviReferenceVerifier();
  verifier.registerSemanticLayer(sampleRegistration(), {
    registeredAt: '2026-07-12T00:00:00.000Z'
  });
  return verifier;
}

function sampleRegistration() {
  return buildSemanticLayerRegistration({
    semanticLayerAddress: LAYER_ADDRESS,
    legacySlId: LEGACY_SL_ID,
    name: 'Persistence Contract Layer',
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
    actions: [{ type: 'persistence-contract-test', sequence }]
  });
}

function hash(byte) {
  return `0x${byte.repeat(32)}`;
}
