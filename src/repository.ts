import type {
  SemanticLayerRegistrationV1,
  VerifierReceiptV1
} from './index.js';

export type StoredSemanticLayerV1 = {
  registration: SemanticLayerRegistrationV1;
  registrationHash: string;
  sequence: number;
  stateRoot: string;
  checkpointId?: string;
  registeredAt: string;
};

export type StoredRegistrationVersionV1 = {
  registration: SemanticLayerRegistrationV1;
  registrationHash: string;
  active: boolean;
  registeredAt: string;
};

export type StoredPayloadV1 = {
  payloadHash: string;
  payloadHex: string;
  payloadSize: number;
};

export type StoredSubmissionV1 = {
  submissionId: string;
  idempotencyKey?: string;
  requestFingerprint: string;
  semanticLayerAddress: string;
  payloadHash: string;
  postingId?: string;
  txHash?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
  receiptId: string;
};

export type StoredCheckpointV1 = {
  checkpointId: string;
  semanticLayerAddress: string;
  registrationHash: string;
  sequence: number;
  payloadHash: string;
  stateRootBefore: string;
  stateRootAfter: string;
  receiptId: string;
  previousCheckpointId?: string;
  timestamp: string;
};

export type AcceptedHeadUpdateV1 = {
  semanticLayerAddress: string;
  expectedRegistrationHash: string;
  expectedSequence: number;
  expectedStateRoot: string;
  expectedCheckpointId?: string;
  sequence: number;
  stateRoot: string;
  checkpointId: string;
};

export interface ReferenceVerifierRepository {
  transaction<T>(operation: () => T): T;
  close(): void;

  insertSemanticLayer(layer: StoredSemanticLayerV1): void;
  getSemanticLayer(semanticLayerAddress: string): StoredSemanticLayerV1 | undefined;
  getSemanticLayerByLegacySlId(legacySlId: string): StoredSemanticLayerV1 | undefined;
  listSemanticLayers(): StoredSemanticLayerV1[];
  listRegistrationVersions(semanticLayerAddress: string): StoredRegistrationVersionV1[];
  updateAcceptedHead(update: AcceptedHeadUpdateV1): void;

  savePayload(payload: StoredPayloadV1): void;
  getPayload(payloadHash: string): StoredPayloadV1 | undefined;

  saveSubmission(submission: StoredSubmissionV1): void;
  getSubmissionByIdempotencyKey(idempotencyKey: string): StoredSubmissionV1 | undefined;
  listSubmissions(input?: { semanticLayerAddress?: string }): StoredSubmissionV1[];

  saveReceipt(receipt: VerifierReceiptV1): void;
  getReceiptById(receiptId: string): VerifierReceiptV1 | undefined;
  getReceiptByPayloadHash(
    payloadHash: string,
    input?: { semanticLayerAddress?: string }
  ): VerifierReceiptV1 | undefined;
  getAcceptedReceipt(input: {
    semanticLayerAddress: string;
    registrationHash: string;
    payloadHash: string;
  }): VerifierReceiptV1 | undefined;
  listReceipts(input?: { semanticLayerAddress?: string }): VerifierReceiptV1[];

  saveCheckpoint(checkpoint: StoredCheckpointV1): void;
  getCheckpoint(checkpointId: string): StoredCheckpointV1 | undefined;
}

export class ReferenceVerifierRepositoryConflictError extends Error {
  readonly code = 'VERIFIER_REPOSITORY_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'ReferenceVerifierRepositoryConflictError';
  }
}

export class InMemoryReferenceVerifierRepository implements ReferenceVerifierRepository {
  private readonly semanticLayers = new Map<string, StoredSemanticLayerV1>();
  private readonly registrationVersions = new Map<string, StoredRegistrationVersionV1>();
  private readonly legacySlIdIndex = new Map<string, string>();
  private readonly payloads = new Map<string, StoredPayloadV1>();
  private readonly submissions = new Map<string, StoredSubmissionV1>();
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly receipts = new Map<string, VerifierReceiptV1>();
  private readonly receiptOrder: string[] = [];
  private readonly checkpoints = new Map<string, StoredCheckpointV1>();
  private transactionDepth = 0;

  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    const snapshot = {
      semanticLayers: cloneMap(this.semanticLayers),
      registrationVersions: cloneMap(this.registrationVersions),
      legacySlIdIndex: new Map(this.legacySlIdIndex),
      payloads: cloneMap(this.payloads),
      submissions: cloneMap(this.submissions),
      idempotencyIndex: new Map(this.idempotencyIndex),
      receipts: cloneMap(this.receipts),
      receiptOrder: [...this.receiptOrder],
      checkpoints: cloneMap(this.checkpoints)
    };
    this.transactionDepth += 1;
    try {
      return operation();
    } catch (error) {
      restoreMap(this.semanticLayers, snapshot.semanticLayers);
      restoreMap(this.registrationVersions, snapshot.registrationVersions);
      restoreMap(this.legacySlIdIndex, snapshot.legacySlIdIndex);
      restoreMap(this.payloads, snapshot.payloads);
      restoreMap(this.submissions, snapshot.submissions);
      restoreMap(this.idempotencyIndex, snapshot.idempotencyIndex);
      restoreMap(this.receipts, snapshot.receipts);
      this.receiptOrder.splice(0, this.receiptOrder.length, ...snapshot.receiptOrder);
      restoreMap(this.checkpoints, snapshot.checkpoints);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  close(): void {}

  insertSemanticLayer(layer: StoredSemanticLayerV1): void {
    const existingVersion = this.registrationVersions.get(layer.registrationHash);
    if (existingVersion !== undefined) {
      if (
        stableJson(existingVersion.registration) !== stableJson(layer.registration) ||
        !existingVersion.active
      ) {
        throw new ReferenceVerifierRepositoryConflictError(
          `registration hash ${layer.registrationHash} has conflicting contents`
        );
      }
      return;
    }
    const existingLayer = this.semanticLayers.get(layer.registration.semanticLayerAddress);
    if (existingLayer !== undefined) {
      throw new ReferenceVerifierRepositoryConflictError(
        `semantic layer ${layer.registration.semanticLayerAddress} already has an active registration`
      );
    }
    const legacySlId = layer.registration.legacySlId;
    if (legacySlId !== undefined && this.legacySlIdIndex.has(legacySlId)) {
      throw new ReferenceVerifierRepositoryConflictError(
        `legacy slId ${legacySlId} is already registered`
      );
    }
    const stored = structuredClone(layer);
    this.registrationVersions.set(layer.registrationHash, {
      registration: structuredClone(layer.registration),
      registrationHash: layer.registrationHash,
      active: true,
      registeredAt: layer.registeredAt
    });
    this.semanticLayers.set(layer.registration.semanticLayerAddress, stored);
    if (legacySlId !== undefined) {
      this.legacySlIdIndex.set(legacySlId, layer.registration.semanticLayerAddress);
    }
  }

  getSemanticLayer(semanticLayerAddress: string): StoredSemanticLayerV1 | undefined {
    return cloneOptional(this.semanticLayers.get(semanticLayerAddress));
  }

  getSemanticLayerByLegacySlId(legacySlId: string): StoredSemanticLayerV1 | undefined {
    const semanticLayerAddress = this.legacySlIdIndex.get(legacySlId);
    return semanticLayerAddress === undefined
      ? undefined
      : cloneOptional(this.semanticLayers.get(semanticLayerAddress));
  }

  listSemanticLayers(): StoredSemanticLayerV1[] {
    return [...this.semanticLayers.values()].map((value) => structuredClone(value));
  }

  listRegistrationVersions(semanticLayerAddress: string): StoredRegistrationVersionV1[] {
    return [...this.registrationVersions.values()]
      .filter((value) => value.registration.semanticLayerAddress === semanticLayerAddress)
      .map((value) => structuredClone(value));
  }

  updateAcceptedHead(update: AcceptedHeadUpdateV1): void {
    const layer = this.semanticLayers.get(update.semanticLayerAddress);
    if (
      layer === undefined ||
      layer.registrationHash !== update.expectedRegistrationHash ||
      layer.sequence !== update.expectedSequence ||
      layer.stateRoot !== update.expectedStateRoot ||
      layer.checkpointId !== update.expectedCheckpointId
    ) {
      throw new ReferenceVerifierRepositoryConflictError(
        `accepted head changed for semantic layer ${update.semanticLayerAddress}`
      );
    }
    layer.sequence = update.sequence;
    layer.stateRoot = update.stateRoot;
    layer.checkpointId = update.checkpointId;
  }

  savePayload(payload: StoredPayloadV1): void {
    const existing = this.payloads.get(payload.payloadHash);
    if (existing !== undefined && stableJson(existing) !== stableJson(payload)) {
      throw new ReferenceVerifierRepositoryConflictError(
        `payload hash ${payload.payloadHash} has conflicting bytes`
      );
    }
    if (existing === undefined) this.payloads.set(payload.payloadHash, structuredClone(payload));
  }

  getPayload(payloadHash: string): StoredPayloadV1 | undefined {
    return cloneOptional(this.payloads.get(payloadHash));
  }

  saveSubmission(submission: StoredSubmissionV1): void {
    const existing = this.submissions.get(submission.submissionId);
    if (existing !== undefined) {
      if (stableJson(existing) !== stableJson(submission)) {
        throw new ReferenceVerifierRepositoryConflictError(
          `submission ${submission.submissionId} has conflicting contents`
        );
      }
      return;
    }
    if (submission.idempotencyKey !== undefined) {
      const existingSubmissionId = this.idempotencyIndex.get(submission.idempotencyKey);
      if (existingSubmissionId !== undefined && existingSubmissionId !== submission.submissionId) {
        throw new ReferenceVerifierRepositoryConflictError(
          `idempotency key ${submission.idempotencyKey} is already in use`
        );
      }
      this.idempotencyIndex.set(submission.idempotencyKey, submission.submissionId);
    }
    this.submissions.set(submission.submissionId, structuredClone(submission));
  }

  getSubmissionByIdempotencyKey(idempotencyKey: string): StoredSubmissionV1 | undefined {
    const submissionId = this.idempotencyIndex.get(idempotencyKey);
    return submissionId === undefined
      ? undefined
      : cloneOptional(this.submissions.get(submissionId));
  }

  listSubmissions(input: { semanticLayerAddress?: string } = {}): StoredSubmissionV1[] {
    return [...this.submissions.values()]
      .filter(
        (submission) =>
          input.semanticLayerAddress === undefined ||
          submission.semanticLayerAddress === input.semanticLayerAddress
      )
      .map((submission) => structuredClone(submission));
  }

  saveReceipt(receipt: VerifierReceiptV1): void {
    const existing = this.receipts.get(receipt.receiptId);
    if (existing !== undefined) {
      if (stableJson(existing) !== stableJson(receipt)) {
        throw new ReferenceVerifierRepositoryConflictError(
          `receipt ${receipt.receiptId} has conflicting contents`
        );
      }
      return;
    }
    this.receipts.set(receipt.receiptId, structuredClone(receipt));
    this.receiptOrder.push(receipt.receiptId);
  }

  getReceiptById(receiptId: string): VerifierReceiptV1 | undefined {
    return cloneOptional(this.receipts.get(receiptId));
  }

  getReceiptByPayloadHash(
    payloadHash: string,
    input: { semanticLayerAddress?: string } = {}
  ): VerifierReceiptV1 | undefined {
    const matches = this.receiptOrder
      .map((receiptId) => this.receipts.get(receiptId))
      .filter(
        (receipt): receipt is VerifierReceiptV1 =>
          receipt !== undefined &&
          receipt.payloadHash === payloadHash &&
          (input.semanticLayerAddress === undefined ||
            receipt.semanticLayerAddress === input.semanticLayerAddress)
      );
    return cloneOptional(
      matches.find((receipt) => receipt.verdict === 'accepted') ?? matches.at(-1)
    );
  }

  getAcceptedReceipt(input: {
    semanticLayerAddress: string;
    registrationHash: string;
    payloadHash: string;
  }): VerifierReceiptV1 | undefined {
    return cloneOptional(
      this.receiptOrder
        .map((receiptId) => this.receipts.get(receiptId))
        .find(
          (receipt) =>
            receipt?.verdict === 'accepted' &&
            receipt.semanticLayerAddress === input.semanticLayerAddress &&
            receipt.registrationHash === input.registrationHash &&
            receipt.payloadHash === input.payloadHash
        )
    );
  }

  listReceipts(input: { semanticLayerAddress?: string } = {}): VerifierReceiptV1[] {
    return this.receiptOrder
      .map((receiptId) => this.receipts.get(receiptId))
      .filter(
        (receipt): receipt is VerifierReceiptV1 =>
          receipt !== undefined &&
          (input.semanticLayerAddress === undefined ||
            receipt.semanticLayerAddress === input.semanticLayerAddress)
      )
      .map((receipt) => structuredClone(receipt));
  }

  saveCheckpoint(checkpoint: StoredCheckpointV1): void {
    const existing = this.checkpoints.get(checkpoint.checkpointId);
    if (existing !== undefined && stableJson(existing) !== stableJson(checkpoint)) {
      throw new ReferenceVerifierRepositoryConflictError(
        `checkpoint ${checkpoint.checkpointId} has conflicting contents`
      );
    }
    if (existing === undefined) this.checkpoints.set(checkpoint.checkpointId, structuredClone(checkpoint));
  }

  getCheckpoint(checkpointId: string): StoredCheckpointV1 | undefined {
    return cloneOptional(this.checkpoints.get(checkpointId));
  }
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function cloneMap<K, V>(value: Map<K, V>): Map<K, V> {
  return new Map([...value.entries()].map(([key, nested]) => [key, structuredClone(nested)]));
}

function restoreMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, structuredClone(value));
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
