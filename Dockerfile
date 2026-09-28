# PIT TV — Docker image
# Multi-stage: builder stage assembles the app, runtime stage serves with Node.

# ---- Builder stage ----
FROM node:22-alpine AS builder

WORKDIR /app

# tools/serve.js uses ES module import syntax. node:22-alpine defaults to
# CommonJS for .js files, so a minimal package.json declares the module type.
RUN echo '{"type":"module","private":true}' > package.json

# Copy only what the app needs to run (build context trimmed by .dockerignore)
COPY index.html sw.js manifest.webmanifest favicon.svg ./
COPY assets/ ./assets/
COPY lib/ ./lib/
# covers/ are gitignored (personal/regenerated); the runtime stage
# creates an empty directory, users can mount their own via compose.
COPY tools/ ./tools/
COPY covers/ ./covers/

# Ship the real catalog.json so the container serves actual shows.
# Users can mount their own data/ to override via compose.
COPY data/catalog.json ./data/catalog.json
COPY data/shows.json ./data/shows.json

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
