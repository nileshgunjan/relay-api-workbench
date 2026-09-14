FROM node:20-alpine

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json ./
RUN npm install --omit=dev

# App source.
COPY server ./server
COPY public ./public

# Data dir for persisted collections (also mounted as a volume in compose).
RUN mkdir -p /app/data/collections

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
# SOCKS5 egress proxy port (used only when SOCKS_ENABLED=true)
EXPOSE 1080

# Basic healthcheck against the public /api/me endpoint.
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/me >/dev/null 2>&1 || exit 1

CMD ["node", "server/index.js"]
