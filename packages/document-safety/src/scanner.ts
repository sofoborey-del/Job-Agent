import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

export const PDF_MIME = 'application/pdf';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type SafeDocumentMimeType = typeof PDF_MIME | typeof DOCX_MIME;

export interface MalwareScanner {
  scan(bytes: Uint8Array, mimeType: SafeDocumentMimeType): Promise<void>;
}

export class ThreatDetectedError extends Error {
  constructor(message = 'Microsoft Defender reported a threat in the document') {
    super(message);
    this.name = 'ThreatDetectedError';
  }
}

async function defenderExecutable(): Promise<string> {
  const programData = process.env.ProgramData;
  if (programData !== undefined) {
    const platformRoot = path.join(programData, 'Microsoft', 'Windows Defender', 'Platform');
    try {
      const directories = (await readdir(platformRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const directory of directories) {
        const candidate = path.join(platformRoot, directory, 'MpCmdRun.exe');
        try {
          await executeFile(candidate, ['-?'], { timeout: 10_000, windowsHide: true });
          return candidate;
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code !== 'ENOENT')
            return candidate;
        }
      }
    } catch {
      // Fall through to the stable installation path.
    }
  }
  const programFiles = process.env.ProgramFiles;
  if (programFiles === undefined) throw new Error('Microsoft Defender scanner is unavailable');
  return path.join(programFiles, 'Windows Defender', 'MpCmdRun.exe');
}

/**
 * Scans bytes with Microsoft Defender in a throwaway directory. The file never keeps its original
 * name, remediation is disabled so Defender cannot quarantine anything outside this directory, and
 * the directory is removed whatever the outcome.
 */
export class WindowsDefenderScanner implements MalwareScanner {
  constructor(private readonly label = 'document') {}

  async scan(bytes: Uint8Array, mimeType: SafeDocumentMimeType): Promise<void> {
    if (process.platform !== 'win32')
      throw new Error('Microsoft Defender scanning requires Windows');
    const directory = await mkdtemp(path.join(tmpdir(), 'job-agent-scan-'));
    const extension = mimeType === PDF_MIME ? '.pdf' : '.docx';
    const target = path.join(directory, `${this.label}${extension}`);
    try {
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      const executable = await defenderExecutable();
      try {
        const result = await executeFile(
          executable,
          ['-Scan', '-ScanType', '3', '-File', target, '-DisableRemediation'],
          { timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024 },
        );
        if (!/found no threats/i.test(result.stdout)) {
          throw new Error('Microsoft Defender did not confirm a clean scan');
        }
      } catch (error) {
        const output =
          error instanceof Error && 'stdout' in error && typeof error.stdout === 'string'
            ? error.stdout
            : '';
        if (/found no threats/i.test(output)) return;
        if (/threat|malware/i.test(output)) throw new ThreatDetectedError();
        throw new Error('Microsoft Defender could not complete the scan');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
