# PIT TV — Docker image
# Multi-stage: build stage copies source, runtime stage serves with Node

# ---- Build stage ----
FROM node:22-alpine AS builder

WORKDIR /app

# Copy only what's needed for the app to run
COPY index.html ./
COPY sw.js ./
COPY manifest.webmanifest ./
COPY favicon.svg ./
COPY assets/ ./assets/
COPY lib/ ./lib/
COPY covers/ ./covers/
COPY data/catalog.demo.json ./data/
COPY tools/serve.js ./tools/
COPY tools/atomic-json.mjs ./tools/

# ---- Runtime stage ----
FROM node:22-alpine AS runtime

WORKDIR /app

# Create non-root user
RUN addgroup -g 1000 -S appgroup && \
    adduser -u 1000 -S appuser -G appgroup

# Copy from builder
COPY --from=builder /app .

# Create data and videos directories with proper ownership
RUN mkdir -p data videos && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

ENV PORT=3000
ENV HOST=0.0.0.0

# Run the zero-dependency static server
CMD ["node", "tools/serve.js"]