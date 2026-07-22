/**
 * Core conversion: .pptx -> slide images.
 *
 * Pipeline: LibreOffice (headless) renders the pptx to a temporary PDF,
 * then poppler's pdftocairo rasterizes each page. Both tools run in an
 * isolated temp directory; LibreOffice additionally gets its own
 * -env:UserInstallation profile per call, so concurrent conversions do not
 * fight over the shared profile lock.
 */
import { spawn } from 'child_process';
import {
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

export interface ConvertOptions {
  /** Target image width in px, aspect ratio preserved (default 400). */
  width?: number;
  /** Render resolution; only used when `width` is explicitly disabled (0). */
  dpi?: number;
  /** Convert a single slide only (1-based index). */
  slide?: number;
  /** Output image format (default 'png'). */
  format?: 'png' | 'jpeg';
  /** Kill the external tool after this many ms (default 120000, per tool). */
  timeoutMs?: number;
  /** LibreOffice binary (default env SOFFICE_BIN or 'soffice'). */
  sofficeBin?: string;
  /** pdftocairo binary (default env PDFTOCAIRO_BIN or 'pdftocairo'). */
  pdftocairoBin?: string;
}

export interface SlideImage {
  /** 1-based slide number. */
  index: number;
  /** Suggested file name, e.g. 'slide-3.png'. */
  file: string;
  data: Buffer;
}

export const DEFAULT_WIDTH = 400;
export const DEFAULT_DPI = 72;
export const DEFAULT_TIMEOUT_MS = 120_000;

export class ConversionError extends Error {
  constructor(message: string, public readonly detail?: string) {
    super(detail ? `${message}: ${detail}` : message);
    this.name = 'ConversionError';
  }
}

function run(
  bin: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new ConversionError(
          `Failed to start '${bin}' — is it installed and on PATH?`,
          err.message
        )
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ConversionError(`'${bin}' timed out after ${timeoutMs}ms`));
      } else if (code !== 0) {
        reject(
          new ConversionError(
            `'${bin}' exited with code ${code}`,
            stderr.trim() || stdout.trim()
          )
        );
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** ZIP local file header — every .pptx (an OOXML zip) starts with this. */
function looksLikePptx(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

/**
 * Convert a pptx (file path or Buffer) into one image per slide.
 * Requires `soffice` (LibreOffice) and `pdftocairo` (poppler-utils).
 */
export async function convertPptxToImages(
  input: string | Buffer,
  opts: ConvertOptions = {}
): Promise<SlideImage[]> {
  const format = opts.format ?? 'png';
  if (format !== 'png' && format !== 'jpeg') {
    throw new ConversionError(`Unsupported format '${format}'`);
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const soffice = opts.sofficeBin ?? process.env.SOFFICE_BIN ?? 'soffice';
  const pdftocairo =
    opts.pdftocairoBin ?? process.env.PDFTOCAIRO_BIN ?? 'pdftocairo';

  const work = await mkdtemp(path.join(os.tmpdir(), 'pptx-thumbnailer-'));
  try {
    const inputFile = path.join(work, 'input.pptx');
    if (Buffer.isBuffer(input)) {
      if (!looksLikePptx(input)) {
        throw new ConversionError('Input does not look like a .pptx file');
      }
      await writeFile(inputFile, input);
    } else {
      await copyFile(input, inputFile);
    }

    // 1) pptx -> pdf. The per-call UserInstallation profile makes parallel
    // soffice invocations safe (and keeps the container's HOME untouched).
    const profileUrl = pathToFileURL(path.join(work, 'lo-profile')).href;
    await run(
      soffice,
      [
        '--headless',
        '--invisible',
        '--norestore',
        `-env:UserInstallation=${profileUrl}`,
        '--convert-to',
        'pdf',
        '--outdir',
        work,
        inputFile,
      ],
      timeoutMs
    );
    const pdfFile = path.join(work, 'input.pdf');
    const pdfExists = await stat(pdfFile).catch(() => null);
    if (!pdfExists) {
      throw new ConversionError(
        'LibreOffice did not produce a PDF (corrupt or unsupported input?)'
      );
    }

    // 2) pdf -> images. -scale-to-x with -scale-to-y -1 preserves the aspect
    // ratio, which replaces a separate ImageMagick resize step.
    const args: string[] = [`-${format}`];
    if (opts.width === 0 || (opts.width === undefined && opts.dpi)) {
      args.push('-r', String(opts.dpi ?? DEFAULT_DPI));
    } else {
      args.push(
        '-scale-to-x',
        String(opts.width ?? DEFAULT_WIDTH),
        '-scale-to-y',
        '-1'
      );
    }
    if (opts.slide !== undefined) {
      if (!Number.isInteger(opts.slide) || opts.slide < 1) {
        throw new ConversionError(`Invalid slide number '${opts.slide}'`);
      }
      args.push('-f', String(opts.slide), '-l', String(opts.slide));
    }
    args.push(pdfFile, path.join(work, 'out'));
    await run(pdftocairo, args, timeoutMs);

    // 3) Collect. pdftocairo names pages 'out-1.png' / 'out-01.png' (zero-
    // padded when the document has many pages), so parse the page number and
    // normalize to unpadded 'slide-<n>' names.
    const ext = format === 'jpeg' ? 'jpg' : 'png';
    const produced = (await readdir(work))
      .map((f) => {
        const m = f.match(new RegExp(`^out-(\\d+)\\.${ext}$`));
        return m ? { file: f, index: parseInt(m[1], 10) } : null;
      })
      .filter((x): x is { file: string; index: number } => x !== null)
      .sort((a, b) => a.index - b.index);

    if (produced.length === 0) {
      throw new ConversionError(
        opts.slide !== undefined
          ? `Slide ${opts.slide} does not exist`
          : 'pdftocairo produced no images'
      );
    }

    return Promise.all(
      produced.map(async ({ file, index }) => ({
        index,
        file: `slide-${index}.${ext}`,
        data: await readFile(path.join(work, file)),
      }))
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
