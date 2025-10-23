FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
# Dependências de build (better-sqlite3 e outras nativas) no Alpine
RUN apk add --no-cache python3 make g++ \
  && npm install --omit=dev \
  && apk del python3 make g++

COPY . .
RUN mkdir -p data public

VOLUME ["/app/data"]

EXPOSE 3000
CMD ["npm", "start"]