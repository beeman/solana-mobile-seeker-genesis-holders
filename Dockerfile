FROM oven/bun:1.3-alpine AS base
WORKDIR /app

FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base
COPY package.json ./
COPY --from=install /app/node_modules node_modules
COPY src src
COPY drizzle drizzle
COPY drizzle.config.ts .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "run", "start"]
