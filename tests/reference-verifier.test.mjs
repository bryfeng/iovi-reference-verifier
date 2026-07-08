import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeSemanticLayerTransition } from '@bryaniovi/sldk';
import {
  CONTRACT_VERSION_V1,
  IoviReferenceVerifier,
  SEMANTIC_LAYER_REGISTRATION_V1_FORMAT,
  VERIFIER_RECEIPT_V1_FORMAT,
  ZERO_HASH,
  buildSemanticLayerRegistration,
  semanticLayerManifestV1Hash,
  semanticLayerRegistrationV1Hash,
  startReferenceVerifierServer
} from '../dist/index.js';

const LAYER_A_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LAYER_B_ADDRESS = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const LAYER_A_SLID = '00010001';
const LAYER_B_SLID = '00010002';

test('IoviReferenceVerifier registers a semantic-layer address and emits an accepted receipt', () => {
  const registration = sampleRegistration();
  const verifier = new IoviReferenceVerifier({ registrations: [registration] });
  const payload = samplePayload({ slId: LAYER_A_SLID, sequence: 1, prevStateHash: ZERO_HASH, newStateHash: hash('12') });

  const receipt = verifier.verifyPayload({
    payloadHex: payload.payloadHex,
    payloadHash: payload.payloadHash,
    txHash: hash('ab'),
    postingId: 'posting-1',
    timestamp: '2026-07-08T00:00:00.000Z'
  });

  assert.equal(receipt.verdict, 'accepted');
  assert.equal(receipt.semanticLayerAddress, LAYER_A_ADDRESS);
  assert.equal(receipt.slId, `0x${LAYER_A_SLID}`);
  assert.equal(receipt.payloadHash, payload.payloadHash);
  assert.equal(receipt.registrationHash, semanticLayerRegistrationV1Hash(registration));
  assert.equal(receipt.manifestHash, undefined);
  assert.equal(receipt.stateRootBefore, ZERO_HASH);
  assert.equal(receipt.stateRootAfter, hash('12'));
  assert.equal(verifier.getState(LAYER_A_ADDRESS).sequence, 1);
  assert.equal(verifier.getState(LAYER_A_ADDRESS).stateRoot, hash('12'));
});

test('IoviReferenceVerifier rejects unregistered semantic layers without advancing registered state', () => {
  const verifier = new IoviReferenceVerifier({ registrations: [sampleRegistration()] });
  const unregistered = samplePayload({
    slId: LAYER_B_SLID,
    sequence: 1,
    prevStateHash: ZERO_HASH,
    newStateHash: hash('13')
  });

  const receipt = verifier.verifyPayload({ payloadHex: unregistered.payloadHex });

  assert.equal(receipt.verdict, 'rejected');
  assert.match(receipt.reason, /not registered/);
  assert.equal(receipt.semanticLayerAddress, `unregistered-sl:${LAYER_B_SLID}`);
  assert.equal(verifier.getState(LAYER_A_ADDRESS).sequence, 0);
});

test('IoviReferenceVerifier keeps independent state for multiple registered semantic layers', () => {
  const verifier = new IoviReferenceVerifier({
    registrations: [
      sampleRegistration({ semanticLayerAddress: LAYER_A_ADDRESS, legacySlId: LAYER_A_SLID }),
      sampleRegistration({ semanticLayerAddress: LAYER_B_ADDRESS, legacySlId: LAYER_B_SLID })
    ]
  });

  const layerA = samplePayload({ slId: LAYER_A_SLID, sequence: 1, prevStateHash: ZERO_HASH, newStateHash: hash('21') });
  const layerB = samplePayload({ slId: LAYER_B_SLID, sequence: 1, prevStateHash: ZERO_HASH, newStateHash: hash('31') });

  assert.equal(verifier.verifyPayload({ payloadHex: layerA.payloadHex }).verdict, 'accepted');
  assert.equal(verifier.verifyPayload({ payloadHex: layerB.payloadHex }).verdict, 'accepted');

  assert.equal(verifier.getState(LAYER_A_ADDRESS).stateRoot, hash('21'));
  assert.equal(verifier.getState(LAYER_B_ADDRESS).stateRoot, hash('31'));
  assert.equal(verifier.listStates().length, 2);
});

test('IoviReferenceVerifier rejects sequence and previous-state mismatches per semantic-layer registration', () => {
  const verifier = new IoviReferenceVerifier({ registrations: [sampleRegistration()] });
  const first = verifier.verifyPayload({
    payloadHex: samplePayload({ slId: LAYER_A_SLID, sequence: 1, prevStateHash: ZERO_HASH, newStateHash: hash('12') })
      .payloadHex
  });
  assert.equal(first.verdict, 'accepted');

  const badSequence = samplePayload({ slId: LAYER_A_SLID, sequence: 3, prevStateHash: hash('12'), newStateHash: hash('13') });
  const badReceipt = verifier.verifyPayload({ payloadHex: badSequence.payloadHex });

  assert.equal(badReceipt.verdict, 'rejected');
  assert.match(badReceipt.reason, /sequence mismatch/);
  assert.equal(verifier.getState(LAYER_A_ADDRESS).sequence, 1);
  assert.equal(verifier.getState(LAYER_A_ADDRESS).stateRoot, hash('12'));

  const badPrev = samplePayload({ slId: LAYER_A_SLID, sequence: 2, prevStateHash: ZERO_HASH, newStateHash: hash('14') });
  const badPrevReceipt = verifier.verifyPayload({ payloadHex: badPrev.payloadHex });
  assert.equal(badPrevReceipt.verdict, 'rejected');
  assert.match(badPrevReceipt.reason, /prevStateHash mismatch/);
  assert.equal(verifier.getState(LAYER_A_ADDRESS).sequence, 1);
});

test('IoviReferenceVerifier can verify data-bearing UTXO rows through registered legacy slId routing', () => {
  const verifier = new IoviReferenceVerifier({ registrations: [sampleRegistration()] });
  const payload = samplePayload({ slId: LAYER_A_SLID, sequence: 1, prevStateHash: ZERO_HASH, newStateHash: hash('44') });
  const receipts = verifier.verifyUtxos([
    { id: 'empty', amount: 99, data: [] },
    { id: 'data-utxo', amount: payload.dataLen, data: payload.dataScalars, txHash: hash('45') }
  ]);

  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].verdict, 'accepted');
  assert.equal(receipts[0].postingId, 'data-utxo');
  assert.equal(receipts[0].semanticLayerAddress, LAYER_A_ADDRESS);
});

test('reference verifier HTTP server exposes registration, state, receipts, and verify route', async () => {
  const verifier = new IoviReferenceVerifier();
  const server = await startReferenceVerifierServer(verifier);
  try {
    const registrationResponse = await fetch(`${server.url}/registrations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sampleRegistration())
    });
    assert.equal(registrationResponse.status, 201);
    assert.equal((await registrationResponse.json()).semanticLayerAddress, LAYER_A_ADDRESS);

    const listResponse = await fetch(`${server.url}/registrations`);
    assert.equal(listResponse.status, 200);
    assert.equal((await listResponse.json()).registrations.length, 1);

    const payload = samplePayload({ slId: LAYER_A_SLID, sequence: 1, prevStateHash: ZERO_HASH, newStateHash: hash('55') });
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
    assert.equal(receipt.semanticLayerAddress, LAYER_A_ADDRESS);

    const receiptResponse = await fetch(`${server.url}/receipts/${encodeURIComponent(payload.payloadHash)}`);
    assert.equal(receiptResponse.status, 200);
    assert.equal((await receiptResponse.json()).payloadHash, payload.payloadHash);

    const stateResponse = await fetch(`${server.url}/semantic-layers/${encodeURIComponent(LAYER_A_ADDRESS)}/state`);
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.sequence, 1);
    assert.equal(state.stateRoot, hash('55'));
  } finally {
    await server.close();
  }
});

test('manifest compatibility remains optional and attaches manifestHash to receipts', async () => {
  const manifest = sampleManifest();
  const verifier = new IoviReferenceVerifier({ manifest, semanticLayerAddress: LAYER_A_ADDRESS });
  const payload = samplePayload({ slId: LAYER_A_SLID, sequence: 1, prevStateHash: ZERO_HASH, newStateHash: hash('66') });

  const receipt = verifier.verifyPayload({ payloadHex: payload.payloadHex });

  assert.equal(receipt.verdict, 'accepted');
  assert.equal(receipt.semanticLayerAddress, LAYER_A_ADDRESS);
  assert.equal(receipt.manifestHash, semanticLayerManifestV1Hash(manifest));

  const server = await startReferenceVerifierServer(verifier);
  try {
    const manifestResponse = await fetch(`${server.url}/semantic-layers/${encodeURIComponent(LAYER_A_ADDRESS)}/manifest`);
    assert.equal(manifestResponse.status, 200);
    assert.equal((await manifestResponse.json()).slId, LAYER_A_SLID);
  } finally {
    await server.close();
  }
});

function samplePayload({ slId, sequence, prevStateHash, newStateHash }) {
  return encodeSemanticLayerTransition({
    slId,
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

function sampleRegistration(input = {}) {
  return buildSemanticLayerRegistration({
    semanticLayerAddress: input.semanticLayerAddress ?? LAYER_A_ADDRESS,
    name: input.name ?? 'IOVI Demo Asset Layer',
    codec: input.codec ?? 'iovi-payload-v1',
    proofStandard: input.proofStandard ?? 'declared-state-root',
    legacySlId: input.legacySlId ?? LAYER_A_SLID,
    publisherAddress: input.publisherAddress ?? input.semanticLayerAddress ?? LAYER_A_ADDRESS,
    registrationTxHash: input.registrationTxHash,
    registrationUtxoId: input.registrationUtxoId ?? 'utxo-registration-demo',
    signature: input.signature ?? referenceRegistrationSignature({
      registrationFormat: SEMANTIC_LAYER_REGISTRATION_V1_FORMAT,
      semanticLayerAddress: input.semanticLayerAddress ?? LAYER_A_ADDRESS,
      legacySlId: input.legacySlId ?? LAYER_A_SLID
    })
  });
}

function sampleManifest() {
  return {
    manifestVersion: CONTRACT_VERSION_V1,
    slId: LAYER_A_SLID,
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
      name: 'declared-state-root',
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

function referenceRegistrationSignature(value) {
  return `reference:${JSON.stringify(value)}`;
}

function hash(byte) {
  return `0x${byte.repeat(32)}`;
}
