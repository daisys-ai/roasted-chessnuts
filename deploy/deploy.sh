#!/bin/bash
set -e

# Get the absolute path to the directory containing this script
SCRIPT_DIR="$(readlink -f $(dirname $0))"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "🔥 Deploying Roasted Chessnuts to AWS..."

# Source .env.deploy from the project root
if [ -f "$PROJECT_ROOT/.env.deploy" ]; then
    echo "Loading environment from $PROJECT_ROOT/.env.deploy..."
    set -a  # automatically export all variables
    source "$PROJECT_ROOT/.env.deploy"
    set +a
else
    echo "Error: .env.deploy not found at $PROJECT_ROOT/.env.deploy"
    exit 1
fi

# Check required environment variables
REQUIRED_VARS=(
    "AWS_REGION"
    "DOMAIN_NAME"
    "HOSTED_ZONE_ID"
    "ACM_CERTIFICATE_ARN"
    "OPENAI_API_KEY"
    "DAISYS_EMAIL"
    "DAISYS_PASSWORD"
    "DAISYS_VOICE_ID"
    "KEY_NAME"
)

for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var}" ]; then
        echo "Error: $var not set in .env.deploy"
        echo "Please set all required environment variables in .env.deploy:"
        echo "  AWS_REGION=us-east-1"
        echo "  DOMAIN_NAME=chessnuts.example.com"
        echo "  HOSTED_ZONE_ID=Z1234567890ABC"
        echo "  ACM_CERTIFICATE_ARN=arn:aws:acm:us-east-1:..."
        echo "  OPENAI_API_KEY=sk-..."
        echo "  DAISYS_EMAIL=your-email@example.com"
        echo "  DAISYS_PASSWORD=your-password"
        echo "  DAISYS_VOICE_ID=your-voice-id"
        echo "  KEY_NAME=my-ec2-keypair"
        exit 1
    fi
done

REPOSITORY_NAME="roasted-chessnuts"
STACK_NAME="roasted-chessnuts"

# Step 1: Create ECR repository
echo "📦 Setting up ECR repository..."
if aws ecr describe-repositories --repository-names $REPOSITORY_NAME --region $AWS_REGION >/dev/null 2>&1; then
    echo "ECR repository already exists"
else
    echo "Creating ECR repository..."
    aws ecr create-repository \
        --repository-name $REPOSITORY_NAME \
        --region $AWS_REGION \
        --image-scanning-configuration scanOnPush=true
fi

# Get repository URI
REPOSITORY_URI=$(aws ecr describe-repositories \
    --repository-names $REPOSITORY_NAME \
    --region $AWS_REGION \
    --query 'repositories[0].repositoryUri' \
    --output text)

echo "ECR Repository URI: $REPOSITORY_URI"

# Set lifecycle policy
aws ecr put-lifecycle-policy \
    --repository-name $REPOSITORY_NAME \
    --region $AWS_REGION \
    --lifecycle-policy-text '{
        "rules": [{
            "rulePriority": 1,
            "description": "Keep last 10 images",
            "selection": {
                "tagStatus": "any",
                "countType": "imageCountMoreThan",
                "countNumber": 10
            },
            "action": {"type": "expire"}
        }]
    }' > /dev/null

# Step 2: Build and push Docker image
echo "🐳 Building Docker image..."
cd "$PROJECT_ROOT"
docker build --build-arg BUILD_MODE=production -t roasted-chessnuts:latest .

# Login to ECR
echo "Logging in to ECR..."
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $REPOSITORY_URI

# Tag and push
TAG="$(date +%Y%m%d-%H%M%S)"
docker tag roasted-chessnuts:latest $REPOSITORY_URI:latest
docker tag roasted-chessnuts:latest $REPOSITORY_URI:$TAG

echo "Pushing to ECR..."
docker push $REPOSITORY_URI:latest
docker push $REPOSITORY_URI:$TAG

DOCKER_IMAGE_URI="$REPOSITORY_URI:$TAG"
echo "Pushed image: $DOCKER_IMAGE_URI"

# Step 3: Deploy CloudFormation stack
echo "☁️  Deploying CloudFormation stack..."
aws cloudformation deploy \
    --template-file "$SCRIPT_DIR/cloudformation-template.yaml" \
    --stack-name $STACK_NAME \
    --parameter-overrides \
        DomainName=$DOMAIN_NAME \
        HostedZoneId=$HOSTED_ZONE_ID \
        CertificateArn=$ACM_CERTIFICATE_ARN \
        DockerImageUri=$DOCKER_IMAGE_URI \
        OpenAIApiKey=$OPENAI_API_KEY \
        DaisysEmail=$DAISYS_EMAIL \
        DaisysPassword=$DAISYS_PASSWORD \
        DaisysVoiceId="$DAISYS_VOICE_ID" \
        KeyName=$KEY_NAME \
    --capabilities CAPABILITY_IAM \
    --region $AWS_REGION

# Get outputs
echo "📊 Getting deployment info..."
DOMAIN_URL=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`DomainURL`].OutputValue' \
    --output text)

EC2_IP=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`EC2PublicIP`].OutputValue' \
    --output text)

EC2_ID=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`EC2InstanceId`].OutputValue' \
    --output text)

echo ""
echo "✅ Deployment complete!"
echo "🌐 Application URL: $DOMAIN_URL"
echo "🖥️  EC2 Instance: $EC2_ID ($EC2_IP)"
echo "📡 SSH: ssh -i $KEY_NAME.pem ec2-user@$EC2_IP"
echo ""
echo "⏳ Note: CloudFront distribution may take 15-30 minutes to fully deploy."
echo "   You can check the app directly at: http://$EC2_IP"
echo ""
echo "🔍 View logs: aws logs tail /aws/ec2/roasted-chessnuts --follow"
