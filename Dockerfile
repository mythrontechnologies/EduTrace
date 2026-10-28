FROM node:24.22.1-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    EDUTRACE_MODE=demo

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public/ ./public/
COPY src/ ./src/

EXPOSE 10000
CMD ["npm", "start"]
