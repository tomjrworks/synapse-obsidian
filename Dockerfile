FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --production=false --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
COPY landing/ ./landing/

RUN npm run build

RUN npm prune --production

EXPOSE 3777

CMD ["node", "dist/index.js", "--cloud", "--port", "3777"]
