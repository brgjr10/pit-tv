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
COPY covers/ ./covers/
COPY tools/ ./tools/

# Ship the demo catalog as the default data/catalog.json so the container
# works out of the box. Users can mount their own data/ to override.
COPY data/catalog.demo.json ./data/catalog.demo.json
COPY data/catalog.demo.json ./data/catalog.json

# ---- Runtime stage ----
FROM node:22-alpine AS runtime

WORKDIR /app

# Create non-root user
RUN addgroup -g 1000 -S appgroup && \
    adduser -u 1000 -S appuser -G appgroup

# Copy from builder
COPY --from=builder /app .

# Create writable directories for user data / videos
RUN mkdir -p data videos && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

ENV PORT=3000
ENV HOST=0.0.0.0

# Healthcheck: verify the server responds
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Run the zero-dependency static server
CMD ["node", "tools/serve.js"]
