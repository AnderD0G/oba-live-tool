ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE}
WORKDIR /app
COPY vendor/package.json vendor/package-lock.json ./vendor/
RUN npm ci --prefix /app/vendor --omit=dev --ignore-scripts --no-audit --no-fund
COPY vendor/doubao_ctl.mjs ./vendor/
COPY entrypoint.mjs probe.mjs probe-tools.mjs recognize.mjs ./
# No host microphones, Chrome profiles, credentials, or ports enter this image.
USER node
CMD ["node", "entrypoint.mjs"]
