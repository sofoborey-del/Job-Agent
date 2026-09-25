/**
 * The worker process boundary. It reads one request on stdin, runs it in an isolated browser
 * context, and writes a sanitised report on stdout. Cookies, storage state, page text, uploaded
 * file bytes and applicant values never cross back out of this process.
 */
import { runWorkerRequest } from './run.js';
import { workerRequestSchema } from './protocol.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const raw = await readStdin();
try {
  const request = workerRequestSchema.parse(JSON.parse(raw));
  const result = await runWorkerRequest(request);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  process.exit(0);
} catch (error) {
  // The message is deliberately generic: a parse or run failure must not echo the request back.
  process.stdout.write(
    `${JSON.stringify({ ok: false, errorCode: error instanceof Error ? error.name : 'unknown' })}\n`,
  );
  process.exit(1);
}
