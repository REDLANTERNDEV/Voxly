FROM node:22-alpine AS deps
WORKDIR /app

ENV HUSKY=0

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
# The build stage builds every workspace, so the bot's manifest belongs in the
# install layer too. Without it npm installs a different workspace set from the
# one the lockfile describes, and the bot compiles only against whatever another
# workspace happened to hoist. Both runtime stages below install from here; what
# separates them is which dist is copied out and which programs are added.
COPY apps/bot/package.json apps/bot/package.json
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

# The Music bot's runtime, which is a different image from the application's on
# purpose: it is the only one that needs an extractor and an encoder, and the
# application should not carry two programs it never runs. Everything before
# this stage is shared, so the second image costs one `apk add` rather than a
# second install and a second build. See ADR-0012.
FROM node:22-alpine AS bot
WORKDIR /app

# yt-dlp's stable release, pinned so that an image is reproducible and so that
# nothing updates itself behind a read-only filesystem. YouTube changes how it
# serves video several times a year and the repair is to raise this and rebuild;
# Compose passes it through from the environment so an operator can do that
# without waiting for a Voxly release. ADR-0004, ADR-0012.
ARG VOXLY_YTDLP_VERSION=2026.08.19

ENV NODE_ENV=production

# ffmpeg comes from the distribution rather than being pinned to a version
# string: Alpine drops old versions from its repository within weeks, so an
# exact pin here would turn a security rebuild into a build that cannot resolve
# its own package. The base image tag is what fixes the version set.
#
# pip goes again once yt-dlp is installed. Nothing at runtime may install
# anything, and the read-only filesystem is not the only reason to say so.
#
# The two checks at the end are what make a broken image a failed build rather
# than a room where a Track resolves and then never plays: an ffmpeg without
# libopus cannot encode anything the mesh can carry, and it fails at the first
# Track rather than at start-up, where nobody is looking. They run after the
# prune so that they also answer for it.
RUN apk add --no-cache ffmpeg python3 py3-pip \
  && pip install --no-cache-dir --break-system-packages "yt-dlp==${VOXLY_YTDLP_VERSION}" \
  && apk del py3-pip \
  && yt-dlp --version \
  && ffmpeg -hide_banner -encoders | grep -q libopus \
  && addgroup -S voxly \
  && adduser -S -G voxly voxly

COPY --from=build --chown=voxly:voxly /app/package.json /app/package-lock.json ./
COPY --from=build --chown=voxly:voxly /app/node_modules node_modules
COPY --from=build --chown=voxly:voxly /app/apps/bot/package.json apps/bot/package.json
COPY --from=build --chown=voxly:voxly /app/apps/bot/dist apps/bot/dist
COPY --from=build --chown=voxly:voxly /app/packages/shared packages/shared

USER voxly

# No port and no healthcheck. The bot has no HTTP surface of its own to probe —
# it is a client of the application's — and a healthcheck that proved only that
# a Node process exists would report a bot that has been failing to authenticate
# for an hour as healthy.
CMD ["node", "apps/bot/dist/src/main.js"]
