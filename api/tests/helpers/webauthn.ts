import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import * as cbor from 'cbor';

export type P256KeyPair = ReturnType<typeof generateKeyPairSync>;

function sha256(data: Buffer | string) {
  return createHash('sha256').update(data).digest();
}

function b64url(buf: Buffer) {
  return buf.toString('base64url');
}

function uint16be(n: number) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(n, 0);
  return buf;
}

function uint32be(n: number) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n >>> 0, 0);
  return buf;
}

function coseKeyFromPublicJwk(jwk: { x: string; y: string }) {
  const key = new Map<number, any>();
  key.set(1, 2); // kty: EC2
  key.set(3, -7); // alg: ES256
  key.set(-1, 1); // crv: P-256
  key.set(-2, Buffer.from(jwk.x, 'base64url'));
  key.set(-3, Buffer.from(jwk.y, 'base64url'));
  return cbor.encode(key);
}

function buildClientDataJSON(params: { type: 'webauthn.create' | 'webauthn.get'; challenge: string; origin: string }) {
  return Buffer.from(
    JSON.stringify({
      type: params.type,
      challenge: params.challenge,
      origin: params.origin,
      crossOrigin: false,
    }),
    'utf8',
  );
}

function buildAttestationObject(params: {
  rpId: string;
  credentialId: Buffer;
  cosePublicKey: Buffer;
}) {
  const rpIdHash = sha256(Buffer.from(params.rpId, 'utf8'));
  const flags = Buffer.from([0x45]); // UP + UV + AT
  const signCount = uint32be(0);
  const aaguid = Buffer.alloc(16, 0);
  const credIdLen = uint16be(params.credentialId.length);
  const authData = Buffer.concat([
    rpIdHash,
    flags,
    signCount,
    aaguid,
    credIdLen,
    params.credentialId,
    params.cosePublicKey,
  ]);

  return cbor.encode({
    fmt: 'none',
    authData,
    attStmt: {},
  });
}

export function generateP256KeyPair() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

export function buildRegistrationResponse(params: { options: any; rpId: string; origin: string; keyPair: P256KeyPair }) {
  const publicJwk = params.keyPair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const credentialId = randomBytes(16);
  const cosePublicKey = coseKeyFromPublicJwk(publicJwk);
  const attestationObject = buildAttestationObject({
    rpId: params.rpId,
    credentialId,
    cosePublicKey,
  });
  const clientDataJSON = buildClientDataJSON({
    type: 'webauthn.create',
    challenge: params.options.challenge,
    origin: params.origin,
  });

  const credentialIdB64 = b64url(credentialId);

  return {
    credentialId: credentialIdB64,
    response: {
      id: credentialIdB64,
      rawId: credentialIdB64,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
      },
      clientExtensionResults: {},
    },
  };
}

export function buildAssertionResponse(params: {
  options: any;
  rpId: string;
  origin: string;
  credentialId: string;
  keyPair: P256KeyPair;
  signCount?: number;
}) {
  const rpIdHash = sha256(Buffer.from(params.rpId, 'utf8'));
  const flags = Buffer.from([0x05]); // UP + UV
  const signCount = uint32be(params.signCount ?? 1);
  const authenticatorData = Buffer.concat([rpIdHash, flags, signCount]);
  const clientDataJSON = buildClientDataJSON({
    type: 'webauthn.get',
    challenge: params.options.challenge,
    origin: params.origin,
  });
  const clientDataHash = sha256(clientDataJSON);
  const signatureBase = Buffer.concat([authenticatorData, clientDataHash]);
  const signature = sign('sha256', signatureBase, params.keyPair.privateKey);

  return {
    id: params.credentialId,
    rawId: params.credentialId,
    type: 'public-key',
    response: {
      clientDataJSON: b64url(clientDataJSON),
      authenticatorData: b64url(authenticatorData),
      signature: b64url(signature),
    },
    clientExtensionResults: {},
  };
}

