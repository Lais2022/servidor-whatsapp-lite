FROM node:20-slim

# Instala ffmpeg, git e openssh (necessário para dependências)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg git openssh-client && \
    rm -rf /var/lib/apt/lists/*

# Configura git pra usar HTTPS em vez de SSH
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/
RUN git config --global url."https://github.com/".insteadOf git@github.com:

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p ./auth_info

EXPOSE 3000

CMD ["node", "servidor.js"]
