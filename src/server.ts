#!/usr/bin/env node
/**
 * Tiny HTTP microservice around convertPptxToImages(). No framework, no
 * multipart: the request body IS the pptx file.
 *
 *   POST /thumbnails?width=400            body: raw .pptx bytes
 *     -> 200 application/json  { slideCount, format, slides: [{index, file, data(base64)}] }
 *     -> Accept: application/zip (or ?as=zip)   a zip of slide-<n>.png
 *     -> ?slide=3&as=image                       a single binary image
 *   GET /healthz
 *
 * Env: PORT, HOST, THUMBNAILER_CONCURRENCY, MAX_UPLOAD_MB, SOFFICE_BIN,
 *      PDFTOCAIRO_BIN, TIMEOUT_MS
 */
import * as http from 'http';
import { execFile } from 'child_process';
import { ZipFile } from 'yazl';
import {
  ConversionError,
  ConvertOptions,
  convertPptxToImages,
  SlideImage,
} from './convert';
import { Semaphore } from './queue';

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Parallel LibreOffice conversions (default env THUMBNAILER_CONCURRENCY or 1). */
  concurrency?: number;
  /** Reject uploads above this size (default env MAX_UPLOAD_MB or 100). */
  maxUploadMb?: number;
}

function binaryAvailable(bin: string, versionFlag: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, [versionFlag], (err) => resolve(!err));
  });
}

function zipSlides(slides: SlideImage[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    for (const slide of slides) {
      zip.addBuffer(slide.data, slide.file);
    }
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    zip.end();
  });
}

function readBody(
  req: http.IncomingMessage,
  maxBytes: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new HttpError(413, `Upload exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function intParam(
  params: URLSearchParams,
  name: string
): number | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const value = parseInt(raw, 10);
  if (isNaN(value) || value < 0) {
    throw new HttpError(400, `Invalid ${name} '${raw}'`);
  }
  return value;
}

export function createServer(opts: ServerOptions = {}): http.Server {
  const concurrency =
    opts.concurrency ??
    parseInt(process.env.THUMBNAILER_CONCURRENCY ?? '1', 10);
  const maxUploadBytes =
    (opts.maxUploadMb ?? parseInt(process.env.MAX_UPLOAD_MB ?? '100', 10)) *
    1024 *
    1024;
  const timeoutMs = process.env.TIMEOUT_MS
    ? parseInt(process.env.TIMEOUT_MS, 10)
    : undefined;
  const semaphore = new Semaphore(concurrency);

  return http.createServer(async (req, res) => {
    const sendJson = (status: number, payload: unknown) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    };

    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/healthz') {
        const [soffice, pdftocairo] = await Promise.all([
          binaryAvailable(process.env.SOFFICE_BIN ?? 'soffice', '--version'),
          // pdftocairo has no --version; -v prints the version and exits 0
          binaryAvailable(process.env.PDFTOCAIRO_BIN ?? 'pdftocairo', '-v'),
        ]);
        const ok = soffice && pdftocairo;
        sendJson(ok ? 200 : 503, {
          status: ok ? 'ok' : 'unavailable',
          soffice,
          pdftocairo,
        });
        return;
      }

      if (
        req.method === 'POST' &&
        (url.pathname === '/thumbnails' || url.pathname === '/convert')
      ) {
        const params = url.searchParams;
        const format =
          (params.get('format') as ConvertOptions['format']) ?? 'png';
        if (format !== 'png' && format !== 'jpeg') {
          throw new HttpError(400, `Invalid format '${format}'`);
        }
        const convertOpts: ConvertOptions = {
          width: intParam(params, 'width'),
          dpi: intParam(params, 'dpi'),
          slide: intParam(params, 'slide'),
          format,
          timeoutMs,
        };

        const body = await readBody(req, maxUploadBytes);
        if (body.length === 0) {
          throw new HttpError(
            400,
            'Empty body — POST the raw .pptx file as request body'
          );
        }

        const slides = await semaphore.use(() =>
          convertPptxToImages(body, convertOpts)
        );

        const accept = req.headers.accept ?? '';
        const as =
          params.get('as') ??
          (accept.includes('application/zip') ? 'zip' : 'json');

        if (as === 'zip') {
          const zip = await zipSlides(slides);
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': 'attachment; filename="slides.zip"',
            'Content-Length': zip.length,
          });
          res.end(zip);
        } else if (as === 'image' || as === 'png') {
          if (slides.length !== 1) {
            throw new HttpError(
              400,
              'as=image requires selecting a single slide (?slide=<n>)'
            );
          }
          res.writeHead(200, {
            'Content-Type': format === 'jpeg' ? 'image/jpeg' : 'image/png',
            'Content-Length': slides[0].data.length,
          });
          res.end(slides[0].data);
        } else {
          sendJson(200, {
            slideCount: slides.length,
            format,
            slides: slides.map((s) => ({
              index: s.index,
              file: s.file,
              data: s.data.toString('base64'),
            })),
          });
        }
        return;
      }

      throw new HttpError(404, 'Not found');
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(err.status, { error: err.message });
      } else if (err instanceof ConversionError) {
        sendJson(422, { error: err.message });
      } else {
        console.error('Unexpected error:', err);
        sendJson(500, { error: 'Internal server error' });
      }
    }
  });
}

export function startServer(opts: ServerOptions = {}): http.Server {
  const port = opts.port ?? parseInt(process.env.PORT ?? '3000', 10);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  const server = createServer(opts);
  server.listen(port, host, () => {
    console.log(`pptx-thumbnailer listening on http://${host}:${port}`);
  });
  return server;
}

/* istanbul ignore next -- direct execution (node dist/server.js) */
if (require.main === module) {
  startServer();
}
