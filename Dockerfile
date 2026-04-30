# syntax=docker/dockerfile:1

FROM node:20-alpine

WORKDIR /app

# Dependencias de producción
COPY package*.json ./
RUN npm ci --omit=dev

# Código fuente mínimo necesario en runtime
COPY app.js ./app.js
COPY src ./src

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3002

EXPOSE 3002

CMD ["node", "app.js"]
