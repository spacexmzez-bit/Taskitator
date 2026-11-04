// Generates the ES256 key pair for the offline Pro entitlement. Run once: node tools/offline-pro-keygen.mjs
//   1. Store the PRIVATE key as a Worker secret: npx wrangler secret put OFFLINE_PRO_PRIVATE_JWK
//      (paste the one-line JSON). Never commit it.
//   2. Paste the PUBLIC key into core.js as TASKITATOR_AUTH_CONFIG.offlineProPublicKey, then deploy.
// Until both are set, offline Pro stays off and everything else works as before.
import { webcrypto } from 'node:crypto';

const { publicKey, privateKey } = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
console.log('PRIVATE (Worker secret OFFLINE_PRO_PRIVATE_JWK, never commit):');
console.log(JSON.stringify(await webcrypto.subtle.exportKey('jwk', privateKey)));
console.log('\nPUBLIC (core.js offlineProPublicKey):');
console.log(JSON.stringify(await webcrypto.subtle.exportKey('jwk', publicKey)));
