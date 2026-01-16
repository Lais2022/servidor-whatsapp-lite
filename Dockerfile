FROM node:20-slim

# Instala dependências do sistema (ffmpeg para áudio/vídeo)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia package.json primeiro para cache de dependências
COPY package*.json ./

# Instala dependências
RUN npm install --production

# Copia código
COPY . .

# Cria pastas de dados
RUN mkdir -p /var/data/auth_info /var/data/media

# Expõe porta
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Inicia servidor
CMD ["node", "servidor.js"]
