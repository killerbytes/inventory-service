# Use official Node image
FROM node:20-slim

# Install PostgreSQL client tools (pg_dump, pg_restore, psql)
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client \
 && rm -rf /var/lib/apt/lists/*

# Set work directory
WORKDIR /app

# Copy package files and install deps
COPY package*.json ./
RUN npm install --production

# Copy app source
COPY . .

# Default command (your app server)
CMD ["npm", "start"]
