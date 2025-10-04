FROM node:20-slim

# Install pg_dump for Postgres 17
RUN apt-get update && apt-get install -y postgresql-client-17 curl \
  && curl -sSL https://github.com/aptible/supercronic/releases/download/v0.2.29/supercronic-linux-amd64 \
     -o /usr/local/bin/supercronic \
  && chmod +x /usr/local/bin/supercronic

WORKDIR /app
COPY . .

RUN npm install --production

# Copy crontab file
COPY crontab /app/crontab

# Default command runs cron + your node app
CMD supercronic /app/crontab
