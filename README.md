# IOVI Reference Verifier

The IOVI Reference Verifier is a standalone V2 verifier proof for semantic-layer payloads posted through the IOVI SLDK flow.

It is designed to be a neutral verification service that any client can query. The playground can use it as one verifier source, but the verifier is not owned by the playground and does not depend on playground state.

## What It Does

- accepts a `SemanticLayerManifestV1`
- decodes IOVI SLDK semantic-layer payloads from `payloadHex` or EON `Data` scalars
- checks semantic-layer id, sequence, and previous-state hash
- advances a local checkpoint when a payload is accepted
- emits `VerifierReceiptV1` receipts for accepted and rejected payloads
- exposes a small HTTP API for verifier discovery and receipt lookup

## What It Is Not Yet

This is a reference implementation, not a production verifier network.

- State is in memory.
- Receipt signatures are deterministic reference signatures, not production key signatures.
- There is no indexed base-layer event feed yet.
- The transition function is the current `declared-state-root-v1` proof contract: the payload declares the next state root, and the verifier checks ordering and continuity.
- It does not submit transactions or custody wallets.

## Install

```bash
git clone https://github.com/bryfeng/iovi-reference-verifier.git
cd iovi-reference-verifier
npm install
npm run check
```

Node 22 or newer is expected.

The package is source-first for now. Runtime verifier code is self-contained. Tests use `@bryaniovi/sldk` to generate realistic SLDK payloads.

You can also install the current GitHub build into another Node project:

```bash
npm install github:bryfeng/iovi-reference-verifier
```

## Core Concepts

### SemanticLayerManifestV1

A manifest describes one semantic layer:

- `slId`: four-byte semantic-layer id
- `ioviApi`: one developer-facing IOVI API URL
- `publication`: the base-layer posting contract routes
- `transitionFunction`: the rule the verifier is expected to run
- `verifiers`: the verifier endpoints and receipt format clients should trust
- `checkpointPolicy`: how many verifier receipts are required

### VerifierReceiptV1

A receipt records a verifier decision:

- payload identity: `payloadHash`, optional `postingId`, optional `txHash`
- semantic-layer position: `slId`, `sequence`
- state transition: `stateRootBefore`, optional `stateRootAfter`
- decision: `accepted` or `rejected`
- verifier identity: `verifierId`, `signature`
- checkpoint identity: `checkpointId`

Receipts are the bridge from "data was posted" to "this semantic layer accepts what that data means."

## Library Usage

```js
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
    name: 'declared-state-root-v1',
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

const verifier = new IoviReferenceVerifier({ manifest, initialStateRoot: ZERO_HASH });

const receipt = verifier.verifyPayload({
  payloadHex: '0x...',
  payloadHash: '0x...',
  postingId: 'posting-123',
  txHash: '0x...'
});

console.log(receipt.verdict);
```

## HTTP Usage

```js
import { IoviReferenceVerifier, startReferenceVerifierServer } from '@bryaniovi/iovi-reference-verifier';

const verifier = new IoviReferenceVerifier({ manifest });
const server = await startReferenceVerifierServer(verifier, { port: 8787 });
console.log(server.url);
```

Routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Readiness check |
| `GET` | `/manifest` | Return the semantic-layer manifest |
| `GET` | `/state` | Return current sequence and state root |
| `GET` | `/checkpoints/latest` | Return the latest checkpoint view |
| `GET` | `/receipts` | Return all in-memory receipts |
| `GET` | `/receipts/:payloadHash` | Return one receipt by payload hash |
| `POST` | `/verify` | Verify a posted payload or data scalars |

`POST /verify` accepts:

```json
{
  "payloadHex": "0x...",
  "dataScalars": ["0000007a"],
  "postingId": "posting-123",
  "txHash": "0x...",
  "payloadHash": "0x...",
  "timestamp": "2026-07-08T00:00:00.000Z",
  "metadata": {
    "source": "base-layer-utxo"
  }
}
```

Use either `payloadHex` or `dataScalars`. `dataScalars` should be the EON `Data` scalar array emitted by the SLDK posting flow.

## Idempotency Guidance

The verifier is idempotent around semantic position, not API submission. It rejects duplicate or out-of-order payloads because `sequence` and `prevStateHash` must match current verifier state.

For posting APIs, keep a separate operation identity:

- `postingId`: stable workflow id for one intended semantic-layer posting
- `idempotencyKey`: retry key for API prepare/relay calls
- `payloadHash`: content id for the encoded semantic payload
- `txHash`: base-layer transaction id
- `checkpointId`: verifier state checkpoint id

The SLDK should help developers generate stable `postingId` and `idempotencyKey` values, but APIs still need to enforce them because only the API sees concurrent retries and relay state.

## Development

```bash
npm install
npm run build
npm test
npm run check
```

## Roadmap

- persistent receipt/checkpoint store
- production verifier signing keys
- indexed base-layer event ingestion
- pluggable transition functions
- hosted reference verifier deployment
- playground verifier-source selection
- shared protocol package for manifests, receipts, and idempotency helpers
