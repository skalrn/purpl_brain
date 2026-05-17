# Purpl Brain — AWS CDK Stack

Deploys the full Purpl Brain stack to AWS (us-west-2 by default).

## Architecture

```
Internet
   │
   ▼
Application Load Balancer
   │
   ▼
ECS Fargate — API server (apps/api)
ECS Fargate — Normalizer worker
ECS Fargate — Extractor worker
ECS Fargate — Brain-writer worker
ECS Fargate — Drift-detector worker
   │
   ├─ ElastiCache (Redis) — event streams
   ├─ ECS Fargate — Neo4j + EFS — knowledge graph
   └─ ECS Fargate — Qdrant + EFS — vector store
```

All services run in private subnets. Only the ALB is public.
Neo4j and Qdrant data persists on EFS (retained on stack destroy).

## Prerequisites

1. **AWS CLI configured**
   ```bash
   aws configure   # or use SSO / IAM role
   ```

2. **CDK bootstrapped** (one-time per account/region)
   ```bash
   cdk bootstrap aws://YOUR_ACCOUNT_ID/us-west-2
   ```

3. **Secrets pre-created in Secrets Manager**
   ```bash
   aws secretsmanager create-secret --name purpl-brain/anthropic-api-key \
     --secret-string "sk-ant-..."
   aws secretsmanager create-secret --name purpl-brain/github-token \
     --secret-string "ghp_..."
   aws secretsmanager create-secret --name purpl-brain/session-secret \
     --secret-string "$(openssl rand -hex 32)"
   aws secretsmanager create-secret --name purpl-brain/github-client-id \
     --secret-string "your-github-oauth-app-client-id"
   aws secretsmanager create-secret --name purpl-brain/github-client-secret \
     --secret-string "your-github-oauth-app-client-secret"
   ```

4. **Docker running** (CDK builds and pushes the API image to ECR)

## Deploy

```bash
cd apps/cdk
npm install
npm run synth    # preview CloudFormation templates
npm run deploy   # deploy all stacks (~15 min first run)
```

CDK deploys four stacks in order:
- `PurplBrainInfra` — VPC, ECS cluster, Cloud Map namespace
- `PurplBrainData`  — Redis, Neo4j, Qdrant
- `PurplBrainApp`   — API server + workers, ALB
- `PurplBrainMetering` — Billing Lambda (hourly seat reporting)

## After deploy

1. **Note the API URL** from the `PurplBrainApp.ApiUrl` output
2. **Point the MCP server at the cloud brain:**
   In `.claude/settings.json`, set `BRAIN_API_URL` to the ALB URL
3. **Seed your first repo:**
   ```bash
   BRAIN_API_URL=http://<alb-dns> npm run seed:github -w apps/api -- --repo your-org/your-repo
   ```
4. **Configure GitHub webhook** (for live ingestion):
   - Go to your repo → Settings → Webhooks → Add webhook
   - Payload URL: `http://<alb-dns>/webhooks/github`
   - Content type: `application/json`
   - Secret: your `GITHUB_WEBHOOK_SECRET` value

## AWS Marketplace metered billing

The `MeteringStack` deploys a Lambda that reports seat usage hourly. It is
inert until you have a published Marketplace listing:

1. Submit product listing at [AWS Marketplace Management Portal](https://aws.amazon.com/marketplace/management/)
2. Add a metering dimension named `seats` (unit: per-seat per hour)
3. After approval (~2 weeks), update the Lambda env var:
   ```bash
   aws lambda update-function-configuration \
     --function-name PurplBrainMetering-MeteringFn \
     --environment Variables="{MARKETPLACE_PRODUCT_CODE=YOUR_CODE,...}"
   ```

## Tear down

```bash
npm run destroy
```

EFS file systems (Neo4j + Qdrant data) are retained after destroy.
Delete them manually from the AWS console if you want a full cleanup.
