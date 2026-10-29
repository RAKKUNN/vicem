FROM node:22-alpine

WORKDIR /app

COPY package.json vicem.mjs README.md LICENSE ./

ENTRYPOINT ["node", "/app/vicem.mjs", "mcp"]
