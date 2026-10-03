FROM node:24-bookworm-slim
WORKDIR /app
COPY . .
ENV CET6_PUBLIC_ROOT=/app CET6_DATA_ROOT=/app/data CET6_LIBRARY_ROOT=/app/resources CET6_HOST=0.0.0.0 CET6_PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
