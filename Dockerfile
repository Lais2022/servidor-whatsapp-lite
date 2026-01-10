# ============================================================
# DOCKERFILE PARA WHATSAPP SERVER NO RENDER
# ============================================================
# 
# Use este Dockerfile para ter ffmpeg instalado automaticamente.
# Isso é NECESSÁRIO para converter áudios de WebM para OGG.
#
# No Render, selecione Runtime: Docker
# ============================================================

FROM node:20-slim

# Instala ffmpeg para conversão de áudio
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Cria diretório da aplicação
WORKDIR /app

# Copia package.json e instala dependências
COPY package*.json ./
RUN npm install --production

# Copia o resto dos arquivos
COPY . .

# Cria pasta de auth (será sobrescrita pelo Persistent Disk)
RUN mkdir -p /var/data/auth_info

# Expõe porta
EXPOSE 3000

# Inicia o servidor
CMD ["node", "servidor.js"]
