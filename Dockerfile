FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node
EXPOSE 3000

# Node 24 runs TypeScript directly, so there is nothing to build.
CMD ["node", "src/index.ts"]
