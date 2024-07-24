FROM node:20

WORKDIR /app
ADD . /app/
RUN npm ci

CMD ["npx", "tsx", "index.ts"]
