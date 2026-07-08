import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export const SEMANTIC_LAYER_MANIFEST_V1_FORMAT = 'iovi-semantic-layer-manifest-v1';
export const SEMANTIC_LAYER_REGISTRATION_V1_FORMAT = 'iovi-semantic-layer-registration-v1';
export const VERIFIER_RECEIPT_V1_FORMAT = 'iovi-verifier-receipt-v1';
export const CONTRACT_VERSION_V1 = '1.0.0';
export const ZERO_HASH = `0x${'00'.repeat(32)}`;

const SCALAR_BYTES = 4;
const PRIVATE_MATERIAL_KEYS = new Set([
  'accountfile',
  'accountfilepath',
  'accountjson',
  'encryptedaccountjson',
  'mnemonic',
  'privatekey',
  'rngseed',
  'secretkey',
  'seed',
  'seedphrase',
  'signingseed',
  'sk',
  'walletfile',
  'walletpath'
]);

export type SemanticLayerManifestV1 = {
  manifestVersion: typeof CONTRACT_VERSION_V1;
  slId: string;
  name: string;
  description?: string;
  version: string;
  ioviApi: string;
  payloadCodec: string;
  schemas?: Record<string, string>;
  publication: {
    accountRegistrationRoute?: string;
    preparePostingRoute: string;
    postingRoute: string;
  };
  transitionFunction: SemanticLayerTransitionFunctionV1;
  verifiers: SemanticLayerVerifierRefV1[];
  checkpointPolicy: SemanticLayerCheckpointPolicyV1;
  upgradePolicy?: {
    type: 'manifest-version' | 'immutable' | 'governance';
    governance?: string;
  };
  metadata?: Record<string, unknown>;
};

export type SemanticLayerTransitionFunctionV1 =
  | {
      type: 'repo';
      url: string;
      commit: string;
      path?: string;
    }
  | {
      type: 'wasm';
      url: string;
      digest: string;
    }
  | {
      type: 'builtin';
      name: string;
      version: string;
    };

export type SemanticLayerVerifierRefV1 = {
  name: string;
  endpoint: string;
  verifierId: string;
  receiptKey?: string;
  receiptFormat: typeof VERIFIER_RECEIPT_V1_FORMAT;
  metadata?: Record<string, unknown>;
};

export type SemanticLayerCheckpointPolicyV1 =
  | {
      type: 'single';
      requiredVerifiers: 1;
    }
  | {
      type: 'quorum';
      requiredVerifiers: number;
    }
  | {
      type: 'proof';
      proofSystem: string;
      requiredVerifiers?: number;
    };

export type SemanticLayerCodecRef =
  | string
  | {
      name: string;
      version?: string;
      compression?: string;
      schema?: string;
      metadata?: Record<string, unknown>;
    };

export type SemanticLayerProofStandardRef =
  | string
  | {
      name: string;
      version?: string;
      verifierKey?: string;
      metadata?: Record<string, unknown>;
    };

export type SemanticLayerRegistrationV1 = {
  registrationVersion: typeof CONTRACT_VERSION_V1;
  registrationFormat: typeof SEMANTIC_LAYER_REGISTRATION_V1_FORMAT;
  semanticLayerAddress: string;
  name?: string;
  codec: SemanticLayerCodecRef;
  proofStandard: SemanticLayerProofStandardRef;
  legacySlId?: string;
  publisherAddress?: string;
  registrationTxHash?: string;
  registrationUtxoId?: string;
  manifestUrl?: string;
  manifestHash?: string;
  manifest?: SemanticLayerManifestV1;
  signature?: string;
  metadata?: Record<string, unknown>;
};

export type SemanticLayerRegistration = SemanticLayerRegistrationV1;
export type SemanticLayerManifest = SemanticLayerManifestV1;
export type VerifierReceipt = VerifierReceiptV1;

export type VerifierReceiptV1 = {
  receiptVersion: typeof CONTRACT_VERSION_V1;
  receiptFormat: typeof VERIFIER_RECEIPT_V1_FORMAT;
  semanticLayerAddress: string;
  registrationHash?: string;
  slId?: string;
  manifestHash?: string;
  payloadHash: string;
  payloadSize?: number;
  postingId?: string;
  txHash?: string;
  sequence: number;
  verdict: 'accepted' | 'rejected';
  reason?: string;
  remediation?: string;
  stateRootBefore: string;
  stateRootAfter?: string;
  checkpointId: string;
  verifierId: string;
  signature: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
};

export type ReceiptTrustResult = {
  trusted: boolean;
  reason?: string;
  verifier?: SemanticLayerVerifierRefV1;
};

export type DecodedSemanticLayerTransition = {
  slId: string;
  version: string;
  sequence: bigint;
  prevStateHash: string;
  newStateHash: string;
  actions: Record<string, unknown>[];
  payloadHex: string;
  payloadHash: string;
  payloadSize: number;
};

export type ReferenceVerifierPayloadInput = {
  semanticLayerAddress?: string;
  payloadHex?: string;
  dataScalars?: string[];
  postingId?: string;
  txHash?: string;
  payloadHash?: string;
  payloadSize?: number;
  timestamp?: string;
  metadata?: Record<string, unknown>;
};

export type ReferenceVerifierState = {
  semanticLayerAddress: string;
  legacySlId?: string;
  registrationHash: string;
  sequence: number;
  stateRoot: string;
  checkpointId?: string;
};

export type ReferenceVerifierOptions = {
  verifierId?: string;
  registrations?: SemanticLayerRegistrationV1[];
  manifest?: SemanticLayerManifestV1;
  semanticLayerAddress?: string;
  initialStateRoot?: string;
};

export type ReferenceVerifierServer = {
  server: Server;
  url: string;
  close: () => Promise<void>;
};

export function assertValidSemanticLayerManifestV1(manifest: SemanticLayerManifestV1): void {
  assertNoPrivateMaterial(manifest);
  assertExact(manifest.manifestVersion, CONTRACT_VERSION_V1, 'manifestVersion');
  assertHexBytes(manifest.slId, 4, 'slId');
  assertNonEmpty(manifest.name, 'name');
  assertNonEmpty(manifest.version, 'version');
  assertUrl(manifest.ioviApi, 'ioviApi');
  assertNonEmpty(manifest.payloadCodec, 'payloadCodec');

  if (manifest.schemas !== undefined) {
    for (const [name, url] of Object.entries(manifest.schemas)) {
      assertNonEmpty(name, 'schema name');
      assertUrl(url, `schemas.${name}`);
    }
  }

  assertRoute(manifest.publication.accountRegistrationRoute ?? '/v1/base-layer/accounts', 'accountRegistrationRoute');
  assertRoute(manifest.publication.preparePostingRoute, 'preparePostingRoute');
  assertRoute(manifest.publication.postingRoute, 'postingRoute');
  assertTransitionFunction(manifest.transitionFunction);

  if (!Array.isArray(manifest.verifiers) || manifest.verifiers.length === 0) {
    throw new Error('manifest.verifiers must include at least one verifier');
  }
  manifest.verifiers.forEach(assertVerifierRef);
  assertCheckpointPolicy(manifest.checkpointPolicy, manifest.verifiers.length);
}

export function assertValidVerifierReceiptV1(receipt: VerifierReceiptV1): void {
  assertNoPrivateMaterial(receipt);
  assertExact(receipt.receiptVersion, CONTRACT_VERSION_V1, 'receiptVersion');
  assertExact(receipt.receiptFormat, VERIFIER_RECEIPT_V1_FORMAT, 'receiptFormat');
  assertSemanticLayerAddress(receipt.semanticLayerAddress, 'semanticLayerAddress');
  if (receipt.registrationHash !== undefined) assertHexHash(receipt.registrationHash, 'registrationHash');
  if (receipt.slId !== undefined) assertHexBytes(receipt.slId, 4, 'slId');
  assertHexHash(receipt.payloadHash, 'payloadHash');
  if (receipt.manifestHash !== undefined) assertHexHash(receipt.manifestHash, 'manifestHash');
  if (receipt.txHash !== undefined) assertHexHash(receipt.txHash, 'txHash');
  assertPositiveInteger(receipt.sequence, 'sequence');
  if (receipt.verdict !== 'accepted' && receipt.verdict !== 'rejected') {
    throw new Error('verdict must be accepted or rejected');
  }
  assertHexHash(receipt.stateRootBefore, 'stateRootBefore');
  if (receipt.stateRootAfter !== undefined) assertHexHash(receipt.stateRootAfter, 'stateRootAfter');
  assertNonEmpty(receipt.checkpointId, 'checkpointId');
  assertNonEmpty(receipt.verifierId, 'verifierId');
  assertNonEmpty(receipt.signature, 'signature');
  assertDateTime(receipt.timestamp, 'timestamp');
}

export function semanticLayerManifestV1Hash(manifest: SemanticLayerManifestV1): string {
  assertValidSemanticLayerManifestV1(manifest);
  return digestHex(canonicalJson(manifest));
}

export function assertValidSemanticLayerRegistrationV1(registration: SemanticLayerRegistrationV1): void {
  assertNoPrivateMaterial(registration);
  assertExact(registration.registrationVersion, CONTRACT_VERSION_V1, 'registrationVersion');
  assertExact(registration.registrationFormat, SEMANTIC_LAYER_REGISTRATION_V1_FORMAT, 'registrationFormat');
  assertSemanticLayerAddress(registration.semanticLayerAddress, 'semanticLayerAddress');
  assertCodecRef(registration.codec, 'codec');
  assertProofStandardRef(registration.proofStandard, 'proofStandard');

  if (registration.name !== undefined) assertNonEmpty(registration.name, 'name');
  if (registration.legacySlId !== undefined) assertHexBytes(registration.legacySlId, 4, 'legacySlId');
  if (registration.publisherAddress !== undefined) assertSemanticLayerAddress(registration.publisherAddress, 'publisherAddress');
  if (registration.registrationTxHash !== undefined) assertHexHash(registration.registrationTxHash, 'registrationTxHash');
  if (registration.registrationUtxoId !== undefined) assertNonEmpty(registration.registrationUtxoId, 'registrationUtxoId');
  if (registration.manifestUrl !== undefined) assertUrl(registration.manifestUrl, 'manifestUrl');
  if (registration.manifestHash !== undefined) assertHexHash(registration.manifestHash, 'manifestHash');
  if (registration.signature !== undefined) assertNonEmpty(registration.signature, 'signature');

  if (registration.manifest !== undefined) {
    assertValidSemanticLayerManifestV1(registration.manifest);
    if (registration.legacySlId !== undefined && stripHex(registration.manifest.slId) !== stripHex(registration.legacySlId)) {
      throw new Error('manifest.slId must match registration.legacySlId');
    }
    if (registration.manifestHash !== undefined) {
      const manifestHash = semanticLayerManifestV1Hash(registration.manifest);
      if (manifestHash !== normalizeHash(registration.manifestHash)) {
        throw new Error(`manifestHash mismatch: expected ${registration.manifestHash}, computed ${manifestHash}`);
      }
    }
  }
}

export function semanticLayerRegistrationV1Hash(registration: SemanticLayerRegistrationV1): string {
  assertValidSemanticLayerRegistrationV1(registration);
  return digestHex(canonicalJson(registration));
}

export function buildSemanticLayerRegistration(input: {
  semanticLayerAddress: string;
  codec?: SemanticLayerCodecRef;
  proofStandard?: SemanticLayerProofStandardRef;
  legacySlId?: string;
  name?: string;
  publisherAddress?: string;
  registrationTxHash?: string;
  registrationUtxoId?: string;
  manifestUrl?: string;
  manifest?: SemanticLayerManifestV1;
  manifestHash?: string;
  signature?: string;
  metadata?: Record<string, unknown>;
}): SemanticLayerRegistrationV1 {
  const registration = {
    registrationVersion: CONTRACT_VERSION_V1,
    registrationFormat: SEMANTIC_LAYER_REGISTRATION_V1_FORMAT,
    semanticLayerAddress: input.semanticLayerAddress,
    name: input.name,
    codec: input.codec ?? 'iovi-payload-v1',
    proofStandard: input.proofStandard ?? 'declared-state-root',
    legacySlId: input.legacySlId ?? input.manifest?.slId,
    publisherAddress: input.publisherAddress,
    registrationTxHash: input.registrationTxHash,
    registrationUtxoId: input.registrationUtxoId,
    manifestUrl: input.manifestUrl,
    manifestHash:
      input.manifestHash ?? (input.manifest === undefined ? undefined : semanticLayerManifestV1Hash(input.manifest)),
    manifest: input.manifest,
    signature: input.signature,
    metadata: input.metadata
  } satisfies SemanticLayerRegistrationV1;
  assertValidSemanticLayerRegistrationV1(registration);
  return removeUndefined(registration) as SemanticLayerRegistrationV1;
}

export function isVerifierTrustedByManifest(
  manifest: SemanticLayerManifestV1,
  receipt: Pick<VerifierReceiptV1, 'slId' | 'verifierId' | 'receiptFormat'>
): ReceiptTrustResult {
  assertValidSemanticLayerManifestV1(manifest);
  if (receipt.slId === undefined) {
    return { trusted: false, reason: 'receipt does not include legacy slId required for manifest trust check' };
  }
  if (receipt.slId !== manifest.slId) {
    return { trusted: false, reason: `receipt slId ${receipt.slId} does not match manifest slId ${manifest.slId}` };
  }
  if (receipt.receiptFormat !== VERIFIER_RECEIPT_V1_FORMAT) {
    return { trusted: false, reason: `unsupported receipt format ${receipt.receiptFormat}` };
  }

  const verifier = manifest.verifiers.find(
    (candidate) => candidate.verifierId === receipt.verifierId || candidate.receiptKey === receipt.verifierId
  );
  if (!verifier) return { trusted: false, reason: `verifier ${receipt.verifierId} is not listed in manifest` };
  return { trusted: true, verifier };
}

export function assertReceiptTrustedByManifest(manifest: SemanticLayerManifestV1, receipt: VerifierReceiptV1): void {
  assertValidVerifierReceiptV1(receipt);
  const trust = isVerifierTrustedByManifest(manifest, receipt);
  if (!trust.trusted) throw new Error(trust.reason ?? 'receipt is not trusted by manifest');
}

export function scalarHexToPayloadBytes(scalars: string[]): Uint8Array {
  if (scalars.length === 0) throw new Error('no scalars supplied');
  const raw = concatBytes(scalars.map((scalar) => fixedHexBytes(scalar, SCALAR_BYTES, 'scalar')));
  const payloadLength = readU32(raw.slice(0, SCALAR_BYTES));
  const payloadStart = SCALAR_BYTES;
  const payloadEnd = payloadStart + payloadLength;
  if (payloadEnd > raw.byteLength) {
    throw new Error(`declared payload length ${payloadLength} exceeds scalar data length`);
  }
  for (const byte of raw.slice(payloadEnd)) {
    if (byte !== 0) throw new Error('non-zero bytes after declared payload length');
  }
  return raw.slice(payloadStart, payloadEnd);
}

export function scalarHexToPayloadHex(scalars: string[]): string {
  return bytesToHex(scalarHexToPayloadBytes(scalars));
}

export function decodeSemanticLayerTransition(payloadHex: string): DecodedSemanticLayerTransition {
  const payload = hexToBytes(payloadHex, 'payloadHex');
  const reader = new PayloadReader(payload);
  const slId = bytesToHex(reader.read(4));
  const version = bytesToHex(reader.read(2));
  const sequence = readU64(reader.read(8));
  const prevStateHash = bytesToHex(reader.read(32));
  const newStateHash = bytesToHex(reader.read(32));
  const actionCount = readU16(reader.read(2));
  const actions: Record<string, unknown>[] = [];

  for (let index = 0; index < actionCount; index += 1) {
    const actionLength = readU16(reader.read(2));
    const actionText = new TextDecoder().decode(reader.read(actionLength));
    const action = JSON.parse(actionText);
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      throw new Error(`action ${index} must decode to an object`);
    }
    actions.push(action as Record<string, unknown>);
  }

  reader.assertDone();

  return {
    slId,
    version,
    sequence,
    prevStateHash,
    newStateHash,
    actions,
    payloadHex: bytesToHex(payload),
    payloadHash: `0x${createHash('sha256').update(payload).digest('hex')}`,
    payloadSize: payload.byteLength
  };
}

type RegisteredSemanticLayer = {
  registration: SemanticLayerRegistrationV1;
  registrationHash: string;
  sequence: number;
  stateRoot: string;
  receipts: VerifierReceiptV1[];
};

export class IoviReferenceVerifier {
  readonly verifierId: string;
  private readonly registrations = new Map<string, RegisteredSemanticLayer>();
  private readonly legacySlIdIndex = new Map<string, string>();
  private readonly receipts: VerifierReceiptV1[] = [];

  constructor(options: ReferenceVerifierOptions = {}) {
    this.verifierId = options.verifierId ?? options.manifest?.verifiers[0]?.verifierId ?? 'did:key:iovi-reference-verifier';
    if (options.manifest !== undefined) {
      this.registerSemanticLayer(
        buildSemanticLayerRegistration({
          semanticLayerAddress: options.semanticLayerAddress ?? `legacy-sl:${stripHex(options.manifest.slId)}`,
          codec: options.manifest.payloadCodec,
          proofStandard:
            options.manifest.transitionFunction.type === 'builtin'
              ? options.manifest.transitionFunction.name
              : {
                  name: options.manifest.transitionFunction.type,
                  metadata: options.manifest.transitionFunction
                },
          manifest: options.manifest,
          name: options.manifest.name
        }),
        { initialStateRoot: options.initialStateRoot }
      );
    }
    for (const registration of options.registrations ?? []) {
      this.registerSemanticLayer(registration, { initialStateRoot: options.initialStateRoot });
    }
  }

  registerSemanticLayer(
    registration: SemanticLayerRegistrationV1,
    options: { initialStateRoot?: string } = {}
  ): SemanticLayerRegistrationV1 {
    assertSupportedReferenceRegistration(registration);
    const semanticLayerAddress = normalizeSemanticLayerAddress(registration.semanticLayerAddress);
    const normalizedRegistration = {
      ...registration,
      semanticLayerAddress
    };
    const registrationHash = semanticLayerRegistrationV1Hash(normalizedRegistration);
    const existing = this.registrations.get(semanticLayerAddress);
    this.registrations.set(semanticLayerAddress, {
      registration: normalizedRegistration,
      registrationHash,
      sequence: existing?.sequence ?? 0,
      stateRoot: existing?.stateRoot ?? options.initialStateRoot ?? ZERO_HASH,
      receipts: existing?.receipts ?? []
    });
    if (registration.legacySlId !== undefined) {
      this.legacySlIdIndex.set(stripHex(registration.legacySlId), semanticLayerAddress);
    }
    return normalizedRegistration;
  }

  listRegistrations(): Array<SemanticLayerRegistrationV1 & { registrationHash: string }> {
    return [...this.registrations.values()].map((registered) => ({
      ...registered.registration,
      registrationHash: registered.registrationHash
    }));
  }

  getRegistration(semanticLayerAddress: string): (SemanticLayerRegistrationV1 & { registrationHash: string }) | undefined {
    const registered = this.registrations.get(normalizeSemanticLayerAddress(semanticLayerAddress));
    if (!registered) return undefined;
    return {
      ...registered.registration,
      registrationHash: registered.registrationHash
    };
  }

  getState(semanticLayerAddress: string): ReferenceVerifierState {
    const registered = this.requireRegisteredSemanticLayer(semanticLayerAddress);
    return this.stateFor(registered);
  }

  listStates(): ReferenceVerifierState[] {
    return [...this.registrations.values()].map((registered) => this.stateFor(registered));
  }

  listReceipts(input: { semanticLayerAddress?: string } = {}): VerifierReceiptV1[] {
    if (input.semanticLayerAddress === undefined) return [...this.receipts];
    return [...this.requireRegisteredSemanticLayer(input.semanticLayerAddress).receipts];
  }

  getReceipt(payloadHash: string): VerifierReceiptV1 | undefined {
    return this.receipts.find((receipt) => receipt.payloadHash === payloadHash);
  }

  verifyPayload(input: ReferenceVerifierPayloadInput): VerifierReceiptV1 {
    const timestamp = input.timestamp ?? new Date().toISOString();
    let decoded: DecodedSemanticLayerTransition | undefined;
    let registered: RegisteredSemanticLayer | undefined;
    try {
      const payloadHex = input.payloadHex ?? scalarHexToPayloadHex(input.dataScalars ?? []);
      decoded = decodeSemanticLayerTransition(payloadHex);
      registered = this.resolveRegistration(input, decoded);
      const expectedPayloadHash = input.payloadHash ?? decoded.payloadHash;
      if (decoded.payloadHash !== expectedPayloadHash) {
        throw new Error(`payload hash mismatch: expected ${expectedPayloadHash}, decoded ${decoded.payloadHash}`);
      }
      if (
        registered.registration.legacySlId !== undefined &&
        stripHex(decoded.slId) !== stripHex(registered.registration.legacySlId)
      ) {
        throw new Error(`legacy slId mismatch: expected ${registered.registration.legacySlId}, got ${decoded.slId}`);
      }

      const expectedSequence = registered.sequence + 1;
      if (Number(decoded.sequence) !== expectedSequence) {
        throw new Error(`sequence mismatch: expected ${expectedSequence}, got ${decoded.sequence.toString()}`);
      }
      if (normalizeHash(decoded.prevStateHash) !== normalizeHash(registered.stateRoot)) {
        throw new Error(`prevStateHash mismatch: expected ${registered.stateRoot}, got ${decoded.prevStateHash}`);
      }

      const receipt = this.buildReceipt({
        input,
        registration: registered,
        decoded,
        timestamp,
        payloadHash: decoded.payloadHash,
        payloadSize: decoded.payloadSize,
        sequence: Number(decoded.sequence),
        verdict: 'accepted',
        stateRootBefore: registered.stateRoot,
        stateRootAfter: decoded.newStateHash
      });
      registered.sequence = Number(decoded.sequence);
      registered.stateRoot = decoded.newStateHash;
      registered.receipts.push(receipt);
      this.receipts.push(receipt);
      return receipt;
    } catch (error) {
      const fallbackRegistration = registered ?? this.rejectionRegistration(input, decoded);
      const receipt = this.buildReceipt({
        input,
        registration: fallbackRegistration,
        decoded,
        timestamp,
        payloadHash: input.payloadHash ?? decoded?.payloadHash ?? digestHex(JSON.stringify(input)),
        payloadSize: input.payloadSize ?? decoded?.payloadSize,
        sequence: Number(decoded?.sequence ?? BigInt(fallbackRegistration.sequence + 1)),
        verdict: 'rejected',
        reason: error instanceof Error ? error.message : String(error),
        stateRootBefore: fallbackRegistration.stateRoot,
        stateRootAfter: fallbackRegistration.stateRoot
      });
      fallbackRegistration.receipts.push(receipt);
      this.receipts.push(receipt);
      return receipt;
    }
  }

  verifyUtxos(
    utxos: Array<{
      id: string;
      amount?: number;
      data?: string[];
      txHash?: string;
      semanticLayerAddress?: string;
    }>
  ): VerifierReceiptV1[] {
    return utxos
      .filter((utxo) => Array.isArray(utxo.data) && utxo.data.length > 0)
      .map((utxo) =>
        this.verifyPayload({
          semanticLayerAddress: utxo.semanticLayerAddress,
          dataScalars: utxo.data,
          postingId: utxo.id,
          txHash: utxo.txHash,
          metadata: {
            source: 'utxo',
            amount: utxo.amount
          }
        })
      );
  }

  private resolveRegistration(
    input: ReferenceVerifierPayloadInput,
    decoded: DecodedSemanticLayerTransition
  ): RegisteredSemanticLayer {
    if (input.semanticLayerAddress !== undefined) {
      return this.requireRegisteredSemanticLayer(input.semanticLayerAddress);
    }
    const legacyAddress = this.legacySlIdIndex.get(stripHex(decoded.slId));
    if (legacyAddress !== undefined) return this.requireRegisteredSemanticLayer(legacyAddress);
    if (this.registrations.size === 1) {
      const only = [...this.registrations.values()][0];
      if (only.registration.legacySlId === undefined || stripHex(only.registration.legacySlId) === stripHex(decoded.slId)) {
        return only;
      }
    }
    throw new Error(`semantic layer is not registered for payload slId ${decoded.slId}`);
  }

  private requireRegisteredSemanticLayer(semanticLayerAddress: string): RegisteredSemanticLayer {
    const registered = this.registrations.get(normalizeSemanticLayerAddress(semanticLayerAddress));
    if (!registered) throw new Error(`semantic layer ${semanticLayerAddress} is not registered`);
    return registered;
  }

  private rejectionRegistration(
    input: ReferenceVerifierPayloadInput,
    decoded: DecodedSemanticLayerTransition | undefined
  ): RegisteredSemanticLayer {
    const semanticLayerAddress = normalizeSemanticLayerAddress(
      input.semanticLayerAddress ?? (decoded === undefined ? 'unregistered:unknown' : `unregistered-sl:${stripHex(decoded.slId)}`)
    );
    return {
      registration: buildSemanticLayerRegistration({
        semanticLayerAddress,
        codec: 'iovi-payload-v1',
        proofStandard: 'declared-state-root',
        legacySlId: decoded?.slId,
        name: 'Unregistered semantic layer'
      }),
      registrationHash: ZERO_HASH,
      sequence: 0,
      stateRoot: ZERO_HASH,
      receipts: []
    };
  }

  private stateFor(registered: RegisteredSemanticLayer): ReferenceVerifierState {
    return {
      semanticLayerAddress: registered.registration.semanticLayerAddress,
      legacySlId: registered.registration.legacySlId,
      registrationHash: registered.registrationHash,
      sequence: registered.sequence,
      stateRoot: registered.stateRoot,
      checkpointId: registered.receipts.at(-1)?.checkpointId
    };
  }

  private buildReceipt(input: {
    input: ReferenceVerifierPayloadInput;
    registration: RegisteredSemanticLayer;
    decoded?: DecodedSemanticLayerTransition;
    timestamp: string;
    payloadHash: string;
    payloadSize?: number;
    sequence: number;
    verdict: VerifierReceiptV1['verdict'];
    reason?: string;
    stateRootBefore: string;
    stateRootAfter?: string;
  }): VerifierReceiptV1 {
    const registration = input.registration.registration;
    const unsigned: Omit<VerifierReceiptV1, 'signature'> = {
      receiptVersion: CONTRACT_VERSION_V1,
      receiptFormat: VERIFIER_RECEIPT_V1_FORMAT,
      semanticLayerAddress: registration.semanticLayerAddress,
      payloadHash: normalizeHash(input.payloadHash),
      sequence: input.sequence,
      verdict: input.verdict,
      stateRootBefore: normalizeHash(input.stateRootBefore),
      checkpointId: checkpointId(registration.semanticLayerAddress, input.sequence, input.payloadHash, input.verdict),
      verifierId: this.verifierId,
      timestamp: input.timestamp
    };
    if (input.registration.registrationHash !== ZERO_HASH) unsigned.registrationHash = input.registration.registrationHash;
    unsigned.slId = input.decoded?.slId ?? registration.legacySlId;
    if (registration.manifestHash !== undefined) unsigned.manifestHash = registration.manifestHash;
    if (input.payloadSize !== undefined) unsigned.payloadSize = input.payloadSize;
    if (input.input.postingId !== undefined) unsigned.postingId = input.input.postingId;
    if (input.input.txHash !== undefined) unsigned.txHash = input.input.txHash;
    if (input.reason !== undefined) unsigned.reason = input.reason;
    if (input.stateRootAfter !== undefined) unsigned.stateRootAfter = normalizeHash(input.stateRootAfter);
    if (input.input.metadata !== undefined) unsigned.metadata = input.input.metadata;

    const receipt = {
      ...unsigned,
      signature: referenceSignature(unsigned)
    };
    assertValidVerifierReceiptV1(receipt);
    return receipt;
  }
}

export async function startReferenceVerifierServer(
  verifier: IoviReferenceVerifier,
  options: { host?: string; port?: number } = {}
): Promise<ReferenceVerifierServer> {
  const server = createServer((request, response) => {
    handleVerifierRequest(verifier, request, response).catch((error) => {
      writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not determine verifier server address');
  return {
    server,
    url: `http://${host}:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

async function handleVerifierRequest(
  verifier: IoviReferenceVerifier,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/health') {
    writeJson(response, 200, { ok: true });
    return;
  }
  if (request.method === 'GET' && (url.pathname === '/registrations' || url.pathname === '/semantic-layers')) {
    writeJson(response, 200, { registrations: verifier.listRegistrations() });
    return;
  }
  if (request.method === 'POST' && (url.pathname === '/registrations' || url.pathname === '/semantic-layers')) {
    const body = await readJson(request);
    const registration = verifier.registerSemanticLayer(body as SemanticLayerRegistrationV1);
    const registered = verifier.getRegistration(registration.semanticLayerAddress);
    writeJson(response, 201, registered);
    return;
  }
  if (request.method === 'GET' && url.pathname.startsWith('/registrations/')) {
    const semanticLayerAddress = decodeURIComponent(url.pathname.slice('/registrations/'.length));
    const registration = verifier.getRegistration(semanticLayerAddress);
    if (!registration) {
      writeJson(response, 404, { error: 'registration not found' });
      return;
    }
    writeJson(response, 200, registration);
    return;
  }
  const semanticLayerMatch = url.pathname.match(/^\/semantic-layers\/([^/]+)(?:\/(state|receipts|manifest))?$/);
  if (request.method === 'GET' && semanticLayerMatch) {
    const semanticLayerAddress = decodeURIComponent(semanticLayerMatch[1]);
    const nested = semanticLayerMatch[2];
    const registration = verifier.getRegistration(semanticLayerAddress);
    if (!registration) {
      writeJson(response, 404, { error: 'semantic layer not registered' });
      return;
    }
    if (nested === 'state') {
      writeJson(response, 200, verifier.getState(semanticLayerAddress));
      return;
    }
    if (nested === 'receipts') {
      writeJson(response, 200, { receipts: verifier.listReceipts({ semanticLayerAddress }) });
      return;
    }
    if (nested === 'manifest') {
      if (registration.manifest === undefined) {
        writeJson(response, 404, { error: 'manifest not configured for semantic layer' });
        return;
      }
      writeJson(response, 200, registration.manifest);
      return;
    }
    writeJson(response, 200, registration);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/manifest') {
    const registrations = verifier.listRegistrations();
    const withManifest = registrations.filter((registration) => registration.manifest !== undefined);
    if (withManifest.length === 1) {
      writeJson(response, 200, withManifest[0].manifest);
      return;
    }
    writeJson(response, 404, {
      error: 'manifest is not a global verifier resource; use /semantic-layers/:address/manifest'
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/state') {
    const semanticLayerAddress = url.searchParams.get('semanticLayerAddress');
    writeJson(
      response,
      200,
      semanticLayerAddress === null ? { states: verifier.listStates() } : verifier.getState(semanticLayerAddress)
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/checkpoints/latest') {
    const semanticLayerAddress = url.searchParams.get('semanticLayerAddress');
    writeJson(
      response,
      200,
      semanticLayerAddress === null ? { states: verifier.listStates() } : verifier.getState(semanticLayerAddress)
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/receipts') {
    const semanticLayerAddress = url.searchParams.get('semanticLayerAddress') ?? undefined;
    writeJson(response, 200, { receipts: verifier.listReceipts({ semanticLayerAddress }) });
    return;
  }
  if (request.method === 'GET' && url.pathname.startsWith('/receipts/')) {
    const payloadHash = decodeURIComponent(url.pathname.slice('/receipts/'.length));
    const receipt = verifier.getReceipt(payloadHash);
    if (!receipt) {
      writeJson(response, 404, { error: 'receipt not found' });
      return;
    }
    writeJson(response, 200, receipt);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/verify') {
    const body = await readJson(request);
    const receipt = verifier.verifyPayload(body as ReferenceVerifierPayloadInput);
    writeJson(response, receipt.verdict === 'accepted' ? 200 : 400, receipt);
    return;
  }

  writeJson(response, 404, { error: 'not found' });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.setHeader('access-control-allow-origin', '*');
  response.end(JSON.stringify(body));
}

function checkpointId(slId: string, sequence: number, payloadHash: string, verdict: string): string {
  return digestHex(`${stripHex(slId)}:${sequence}:${payloadHash}:${verdict}`);
}

function referenceSignature(unsigned: Omit<VerifierReceiptV1, 'signature'>): string {
  return digestHex(`iovi-reference-verifier-v1:${canonicalJson(unsigned)}`);
}

function assertSupportedReferenceRegistration(registration: SemanticLayerRegistrationV1): void {
  assertValidSemanticLayerRegistrationV1(registration);
  const codec = codecName(registration.codec);
  if (codec !== 'iovi-payload-v1') {
    throw new Error(`unsupported codec ${codec}; reference verifier currently supports iovi-payload-v1`);
  }
  const proofStandard = proofStandardName(registration.proofStandard);
  if (proofStandard !== 'declared-state-root' && proofStandard !== 'declared-state-root-v1') {
    throw new Error(
      `unsupported proofStandard ${proofStandard}; reference verifier currently supports declared-state-root`
    );
  }
}

function assertNoPrivateMaterial(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((nested, index) => assertNoPrivateMaterial(nested, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (PRIVATE_MATERIAL_KEYS.has(normalized)) {
      throw new Error(`Private material field "${path}.${key}" must not be sent to verifier or IOVI APIs`);
    }
    assertNoPrivateMaterial(nested, `${path}.${key}`);
  }
}

function assertCodecRef(codec: SemanticLayerCodecRef, label: string): void {
  if (typeof codec === 'string') {
    assertNonEmpty(codec, label);
    return;
  }
  assertNonEmpty(codec.name, `${label}.name`);
  if (codec.version !== undefined) assertNonEmpty(codec.version, `${label}.version`);
  if (codec.compression !== undefined) assertNonEmpty(codec.compression, `${label}.compression`);
  if (codec.schema !== undefined) assertUrl(codec.schema, `${label}.schema`);
}

function assertProofStandardRef(proofStandard: SemanticLayerProofStandardRef, label: string): void {
  if (typeof proofStandard === 'string') {
    assertNonEmpty(proofStandard, label);
    return;
  }
  assertNonEmpty(proofStandard.name, `${label}.name`);
  if (proofStandard.version !== undefined) assertNonEmpty(proofStandard.version, `${label}.version`);
  if (proofStandard.verifierKey !== undefined) assertNonEmpty(proofStandard.verifierKey, `${label}.verifierKey`);
}

function codecName(codec: SemanticLayerCodecRef): string {
  return typeof codec === 'string' ? codec : codec.name;
}

function proofStandardName(proofStandard: SemanticLayerProofStandardRef): string {
  return typeof proofStandard === 'string' ? proofStandard : proofStandard.name;
}

function normalizeSemanticLayerAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('0x')) return trimmed.toLowerCase();
  return trimmed;
}

function assertSemanticLayerAddress(value: string, label: string): void {
  assertNonEmpty(value, label);
}

function assertTransitionFunction(transitionFunction: SemanticLayerTransitionFunctionV1): void {
  if (transitionFunction.type === 'repo') {
    assertUrl(transitionFunction.url, 'transitionFunction.url');
    assertNonEmpty(transitionFunction.commit, 'transitionFunction.commit');
    return;
  }
  if (transitionFunction.type === 'wasm') {
    assertUrl(transitionFunction.url, 'transitionFunction.url');
    assertNonEmpty(transitionFunction.digest, 'transitionFunction.digest');
    return;
  }
  if (transitionFunction.type === 'builtin') {
    assertNonEmpty(transitionFunction.name, 'transitionFunction.name');
    assertNonEmpty(transitionFunction.version, 'transitionFunction.version');
    return;
  }
  throw new Error('transitionFunction.type must be repo, wasm, or builtin');
}

function assertVerifierRef(verifier: SemanticLayerVerifierRefV1, index: number): void {
  assertNonEmpty(verifier.name, `verifiers[${index}].name`);
  assertUrl(verifier.endpoint, `verifiers[${index}].endpoint`);
  assertNonEmpty(verifier.verifierId, `verifiers[${index}].verifierId`);
  if (verifier.receiptKey !== undefined) assertNonEmpty(verifier.receiptKey, `verifiers[${index}].receiptKey`);
  assertExact(verifier.receiptFormat, VERIFIER_RECEIPT_V1_FORMAT, `verifiers[${index}].receiptFormat`);
}

function assertCheckpointPolicy(policy: SemanticLayerCheckpointPolicyV1, verifierCount: number): void {
  if (policy.type === 'single') {
    assertExact(policy.requiredVerifiers, 1, 'checkpointPolicy.requiredVerifiers');
    return;
  }
  if (policy.type === 'quorum') {
    assertPositiveInteger(policy.requiredVerifiers, 'checkpointPolicy.requiredVerifiers');
    if (policy.requiredVerifiers > verifierCount) {
      throw new Error('checkpointPolicy.requiredVerifiers cannot exceed verifier count');
    }
    return;
  }
  if (policy.type === 'proof') {
    assertNonEmpty(policy.proofSystem, 'checkpointPolicy.proofSystem');
    if (policy.requiredVerifiers !== undefined) {
      assertPositiveInteger(policy.requiredVerifiers, 'checkpointPolicy.requiredVerifiers');
    }
    return;
  }
  throw new Error('checkpointPolicy.type must be single, quorum, or proof');
}

function assertRoute(value: string, label: string): void {
  assertNonEmpty(value, label);
  if (!value.startsWith('/')) throw new Error(`${label} must start with /`);
}

function assertUrl(value: string, label: string): void {
  assertNonEmpty(value, label);
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${label} must be an http(s) URL`);
  }
}

function assertHexHash(value: string, label: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be a 32-byte hex string`);
}

function assertHexBytes(value: string, bytes: number, label: string): void {
  const normalized = value.startsWith('0x') ? value.slice(2) : value;
  if (!new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be a ${bytes}-byte hex string`);
  }
}

function assertDateTime(value: string, label: string): void {
  assertNonEmpty(value, label);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label} must be a valid date-time string`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
}

function assertExact<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label} must be ${String(expected)}`);
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined)) as Partial<T>;
}

function digestHex(value: string): string {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function fixedHexBytes(value: string, expectedBytes: number, label: string): Uint8Array {
  const bytes = hexToBytes(value, label);
  if (bytes.byteLength !== expectedBytes) throw new Error(`${label} must be ${expectedBytes} bytes`);
  return bytes;
}

function hexToBytes(value: string, label: string): Uint8Array {
  let normalized = value.trim().toLowerCase();
  if (normalized.startsWith('0x')) normalized = normalized.slice(2);
  if (!normalized) throw new Error(`${label} is empty`);
  if (normalized.length % 2 !== 0) normalized = `0${normalized}`;
  if (!/^[0-9a-f]*$/.test(normalized)) throw new Error(`${label} must be hex`);
  return Uint8Array.from(Buffer.from(normalized, 'hex'));
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

function readU32(bytes: Uint8Array): number {
  return ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
}

function readU16(bytes: Uint8Array): number {
  return (bytes[0] << 8) + bytes[1];
}

function readU64(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  return value;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

class PayloadReader {
  private offset = 0;

  constructor(private readonly payload: Uint8Array) {}

  read(length: number): Uint8Array {
    const next = this.offset + length;
    if (next > this.payload.byteLength) throw new Error('payload ended unexpectedly');
    const bytes = this.payload.slice(this.offset, next);
    this.offset = next;
    return bytes;
  }

  assertDone(): void {
    if (this.offset !== this.payload.byteLength) {
      throw new Error(`payload has ${this.payload.byteLength - this.offset} trailing bytes`);
    }
  }
}

function normalizeHash(value: string): string {
  const normalized = value.startsWith('0x') ? value : `0x${value}`;
  return normalized.toLowerCase();
}

function stripHex(value: string): string {
  return value.toLowerCase().replace(/^0x/, '');
}

function canonicalJson(value: unknown): string {
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
