FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
# Dependências de build (better-sqlite3 e outras nativas) no Alpine + git para deps que referenciam repositórios
RUN apk add --no-cache git python3 make g++ ca-certificates tzdata \
  && npm install --omit=dev \
  && apk del git python3 make g++ tzdata \
  && update-ca-certificates

COPY . .
RUN mkdir -p data public

VOLUME ["/app/data"]

EXPOSE 3000
CMD ["npm", "start"]