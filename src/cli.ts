#!/usr/bin/env node
/**
 * CLI:
 *   pptx-thumbnailer <input.pptx> [-o dir] [-w 400] [--dpi n] [--slide n] [--format png|jpeg]
 *   pptx-thumbnailer serve [-p 3000] [--host 0.0.0.0] [--concurrency 1]
 */
import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import { convertPptxToImages, ConvertOptions } from './convert';
import { startServer } from './server';

const USAGE = `pptx-thumbnailer — slide thumbnails from .pptx via headless LibreOffice

Usage:
  pptx-thumbnailer <input.pptx> [options]   Convert locally
                                            (requires libreoffice + poppler-utils)
  pptx-thumbnailer serve [options]          Run the HTTP service

Convert options:
  -o, --out <dir>        Output directory (default: <input>-thumbnails)
  -w, --width <px>       Target width, aspect ratio kept (default: 400)
      --dpi <n>          Render at fixed dpi instead of a fixed width
      --slide <n>        Only convert slide <n> (1-based)
      --format <fmt>     png | jpeg (default: png)

Serve options:
  -p, --port <n>         Port (default: env PORT or 3000)
      --host <host>      Bind address (default: env HOST or 0.0.0.0)
      --concurrency <n>  Parallel conversions (default: env THUMBNAILER_CONCURRENCY or 1)
`;

function fail(message: string): never {
  console.error(`Error: ${message}\n`);
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  positional: string[];
  flags: Map<string, string | true>;
} {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const aliases: Record<string, string> = {
    '-o': '--out',
    '-w': '--width',
    '-p': '--port',
    '-h': '--help',
  };
  const valueFlags = new Set([
    '--out',
    '--width',
    '--dpi',
    '--slide',
    '--format',
    '--port',
    '--host',
    '--concurrency',
  ]);
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    arg = aliases[arg] ?? arg;
    if (valueFlags.has(arg)) {
      const value = argv[++i];
      if (value === undefined) fail(`Missing value for ${arg}`);
      flags.set(arg, value);
    } else {
      flags.set(arg, true);
    }
  }
  return { positional, flags };
}

function intFlag(
  flags: Map<string, string | true>,
  name: string
): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  const value = parseInt(String(raw), 10);
  if (isNaN(value)) fail(`Invalid value for ${name}: '${raw}'`);
  return value;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  if (flags.has('--help') || (positional.length === 0 && flags.size === 0)) {
    console.log(USAGE);
    return;
  }

  if (positional[0] === 'serve') {
    startServer({
      port: intFlag(flags, '--port'),
      host: flags.get('--host') as string | undefined,
      concurrency: intFlag(flags, '--concurrency'),
    });
    return;
  }

  const input = positional[0];
  if (!input) fail('No input file given');
  if (!input.toLowerCase().endsWith('.pptx')) {
    fail(`Input must be a .pptx file, got '${input}'`);
  }

  const format = (flags.get('--format') as ConvertOptions['format']) ?? 'png';
  const outDir =
    (flags.get('--out') as string | undefined) ??
    path.join(
      path.dirname(input),
      `${path.basename(input, path.extname(input))}-thumbnails`
    );

  const slides = await convertPptxToImages(input, {
    width: intFlag(flags, '--width'),
    dpi: intFlag(flags, '--dpi'),
    slide: intFlag(flags, '--slide'),
    format,
  });

  await mkdir(outDir, { recursive: true });
  for (const slide of slides) {
    await writeFile(path.join(outDir, slide.file), slide.data);
  }
  console.log(`Wrote ${slides.length} image(s) to ${outDir}`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
