import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

/**
 * AWS Marketplace metered billing (M6).
 *
 * Reports seat usage to the AWS Marketplace Metering API once per hour.
 * Requires a published AWS Marketplace listing with a metering dimension
 * named "seats" before this stack will work in production.
 *
 * To activate:
 *   1. Submit product listing on AWS Marketplace (takes ~2 weeks for approval)
 *   2. Set MARKETPLACE_PRODUCT_CODE in the Lambda env (from your listing)
 *   3. Add the IAM permission aws-marketplace:MeterUsage to the Lambda role
 *
 * During development/beta: the Lambda runs but calls are no-ops unless
 * MARKETPLACE_PRODUCT_CODE is set, so it is safe to deploy before listing approval.
 *
 * Metering dimension: "seats" = distinct active Person nodes in last 30 days.
 * The Lambda calls GET /brain/seats on the API and reports the count.
 */
export interface MeteringStackProps extends cdk.StackProps {
  apiUrl: string;
}

export class MeteringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MeteringStackProps) {
    super(scope, id, props);

    const { apiUrl } = props;

    // ── Metering Lambda ───────────────────────────────────────────────────────
    const meteringFn = new lambda.Function(this, "MeteringFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      timeout: cdk.Duration.seconds(30),
      environment: {
        BRAIN_API_URL: apiUrl,
        // Set to your AWS Marketplace product code after listing approval
        MARKETPLACE_PRODUCT_CODE: process.env.MARKETPLACE_PRODUCT_CODE ?? "",
        METERING_DIMENSION: "seats",
      },
      code: lambda.Code.fromInline(`
const https = require('https');

// Fetch active seat count from the brain API
async function getActiveSeats(apiUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL('/brain/seats', apiUrl);
    https.get(url.href.replace('http://', 'https://'), (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data).seats ?? 0); }
        catch { resolve(0); }
      });
    }).on('error', reject);
  });
}

// Report usage to AWS Marketplace Metering API
async function reportUsage(seats, productCode, dimension) {
  const { MarketplaceMeteringClient, MeterUsageCommand } = require('@aws-sdk/client-marketplace-metering');
  const client = new MarketplaceMeteringClient({});
  const now = new Date();
  // AWS Marketplace requires timestamps on the hour boundary
  now.setMinutes(0, 0, 0);
  await client.send(new MeterUsageCommand({
    ProductCode: productCode,
    Timestamp: now,
    UsageDimension: dimension,
    UsageQuantity: seats,
    DryRun: false,
  }));
}

exports.handler = async () => {
  const apiUrl = process.env.BRAIN_API_URL;
  const productCode = process.env.MARKETPLACE_PRODUCT_CODE;
  const dimension = process.env.METERING_DIMENSION ?? 'seats';

  if (!productCode) {
    console.log('[metering] MARKETPLACE_PRODUCT_CODE not set — skipping (pre-listing mode)');
    return { status: 'skipped', reason: 'no-product-code' };
  }

  const seats = await getActiveSeats(apiUrl);
  console.log('[metering] active seats:', seats);

  await reportUsage(seats, productCode, dimension);
  console.log('[metering] reported', seats, 'seats to Marketplace');

  return { status: 'ok', seats };
};
      `),
    });

    // Grant marketplace:MeterUsage permission
    meteringFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["aws-marketplace:MeterUsage"],
      resources: ["*"],
    }));

    // ── Run every hour on the hour ────────────────────────────────────────────
    const rule = new events.Rule(this, "MeteringSchedule", {
      schedule: events.Schedule.cron({ minute: "0" }), // top of every hour
      description: "Report Purpl Brain seat usage to AWS Marketplace",
    });

    rule.addTarget(new targets.LambdaFunction(meteringFn));

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "MeteringFnArn", {
      value: meteringFn.functionArn,
      description: "Set MARKETPLACE_PRODUCT_CODE env var after listing approval",
    });
  }
}
