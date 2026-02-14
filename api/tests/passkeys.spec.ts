import request from 'supertest';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import * as cbor from 'cbor';
import { createServer } from '../src/index';
import { env } from '../src/config/env';

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

function buildClientDataJSON(type: 'webauthn.create' | 'webauthn.get', challenge: string) {
  return Buffer.from(
    JSON.stringify({
      type,
      challenge,
      origin: env.PASSKEY_ORIGIN,
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

function buildRegistrationResponse(options: any, keyPair: { publicKey: any; privateKey: any }) {
  const publicJwk = keyPair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const credentialId = randomBytes(16);
  const cosePublicKey = coseKeyFromPublicJwk(publicJwk);
  const attestationObject = buildAttestationObject({
    rpId: env.PASSKEY_RP_ID,
    credentialId,
    cosePublicKey,
  });
  const clientDataJSON = buildClientDataJSON('webauthn.create', options.challenge);

  const credentialIdB64 = b64url(credentialId);

  return {
    id: credentialIdB64,
    rawId: credentialIdB64,
    type: 'public-key',
    response: {
      clientDataJSON: b64url(clientDataJSON),
      attestationObject: b64url(attestationObject),
    },
    clientExtensionResults: {},
  };
}

function buildAssertionResponse(options: any, credentialIdB64: string, keyPair: { privateKey: any }) {
  const rpIdHash = sha256(Buffer.from(env.PASSKEY_RP_ID, 'utf8'));
  const flags = Buffer.from([0x05]); // UP + UV
  const signCount = uint32be(1);
  const authenticatorData = Buffer.concat([rpIdHash, flags, signCount]);
  const clientDataJSON = buildClientDataJSON('webauthn.get', options.challenge);
  const clientDataHash = sha256(clientDataJSON);
  const signatureBase = Buffer.concat([authenticatorData, clientDataHash]);
  const signature = sign('sha256', signatureBase, keyPair.privateKey);

  return {
    id: credentialIdB64,
    rawId: credentialIdB64,
    type: 'public-key',
    response: {
      clientDataJSON: b64url(clientDataJSON),
      authenticatorData: b64url(authenticatorData),
      signature: b64url(signature),
    },
    clientExtensionResults: {},
  };
}

describe('passkey auth', () => {
  it('registers and authenticates with WebAuthn passkeys', async () => {
    const app = await createServer();
    try {
      const keyPair = generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
      });

      const optionsResp = await request(app.server)
        .post('/v1/auth/passkey/register/options')
        .send({ handle: 'alice' });
      expect(optionsResp.status).toBe(200);
      expect(optionsResp.body.challengeId).toBeTruthy();
      expect(optionsResp.body.options?.challenge).toBeTruthy();

      const registrationResponse = buildRegistrationResponse(optionsResp.body.options, keyPair);
      const credId = registrationResponse.id;

      const verifyResp = await request(app.server)
        .post('/v1/auth/passkey/register/verify')
        .send({ challengeId: optionsResp.body.challengeId, response: registrationResponse });
      expect(verifyResp.status).toBe(200);
      expect(verifyResp.body.ok).toBe(true);
      expect(verifyResp.body.token).toMatch(/^mmp\./);
      expect(verifyResp.body.user?.walletAddress).toMatch(/^0x[0-9a-f]{40}$/i);
      const userId = verifyResp.body.user.id;

      const loginOptionsResp = await request(app.server)
        .post('/v1/auth/passkey/login/options')
        .send({ handle: 'alice' });
      expect(loginOptionsResp.status).toBe(200);
      expect(loginOptionsResp.body.options?.challenge).toBeTruthy();

      const assertionResponse = buildAssertionResponse(loginOptionsResp.body.options, credId, keyPair);
      const loginVerifyResp = await request(app.server)
        .post('/v1/auth/passkey/login/verify')
        .send({ challengeId: loginOptionsResp.body.challengeId, response: assertionResponse });

      expect(loginVerifyResp.status).toBe(200);
      expect(loginVerifyResp.body.ok).toBe(true);
      expect(loginVerifyResp.body.token).toMatch(/^mmp\./);
      expect(loginVerifyResp.body.user?.id).toBe(userId);
    } finally {
      await app.close();
    }
  });
});
