FROM node:20-alpine

WORKDIR /app

# Instala dependências de build para better-sqlite3
RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++ \
    ca-certificates

# Copia apenas package.json primeiro (melhor cache)
COPY package.json ./

# Instala dependências (será compilado para arquitetura correta do container)
RUN npm install --only=production

# Copia o resto do código (node_modules do Mac é ignorado pelo .dockerignore)
COPY . .

# Cria diretórios necessários
RUN mkdir -p data public

# Remove ferramentas de build para reduzir tamanho da imagem
RUN apk del git python3 make g++

# Volume persistente para dados
VOLUME ["/app/data"]

# Porta do servidor
EXPOSE 3000

# Health check para Coolify
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Inicia o servidor
CMD ["npm", "start"]