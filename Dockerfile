FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --ignore-scripts \
    && npx playwright install --with-deps chromium \
    && npm install -g serve

# Copy of HoloPrint, served locally inside the container
RUN git clone --depth 1 https://github.com/SuperLlama88888/HoloPrint.git /app/holoprint

COPY index.js ./

ENV HOLOPRINT_URL=http://localhost:8080/

CMD ["sh", "-c", "serve -l 8080 /app/holoprint & node index.js"]
