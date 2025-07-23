# Build stage for Next.js
FROM node:20-alpine AS frontend-builder
WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./
RUN apk add curl
RUN npm ci

# Copy only necessary frontend source files
COPY next.config.ts ./
COPY tsconfig.json ./
COPY postcss.config.mjs ./
COPY src/ ./src/
COPY public/ ./public/

# Build the frontend
RUN npm run build
RUN npm run export || npx next export || echo "Export not configured"

# Final stage with Python backend
FROM python:3.11-slim
WORKDIR /app

# Force Python to run in unbuffered mode
ENV PYTHONUNBUFFERED=1

# Install backend dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY backend/ .

# Copy built frontend files
COPY --from=frontend-builder /app/out /app/static

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]