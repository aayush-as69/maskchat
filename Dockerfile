# MaskChat Phase 10: production-friendly single-container image.
FROM node:22-alpine AS client-build
WORKDIR /app/client
ARG VITE_SERVER_URL=
ENV VITE_SERVER_URL=$VITE_SERVER_URL
RUN corepack enable
COPY client/package.json client/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY client ./
RUN pnpm build

FROM node:22-alpine AS server
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY server/package.json server/pnpm-lock.yaml ./server/
RUN pnpm install --dir server --frozen-lockfile --prod
COPY server ./server
COPY --from=client-build /app/client/dist ./client/dist
EXPOSE 3001
CMD ["node", "server/index.js"]
