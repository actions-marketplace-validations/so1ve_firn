FROM node:24-slim

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY src ./src
COPY public ./public
COPY migrations ./migrations

VOLUME ["/data"]
EXPOSE 8787

ENV HOST=0.0.0.0
ENV PORT=8787
ENV FIRN_DB_PATH=/data/firn.db

CMD ["node", "src/cli/index.ts", "serve"]
