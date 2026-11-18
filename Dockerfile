FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir /app/data && chown node:node /app/data
ENV HOST=0.0.0.0 FOOD_DB_PATH=/app/data/orders.sqlite
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
