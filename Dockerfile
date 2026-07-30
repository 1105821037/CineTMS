FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

COPY scripts/kdm-auto-download-ts/package*.json ./scripts/kdm-auto-download-ts/
RUN cd scripts/kdm-auto-download-ts \
    && ONNXRUNTIME_NODE_INSTALL=skip npm ci
COPY scripts/kdm-auto-download-ts/tsconfig.json ./scripts/kdm-auto-download-ts/tsconfig.json
COPY scripts/kdm-auto-download-ts/src ./scripts/kdm-auto-download-ts/src
RUN cd scripts/kdm-auto-download-ts && npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=4173 \
    FTP_HOST=0.0.0.0 \
    FTP_PORT=2121 \
    FTP_PASV_MIN=41000 \
    FTP_PASV_MAX=41100 \
    KDM_YOLO_MODEL=/app/scripts/kdm-auto-download-ts/best.onnx \
    KDM_AUTO_DOWNLOAD_DIR=/app/scripts/kdm-auto-download-ts \
    KDM_STATE_DIR=/app/.tms/kdm-auto-download \
    KDM_HEADLESS=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      fonts-noto-cjk \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/.tms/repository /app/.tms/kdm-auto-download/downloads /app/scripts/kdm-auto-download-ts /ms-playwright \
    && chown -R node:node /app /ms-playwright

COPY --chown=node:node package*.json ./
USER node
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node web ./web
COPY --chown=node:node --chmod=755 docker-entrypoint.sh ./docker-entrypoint.sh
RUN sed -i 's/\r$//' ./docker-entrypoint.sh

COPY --chown=node:node scripts/kdm-auto-download-ts/package*.json ./scripts/kdm-auto-download-ts/
RUN cd scripts/kdm-auto-download-ts \
    && ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev \
    && npm cache clean --force \
    && rm -rf \
      node_modules/onnxruntime-node/bin/napi-v6/darwin \
      node_modules/onnxruntime-node/bin/napi-v6/win32 \
      node_modules/onnxruntime-node/bin/napi-v6/linux/arm64 \
      node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so \
      node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_tensorrt.so

USER root
RUN cd scripts/kdm-auto-download-ts \
    && npx playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* /tmp/*

COPY --chown=node:node --from=build /app/scripts/kdm-auto-download-ts/dist ./scripts/kdm-auto-download-ts/dist
COPY --chown=node:node scripts/kdm-auto-download-ts/best.onnx ./scripts/kdm-auto-download-ts/best.onnx

ARG BUILD_TIME=
ARG RELEASE_CHANNEL=docker
ARG BUILD_COMMIT=
RUN node -e 'const fs = require("node:fs"); const value = (item) => item?.trim() || undefined; const [channel, commit, buildTime] = process.argv.slice(1); fs.writeFileSync("/app/build-info.json", JSON.stringify({ channel: value(channel) || "docker", commit: value(commit), buildTime: value(buildTime) }, null, 2) + "\n");' \
      -- "${RELEASE_CHANNEL}" "${BUILD_COMMIT}" "${BUILD_TIME}" \
    && chown node:node /app/build-info.json

VOLUME ["/app/.tms"]
EXPOSE 4173 2121

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/server/web-server.js"]
