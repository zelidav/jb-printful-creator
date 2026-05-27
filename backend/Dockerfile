FROM node:20-slim
# Fonts + fontconfig so sharp/librsvg can render the "add text to design" overlay (slim ships none).
RUN apt-get update && apt-get install -y --no-install-recommends \
      fontconfig fonts-liberation fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/server.js"]
