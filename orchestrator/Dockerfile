FROM node:22-alpine AS build
WORKDIR /app/orchestrator
COPY orchestrator/package.json orchestrator/package-lock.json ./
RUN npm ci
COPY orchestrator/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 WEB_DIR=/app/web DATA_DIR=/data
WORKDIR /app/orchestrator
COPY --from=build /app/orchestrator/node_modules ./node_modules
COPY --from=build /app/orchestrator/dist ./dist
COPY --from=build /app/orchestrator/db ./db
COPY --from=build /app/orchestrator/package.json ./
COPY web/ /app/web/
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
