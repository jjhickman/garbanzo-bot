#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GarbanzoEc2Stack } from '../lib/garbanzo-ec2-stack.js';
import { GarbanzoSiteStack } from '../lib/garbanzo-site-stack.js';

const app = new cdk.App();

const deployEc2 = String(app.node.tryGetContext('deployEc2') ?? 'true').toLowerCase() !== 'false';
const deploySite = String(app.node.tryGetContext('deploySite') ?? 'false').toLowerCase() === 'true';

if (!deployEc2 && !deploySite) {
  throw new Error('Nothing to deploy: set -c deployEc2=true or -c deploySite=true');
}

if (deployEc2) {
  new GarbanzoEc2Stack(app, 'GarbanzoEc2Stack', {
    /*
     * Set these via `cdk deploy` context or environment:
     *
     *   cdk deploy GarbanzoEc2Stack \
     *     -c appVersion=0.1.6 \
     *     -c envParamName=/garbanzo/prod/env \
     *     -c groupsParamName=/garbanzo/prod/groups_json \
     *     -c allowedHealthCidr=203.0.113.4/32
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
