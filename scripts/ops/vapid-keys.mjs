#!/usr/bin/env node
/** Generate a VAPID P-256 key pair in the base64url form expected by the API. */
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });
const priv = privateKey.export({ format: 'jwk' });
const encode = (value) => Buffer.from(value, 'base64url').toString('base64url');

console.log(`VAPID_PUBLIC_KEY=04${encode(pub.x)}${encode(pub.y)}`);
console.log(`VAPID_PRIVATE_KEY=${encode(priv.d)}`);
console.log('VAPID_SUBJECT=mailto:ops@example.com');
