import { createHash } from 'node:crypto';

import type { UploadedFile } from './state.js';

export type ParsedMultipart = {
  fields: Record<string, string>;
  files: Record<string, UploadedFile>;
};

/**
 * A deliberately small multipart reader for this test server's own forms. It records file names,
 * sizes and digests but never keeps the file bytes, so an uploaded CV does not sit in memory.
 */
export function parseMultipart(body: Buffer, contentType: string): ParsedMultipart {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (boundary === undefined) throw new Error('missing multipart boundary');
  const delimiter = Buffer.from(`--${boundary.trim()}`, 'utf8');

  const fields: Record<string, string> = {};
  const files: Record<string, UploadedFile> = {};

  let cursor = body.indexOf(delimiter);
  while (cursor >= 0) {
    const partStart = cursor + delimiter.length;
    if (body.subarray(partStart, partStart + 2).toString('utf8') === '--') break;
    const next = body.indexOf(delimiter, partStart);
    if (next < 0) break;
    const raw = body.subarray(partStart, next);
    const headerEnd = raw.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const headerText = raw.subarray(0, headerEnd).toString('utf8');
      let content = raw.subarray(headerEnd + 4);
      if (content.subarray(content.length - 2).toString('utf8') === '\r\n') {
        content = content.subarray(0, content.length - 2);
      }
      const nameMatch = /name="([^"]*)"/i.exec(headerText);
      const filenameMatch = /filename="([^"]*)"/i.exec(headerText);
      const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText);
      const name = nameMatch?.[1];
      if (name !== undefined) {
        if (filenameMatch?.[1] !== undefined && filenameMatch[1] !== '') {
          files[name] = {
            fieldName: name,
            filename: filenameMatch[1],
            bytes: content.length,
            sha256: createHash('sha256').update(content).digest('hex'),
            contentType: typeMatch?.[1]?.trim() ?? 'application/octet-stream',
          };
        } else {
          fields[name] = content.toString('utf8');
        }
      }
    }
    cursor = next;
  }
  return { fields, files };
}
