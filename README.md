# IOVI Reference Verifier

Run a local verifier for IOVI semantic-layer payloads.

The Reference Verifier checks that an encoded semantic-layer payload belongs to the expected semantic layer, follows the next valid sequence number, and continues from the previous accepted state root. It returns a Verifier Receipt that your app can store, display, or pass to another system as evidence of the verifier's decision.

Use this repo when you want to:

- test semantic-layer payloads produced by the IOVI SLDK
- run a local verifier while building an app or integration
- expose verifier endpoints that a client, playground, or agent can query
- understand the receipt and checkpoint shape before running a production verifier

## Quick Start

```bash
git clone https://github.com/bryfeng/iovi-reference-verifier.git
cd iovi-reference-verifier
npm install
npm run check
```

Node 22 or newer is expected.

You can also install the current GitHub build into another Node project:

```bash
npm install github:bryfeng/iovi-reference-verifier
```

If your app also needs to create semantic-layer payloads, install the SLDK:

```bash
npm install @bryaniovi/sldk
```

## How It Fits

IOVI separates data publication from semantic verification.

- The SLDK creates local accounts, encodes semantic-layer payloads, and helps post them to EON.
- The IOVI API prepares and relays base-layer postings without receiving private keys.
- A verifier reads posted payloads, applies semantic-layer rules, and emits receipts.

This repo is the verifier side of that flow. It does not sign transactions, relay transactions, hold wallets, or custody private material.

## First Verification

This example creates a manifest, generates a realistic SLDK payload, verifies it, and prints the receipt verdict. It expects both `github:bryfeng/iovi-reference-verifier` and `@bryaniovi/sldk` to be installed.

```js
import { encodeSemanticLayerTransition } from '@bryaniovi/sldk';
import {
  CONTRACT_VERSION_V1,
  IoviReferenceVerifier,
  VERIFIER_RECEIPT_V1_FORMAT,
  ZERO_HASH
} from '@bryaniovi/iovi-reference-verifier';

const manifest = {
  manifestVersion: CONTRACT_VERSION_V1,
  slId: '00010001',
  name: 'Demo Asset Layer',
  version: '1.0.0',
  ioviApi: 'https://iovi-api-production.up.railway.app',
  payloadCodec: 'iovi-payload-v1',
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
      endpoint: 'http://127.0.0.1:8787',
      verifierId: 'did:key:iovi-reference-verifier',
      receiptFormat: VERIFIER_RECEIPT_V1_FORMAT
    }
  ],
  checkpointPolicy: {
    type: 'single',
    requiredVerifiers: 1
  }
};

const payload = encodeSemanticLayerTransition({
  slId: manifest.slId,
  sequence: 1,
  prevStateHash: ZERO_HASH,
  newStateHash: `0x${'11'.repeat(32)}`,
  actions: [
    {
      type: 'mint',
      to: 'demo-user',
      amount: 100
    }
  ]
});

const verifier = new IoviReferenceVerifier({ manifest });
const receipt = verifier.verifyPayload({
  payloadHex: payload.payloadHex,
  payloadHash: payload.payloadHash,
  postingId: 'demo-posting-1',
  txHash: `0x${'22'.repeat(32)}`
});

console.log(receipt.verdict);
console.log(receipt.checkpointId);
```

The first payload is accepted because its sequence is `1` and its previous state root is the zero hash. A second payload must use sequence `2` and the first receipt's `stateRootAfter` as its previous state root.

## Run an HTTP Verifier

Using the same `manifest` object from the first example:

```js
import { IoviReferenceVerifier, startReferenceVerifierServer } from '@bryaniovi/iovi-reference-verifier';

const verifier = new IoviReferenceVerifier({ manifest });
const server = await startReferenceVerifierServer(verifier, { port: 8787 });

console.log(`Verifier listening at ${server.url}`);
```

Routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Readiness check |
| `GET` | `/manifest` | Return the Semantic Layer Manifest |
| `GET` | `/state` | Return current sequence and state root |
| `GET` | `/checkpoints/latest` | Return the latest checkpoint view |
| `GET` | `/receipts` | Return all in-memory receipts |
| `GET` | `/receipts/:payloadHash` | Return one receipt by payload hash |
| `POST` | `/verify` | Verify a payload or EON data scalars |

`POST /verify` accepts either `payloadHex` or `dataScalars`:

```json
{
  "payloadHex": "0x...",
  "dataScalars": ["0000007a"],
  "postingId": "posting-123",
  "txHash": "0x2222222222222222222222222222222222222222222222222222222222222222",
  "payloadHash": "0x...",
  "timestamp": "2026-07-08T00:00:00.000Z",
  "metadata": {
    "source": "base-layer-utxo"
  }
}
```

`dataScalars` should be the EON `Data` scalar array emitted by the SLDK posting flow.

## Core Primitives

### Semantic Layer Manifest

A Semantic Layer Manifest tells clients how one semantic layer is published, verified, and checkpointed.

It includes:

- `slId`: four-byte semantic-layer id
- `ioviApi`: one developer-facing IOVI API URL
- `publication`: the API routes used to register accounts, prepare postings, and relay signed postings
- `transitionFunction`: the rule this verifier applies to payloads
- `verifiers`: verifier endpoints and receipt formats clients should trust
- `checkpointPolicy`: how many verifier receipts are required

The current schema version is represented in code by `SemanticLayerManifestV1`.

### Verifier Receipt

A Verifier Receipt is the portable result of a verifier decision.

It includes:

- `payloadHash`: the encoded payload that was checked
- `postingId`: the application workflow id, when available
- `txHash`: the base-layer transaction id, when available
- `sequence`: the semantic-layer sequence number
- `verdict`: `accepted` or `rejected`
- `stateRootBefore` and `stateRootAfter`: the semantic state transition
- `checkpointId`: the verifier's checkpoint for this decision
- `verifierId` and `signature`: the verifier identity and receipt signature

The current schema version is represented in code by `VerifierReceiptV1`.

## What Your App Should Store

For each semantic-layer posting, store the identifiers that let you reconnect the full path later:

- `postingId`: stable workflow id for the intended posting
- `idempotencyKey`: retry key for prepare and relay calls
- `payloadHash`: content id for the encoded semantic payload
- `txHash`: base-layer transaction id after relay
- `checkpointId`: verifier checkpoint id after verification
- `verdict`: verifier decision

The SLDK should help generate stable operation ids. APIs still need to enforce idempotency because they are the concurrency boundary for retries, duplicate submissions, and relay state. The verifier then gives semantic replay protection through `sequence`, `prevStateHash`, and `payloadHash`.

## Current Limits

This is a reference implementation, not a production verifier network.

- State is in memory.
- Receipt signatures are deterministic reference signatures, not production key signatures.
- There is no indexed base-layer event feed yet.
- The built-in transition function checks ordering and state-root continuity, but it does not execute arbitrary application logic yet.
- It does not submit transactions or custody wallets.

## Development

```bash
npm install
npm run build
npm test
npm run check
```

## Roadmap

- persistent receipt and checkpoint store
- production verifier signing keys
- indexed base-layer event ingestion
- pluggable transition functions
- hosted reference verifier deployment
- playground verifier-source selection
- shared protocol package for manifests, receipts, and idempotency helpers
