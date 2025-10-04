FROM node:20-slim

# Install pg_dump for Postgres 17
RUN apt-get update \
 && apt-get install -y wget gnupg curl lsb-release \
 && echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
 && wget -qO - https://www.postgresql.org/media/keys/ACCC4CF8.asc | apt-key add - \
 && apt-get update \
 && apt-get install -y postgresql-client-17 \
 && curl -sSL https://github.com/aptible/supercronic/releases/download/v0.2.29/supercronic-linux-amd64 \
      -o /usr/local/bin/supercronic \
 && chmod +x /usr/local/bin/supercronic \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN npm install --production

# Copy crontab file
COPY crontab /app/crontab

# Default command runs cron + your node app
CMD ["/usr/local/bin/supercronic", "/app/crontab"]
