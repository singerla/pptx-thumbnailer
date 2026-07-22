/**
 * HTTP client for a running pptx-thumbnailer service. Needs only Node >= 18
 * (global fetch) — no LibreOffice on the consumer side.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import * as path from 'path';
import { ConvertOptions, SlideImage } from './convert';

export type ClientConvertOptions = Pick<
  ConvertOptions,
  'width' | 'dpi' | 'slide' | 'format'
>;

export interface ThumbnailerClientOptions {
  /** Abort the request after this many ms (default 180000). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface JsonResponse {
  slideCount: number;
  format: string;
  slides: Array<{ index: number; file: string; data: string }>;
}

export class ThumbnailerClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, opts: ThumbnailerClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async health(): Promise<{
    status: string;
    soffice: boolean;
    pdftocairo: boolean;
  }> {
    const res = await this.fetchImpl(`${this.baseUrl}/healthz`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return (await res.json()) as {
      status: string;
      soffice: boolean;
      pdftocairo: boolean;
    };
  }

  /**
   * Convert a pptx (path or Buffer) into slide images via the service.
   */
  async thumbnails(
    input: string | Buffer,
    opts: ClientConvertOptions = {}
  ): Promise<SlideImage[]> {
    const body = Buffer.isBuffer(input) ? input : await readFile(input);
    const params = new URLSearchParams();
    if (opts.width !== undefined) params.set('width', String(opts.width));
    if (opts.dpi !== undefined) params.set('dpi', String(opts.dpi));
    if (opts.slide !== undefined) params.set('slide', String(opts.slide));
    if (opts.format) params.set('format', opts.format);
    const query = params.toString();

    const res = await this.fetchImpl(
      `${this.baseUrl}/thumbnails${query ? `?${query}` : ''}`,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          Accept: 'application/json',
        },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      }
    );

    if (!res.ok) {
      let detail = '';
      try {
        detail = ((await res.json()) as { error?: string }).error ?? '';
      } catch {
        /* non-JSON error body */
      }
      throw new Error(
        `pptx-thumbnailer request failed (${res.status})${
          detail ? `: ${detail}` : ''
        }`
      );
    }

    const payload = (await res.json()) as JsonResponse;
    return payload.slides.map((s) => ({
      index: s.index,
      file: s.file,
      data: Buffer.from(s.data, 'base64'),
    }));
  }

  /**
   * Convenience: convert and write 'slide-<n>.<ext>' files into outDir
   * (created if missing). Returns the written file paths.
   */
  async thumbnailsToDir(
    input: string | Buffer,
    outDir: string,
    opts: ClientConvertOptions = {}
  ): Promise<string[]> {
    const slides = await this.thumbnails(input, opts);
    await mkdir(outDir, { recursive: true });
    const written: string[] = [];
    for (const slide of slides) {
      const target = path.join(outDir, slide.file);
      await writeFile(target, slide.data);
      written.push(target);
    }
    return written;
  }
}
