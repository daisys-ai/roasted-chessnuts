# AWS Deployment Plan for Roasted Chessnuts

## Architecture Overview
- EC2 instance running Docker Compose
- CloudFront for HTTPS termination and caching
- Route53 for domain management
- ECR for Docker image storage

## URL Structure & Caching Strategy

### CloudFront Behaviors:
1. **`/_next/static/*`** - Cache: 1 year (immutable Next.js assets)
2. **`/static/*`** - Cache: 1 week (other static assets)
3. **`/api/*`** - Cache: None (dynamic API endpoints)
4. **`/ws`** - Cache: None (WebSocket endpoint - requires special handling)
5. **`/`** - Cache: 5 minutes (HTML pages)
6. **Default (*)** - Cache: None

### Current Endpoints:
- `/` - Main page
- `/api/move-stream` - SSE endpoint for move commentary
- `/api/websocket-url` - Returns WebSocket URL for Daisys
- `/ws` - WebSocket endpoint

## Deployment Steps

### Step 1: Set up ECR Repository
```bash
./scripts/1-setup-ecr.sh
```

### Step 2: Build and Push Docker Images
```bash
./scripts/2-push-images.sh
```

### Step 3: Deploy CloudFormation Stack
```bash
./scripts/3-deploy-stack.sh
```

## Environment Variables Required
- `AWS_REGION`
- `DOMAIN_NAME` (e.g., chessnuts.example.com)
- `HOSTED_ZONE_ID`
- `ACM_CERTIFICATE_ARN`
- `OPENAI_API_KEY`
- `DAISYS_API_KEY`