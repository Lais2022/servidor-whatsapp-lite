FROM node:20-slim

# Instala ffmpeg E git (necessário para algumas dependências)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p ./auth_info

EXPOSE 3000

CMD ["node", "servidor.js"]
