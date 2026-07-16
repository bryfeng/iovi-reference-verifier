# Neutral Verifier Persistence Contract V1

## Purpose

The reference verifier is a protocol-neutral replicated-state verification machine. Persistence makes its registrations, payload observations, decisions, and accepted state durable across retries and process restarts. It does not execute or store Uniswap events, routes, fillers, cases, projections, or other semantic-layer domain records.

This contract separates three concepts that the in-memory alpha originally combined:

- A submission is one delivery or retry of a payload and its base-layer references.
- A receipt is the verifier's durable result for one verification attempt.
- A checkpoint is an accepted semantic-layer state transition. Rejected attempts never advance or replace it.

## Public Contract

Every `VerifierReceiptV1` has a deterministic `receiptId`. An accepted receipt also has a deterministic `checkpointId`; a rejected receipt does not. `ReferenceVerifierState.checkpointId` always means the latest accepted checkpoint.

The receipt ID commits the complete unsigned decision, excluding only `receiptId` and `signature`. The reference signature commits the unsigned receipt including its `receiptId`. The checkpoint ID commits only accepted state-transition identity: verifier, semantic-layer address, registration hash, sequence, payload hash, previous state root, and next state root. Posting IDs, transaction hashes, timestamps, and metadata do not change accepted checkpoint identity.

`ReferenceVerifierPayloadInput.idempotencyKey` is optional. Reusing a key with the same request fingerprint returns the original receipt. Reusing it with different input is an idempotency conflict and does not create a verifier receipt.

The public read contract returns a content-addressed `StoredPayloadV1` by
`payloadHash` and an accepted `StoredCheckpointV1` by `checkpointId`. Reads expose
the exact committed records and never trigger verification, external retrieval,
polling, or semantic projection. Unknown well-formed identifiers return HTTP `404`
with the stable code `VERIFIER_RECORD_NOT_FOUND`.

## Required Behavior

| Situation | Required result |
| --- | --- |
| New valid next-sequence payload | Persist payload and submission, create one accepted receipt and checkpoint, and advance the accepted head atomically. |
| Payload already accepted under the active registration | Record the new submission reference when present and return the canonical accepted receipt without advancing state. |
| Same idempotency key and same request fingerprint | Return the original receipt without reevaluation. |
| Same idempotency key and different request fingerprint | Raise an idempotency conflict without creating a receipt or changing state. |
| State-dependent rejection, retried with a new submission identity after the head changes | Reevaluate against the current accepted head. Rejections are not globally immutable by payload hash. |
| Rejected or malformed submission | Persist the attempt and rejected receipt; do not update the accepted head or checkpoint. |
| Two submissions competing for the same next sequence | At most one transaction may commit an accepted checkpoint. The other is reevaluated or rejected against the committed head. |
| Process restart | Restore active registrations, accepted heads, payloads, attempts, receipts, and checkpoints exactly. |

## Registration Policy

Registration rows are append-only and keyed by `registrationHash`. One row is active for each `semanticLayerAddress`. Re-registering the identical registration is idempotent.

V1 does not silently activate a different registration hash for an existing address. An explicit, authenticated upgrade contract is deferred. Until that contract exists, a conflicting registration is rejected and the active registration and state head remain unchanged. A legacy `slId` can resolve to at most one active semantic-layer address.

## Storage Records

| Record | Required contents |
| --- | --- |
| Registration version | Semantic-layer address, registration hash, canonical registration JSON, active flag, and creation time. |
| Accepted state head | Semantic-layer address, active registration hash, accepted sequence, state root, latest accepted checkpoint ID, and update time. |
| Payload | Payload hash, exact encoded bytes, and byte length. |
| Submission | Submission ID, optional idempotency key, request fingerprint, semantic-layer address when resolved, payload hash, posting ID, transaction hash, public metadata, timestamp, and linked receipt ID. |
| Receipt | Receipt ID, semantic-layer address, registration hash when available, payload hash, sequence, verdict, reason, state roots, optional accepted checkpoint ID, verifier identity, timestamp, signature, and canonical receipt JSON. |
| Checkpoint | Checkpoint ID, semantic-layer address, registration hash, sequence, payload hash, previous and next state roots, receipt ID, and previous accepted checkpoint ID. |
| Schema migration | Monotonic migration version and application time. |

Payload bytes are content-addressed and stored once. Multiple submissions can reference one payload and one canonical accepted receipt. Public metadata is retained only after the existing private-material rejection check.

## Atomicity

Verification uses a transaction-oriented repository port rather than independent load and save calls. For an accepted transition, payload storage, submission storage, receipt creation, checkpoint creation, and compare-and-set advancement of the accepted head are one transaction.

The repository must check the expected active registration hash, sequence, state root, and latest accepted checkpoint before committing. A rejected attempt stores its submission and receipt in one transaction but does not modify the accepted head.

The SQLite reference adapter may serialize writers with an immediate transaction. Database constraints remain authoritative: accepted checkpoints are unique by semantic-layer address and sequence, receipt IDs are unique, payload hashes are unique, and idempotency keys are unique within one verifier.

## Migration And Recovery

Migrations are ordered, deterministic, and safe to run repeatedly. The adapter enables foreign-key enforcement and uses a journaling mode suitable for restart recovery. Opening a database applies pending migrations before any verifier operation.

Closing and reopening the repository must reproduce the same active registration, sequence, state root, accepted checkpoint, canonical accepted receipt, and receipt history. The reference implementation does not claim multi-node consensus or production backup guarantees.

## Reference Limitations

Receipt authentication remains a deterministic reference signature, not an asymmetric production signature. Registration signatures remain shape-checked rather than production-verified. Persistence must label and preserve those limitations; it must not make the reference mechanism appear production-authenticated.

The storage port is driver-independent. The first implementation is SQLite, but no SQLite type or query belongs in the verifier's public receipt, registration, or state contracts.
