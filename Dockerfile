FROM node:22-alpine AS deps
WORKDIR /app

ENV HUSKY=0

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci

FROM deps AS build
WORKDIR /app

COPY apps apps
COPY packages packages

RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/voxly.sqlite \
    WEB_DIST_PATH=/app/apps/web/dist

RUN addgroup -S voxly \
  && adduser -S -G voxly voxly \
  && mkdir -p /data \
  && chown -R voxly:voxly /data /app

COPY --from=build --chown=voxly:voxly /app/package.json /app/package-lock.json ./
COPY --from=build --chown=voxly:voxly /app/node_modules node_modules
COPY --from=build --chown=voxly:voxly /app/apps/server/package.json apps/server/package.json
COPY --from=build --chown=voxly:voxly /app/apps/server/dist apps/server/dist
COPY --from=build --chown=voxly:voxly /app/apps/web/dist apps/web/dist
COPY --from=build --chown=voxly:voxly /app/packages/shared packages/shared

USER voxly
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r)=>process.exit(r.ok ? 0 : 1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/src/main.js"]
