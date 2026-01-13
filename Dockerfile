FROM node:20-slim

# Instala dependências do sistema
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg git openssh-client && \
    rm -rf /var/lib/apt/lists/*

# Força git a usar HTTPS
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/
RUN git config --global url."https://github.com/".insteadOf git@github.com:

# Define diretório de trabalho
WORKDIR /app

# Copia package.json primeiro (cache)
COPY package*.json ./

# Instala dependências
RUN npm install --omit=dev

# Copia o restante do projeto
COPY . .

# Cria pastas necessárias
RUN mkdir -p auth_info /var/data/auth_info /var/data/media

# Expõe a porta
EXPOSE 3000

# 🔥 COMANDO QUE MANTÉM O CONTAINER VIVO
CMD ["node", "servidor.js"]
