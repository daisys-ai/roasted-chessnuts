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

# Build argument to control build mode
ARG BUILD_MODE=production

# Conditionally build the frontend based on BUILD_MODE
RUN if [ "$BUILD_MODE" = "production" ]; then \
        echo "Building frontend for production..." && \
        npm run build && \
        (npm run export || npx next export || echo "Export not configured"); \
    else \
        echo "Skipping frontend build for development mode" && \
        mkdir -p out && \
        echo '<!DOCTYPE html><html><body><h1>Development Mode</h1><p>Run npm run dev for frontend development</p></body></html>' > out/index.html; \
    fi

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