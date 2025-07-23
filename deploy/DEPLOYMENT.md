# AWS Deployment Guide for Roasted Chessnuts

## Architecture
- Single EC2 instance running Docker
- CloudFront for HTTPS and caching
- Route53 for domain management
- ECR for Docker image storage
- WebSocket connections go directly from browser to Daisys API

## Prerequisites

1. AWS CLI configured with appropriate credentials
2. Docker installed locally
3. EC2 key pair created in your AWS region
4. ACM certificate in us-east-1 (for CloudFront)
5. Route53 hosted zone for your domain

## Environment Variables

Set these before running the deployment:

```bash
export AWS_REGION=us-east-1
export DOMAIN_NAME=chessnuts.example.com
export HOSTED_ZONE_ID=Z1234567890ABC
export ACM_CERTIFICATE_ARN=arn:aws:acm:us-east-1:123456789012:certificate/...
export OPENAI_API_KEY=sk-...
export DAISYS_API_KEY=...
export KEY_NAME=my-ec2-keypair
```

## Deploy

Run the deployment script:

```bash
./scripts/deploy.sh
```

This will:
1. Create an ECR repository
2. Build and push the Docker image
3. Deploy CloudFormation stack with:
   - EC2 instance with Docker
   - CloudFront distribution
   - Route53 DNS record

## Caching Strategy

CloudFront behaviors:
- `/_next/static/*` - Cached for 1 year (immutable assets)
- `/static/*` - Cached for 1 week
- `/api/*` - Not cached (dynamic content)
- `/` and other pages - Cached for 5 minutes

## Post-Deployment

- CloudFront takes 15-30 minutes to fully deploy
- You can test directly via EC2 IP while waiting
- SSH access: `ssh -i <keyname>.pem ec2-user@<ec2-ip>`
- View logs: `aws logs tail /aws/ec2/roasted-chessnuts --follow`

## Updates

To deploy updates:
1. Make your code changes
2. Run `./scripts/deploy.sh` again
3. The script will push a new image and update the EC2 instance