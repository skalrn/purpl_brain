#!/usr/bin/env node
/**
 * Purpl Brain CDK App — deploys to us-west-2 by default.
 *
 * Prerequisites:
 *   1. AWS CLI configured: `aws configure` (or use IAM role / SSO)
 *   2. CDK bootstrapped: `cdk bootstrap aws://ACCOUNT/us-west-2`
 *   3. Secrets pre-created in Secrets Manager (see README below):
 *        purpl-brain/anthropic-api-key
 *        purpl-brain/github-token
 *        purpl-brain/session-secret
 *        purpl-brain/github-client-id
 *        purpl-brain/github-client-secret
 *
 * Deploy:
 *   cd apps/cdk
 *   npm run deploy         # deploys all stacks
 *   npm run diff           # preview changes
 *
 * Tear down (keeps EFS data):
 *   npm run destroy
 */
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import { DataStack } from "../lib/data-stack";
import { AppStack } from "../lib/app-stack";
import { MeteringStack } from "../lib/metering-stack";

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
};

// ── Shared VPC + ECS cluster (used by data and app stacks) ───────────────────
class InfraStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly cluster: ecs.Cluster;

  constructor(scope: cdk.App, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1, // one NAT per AZ is cheaper; workers need outbound internet for LLM calls
      subnetConfiguration: [
        { name: "Public",  subnetType: ec2.SubnetType.PUBLIC,           cidrMask: 24 },
        { name: "Private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    this.cluster = new ecs.Cluster(this, "Cluster", {
      vpc: this.vpc,
      containerInsights: true,
      defaultCloudMapNamespace: {
        name: "purpl-brain.local",
      },
    });
  }
}

const infra = new InfraStack(app, "PurplBrainInfra", { env });

const data = new DataStack(app, "PurplBrainData", {
  env,
  vpc: infra.vpc,
  cluster: infra.cluster,
});

const appStack = new AppStack(app, "PurplBrainApp", {
  env,
  vpc: infra.vpc,
  cluster: infra.cluster,
  redisEndpoint: data.redisEndpoint,
  neo4jEndpoint: data.neo4jEndpoint,
  qdrantEndpoint: data.qdrantEndpoint,
  neo4jSecret: data.neo4jSecret,
});

new MeteringStack(app, "PurplBrainMetering", {
  env,
  apiUrl: appStack.apiUrl,
});

app.synth();
