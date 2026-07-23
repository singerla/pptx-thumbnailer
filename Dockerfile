# ---- build stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ----------------------------------------------------------
FROM node:22-bookworm-slim

# libreoffice-impress (not the full suite) is enough for pptx -> pdf;
# poppler-utils provides pdftocairo. Fonts improve rendering fidelity:
# liberation covers Arial/Times/Courier metrics, crosextra-carlito/-caladea
# cover Calibri/Cambria (PowerPoint's defaults) — without them line breaks
# shift wherever a deck uses the Office default fonts.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-impress \
      poppler-utils \
      fonts-liberation \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
      fonts-dejavu-core \
      curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    HOME=/tmp/home

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./

RUN mkdir -p /tmp/home && chown node:node /tmp/home
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s \
  CMD curl -fsS http://localhost:3000/healthz || exit 1

CMD ["node", "dist/server.js"]
