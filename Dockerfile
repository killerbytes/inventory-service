FROM node:18

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm install

# Copy all files (including backup.js and crontab)
COPY . .

# Install cron + Postgres client
RUN apt-get update && apt-get install -y cron postgresql-client

# Copy cron schedule
COPY crontab /etc/cron.d/db-backup-cron

# Set correct permissions
RUN chmod 0644 /etc/cron.d/db-backup-cron

# Apply cron job
RUN crontab /etc/cron.d/db-backup-cron

# Run cron in foreground
CMD ["cron", "-f"]
