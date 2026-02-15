#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GarbanzoEc2Stack } from '../lib/garbanzo-ec2-stack.js';

const app = new cdk.App();

new GarbanzoEc2Stack(app, 'GarbanzoEc2Stack', {
  /*
   * Set these via `cdk deploy` context or environment:
   *
   *   cdk deploy \
   *     -c appVersion=0.1.1 \
   *     -c envParamName=/garbanzo/prod/env \
   *     -c groupsParamName=/garbanzo/prod/groups_json \
   *     -c allowedHealthCidr=203.0.113.4/32
   */
});
