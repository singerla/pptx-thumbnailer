# pptx-thumbnailer

Slide thumbnails (PNG/JPEG) from PowerPoint `.pptx` files via headless
LibreOffice — usable as a **library**, a **CLI**, or a tiny **HTTP
microservice** (Docker).

Why a microservice? LibreOffice adds hundreds of MB to an application image.
Running it once, in its own small static container, keeps your app image slim
and your CI fast — your app just POSTs the pptx and gets images back.

**Pipeline:** `soffice --headless` renders the pptx to a temporary PDF, then
poppler's `pdftocairo` rasterizes each page (aspect-ratio-preserving scaling
built in — no ImageMagick needed). Concurrent conversions are safe: every call
gets an isolated LibreOffice user profile, and the server queues requests
beyond a configurable concurrency limit.

## Run the service (Docker)

```bash
docker build -t pptx-thumbnailer .
docker run --rm -p 3000:3000 pptx-thumbnailer
# or: docker compose up -d
```

### HTTP API

The request body **is** the pptx file — no multipart forms.

```bash
# All slides as JSON (base64-encoded images)
curl --data-binary @deck.pptx 'http://localhost:3000/thumbnails?width=400'

# All slides as a zip of slide-<n>.png
curl --data-binary @deck.pptx -H 'Accept: application/zip' \
  'http://localhost:3000/thumbnails?width=400' -o slides.zip

# One slide as a plain PNG
curl --data-binary @deck.pptx \
  'http://localhost:3000/thumbnails?slide=1&as=image' -o slide-1.png

# Health (checks that soffice + pdftocairo are present)
curl http://localhost:3000/healthz
```

| Query param | Default | Meaning                                            |
| ----------- | ------- | -------------------------------------------------- |
| `width`     | `400`   | Target width in px (aspect ratio preserved)        |
| `dpi`       | –       | Render at a fixed dpi instead of a fixed width     |
| `slide`     | –       | Only convert slide *n* (1-based)                   |
| `format`    | `png`   | `png` or `jpeg`                                    |
| `as`        | `json`  | `json`, `zip` or `image` (single slide)            |

JSON response shape:

```json
{
  "slideCount": 12,
  "format": "png",
  "slides": [
    { "index": 1, "file": "slide-1.png", "data": "<base64>" }
  ]
}
```

Errors: `400` bad request, `413` upload too large, `422` conversion failed,
`503` (healthz) tools missing.

### Environment variables

| Variable                  | Default      | Meaning                             |
| ------------------------- | ------------ | ----------------------------------- |
| `PORT` / `HOST`           | `3000` / `0.0.0.0` | Listen address                |
| `THUMBNAILER_CONCURRENCY` | `1`          | Parallel LibreOffice conversions    |
| `MAX_UPLOAD_MB`           | `100`        | Reject larger uploads (413)         |
| `TIMEOUT_MS`              | `120000`     | Per-tool timeout                    |
| `SOFFICE_BIN`             | `soffice`    | LibreOffice binary                  |
| `PDFTOCAIRO_BIN`          | `pdftocairo` | poppler binary                      |

## Use the client (no LibreOffice needed)

```bash
npm install pptx-thumbnailer
```

```ts
import { ThumbnailerClient } from 'pptx-thumbnailer';

const client = new ThumbnailerClient('http://thumbnailer:3000');

// In-memory
const slides = await client.thumbnails('deck.pptx', { width: 400 });
// slides: [{ index: 1, file: 'slide-1.png', data: <Buffer> }, ...]

// Or straight to disk: writes slide-1.png, slide-2.png, ...
await client.thumbnailsToDir(buffer, './out/slides/42', { width: 400 });
```

## Use as a library (LibreOffice installed locally)

Requires `libreoffice` (impress) and `poppler-utils` on the host:

```ts
import { convertPptxToImages } from 'pptx-thumbnailer';

const slides = await convertPptxToImages('deck.pptx', { width: 400 });
```

## CLI

```bash
npx pptx-thumbnailer deck.pptx -o ./thumbs --width 400   # local conversion
npx pptx-thumbnailer serve --port 3000                   # run the service
```

## License

MIT
