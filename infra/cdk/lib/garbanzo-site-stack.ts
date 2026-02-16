import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEBSITE_ASSET_PATH = resolve(__dirname, '../../../website');

function optionalContext(app: cdk.App, key: string): string | undefined {
  const value = app.node.tryGetContext(key);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePriceClass(value: string | undefined): cloudfront.PriceClass {
  const normalized = String(value ?? '100').trim();
  if (normalized === '200') return cloudfront.PriceClass.PRICE_CLASS_200;
  if (normalized === 'all') return cloudfront.PriceClass.PRICE_CLASS_ALL;
  return cloudfront.PriceClass.PRICE_CLASS_100;
}

export class GarbanzoSiteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const app = this.node.root as cdk.App;

    const bucketName = optionalContext(app, 'siteBucketName');
    const websiteIndex = optionalContext(app, 'siteIndexDocument') ?? 'index.html';
    const websiteError = optionalContext(app, 'siteErrorDocument') ?? 'index.html';
    const priceClass = parsePriceClass(optionalContext(app, 'sitePriceClass'));

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultRootObject: websiteIndex,
      priceClass,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      },
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: `/${websiteError}`,
          ttl: cdk.Duration.minutes(5),
        },
      ],
    });

    new s3deploy.BucketDeployment(this, 'SiteDeployment', {
      destinationBucket: siteBucket,
      sources: [s3deploy.Source.asset(WEBSITE_ASSET_PATH)],
      distribution,
      distributionPaths: ['/*'],
      prune: true,
      retainOnDelete: false,
    });

    new cdk.CfnOutput(this, 'WebsiteUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Public CloudFront URL for the Garbanzo marketing/support site',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
    });

    new cdk.CfnOutput(this, 'SiteBucketName', {
      value: siteBucket.bucketName,
    });
  }
}
