FROM node:23-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data

VOLUME ["/app/data"]

EXPOSE 3232

CMD ["node", "server.js"]
