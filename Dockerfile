# Cyboros Console — container image.
#
# The image contains CODE only. Configuration, accounts, authorization, reports and
# the audit trail live in volumes mounted from the host, so upgrading the image
# never touches an engagement:
#
#   docker compose -f docker-compose.yml up -d
#
# Build from the repository root:
#   docker build -t cyboros-console .
FROM node:22-alpine

WORKDIR /app

# Code: the engine, the console and the docs. Tests and engagement files are
# excluded by .dockerignore — an image is not a checkout.
COPY package.json ./
COPY tools ./tools
COPY runtime ./runtime
COPY workflows ./workflows
COPY skills ./skills
COPY local ./local
COPY docs ./docs
COPY cyboros.config.example.json ./

# Run unprivileged. The data directory is mounted, so nothing is written into /app.
RUN addgroup -S cyboros && adduser -S -G cyboros cyboros \
 && mkdir -p /data /config && chown cyboros:cyboros /data /config
USER cyboros

# CYBOROS_CONFIG points at the mounted config; docker-compose.yml sets it.
ENV NODE_ENV=production \
    CYBOROS_CONFIG=/config/cyboros.config.json

EXPOSE 8787

# The health endpoint is public by design (it carries no engagement data).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GUI_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "tools/gui-server.js"]
