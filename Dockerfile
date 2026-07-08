FROM node:current-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:current-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 5001

CMD ["node", "src/server.js"]