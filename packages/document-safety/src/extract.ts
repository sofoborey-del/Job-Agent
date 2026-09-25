import mammoth from 'mammoth';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export const MAX_EXTRACTED_CHARACTERS = 100_000;

/** Collapses whitespace and caps length. Extraction output is data, never instructions. */
export function normaliseExtractedText(
  text: string,
  maxCharacters = MAX_EXTRACTED_CHARACTERS,
): string {
  return text
    .replaceAll('\u0000', '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxCharacters);
}

/**
 * Extracts text locally with pdf.js. No network fetching, no system fonts, no WASM and no worker:
 * the document cannot reach out while being read.
 */
export async function extractPdfText(bytes: Buffer, maxPages = 30): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    stopAtErrors: true,
  });
  const document: PDFDocumentProxy = await loadingTask.promise;
  try {
    if (document.numPages > maxPages) {
      throw new Error(`PDF exceeds the ${String(maxPages)}-page safety limit`);
    }
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let currentLine = '';
      let previousY: number | null = null;
      for (const item of content.items) {
        if (!('str' in item) || item.str.trim() === '') continue;
        const transform = item.transform as unknown[];
        const rawY = transform[5];
        const y = typeof rawY === 'number' ? rawY : 0;
        if (previousY !== null && Math.abs(y - previousY) > 2 && currentLine !== '') {
          lines.push(currentLine.trim());
          currentLine = '';
        }
        currentLine += (currentLine === '' ? '' : ' ') + item.str;
        if (item.hasEOL) {
          lines.push(currentLine.trim());
          currentLine = '';
        }
        previousY = y;
      }
      if (currentLine !== '') lines.push(currentLine.trim());
      pages.push(lines.join('\n'));
      page.cleanup();
    }
    return pages.join('\n\n');
  } finally {
    await loadingTask.destroy();
  }
}

export async function extractDocxText(
  bytes: Buffer,
): Promise<{ text: string; warnings: string[] }> {
  const result = await mammoth.extractRawText({ buffer: bytes });
  return {
    text: result.value,
    warnings: result.messages.map((message) => message.message),
  };
}
