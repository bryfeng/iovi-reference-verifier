# IOVI Reference Verifier

Run a local reference verifier platform for IOVI semantic-layer payloads.

In the current model, a verifier is a third-party platform. Semantic layers register with the verifier by public address, declare the codec and proof standard they use, and then the verifier can pull or receive base-layer payloads, verify them, maintain its own accepted state, and emit Verifier Receipts.

Use this repo when you want to:

- test semantic-layer payloads produced by the IOVI SLDK
- register one or more semantic layers with a verifier
- verify payloads under the registered codec and proof standard
- expose verifier endpoints that clients, playgrounds, or agents can query
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
- A verifier platform registers semantic layers, indexes or receives their payloads, verifies transitions, and emits receipts.

This repo is the verifier side of that flow. It does not sign base-layer transactions, relay transactions, hold wallets, or custody private material.

## Core Model

The semantic-layer identity is the semantic layer's public address.

The verifier registry is keyed by that address:

- `semanticLayerAddress -> registration`
- `semanticLayerAddress -> codec and proof standard`
- `semanticLayerAddress -> current verified state`
- `semanticLayerAddress -> receipts`

A separate `slId` is not the core identity. The current SLDK payload codec still includes a compact `slId`, so this reference verifier supports `legacySlId` as a bridge. Future payload codecs should be able to route by signer, publisher, owner, or explicit semantic-layer address instead.

## First Verification

This example registers a semantic layer by address, generates a realistic SLDK payload, verifies it, and prints the receipt verdict.

```js
import { encodeSemanticLayerTransition } from '@bryaniovi/sldk';
import {
  IoviReferenceVerifier,
  ZERO_HASH,
  buildSemanticLayerRegistration
} from '@bryaniovi/iovi-reference-verifier';

const semanticLayerAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const registration = buildSemanticLayerRegistration({
  semanticLayerAddress,
  name: 'Demo Asset Layer',
  codec: 'iovi-payload-v1',
  proofStandard: 'declared-state-root',
  legacySlId: '00010001',
  publisherAddress: semanticLayerAddress,
  registrationUtxoId: 'utxo-registration-demo',
  signature: 'reference-signature'
});

const verifier = new IoviReferenceVerifier({
  registrations: [registration]
});

const payload = encodeSemanticLayerTransition({
  slId: '00010001',
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

const receipt = verifier.verifyPayload({
  payloadHex: payload.payloadHex,
  payloadHash: payload.payloadHash,
  postingId: 'demo-posting-1',
  txHash: `0x${'22'.repeat(32)}`
});

console.log(receipt.verdict);
console.log(receipt.semanticLayerAddress);
console.log(receipt.checkpointId);
```

The first payload is accepted because its sequence is `1` and its previous state root is the zero hash. A second payload for the same semantic-layer address must use sequence `2` and the first receipt's `stateRootAfter` as its previous state root.

## Registration

A registration tells a verifier how to handle a semantic layer.

It includes:

- `semanticLayerAddress`: the public address that identifies the semantic layer
- `codec`: the payload language, such as `iovi-payload-v1`
- `proofStandard`: the verification rule or proof family, such as `declared-state-root`
- `publisherAddress`: the key or address authorized to publish the registration
- `registrationTxHash` or `registrationUtxoId`: optional base-layer anchoring evidence
- `legacySlId`: optional bridge for the current SLDK payload codec
- `manifestUrl` and `manifestHash`: optional public metadata
- `signature`: registration authorization evidence

In production, the registration should be anchored to the base layer. A semantic layer can post a compact registration object or pointer as a data-bearing UTXO, then give the verifier the UTXO id or transaction hash. The verifier can fetch that base-layer object, validate the public address and signature, and register the semantic layer.

This reference package validates the registration shape and supported standards. It does not yet verify a production EON signature for the registration.

## Manifests Are Optional

A manifest is no longer required to use the verifier.

A manifest is useful when a semantic layer wants a richer public document for developers: schemas, docs, endpoints, verifier references, upgrade policy, and other metadata. It can be attached to registration through `manifestUrl`, `manifestHash`, or an embedded manifest object.

For closed integrations, a registration can be enough. For public interoperability, a manifest is a recommended best practice, not a protocol requirement.

## Run an HTTP Verifier

```js
import { IoviReferenceVerifier, startReferenceVerifierServer } from '@bryaniovi/iovi-reference-verifier';

const verifier = new IoviReferenceVerifier({
  registrations: [registration]
});

const server = await startReferenceVerifierServer(verifier, { port: 8787 });

console.log(`Verifier listening at ${server.url}`);
```

Routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Readiness check |
| `GET` | `/registrations` | List registered semantic layers |
| `POST` | `/registrations` | Register a semantic layer |
| `GET` | `/registrations/:address` | Read one registration |
| `GET` | `/semantic-layers` | Alias for registration list |
| `GET` | `/semantic-layers/:address` | Read one semantic layer registration |
| `GET` | `/semantic-layers/:address/state` | Read one semantic layer's verified state |
| `GET` | `/semantic-layers/:address/receipts` | Read receipts for one semantic layer |
| `GET` | `/state` | Read all verifier states |
| `GET` | `/receipts` | Read all receipts |
| `GET` | `/receipts/:payloadHash` | Read one receipt by payload hash |
| `POST` | `/verify` | Verify a payload or EON data scalars |

`POST /verify` accepts either `payloadHex` or `dataScalars`:

```json
{
  "semanticLayerAddress": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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

If `semanticLayerAddress` is omitted, the verifier can route current `iovi-payload-v1` payloads by registered `legacySlId`.

## Verifier Receipt

A Verifier Receipt is the portable result of a verifier decision.

It includes:

- `semanticLayerAddress`: the registered semantic-layer identity
- `registrationHash`: hash of the registration used by the verifier
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

- `semanticLayerAddress`: the public address that identifies the semantic layer
- `registrationHash`: the verifier registration used for the decision
- `postingId`: stable workflow id for the intended posting
- `idempotencyKey`: retry key for prepare and relay calls
- `payloadHash`: content id for the encoded semantic payload
- `txHash`: base-layer transaction id after relay
- `checkpointId`: verifier checkpoint id after verification
- `verdict`: verifier decision

The SLDK should help generate stable operation ids. APIs still need to enforce idempotency because they are the concurrency boundary for retries, duplicate submissions, and relay state. The verifier then gives semantic replay protection through sequence, previous state root, payload hash, and registration hash.

## Current Limits

This is a reference implementation, not a production verifier network.

- State is in memory.
- Registration signatures are shape-checked but not production-verified.
- Receipt signatures are deterministic reference signatures, not production key signatures.
- There is no indexed base-layer event feed yet.
- The built-in transition function checks ordering and state-root continuity, but it does not execute arbitrary application logic yet.
- The current SLDK payload codec still uses `slId`, so `legacySlId` remains as a compatibility bridge.
- It does not submit transactions or custody wallets.

## Development

```bash
npm install
npm run build
npm test
npm run check
```

## Roadmap

- production registration signature verification
- base-layer registration UTXO fetch and validation
- persistent registration, receipt, and checkpoint store
- production verifier signing keys
- indexed base-layer event ingestion
- pluggable codecs and proof standards
- hosted reference verifier deployment
- shared protocol package for registrations, receipts, and idempotency helpers
