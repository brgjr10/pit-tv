# PIT TV — Docker image
# Multi-stage: builder stage assembles the app, runtime stage serves with Node.

# ---- Builder stage ----
FROM node:22-alpine AS builder

WORKDIR /app

# tools/serve.js uses ES module import syntax. node:22-alpine defaults to
# CommonJS for .js files, so a minimal package.json declares the module type.
RUN echo '{"type":"module","private":true}' > package.json

# Copy only what the app needs to run (build context trimmed by .dockerignore)
COPY index.html sw.js manifest.webmanifest favicon.svg apple-touch-icon.png offline.html ./
COPY assets/ ./assets/
COPY lib/ ./lib/
COPY tools/ ./tools/

# covers/ and the live catalog.json / shows.json are gitignored — they are the
# developer's personal data, not repository content — so copying them made the
# build work only from their working tree. The demo catalog is the one data file
# that is tracked, and it is what a clean clone can serve until ./data is
# mounted over it (docker-compose.yml mounts ./data:/app/data).
COPY data/catalog.demo.json ./data/catalog.demo.json
RUN mkdir -p data videos covers && \
    cp data/catalog.demo.json data/catalog.json && \
    printf '{"_comment":"Placeholder — mount ./data over /app/data to supply the real shows.json.","shows":{}}' > data/shows.json

# ---- Runtime stage ----
FROM node:22-alpine AS runtime

WORKDIR /app

# Copy from builder
COPY --from=builder /app .

# Use existing node user (uid 1000 already exists in node:22-alpine)
RUN mkdir -p data videos covers && \
    chown -R node:node /app

USER node

EXPOSE 3000

ENV PORT=3000
ENV HOST=0.0.0.0

# Healthcheck: verify the server responds
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Run the zero-dependency static server
CMD ["node", "tools/serve.js"]
