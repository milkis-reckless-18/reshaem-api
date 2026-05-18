FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY . .
ARG PORT=8080
EXPOSE $PORT
CMD ["node", "index.js"]
