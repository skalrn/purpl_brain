import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as efs from "aws-cdk-lib/aws-efs";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export interface DataStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  cluster: ecs.Cluster;
}

/**
 * Stateful data layer:
 *   - ElastiCache (Redis) — event streams
 *   - Neo4j on ECS Fargate + EFS — knowledge graph
 *   - Qdrant on ECS Fargate + EFS — vector store
 */
export class DataStack extends cdk.Stack {
  public readonly redisEndpoint: string;
  public readonly neo4jEndpoint: string;
  public readonly qdrantEndpoint: string;
  public readonly neo4jSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { vpc, cluster } = props;

    // ── Security groups ───────────────────────────────────────────────────────
    const redisSg = new ec2.SecurityGroup(this, "RedisSg", { vpc, description: "Redis" });
    const neo4jSg = new ec2.SecurityGroup(this, "Neo4jSg", { vpc, description: "Neo4j" });
    const qdrantSg = new ec2.SecurityGroup(this, "QdrantSg", { vpc, description: "Qdrant" });

    // Allow app tier to reach data services
    redisSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(6379), "Redis from VPC");
    neo4jSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(7474), "Neo4j HTTP from VPC");
    neo4jSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(7687), "Neo4j Bolt from VPC");
    qdrantSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(6333), "Qdrant REST from VPC");
    qdrantSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(6334), "Qdrant gRPC from VPC");

    // ── ElastiCache (Redis) ───────────────────────────────────────────────────
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, "RedisSubnetGroup", {
      description: "Purpl Brain Redis",
      subnetIds: vpc.privateSubnets.map((s) => s.subnetId),
    });

    const redis = new elasticache.CfnCacheCluster(this, "Redis", {
      cacheNodeType: "cache.t4g.micro",
      engine: "redis",
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
    });

    this.redisEndpoint = `redis://${redis.attrRedisEndpointAddress}:${redis.attrRedisEndpointPort}`;

    // ── EFS for persistent storage ────────────────────────────────────────────
    const neo4jFs = new efs.FileSystem(this, "Neo4jFs", {
      vpc,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // never delete data on stack destroy
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
    });

    const qdrantFs = new efs.FileSystem(this, "QdrantFs", {
      vpc,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
    });

    // ── Neo4j secret ──────────────────────────────────────────────────────────
    this.neo4jSecret = new secretsmanager.Secret(this, "Neo4jSecret", {
      description: "Neo4j admin password",
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    // ── Neo4j on ECS Fargate ──────────────────────────────────────────────────
    const neo4jTaskDef = new ecs.FargateTaskDefinition(this, "Neo4jTask", {
      cpu: 1024,
      memoryLimitMiB: 2048,
    });

    neo4jTaskDef.addVolume({
      name: "neo4j-data",
      efsVolumeConfiguration: {
        fileSystemId: neo4jFs.fileSystemId,
        transitEncryption: "ENABLED",
      },
    });

    const neo4jContainer = neo4jTaskDef.addContainer("Neo4j", {
      image: ecs.ContainerImage.fromRegistry("neo4j:5.20"),
      environment: {
        NEO4J_AUTH: "neo4j/$(NEO4J_PASSWORD)",
        NEO4J_dbms_memory_heap_max__size: "1G",
        NEO4J_dbms_memory_pagecache_size: "512M",
      },
      secrets: {
        NEO4J_PASSWORD: ecs.Secret.fromSecretsManager(this.neo4jSecret),
      },
      portMappings: [
        { containerPort: 7474, name: "http" },
        { containerPort: 7687, name: "bolt" },
      ],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "neo4j" }),
    });

    neo4jContainer.addMountPoints({
      containerPath: "/data",
      sourceVolume: "neo4j-data",
      readOnly: false,
    });

    neo4jFs.connections.allowDefaultPortFrom(neo4jSg);

    const neo4jService = new ecs.FargateService(this, "Neo4jService", {
      cluster,
      taskDefinition: neo4jTaskDef,
      desiredCount: 1,
      securityGroups: [neo4jSg],
      assignPublicIp: false,
      cloudMapOptions: { name: "neo4j" }, // neo4j.purpl-brain.local
    });

    this.neo4jEndpoint = `bolt://neo4j.purpl-brain.local:7687`;
    void neo4jService; // referenced via Cloud Map

    // ── Qdrant on ECS Fargate ─────────────────────────────────────────────────
    const qdrantTaskDef = new ecs.FargateTaskDefinition(this, "QdrantTask", {
      cpu: 1024,
      memoryLimitMiB: 2048,
    });

    qdrantTaskDef.addVolume({
      name: "qdrant-data",
      efsVolumeConfiguration: {
        fileSystemId: qdrantFs.fileSystemId,
        transitEncryption: "ENABLED",
      },
    });

    const qdrantContainer = qdrantTaskDef.addContainer("Qdrant", {
      image: ecs.ContainerImage.fromRegistry("qdrant/qdrant:v1.9.0"),
      portMappings: [
        { containerPort: 6333, name: "rest" },
        { containerPort: 6334, name: "grpc" },
      ],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "qdrant" }),
    });

    qdrantContainer.addMountPoints({
      containerPath: "/qdrant/storage",
      sourceVolume: "qdrant-data",
      readOnly: false,
    });

    qdrantFs.connections.allowDefaultPortFrom(qdrantSg);

    const qdrantService = new ecs.FargateService(this, "QdrantService", {
      cluster,
      taskDefinition: qdrantTaskDef,
      desiredCount: 1,
      securityGroups: [qdrantSg],
      assignPublicIp: false,
      cloudMapOptions: { name: "qdrant" }, // qdrant.purpl-brain.local
    });

    this.qdrantEndpoint = `http://qdrant.purpl-brain.local:6333`;
    void qdrantService;

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "RedisUrl", { value: this.redisEndpoint });
    new cdk.CfnOutput(this, "Neo4jBoltUrl", { value: this.neo4jEndpoint });
    new cdk.CfnOutput(this, "QdrantUrl", { value: this.qdrantEndpoint });
  }
}
