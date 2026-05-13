# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci

FROM deps AS build

COPY tsconfig.base.json ./
COPY apps/server apps/server
COPY apps/web apps/web
COPY packages/shared packages/shared

RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV SERVER_PORT=3000
ENV WEB_DIST_PATH=/app/apps/web/dist

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --omit=dev --workspace @sync-seat/server --workspace @sync-seat/shared --include-workspace-root=false \
  && npm cache clean --force

COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/shared/dist packages/shared/dist

USER node

EXPOSE 3000

CMD ["npm", "run", "start", "-w", "@sync-seat/server"]
