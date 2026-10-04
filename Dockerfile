FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.mjs db.mjs db-postgres.mjs postgres-driver.mjs cloud-resources.mjs ./
COPY public ./public
COPY content/catalog.json content/real-exams.json content/mock-exams.json content/sample-content.json content/vocabulary.json ./content/
COPY content/cloud-media.json ./content/
ENV CET6_HOST=0.0.0.0
EXPOSE 10000
CMD ["node", "server.mjs"]
