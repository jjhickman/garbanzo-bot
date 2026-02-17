#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GarbanzoEc2Stack } from '../lib/garbanzo-ec2-stack.js';
import { GarbanzoEcsStack } from '../lib/garbanzo-ecs-stack.js';
import { GarbanzoSiteStack } from '../lib/garbanzo-site-stack.js';

const app = new cdk.App();

const deployEc2 = String(app.node.tryGetContext('deployEc2') ?? 'true').toLowerCase() !== 'false';
const deployEcs = String(app.node.tryGetContext('deployEcs') ?? 'false').toLowerCase() === 'true';
const deploySite = String(app.node.tryGetContext('deploySite') ?? 'false').toLowerCase() === 'true';

if (!deployEc2 && !deployEcs && !deploySite) {
  throw new Error('Nothing to deploy: set -c deployEc2=true, -c deployEcs=true, or -c deploySite=true');
}

if (deployEc2) {
  new GarbanzoEc2Stack(app, 'GarbanzoEc2Stack', {
    /*
     * Set these via `cdk deploy` context or environment:
     *
     *   cdk deploy GarbanzoEc2Stack \
     *     -c appVersion=0.1.8 \
     *     -c envParamName=/garbanzo/prod/env \
     *     -c groupsParamName=/garbanzo/prod/groups_json \
     *     -c allowedHealthCidr=203.0.113.4/32
     */
  });
}

if (deployEcs) {
  new GarbanzoEcsStack(app, 'GarbanzoEcsStack', {
    /*
     * Example:
     *
     *   cdk deploy GarbanzoEcsStack \
     *     -c deployEc2=false \
     *     -c deployEcs=true \
     *     -c appVersion=0.1.8 \
     *     -c ownerJid=U1234567890 \
     *     -c slackSecretArn=arn:aws:secretsmanager:...:secret:garbanzo/slack \
     *     -c discordSecretArn=arn:aws:secretsmanager:...:secret:garbanzo/discord
     */
  });
}

if (deploySite) {
  new GarbanzoSiteStack(app, 'GarbanzoSiteStack', {
    /*
     * Example:
     *
     *   cdk deploy GarbanzoSiteStack \
     *     -c deployEc2=false \
     *     -c deploySite=true
     */
  });
}
