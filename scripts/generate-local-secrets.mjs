import { randomBytes } from 'node:crypto';

console.log(`APP_ENCRYPTION_KEY_BASE64=${randomBytes(32).toString('base64')}`);
console.log(`PROFILE_ADMIN_TOKEN=${randomBytes(32).toString('base64url')}`);
