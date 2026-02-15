import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

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
    const createParameters = (optionalContext(app, 'createParameters') ?? 'false').toLowerCase() === 'true';

    const logGroupName = optionalContext(app, 'logGroupName') ?? '/garbanzo/prod';
    const logRetentionDaysRaw = optionalContext(app, 'logRetentionDays');
    const logRetentionDays = logRetentionDaysRaw ? Number.parseInt(logRetentionDaysRaw, 10) : 14;

    const networkMode = (optionalContext(app, 'networkMode') ?? 'default').toLowerCase();

    const vpc = networkMode === 'private'
      ? new ec2.Vpc(this, 'GarbanzoVpc', {
        maxAzs: 2,
        natGateways: 1,
        subnetConfiguration: [
          { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
          { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        ],
      })
      // Default VPC keeps this easy to adopt.
      : ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

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
      description: 'EC2 role for Garbanzo (SSM + Parameter Store reads + CloudWatch Logs)',
    });

    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

    const envParamArn = `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter${envParamName}`;
    const groupsParamArn = `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter${groupsParamName}`;

    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [envParamArn, groupsParamArn],
    }));

    const logGroup = new logs.LogGroup(this, 'GarbanzoLogGroup', {
      logGroupName,
      retention: logRetentionDays === 1 ? logs.RetentionDays.ONE_DAY
        : logRetentionDays === 3 ? logs.RetentionDays.THREE_DAYS
          : logRetentionDays === 5 ? logs.RetentionDays.FIVE_DAYS
            : logRetentionDays === 7 ? logs.RetentionDays.ONE_WEEK
              : logRetentionDays === 14 ? logs.RetentionDays.TWO_WEEKS
                : logRetentionDays === 30 ? logs.RetentionDays.ONE_MONTH
                  : logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:DescribeLogStreams',
        'logs:PutLogEvents',
      ],
      resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`],
    }));

    if (createParameters) {
      // Placeholders only. Avoid putting real secrets/config into CloudFormation.
      new ssm.StringParameter(this, 'GarbanzoEnvParam', {
        parameterName: envParamName,
        type: ssm.ParameterType.SECURE_STRING,
        stringValue: '__SET_ME__',
        description: 'Garbanzo .env (SecureString). Overwrite with real value after deploy.',
      });

      new ssm.StringParameter(this, 'GarbanzoGroupsParam', {
        parameterName: groupsParamName,
        type: ssm.ParameterType.STRING,
        stringValue: '__SET_ME__',
        description: 'Garbanzo config/groups.json (String). Overwrite with real value after deploy.',
      });
    }

    // Ubuntu 24.04 LTS
    const machineImage = ec2.MachineImage.fromSsmParameter(
      '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
    );

    const instance = new ec2.Instance(this, 'GarbanzoEc2', {
      vpc,
      vpcSubnets: {
        subnetType: networkMode === 'private'
          ? ec2.SubnetType.PRIVATE_WITH_EGRESS
          : ec2.SubnetType.PUBLIC,
      },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.SMALL),
      machineImage,
      securityGroup: sg,
      role,
    });

    const bootstrapScript = `#!/usr/bin/env bash
set -euo pipefail

ENV_PARAM_NAME=${JSON.stringify(envParamName)}
GROUPS_PARAM_NAME=${JSON.stringify(groupsParamName)}
APP_VERSION=${JSON.stringify(appVersion)}
AWS_LOG_GROUP=${JSON.stringify(logGroupName)}

AWS_REGION="$(curl -fsS http://169.254.169.254/latest/dynamic/instance-identity/document | jq -r .region)"
AWS_INSTANCE_ID="$(curl -fsS http://169.254.169.254/latest/meta-data/instance-id)"
export AWS_REGION AWS_INSTANCE_ID AWS_LOG_GROUP

cd /opt/garbanzo/garbanzo-bot

ENV_VAL="$(aws ssm get-parameter --with-decryption --name \"\${ENV_PARAM_NAME}\" --query 'Parameter.Value' --output text)"
GROUPS_VAL="$(aws ssm get-parameter --name \"\${GROUPS_PARAM_NAME}\" --query 'Parameter.Value' --output text)"

if [ "$ENV_VAL" = "__SET_ME__" ] || [ "$GROUPS_VAL" = "__SET_ME__" ]; then
  cat > /opt/garbanzo/SETUP_REQUIRED.txt <<TXT
Garbanzo bootstrap is waiting for SSM parameters to be populated.

Set these and then run:
  sudo systemctl restart garbanzo-bootstrap

Parameters:
- $ENV_PARAM_NAME (SecureString)
- $GROUPS_PARAM_NAME (String)

CloudWatch Log Group (container logs): $AWS_LOG_GROUP
TXT
  exit 0
fi

printf '%s\n' "$ENV_VAL" > .env
printf '%s\n' "$GROUPS_VAL" > config/groups.json

APP_VERSION="$APP_VERSION" docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.aws.yml pull garbanzo
APP_VERSION="$APP_VERSION" docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.aws.yml up -d
`;

    instance.addUserData(
      'set -euo pipefail',
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get update -y',
      'apt-get install -y git awscli ca-certificates curl jq',
      'apt-get install -y docker.io docker-compose-plugin',
      'systemctl enable --now docker',
      'mkdir -p /opt/garbanzo',
      'cd /opt/garbanzo',
      'if [ ! -d garbanzo-bot ]; then git clone https://github.com/jjhickman/garbanzo-bot.git; fi',
      'cd garbanzo-bot',
      `cat > /opt/garbanzo/bootstrap.sh <<'EOF'\n${bootstrapScript}\nEOF`,
      'chmod +x /opt/garbanzo/bootstrap.sh',
      'cat > /etc/systemd/system/garbanzo-bootstrap.service <<\'EOF\'\n[Unit]\nDescription=Garbanzo bootstrap (pull SSM params + start Docker Compose)\nAfter=network-online.target docker.service\nWants=network-online.target\n\n[Service]\nType=oneshot\nExecStart=/opt/garbanzo/bootstrap.sh\nRemainAfterExit=yes\n\n[Install]\nWantedBy=multi-user.target\nEOF\n',
      'systemctl daemon-reload',
      'systemctl enable --now garbanzo-bootstrap.service',
    );

    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new cdk.CfnOutput(this, 'CloudWatchLogGroup', { value: logGroup.logGroupName });

    if (networkMode === 'private') {
      new cdk.CfnOutput(this, 'PrivateIp', { value: instance.instancePrivateIp });
      new cdk.CfnOutput(this, 'HealthUrl', {
        value: `http://${instance.instancePrivateIp}:3001/health`,
        description: 'Only reachable from within the VPC (or via SSM port forwarding)',
      });
    } else {
      new cdk.CfnOutput(this, 'PublicIp', { value: instance.instancePublicIp });
      new cdk.CfnOutput(this, 'HealthUrl', {
        value: `http://${instance.instancePublicIp}:3001/health`,
        description: 'Only reachable if allowedHealthCidr is set and matches your source IP',
      });
    }
  }
}
