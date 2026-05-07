# syntax=docker/dockerfile:1

FROM node:20-alpine

WORKDIR /app

# Instalar dependencias de producción
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copiar código fuente necesario en runtime
COPY app.js ./app.js
COPY src ./src

# Variables base seguras para contenedor.
# NODE_ENV NO se fuerza aquí para permitir QA, staging o producción desde Easypanel.
ENV HOST=0.0.0.0
ENV PORT=3002

EXPOSE 3002

CMD ["node", "app.js"]