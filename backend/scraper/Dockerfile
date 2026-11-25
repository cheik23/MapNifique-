FROM node:22-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npx playwright install --with-deps chromium
COPY src ./src
ENV NODE_ENV=production
EXPOSE 8787
CMD ["npm", "run", "start:api"]
