import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';

function requireContext(app: cdk.App, key: string): string {
  const value = app.node.tryGetContext(key);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required CDK context value: ${key}`);
  }
  return value;
}

function optionalContext(app: cdk.App, key: string): string | undefined {
  const value = app.node.tryGetContext(key);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class GarbanzoEc2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const app = this.node.root as cdk.App;

    const appVersion = optionalContext(app, 'appVersion') ?? '0.1.1';
    const envParamName = requireContext(app, 'envParamName');
    const groupsParamName = requireContext(app, 'groupsParamName');
    const allowedHealthCidr = optionalContext(app, 'allowedHealthCidr');

    // Default VPC keeps this easy to adopt.
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    const sg = new ec2.SecurityGroup(this, 'GarbanzoSg', {
      vpc,
      allowAllOutbound: true,
      description: 'Garbanzo EC2 security group',
    });

    // Prefer SSM Session Manager instead of opening SSH.
    // If you want SSH, add an ingress rule explicitly in your fork.

    if (allowedHealthCidr) {
      sg.addIngressRule(ec2.Peer.ipv4(allowedHealthCidr), ec2.Port.tcp(3001), 'Health endpoint (restricted)');
    }

    const role = new iam.Role(this, 'GarbanzoInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'EC2 role for Garbanzo (SSM + Parameter Store reads)',
    });

    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [
        `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter${envParamName}`,
        `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter${groupsParamName}`,
      ],
    }));

    // Ubuntu 24.04 LTS
    const machineImage = ec2.MachineImage.fromSsmParameter(
      '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
    );

    const instance = new ec2.Instance(this, 'GarbanzoEc2', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.SMALL),
      machineImage,
      securityGroup: sg,
      role,
    });

    instance.addUserData(
      'set -euo pipefail',
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get update -y',
      'apt-get install -y git awscli ca-certificates curl',
      'apt-get install -y docker.io docker-compose-plugin',
      'systemctl enable --now docker',
      'mkdir -p /opt/garbanzo',
      'cd /opt/garbanzo',
      'if [ ! -d garbanzo-bot ]; then git clone https://github.com/jjhickman/garbanzo-bot.git; fi',
      'cd garbanzo-bot',
      // Pull secrets/config from Parameter Store.
      `aws ssm get-parameter --with-decryption --name "${envParamName}" --query 'Parameter.Value' --output text > .env`,
      `aws ssm get-parameter --name "${groupsParamName}" --query 'Parameter.Value' --output text > config/groups.json`,
      // Deploy pinned version.
      `APP_VERSION=${appVersion} docker compose -f docker-compose.yml -f docker-compose.prod.yml pull garbanzo`,
      `APP_VERSION=${appVersion} docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`,
    );

    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new cdk.CfnOutput(this, 'PublicIp', { value: instance.instancePublicIp });
    new cdk.CfnOutput(this, 'HealthUrl', {
      value: `http://${instance.instancePublicIp}:3001/health`,
      description: 'Only reachable if allowedHealthCidr is set and matches your source IP',
    });
  }
}
