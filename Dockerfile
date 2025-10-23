FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p data public

VOLUME ["/app/data"]

EXPOSE 3000
CMD ["npm", "start"]