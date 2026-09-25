import { buildFakeAts } from './server.js';

// Local test software. It binds to the loopback interface only and is never exposed.
const host = process.env.FAKE_ATS_HOST ?? '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  throw new Error('The fake ATS is local-only test software');
}
const port = Number(process.env.FAKE_ATS_PORT ?? '3311');
const app = buildFakeAts({ logger: true });
await app.listen({ host, port });
