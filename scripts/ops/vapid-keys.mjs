#!/usr/bin/env node
/** Generate a VAPID P-256 key pair in the base64url form expected by the API. */
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });
const priv = privateKey.export({ format: 'jwk' });
const rawPublic = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(pub.x, 'base64url'),
  Buffer.from(pub.y, 'base64url'),
]);
const rawPrivate = Buffer.from(priv.d, 'base64url');

console.log(`VAPID_PUBLIC_KEY=${rawPublic.toString('base64url')}`);
console.log(`VAPID_PRIVATE_KEY=${rawPrivate.toString('base64url')}`);
console.log('VAPID_SUBJECT=mailto:ops@example.com');
