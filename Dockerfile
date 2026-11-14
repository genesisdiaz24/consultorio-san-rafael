# Imagen de producción del Consultorio Médico San Rafael para Google Cloud Run
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

# Instalar solo dependencias de producción (capa cacheada si package*.json no cambia)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Código de la aplicación (ver .dockerignore: no se copian .env, scripts de prueba ni node_modules)
COPY src ./src
COPY public ./public

# Ejecutar sin privilegios de root
USER node

EXPOSE 8080
CMD ["node", "src/server.js"]
