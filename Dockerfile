FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma

# Install Chromium and all its system library dependencies via apt (not Nix).
# playwright install --with-deps downloads the browser binary AND runs
# install-deps which calls apt-get for the required Debian packages
# (libglib2.0-0, libnss3, libxrandr2, etc.).
RUN npm ci && npx playwright install --with-deps chromium

COPY . .
RUN npm run build

CMD ["node", "dist/server/server.js"]
