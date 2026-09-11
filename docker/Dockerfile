# syntax=docker/dockerfile:1

FROM node:lts-alpine AS base
WORKDIR /app

FROM base AS frontend-build
WORKDIR /app/public
COPY public/package.json public/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev --no-audit --no-fund
COPY public/ ./
RUN npm run build

FROM base AS production-dependencies
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

FROM base AS runtime
ENV NODE_ENV=production

# Copy only runtime files; build dependencies and npm caches stay out of the image.
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json ecosystem.config.js ./
COPY src/ ./src/
COPY --from=frontend-build /app/public/dist ./public/dist

RUN chmod 777 /app && mkdir -p logs data caches

EXPOSE 3000
CMD ["npm", "start"]
