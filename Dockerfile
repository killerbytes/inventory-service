FROM node:18

WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm install

# Copy code
COPY . .

# Install cron + postgres client
RUN apt-get update && apt-get install -y cron postgresql-client

# Copy crontab
COPY crontab /etc/cron.d/db-backup-cron
RUN chmod 0644 /etc/cron.d/db-backup-cron

# Copy wrapper script
COPY run-backup.sh /app/run-backup.sh
RUN chmod +x /app/run-backup.sh

# Register cron jobs
RUN crontab /etc/cron.d/db-backup-cron

# Run cron in foreground
CMD ["cron", "-f"]
