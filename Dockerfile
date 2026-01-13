FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg git openssh-client && \
    rm -rf /var/lib/apt/lists/*

RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/
RUN git config --global url."https://github.com/".insteadOf git@github.com:

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /var/data/auth_info /var/data/media

EXPOSE 3000

CMD ["node", "servidor.js"]
