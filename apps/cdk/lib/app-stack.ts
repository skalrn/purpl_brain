import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as path from "path";
import { Construct } from "constructs";

export interface AppStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  cluster: ecs.Cluster;
  redisEndpoint: string;
  neo4jEndpoint: string;
  qdrantEndpoint: string;
  neo4jSecret: secretsmanager.Secret;
}

/**
 * Application layer: API server + 4 workers on ECS Fargate.
 * All services share one Docker image built from apps/api.
 * The API is internet-facing via ALB; workers run in private subnets.
 */
export class AppStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const { vpc, cluster, redisEndpoint, neo4jEndpoint, qdrantEndpoint, neo4jSecret } = props;

    // ── Secrets ───────────────────────────────────────────────────────────────
    const anthropicSecret = secretsmanager.Secret.fromSecretNameV2(
      this, "AnthropicSecret", "purpl-brain/anthropic-api-key"
    );
    const githubSecret = secretsmanager.Secret.fromSecretNameV2(
      this, "GithubSecret", "purpl-brain/github-token"
    );
    const sessionSecret = secretsmanager.Secret.fromSecretNameV2(
      this, "SessionSecret", "purpl-brain/session-secret"
    );
    const githubOAuthClientId = secretsmanager.Secret.fromSecretNameV2(
      this, "GithubClientId", "purpl-brain/github-client-id"
    );
    const githubOAuthClientSecret = secretsmanager.Secret.fromSecretNameV2(
      this, "GithubClientSecret", "purpl-brain/github-client-secret"
    );

    // ── Docker image (shared by API + all workers) ────────────────────────────
    const apiImage = new ecr_assets.DockerImageAsset(this, "ApiImage", {
      directory: path.join(__dirname, "../../../api"),
      file: "Dockerfile",
    });

    const image = ecs.ContainerImage.fromDockerImageAsset(apiImage);

    // Common env vars shared by all services
    const commonEnv: Record<string, string> = {
      REDIS_URL: redisEndpoint,
      NEO4J_URI: neo4jEndpoint,
      NEO4J_USER: "neo4j",
      QDRANT_URL: qdrantEndpoint,
      LLM_PROVIDER: "anthropic",
      LLM_MODEL: "claude-haiku-4-5-20251001",
      EXTRACTION_MODEL: "claude-haiku-4-5-20251001",
      NODE_ENV: "production",
      GITHUB_CALLBACK_URL: `https://api.purpl-brain.io/auth/github/callback`,
      UI_BASE_URL: `https://app.purpl-brain.io`,
      DRIFT_SEMANTIC_THRESHOLD: "0.55",
      DRIFT_TOP_K: "3",
    };

    const commonSecrets: Record<string, ecs.Secret> = {
      ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(anthropicSecret),
      GITHUB_TOKEN: ecs.Secret.fromSecretsManager(githubSecret),
      NEO4J_PASSWORD: ecs.Secret.fromSecretsManager(neo4jSecret),
      SESSION_SECRET: ecs.Secret.fromSecretsManager(sessionSecret),
      GITHUB_CLIENT_ID: ecs.Secret.fromSecretsManager(githubOAuthClientId),
      GITHUB_CLIENT_SECRET: ecs.Secret.fromSecretsManager(githubOAuthClientSecret),
    };

    // ── API service (internet-facing via ALB) ─────────────────────────────────
    const apiService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "ApiService", {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 1,
      publicLoadBalancer: true,
      taskImageOptions: {
        image,
        containerPort: 3001,
        environment: commonEnv,
        secrets: commonSecrets,
        command: ["node", "dist/index.js"],
      },
    });

    apiService.targetGroup.configureHealthCheck({
      path: "/health",
      healthyHttpCodes: "200",
      interval: cdk.Duration.seconds(30),
    });

    this.apiUrl = `http://${apiService.loadBalancer.loadBalancerDnsName}`;

    // ── Workers (private, no ALB) ─────────────────────────────────────────────
    const workerServices = [
      { name: "Normalizer", command: ["node", "dist/workers/normalizer.js"] },
      { name: "Extractor",  command: ["node", "dist/workers/extractor.js"]  },
      { name: "BrainWriter",command: ["node", "dist/workers/brain-writer.js"]},
      { name: "DriftDetector", command: ["node", "dist/workers/drift-detector.js"] },
    ];

    for (const worker of workerServices) {
      const taskDef = new ecs.FargateTaskDefinition(this, `${worker.name}Task`, {
        cpu: 256,
        memoryLimitMiB: 512,
      });

      taskDef.addContainer(worker.name, {
        image,
        command: worker.command,
        environment: commonEnv,
        secrets: commonSecrets,
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: worker.name.toLowerCase() }),
      });

      new ecs.FargateService(this, `${worker.name}Service`, {
        cluster,
        taskDefinition: taskDef,
        desiredCount: 1,
        assignPublicIp: false,
      });
    }

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "ApiUrl", {
      value: this.apiUrl,
      description: "Brain API — set BRAIN_API_URL in MCP server config",
    });
    new cdk.CfnOutput(this, "ApiUrlHttps", {
      value: `https://${apiService.loadBalancer.loadBalancerDnsName}`,
      description: "Add your domain → ALB alias record to use HTTPS",
    });
  }
}
