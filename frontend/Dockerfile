FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY docker-entrypoint-dev.sh /usr/local/bin/docker-entrypoint-dev.sh
RUN chmod +x /usr/local/bin/docker-entrypoint-dev.sh
COPY . .
EXPOSE 5173
ENTRYPOINT ["docker-entrypoint-dev.sh"]
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
