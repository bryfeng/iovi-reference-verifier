import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export const SEMANTIC_LAYER_MANIFEST_V1_FORMAT = 'iovi-semantic-layer-manifest-v1';
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

export type VerifierReceiptV1 = {
  receiptVersion: typeof CONTRACT_VERSION_V1;
  receiptFormat: typeof VERIFIER_RECEIPT_V1_FORMAT;
  slId: string;
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
  slId: string;
  sequence: number;
  stateRoot: string;
  checkpointId?: string;
};

export type ReferenceVerifierOptions = {
  manifest: SemanticLayerManifestV1;
  verifierId?: string;
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
  assertHexBytes(receipt.slId, 4, 'slId');
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

export function isVerifierTrustedByManifest(
  manifest: SemanticLayerManifestV1,
  receipt: Pick<VerifierReceiptV1, 'slId' | 'verifierId' | 'receiptFormat'>
): ReceiptTrustResult {
  assertValidSemanticLayerManifestV1(manifest);
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

export class IoviReferenceVerifier {
  readonly manifest: SemanticLayerManifestV1;
  readonly verifierId: string;
  readonly manifestHash: string;
  private stateRoot: string;
  private sequence = 0;
  private readonly receipts: VerifierReceiptV1[] = [];

  constructor(options: ReferenceVerifierOptions) {
    assertValidSemanticLayerManifestV1(options.manifest);
    this.manifest = options.manifest;
    this.manifestHash = semanticLayerManifestV1Hash(options.manifest);
    this.verifierId = options.verifierId ?? options.manifest.verifiers[0].verifierId;
    this.stateRoot = options.initialStateRoot ?? ZERO_HASH;
  }

  getState(): ReferenceVerifierState {
    return {
      slId: this.manifest.slId,
      sequence: this.sequence,
      stateRoot: this.stateRoot,
      checkpointId: this.receipts.at(-1)?.checkpointId
    };
  }

  listReceipts(): VerifierReceiptV1[] {
    return [...this.receipts];
  }

  getReceipt(payloadHash: string): VerifierReceiptV1 | undefined {
    return this.receipts.find((receipt) => receipt.payloadHash === payloadHash);
  }

  verifyPayload(input: ReferenceVerifierPayloadInput): VerifierReceiptV1 {
    const timestamp = input.timestamp ?? new Date().toISOString();
    try {
      const payloadHex = input.payloadHex ?? scalarHexToPayloadHex(input.dataScalars ?? []);
      const decoded = decodeSemanticLayerTransition(payloadHex);
      const expectedPayloadHash = input.payloadHash ?? decoded.payloadHash;
      if (decoded.payloadHash !== expectedPayloadHash) {
        throw new Error(`payload hash mismatch: expected ${expectedPayloadHash}, decoded ${decoded.payloadHash}`);
      }
      if (stripHex(decoded.slId) !== stripHex(this.manifest.slId)) {
        throw new Error(`semantic layer mismatch: expected ${this.manifest.slId}, got ${decoded.slId}`);
      }
      const expectedSequence = this.sequence + 1;
      if (Number(decoded.sequence) !== expectedSequence) {
        throw new Error(`sequence mismatch: expected ${expectedSequence}, got ${decoded.sequence.toString()}`);
      }
      if (normalizeHash(decoded.prevStateHash) !== normalizeHash(this.stateRoot)) {
        throw new Error(`prevStateHash mismatch: expected ${this.stateRoot}, got ${decoded.prevStateHash}`);
      }

      const receipt = this.buildReceipt({
        input,
        timestamp,
        payloadHash: decoded.payloadHash,
        payloadSize: decoded.payloadSize,
        sequence: Number(decoded.sequence),
        verdict: 'accepted',
        stateRootBefore: this.stateRoot,
        stateRootAfter: decoded.newStateHash
      });
      assertReceiptTrustedByManifest(this.manifest, receipt);
      this.sequence = Number(decoded.sequence);
      this.stateRoot = decoded.newStateHash;
      this.receipts.push(receipt);
      return receipt;
    } catch (error) {
      const receipt = this.buildReceipt({
        input,
        timestamp,
        payloadHash: input.payloadHash ?? digestHex(JSON.stringify(input)),
        payloadSize: input.payloadSize,
        sequence: this.sequence + 1,
        verdict: 'rejected',
        reason: error instanceof Error ? error.message : String(error),
        stateRootBefore: this.stateRoot,
        stateRootAfter: this.stateRoot
      });
      assertReceiptTrustedByManifest(this.manifest, receipt);
      this.receipts.push(receipt);
      return receipt;
    }
  }

  verifyUtxos(utxos: Array<{ id: string; amount?: number; data?: string[]; txHash?: string }>): VerifierReceiptV1[] {
    return utxos
      .filter((utxo) => Array.isArray(utxo.data) && utxo.data.length > 0)
      .map((utxo) =>
        this.verifyPayload({
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

  private buildReceipt(input: {
    input: ReferenceVerifierPayloadInput;
    timestamp: string;
    payloadHash: string;
    payloadSize?: number;
    sequence: number;
    verdict: VerifierReceiptV1['verdict'];
    reason?: string;
    stateRootBefore: string;
    stateRootAfter?: string;
  }): VerifierReceiptV1 {
    const unsigned = {
      receiptVersion: CONTRACT_VERSION_V1,
      receiptFormat: VERIFIER_RECEIPT_V1_FORMAT,
      slId: this.manifest.slId,
      manifestHash: this.manifestHash,
      payloadHash: normalizeHash(input.payloadHash),
      payloadSize: input.payloadSize,
      postingId: input.input.postingId,
      txHash: input.input.txHash,
      sequence: input.sequence,
      verdict: input.verdict,
      reason: input.reason,
      stateRootBefore: normalizeHash(input.stateRootBefore),
      stateRootAfter: input.stateRootAfter ? normalizeHash(input.stateRootAfter) : undefined,
      checkpointId: checkpointId(this.manifest.slId, input.sequence, input.payloadHash, input.verdict),
      verifierId: this.verifierId,
      timestamp: input.timestamp,
      metadata: input.input.metadata
    } satisfies Omit<VerifierReceiptV1, 'signature'>;

    return {
      ...unsigned,
      signature: referenceSignature(unsigned)
    };
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
  if (request.method === 'GET' && url.pathname === '/manifest') {
    writeJson(response, 200, verifier.manifest);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/state') {
    writeJson(response, 200, verifier.getState());
    return;
  }
  if (request.method === 'GET' && url.pathname === '/checkpoints/latest') {
    writeJson(response, 200, verifier.getState());
    return;
  }
  if (request.method === 'GET' && url.pathname === '/receipts') {
    writeJson(response, 200, { receipts: verifier.listReceipts() });
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
