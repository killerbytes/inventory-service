# Use Node.js 20 slim image
FROM node:20-slim

# Install Postgres client 17 + cron + needed tools
RUN apt-get update && apt-get install -y wget gnupg cron \
  && echo "deb http://apt.postgresql.org/pub/repos/apt/ bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | apt-key add - \
  && apt-get update \
  && apt-get install -y postgresql-client-17 \
  && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files and install deps
COPY package*.json ./
RUN npm install --production

# Copy app code
COPY . .

# Add cron job
# Example: run backup every day at 2 AM UTC
RUN echo "* * * * * root node /app/backup.js backup >> /app/backup.log 2>&1" > /etc/cron.d/backup-cron \
  && chmod 0644 /etc/cron.d/backup-cron \
  && crontab /etc/cron.d/backup-cron

# Run cron in foreground (Railway needs the container alive)
CMD ["cron", "-f"]
