FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 coturn \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /lab
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci && npx playwright install --with-deps chromium
COPY . .
RUN npm run build
ENV VOICE_LAB_ISOLATED=1
ENTRYPOINT ["node", "scripts/voice-lab/container.mjs"]
