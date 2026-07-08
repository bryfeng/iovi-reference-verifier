import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeSemanticLayerTransition } from '@bryaniovi/sldk';
import {
  CONTRACT_VERSION_V1,
  VERIFIER_RECEIPT_V1_FORMAT,
  ZERO_HASH,
  semanticLayerManifestV1Hash
} from '../dist/index.js';
import { IoviReferenceVerifier, startReferenceVerifierServer } from '../dist/index.js';

test('IoviReferenceVerifier accepts a valid SLDK semantic-layer payload and emits a receipt', () => {
  const manifest = sampleManifest();
  const verifier = new IoviReferenceVerifier({ manifest });
  const payload = samplePayload({ sequence: 1, prevStateHash: ZERO_HASH, newStateHash: hash('12') });

  const receipt = verifier.verifyPayload({
    payloadHex: payload.payloadHex,
    payloadHash: payload.payloadHash,
    txHash: hash('ab'),
    postingId: 'posting-1',
    timestamp: '2026-07-08T00:00:00.000Z'
  });

  assert.equal(receipt.verdict, 'accepted');
  assert.equal(receipt.slId, manifest.slId);
  assert.equal(receipt.payloadHash, payload.payloadHash);
  assert.equal(receipt.manifestHash, semanticLayerManifestV1Hash(manifest));
  assert.equal(receipt.stateRootBefore, ZERO_HASH);
  assert.equal(receipt.stateRootAfter, hash('12'));
  assert.equal(verifier.getState().sequence, 1);
  assert.equal(verifier.getState().stateRoot, hash('12'));
});

test('IoviReferenceVerifier rejects sequence and previous-state mismatches without advancing state', () => {
  const verifier = new IoviReferenceVerifier({ manifest: sampleManifest() });
  const first = verifier.verifyPayload({
    payloadHex: samplePayload({ sequence: 1, prevStateHash: ZERO_HASH, newStateHash: hash('12') }).payloadHex
  });
  assert.equal(first.verdict, 'accepted');

  const badSequence = samplePayload({ sequence: 3, prevStateHash: hash('12'), newStateHash: hash('13') });
  const badReceipt = verifier.verifyPayload({ payloadHex: badSequence.payloadHex });

  assert.equal(badReceipt.verdict, 'rejected');
  assert.match(badReceipt.reason, /sequence mismatch/);
  assert.equal(verifier.getState().sequence, 1);
  assert.equal(verifier.getState().stateRoot, hash('12'));

  const badPrev = samplePayload({ sequence: 2, prevStateHash: ZERO_HASH, newStateHash: hash('14') });
  const badPrevReceipt = verifier.verifyPayload({ payloadHex: badPrev.payloadHex });
  assert.equal(badPrevReceipt.verdict, 'rejected');
  assert.match(badPrevReceipt.reason, /prevStateHash mismatch/);
  assert.equal(verifier.getState().sequence, 1);
});

test('IoviReferenceVerifier can verify data-bearing UTXO rows', () => {
  const verifier = new IoviReferenceVerifier({ manifest: sampleManifest() });
  const payload = samplePayload({ sequence: 1, prevStateHash: ZERO_HASH, newStateHash: hash('44') });
  const receipts = verifier.verifyUtxos([
    { id: 'empty', amount: 99, data: [] },
    { id: 'data-utxo', amount: payload.dataLen, data: payload.dataScalars, txHash: hash('45') }
  ]);

  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].verdict, 'accepted');
  assert.equal(receipts[0].postingId, 'data-utxo');
});

test('reference verifier HTTP server exposes manifest, state, receipts, and verify route', async () => {
  const verifier = new IoviReferenceVerifier({ manifest: sampleManifest() });
  const server = await startReferenceVerifierServer(verifier);
  try {
    const manifestResponse = await fetch(`${server.url}/manifest`);
    assert.equal(manifestResponse.status, 200);
    assert.equal((await manifestResponse.json()).slId, '00010001');

    const payload = samplePayload({ sequence: 1, prevStateHash: ZERO_HASH, newStateHash: hash('55') });
    const verifyResponse = await fetch(`${server.url}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payloadHex: payload.payloadHex,
        payloadHash: payload.payloadHash
      })
    });
    assert.equal(verifyResponse.status, 200);
    const receipt = await verifyResponse.json();
    assert.equal(receipt.verdict, 'accepted');

    const receiptResponse = await fetch(`${server.url}/receipts/${encodeURIComponent(payload.payloadHash)}`);
    assert.equal(receiptResponse.status, 200);
    assert.equal((await receiptResponse.json()).payloadHash, payload.payloadHash);

    const stateResponse = await fetch(`${server.url}/checkpoints/latest`);
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.sequence, 1);
    assert.equal(state.stateRoot, hash('55'));
  } finally {
    await server.close();
  }
});

function samplePayload({ sequence, prevStateHash, newStateHash }) {
  return encodeSemanticLayerTransition({
    slId: '00010001',
    sequence,
    prevStateHash,
    newStateHash,
    actions: [
      {
        amount: 100,
        to: 'reference-verifier-recipient',
        type: 'mint'
      }
    ]
  });
}

function sampleManifest() {
  return {
    manifestVersion: CONTRACT_VERSION_V1,
    slId: '00010001',
    name: 'IOVI Demo Asset Layer',
    version: '1.0.0',
    ioviApi: 'https://iovi-api-production.up.railway.app',
    payloadCodec: 'iovi-payload-v1',
    schemas: {
      mint: 'https://iovi.dev/schemas/demo-mint.schema.json'
    },
    publication: {
      accountRegistrationRoute: '/v1/base-layer/accounts',
      preparePostingRoute: '/v1/semantic-payloads/prepare-posting',
      postingRoute: '/v1/base-layer/postings'
    },
    transitionFunction: {
      type: 'builtin',
      name: 'declared-state-root-v1',
      version: '1.0.0'
    },
    verifiers: [
      {
        name: 'IOVI Reference Verifier',
        endpoint: 'http://127.0.0.1:0',
        verifierId: 'did:key:iovi-reference-verifier',
        receiptFormat: VERIFIER_RECEIPT_V1_FORMAT
      }
    ],
    checkpointPolicy: {
      type: 'single',
      requiredVerifiers: 1
    }
  };
}

function hash(byte) {
  return `0x${byte.repeat(32)}`;
}
