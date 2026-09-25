import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  artifactMetadata,
  isLoopbackOrigin,
  screenshotPlanFor,
  type ArtifactMetadata,
} from '@job-agent/browser-core';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export type WorkerSessionOptions = {
  targetOrigin: string;
  headless?: boolean;
  /** Applicant values that must never reach a screenshot, trace, log or error. */
  secrets: readonly string[];
  artifactRoot?: string;
};

/**
 * One isolated browser context per attempt. Nothing is shared with the user's own browser: there is
 * no persistent profile, no imported cookies and no saved storage state. Everything the context
 * produces stays inside this process's own temporary directory and is deleted when it closes.
 */
export class WorkerSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private artifactDir = '';
  private uploadDir = '';
  readonly artifacts: ArtifactMetadata[] = [];

  constructor(private readonly options: WorkerSessionOptions) {
    if (!isLoopbackOrigin(options.targetOrigin)) {
      throw new Error('The browser worker only ever opens a local address');
    }
  }

  async open(): Promise<Page> {
    this.artifactDir = await mkdtemp(
      path.join(this.options.artifactRoot ?? tmpdir(), 'jaa-worker-'),
    );
    this.uploadDir = await mkdtemp(path.join(tmpdir(), 'jaa-upload-'));
    this.browser = await chromium.launch({ headless: this.options.headless ?? true });
    this.context = await this.browser.newContext({
      // No storageState, no persistent profile, no imported cookies.
      acceptDownloads: false,
      javaScriptEnabled: true,
    });
    await this.context.tracing.start({ screenshots: false, snapshots: false, sources: false });

    // Anything that is not the fake ATS is refused at the network layer as well as the validator.
    await this.context.route('**/*', async (route) => {
      const url = route.request().url();
      if (!isLoopbackOrigin(url)) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });

    return this.context.newPage();
  }

  /**
   * Writes an approved document into a directory owned by this session alone, so the form receives
   * it under its own name. The directory is removed when the session closes.
   */
  async materialiseUpload(filename: string, bytes: Buffer): Promise<string> {
    const safeName = path.basename(filename).replace(/[^A-Za-z0-9._-]/g, '_');
    const target = path.join(this.uploadDir, safeName);
    await writeFile(target, bytes);
    return target;
  }

  /** Masks every input, textarea and select before the pixels are taken. */
  async captureScreenshot(page: Page, label: string): Promise<ArtifactMetadata> {
    const plan = screenshotPlanFor([]);
    const objectKey = path.join(this.artifactDir, `${label}.png`);
    const buffer = await page.screenshot({
      path: objectKey,
      fullPage: plan.fullPage,
      mask: plan.maskSelectors.map((selector) => page.locator(selector)),
      maskColor: '#334155',
    });
    const metadata = artifactMetadata({
      kind: 'screenshot',
      objectKey,
      bytes: buffer.byteLength,
      content: buffer,
    });
    this.artifacts.push(metadata);
    return metadata;
  }

  async captureValidationLog(
    messages: readonly string[],
    label: string,
  ): Promise<ArtifactMetadata> {
    const objectKey = path.join(this.artifactDir, `${label}.log`);
    const content = messages.join('\n');
    await writeFile(objectKey, content, 'utf8');
    const metadata = artifactMetadata({
      kind: 'validation_log',
      objectKey,
      bytes: Buffer.byteLength(content),
      content,
    });
    this.artifacts.push(metadata);
    return metadata;
  }

  async close(): Promise<void> {
    if (this.context !== null) {
      const tracePath = path.join(this.artifactDir, 'trace.zip');
      try {
        await this.context.tracing.stop({ path: tracePath });
        this.artifacts.push(
          artifactMetadata({ kind: 'trace', objectKey: tracePath, bytes: 0, content: tracePath }),
        );
      } catch {
        // A trace is best effort; losing it must never fail an attempt.
      }
      await this.context.close();
      this.context = null;
    }
    if (this.browser !== null) {
      await this.browser.close();
      this.browser = null;
    }
    if (this.uploadDir !== '') {
      await rm(this.uploadDir, { recursive: true, force: true });
      this.uploadDir = '';
    }
  }

  /** Removes every artefact this session produced. */
  async discardArtifacts(): Promise<void> {
    if (this.artifactDir === '') return;
    await rm(this.artifactDir, { recursive: true, force: true });
    this.artifacts.length = 0;
  }
}
