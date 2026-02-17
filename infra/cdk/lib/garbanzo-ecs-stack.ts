import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

function optionalContext(app: cdk.App, key: string): string | undefined {
  const value = app.node.tryGetContext(key);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireContext(app: cdk.App, key: string): string {
  const value = optionalContext(app, key);
  if (!value) {
    throw new Error(`Missing required CDK context value: ${key}`);
  }
  return value;
}

function contextBoolean(app: cdk.App, key: string, fallback: boolean): boolean {
  const raw = optionalContext(app, key);
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function contextNumber(app: cdk.App, key: string, fallback: number): number {
  const raw = optionalContext(app, key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseEcrRepositoryName(imageRepo: string): string | undefined {
  const match = imageRepo.match(/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/(.+)$/);
  if (!match) return undefined;
  const repositoryName = match[1]?.trim();
  return repositoryName && repositoryName.length > 0 ? repositoryName : undefined;
}

interface ServiceConfig {
  id: 'slack' | 'discord' | 'demo';
  runtimePlatform: 'slack' | 'discord';
  mode: 'official' | 'demo';
  containerPort: number;
  healthPath: string;
  ownerId: string;
  desiredCount: number;
  secretArn?: string;
  routePathPatterns?: string[];
  routeHostHeaders?: string[];
}

export class GarbanzoEcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const app = this.node.root as cdk.App;

    const appVersion = optionalContext(app, 'appVersion') ?? '0.1.8';
    const imageRepo = optionalContext(app, 'imageRepo') ?? 'jjhickman/garbanzo';
    const imageTag = optionalContext(app, 'imageTag') ?? appVersion;

    const deploySlack = contextBoolean(app, 'deploySlack', true);
    const deployDiscord = contextBoolean(app, 'deployDiscord', true);
    const deployDemo = contextBoolean(app, 'deployDemo', false);
    if (!deploySlack && !deployDiscord && !deployDemo) {
      throw new Error('Nothing to deploy: set deploySlack=true, deployDiscord=true, and/or deployDemo=true');
    }

    const defaultOwnerId = optionalContext(app, 'ownerJid');

    const bedrockRegion = optionalContext(app, 'bedrockRegion') ?? cdk.Stack.of(this).region;
    const bedrockModelId = optionalContext(app, 'bedrockModelId') ?? 'anthropic.claude-3-5-haiku-20241022-v1:0';
    const bedrockMaxTokens = contextNumber(app, 'bedrockMaxTokens', 1024);
    const bedrockPricingInputPerM = optionalContext(app, 'bedrockPricingInputPerM') ?? '0';
    const bedrockPricingOutputPerM = optionalContext(app, 'bedrockPricingOutputPerM') ?? '0';

    const aiProviderOrder = optionalContext(app, 'aiProviderOrder') ?? 'bedrock,openrouter,anthropic,openai,gemini';
    const demoAiProviderOrder = optionalContext(app, 'demoAiProviderOrder') ?? 'bedrock';
    const cloudMaxTokens = contextNumber(app, 'cloudMaxTokens', 1024);
    const cloudRequestTimeoutMs = contextNumber(app, 'cloudRequestTimeoutMs', 30000);
    const vectorEmbeddingProvider = optionalContext(app, 'vectorEmbeddingProvider') ?? 'deterministic';
    const vectorEmbeddingModel = optionalContext(app, 'vectorEmbeddingModel') ?? 'text-embedding-3-small';
    const vectorEmbeddingTimeoutMs = contextNumber(app, 'vectorEmbeddingTimeoutMs', 12000);
    const vectorEmbeddingMaxChars = contextNumber(app, 'vectorEmbeddingMaxChars', 4000);
    const logLevel = optionalContext(app, 'logLevel') ?? 'info';

    const demoOpenRouterModel = optionalContext(app, 'demoOpenRouterModel') ?? 'openai/gpt-4.1-mini';
    const demoVectorEmbeddingProvider = optionalContext(app, 'demoVectorEmbeddingProvider') ?? 'openai';
    const demoVectorEmbeddingModel = optionalContext(app, 'demoVectorEmbeddingModel') ?? vectorEmbeddingModel;
    const demoOpenAiModel = optionalContext(app, 'demoOpenAiModel') ?? 'gpt-4.1-mini';
    const demoAnthropicModel = optionalContext(app, 'demoAnthropicModel') ?? 'claude-3-5-haiku-20241022';
    const demoGeminiModel = optionalContext(app, 'demoGeminiModel') ?? 'gemini-1.5-flash';
    const demoBedrockModelId = optionalContext(app, 'demoBedrockModelId') ?? bedrockModelId;
    const demoBedrockMaxTokens = contextNumber(app, 'demoBedrockMaxTokens', 256);
    const demoCloudMaxTokens = contextNumber(app, 'demoCloudMaxTokens', 384);
    const demoRequestTimeoutMs = contextNumber(app, 'demoRequestTimeoutMs', 12000);
    const demoVectorEmbeddingTimeoutMs = contextNumber(app, 'demoVectorEmbeddingTimeoutMs', vectorEmbeddingTimeoutMs);
    const demoVectorEmbeddingMaxChars = contextNumber(app, 'demoVectorEmbeddingMaxChars', vectorEmbeddingMaxChars);

    const serviceCpu = contextNumber(app, 'serviceCpu', 512);
    const serviceMemoryMiB = contextNumber(app, 'serviceMemoryMiB', 1024);

    const dbName = optionalContext(app, 'dbName') ?? 'garbanzo';
    const dbStorageGiB = contextNumber(app, 'dbStorageGiB', 20);
    const dbMaxAllocatedStorageGiB = contextNumber(app, 'dbMaxAllocatedStorageGiB', 100);
    const dbDeletionProtection = contextBoolean(app, 'dbDeletionProtection', false);
    const postgresSsl = contextBoolean(app, 'postgresSsl', true);
    const postgresSslRejectUnauthorized = contextBoolean(app, 'postgresSslRejectUnauthorized', false);

    const domainName = optionalContext(app, 'domainName');
    const hostedZoneName = optionalContext(app, 'hostedZoneName');
    const hostedZoneId = optionalContext(app, 'hostedZoneId');
    const certificateArn = optionalContext(app, 'certificateArn');

    const demoDomainName = optionalContext(app, 'demoDomainName');
    const demoCertificateArn = optionalContext(app, 'demoCertificateArn');
    const demoSecretArn = optionalContext(app, 'demoSecretArn');
    const aiSecretArn = optionalContext(app, 'aiSecretArn');
    const featureSecretArn = optionalContext(app, 'featureSecretArn') ?? aiSecretArn;
    const demoTurnstileEnabled = contextBoolean(app, 'demoTurnstileEnabled', true);
    const demoWafRateLimit = contextNumber(app, 'demoWafRateLimit', 300);

    const vpc = new ec2.Vpc(this, 'GarbanzoEcsVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    const cluster = new ecs.Cluster(this, 'GarbanzoCluster', { vpc });

    const dbSg = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      description: 'Security group for Garbanzo Postgres',
      allowAllOutbound: true,
    });

    const db = new rds.DatabaseInstance(this, 'GarbanzoPostgres', {
      vpc,
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_4 }),
      credentials: rds.Credentials.fromGeneratedSecret('garbanzo'),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      allocatedStorage: dbStorageGiB,
      maxAllocatedStorage: dbMaxAllocatedStorageGiB,
      databaseName: dbName,
      multiAz: false,
      publiclyAccessible: false,
      storageEncrypted: true,
      deletionProtection: dbDeletionProtection,
      backupRetention: cdk.Duration.days(7),
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    if (!db.secret) {
      throw new Error('Database secret was not created for RDS instance');
    }

    const alb = new elbv2.ApplicationLoadBalancer(this, 'GarbanzoAlb', {
      vpc,
      internetFacing: true,
    });

    let listener: elbv2.ApplicationListener;
    const hasHttpsListener = Boolean(certificateArn);
    if (certificateArn) {
      const certificate = acm.Certificate.fromCertificateArn(this, 'GarbanzoAlbCertificate', certificateArn);
      listener = alb.addListener('HttpsListener', {
        port: 443,
        certificates: [certificate],
        defaultAction: elbv2.ListenerAction.fixedResponse(404, {
          contentType: 'application/json',
          messageBody: JSON.stringify({ ok: false, error: 'Not found' }),
        }),
      });

      alb.addListener('HttpRedirect', {
        port: 80,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });
    } else {
      listener = alb.addListener('HttpListener', {
        port: 80,
        defaultAction: elbv2.ListenerAction.fixedResponse(404, {
          contentType: 'application/json',
          messageBody: JSON.stringify({ ok: false, error: 'Not found' }),
        }),
      });
    }

    let priorityCounter = 10;

    const commonEnvironment: Record<string, string> = {
      DB_DIALECT: 'postgres',
      POSTGRES_HOST: db.instanceEndpoint.hostname,
      POSTGRES_PORT: db.instanceEndpoint.port.toString(),
      POSTGRES_DB: dbName,
      POSTGRES_SSL: String(postgresSsl),
      POSTGRES_SSL_REJECT_UNAUTHORIZED: String(postgresSslRejectUnauthorized),
      HEALTH_BIND_HOST: '0.0.0.0',
      HEALTH_PORT: '3001',
      METRICS_ENABLED: 'true',
      AI_PROVIDER_ORDER: aiProviderOrder,
      CLOUD_MAX_TOKENS: String(cloudMaxTokens),
      CLOUD_REQUEST_TIMEOUT_MS: String(cloudRequestTimeoutMs),
      BEDROCK_REGION: bedrockRegion,
      BEDROCK_MODEL_ID: bedrockModelId,
      BEDROCK_MAX_TOKENS: String(bedrockMaxTokens),
      BEDROCK_PRICING_INPUT_PER_M: bedrockPricingInputPerM,
      BEDROCK_PRICING_OUTPUT_PER_M: bedrockPricingOutputPerM,
      VECTOR_EMBEDDING_PROVIDER: vectorEmbeddingProvider,
      VECTOR_EMBEDDING_MODEL: vectorEmbeddingModel,
      VECTOR_EMBEDDING_TIMEOUT_MS: String(vectorEmbeddingTimeoutMs),
      VECTOR_EMBEDDING_MAX_CHARS: String(vectorEmbeddingMaxChars),
      LOG_LEVEL: logLevel,
    };

    let hostedZone: route53.IHostedZone | undefined;
    if (hostedZoneId && hostedZoneName) {
      hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZoneByAttributes', {
        hostedZoneId,
        zoneName: hostedZoneName,
      });
    } else if (hostedZoneName) {
      hostedZone = route53.HostedZone.fromLookup(this, 'HostedZoneByName', { domainName: hostedZoneName });
    }

    const aiRuntimeSecret = aiSecretArn
      ? (aiSecretArn.startsWith('arn:')
        ? secretsmanager.Secret.fromSecretPartialArn(this, 'AiRuntimeSecret', aiSecretArn)
        : secretsmanager.Secret.fromSecretNameV2(this, 'AiRuntimeSecret', aiSecretArn))
      : undefined;

    const featureRuntimeSecret = featureSecretArn
      ? (featureSecretArn.startsWith('arn:')
        ? secretsmanager.Secret.fromSecretPartialArn(this, 'FeatureRuntimeSecret', featureSecretArn)
        : secretsmanager.Secret.fromSecretNameV2(this, 'FeatureRuntimeSecret', featureSecretArn))
      : undefined;

    const services: Array<{ platform: string; service: ecs.FargateService }> = [];
    let demoServiceMeta: {
      service: ecs.FargateService;
      targetGroup: elbv2.ApplicationTargetGroup;
    } | null = null;

    const createService = (cfg: ServiceConfig): {
      service: ecs.FargateService;
      targetGroup: elbv2.ApplicationTargetGroup;
    } => {
      const logGroup = new logs.LogGroup(this, `${cfg.id}ServiceLogGroup`, {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      const taskDefinition = new ecs.FargateTaskDefinition(this, `${cfg.id}TaskDef`, {
        cpu: serviceCpu,
        memoryLimitMiB: serviceMemoryMiB,
      });

      taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: ['*'],
      }));

      const baseSecrets: Record<string, ecs.Secret> = {
        POSTGRES_USER: ecs.Secret.fromSecretsManager(db.secret!, 'username'),
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(db.secret!, 'password'),
      };

      const aiProviderSecrets: Record<string, ecs.Secret> = {};
      if (aiRuntimeSecret) {
        aiProviderSecrets.OPENROUTER_API_KEY = ecs.Secret.fromSecretsManager(aiRuntimeSecret, 'OPENROUTER_API_KEY');
        aiProviderSecrets.ANTHROPIC_API_KEY = ecs.Secret.fromSecretsManager(aiRuntimeSecret, 'ANTHROPIC_API_KEY');
        aiProviderSecrets.OPENAI_API_KEY = ecs.Secret.fromSecretsManager(aiRuntimeSecret, 'OPENAI_API_KEY');
      }

      const featureSecrets: Record<string, ecs.Secret> = {};
      if (featureRuntimeSecret) {
        featureSecrets.GOOGLE_API_KEY = ecs.Secret.fromSecretsManager(featureRuntimeSecret, 'GOOGLE_API_KEY');
        featureSecrets.MBTA_API_KEY = ecs.Secret.fromSecretsManager(featureRuntimeSecret, 'MBTA_API_KEY');
        featureSecrets.NEWSAPI_KEY = ecs.Secret.fromSecretsManager(featureRuntimeSecret, 'NEWSAPI_KEY');
        featureSecrets.BRAVE_SEARCH_API_KEY = ecs.Secret.fromSecretsManager(featureRuntimeSecret, 'BRAVE_SEARCH_API_KEY');
      }

      const platformSecrets: Record<string, ecs.Secret> = {};
      let runtimeSecret: secretsmanager.ISecret | undefined;

      if (cfg.secretArn) {
        runtimeSecret = cfg.secretArn.startsWith('arn:')
          ? secretsmanager.Secret.fromSecretPartialArn(
            this,
            `${cfg.id}RuntimeSecret`,
            cfg.secretArn,
          )
          : secretsmanager.Secret.fromSecretNameV2(
            this,
            `${cfg.id}RuntimeSecret`,
            cfg.secretArn,
          );
      }

      if (cfg.mode === 'official') {
        if (!runtimeSecret) {
          throw new Error(`Missing secretArn for official ${cfg.runtimePlatform} runtime`);
        }

        if (cfg.runtimePlatform === 'slack') {
          platformSecrets.SLACK_BOT_TOKEN = ecs.Secret.fromSecretsManager(runtimeSecret, 'SLACK_BOT_TOKEN');
          platformSecrets.SLACK_SIGNING_SECRET = ecs.Secret.fromSecretsManager(runtimeSecret, 'SLACK_SIGNING_SECRET');
        } else {
          platformSecrets.DISCORD_BOT_TOKEN = ecs.Secret.fromSecretsManager(runtimeSecret, 'DISCORD_BOT_TOKEN');
          platformSecrets.DISCORD_PUBLIC_KEY = ecs.Secret.fromSecretsManager(runtimeSecret, 'DISCORD_PUBLIC_KEY');
        }
      }

      if (cfg.mode === 'demo' && runtimeSecret) {
        platformSecrets.DEMO_TURNSTILE_SITE_KEY = ecs.Secret.fromSecretsManager(runtimeSecret, 'DEMO_TURNSTILE_SITE_KEY');
        platformSecrets.DEMO_TURNSTILE_SECRET_KEY = ecs.Secret.fromSecretsManager(runtimeSecret, 'DEMO_TURNSTILE_SECRET_KEY');
      }

      const environment: Record<string, string> = {
        ...commonEnvironment,
        MESSAGING_PLATFORM: cfg.runtimePlatform,
        OWNER_JID: cfg.ownerId,
      };

      if (cfg.runtimePlatform === 'slack') {
        if (cfg.mode === 'demo') {
          environment.SLACK_DEMO = 'true';
          environment.SLACK_DEMO_BIND_HOST = '0.0.0.0';
          environment.SLACK_DEMO_PORT = String(cfg.containerPort);
        } else {
          environment.SLACK_DEMO = 'false';
          environment.SLACK_EVENTS_BIND_HOST = '0.0.0.0';
          environment.SLACK_EVENTS_PORT = String(cfg.containerPort);
        }
      } else if (cfg.mode === 'demo') {
        environment.DISCORD_DEMO = 'true';
        environment.DISCORD_DEMO_BIND_HOST = '0.0.0.0';
        environment.DISCORD_DEMO_PORT = String(cfg.containerPort);
      } else {
        environment.DISCORD_DEMO = 'false';
        environment.DISCORD_INTERACTIONS_BIND_HOST = '0.0.0.0';
        environment.DISCORD_INTERACTIONS_PORT = String(cfg.containerPort);
      }

      if (cfg.mode === 'demo') {
        environment.AI_PROVIDER_ORDER = demoAiProviderOrder;
        environment.OPENROUTER_MODEL = demoOpenRouterModel;
        environment.OPENAI_MODEL = demoOpenAiModel;
        environment.ANTHROPIC_MODEL = demoAnthropicModel;
        environment.GEMINI_MODEL = demoGeminiModel;
        environment.BEDROCK_MODEL_ID = demoBedrockModelId;
        environment.BEDROCK_MAX_TOKENS = String(demoBedrockMaxTokens);
        environment.CLOUD_MAX_TOKENS = String(demoCloudMaxTokens);
        environment.CLOUD_REQUEST_TIMEOUT_MS = String(demoRequestTimeoutMs);
        environment.DEMO_TURNSTILE_ENABLED = String(demoTurnstileEnabled);
        environment.VECTOR_EMBEDDING_PROVIDER = demoVectorEmbeddingProvider;
        environment.VECTOR_EMBEDDING_MODEL = demoVectorEmbeddingModel;
        environment.VECTOR_EMBEDDING_TIMEOUT_MS = String(demoVectorEmbeddingTimeoutMs);
        environment.VECTOR_EMBEDDING_MAX_CHARS = String(demoVectorEmbeddingMaxChars);

        if (demoTurnstileEnabled && !runtimeSecret) {
          throw new Error('Demo runtime requires demoSecretArn with DEMO_TURNSTILE_SITE_KEY and DEMO_TURNSTILE_SECRET_KEY');
        }
      }

      const ecrRepositoryName = parseEcrRepositoryName(imageRepo);
      const ecrRepository = ecrRepositoryName
        ? ecr.Repository.fromRepositoryName(this, `${cfg.id}ImageRepository`, ecrRepositoryName)
        : undefined;
      const containerImage = ecrRepository
        ? ecs.ContainerImage.fromEcrRepository(ecrRepository, imageTag)
        : ecs.ContainerImage.fromRegistry(`${imageRepo}:${imageTag}`);

      taskDefinition.addContainer(`${cfg.id}Container`, {
        image: containerImage,
        logging: ecs.LogDriver.awsLogs({
          logGroup,
          streamPrefix: cfg.id,
        }),
        environment,
        secrets: { ...baseSecrets, ...aiProviderSecrets, ...featureSecrets, ...platformSecrets },
        essential: true,
      }).addPortMappings(
        { containerPort: cfg.containerPort, protocol: ecs.Protocol.TCP },
        { containerPort: 3001, protocol: ecs.Protocol.TCP },
      );

      if (runtimeSecret) {
        runtimeSecret.grantRead(taskDefinition.executionRole!);
      }
      if (aiRuntimeSecret) {
        aiRuntimeSecret.grantRead(taskDefinition.executionRole!);
      }
      if (featureRuntimeSecret) {
        featureRuntimeSecret.grantRead(taskDefinition.executionRole!);
      }
      if (ecrRepository) {
        taskDefinition.addToExecutionRolePolicy(new iam.PolicyStatement({
          actions: ['ecr:GetAuthorizationToken'],
          resources: ['*'],
        }));
        taskDefinition.addToExecutionRolePolicy(new iam.PolicyStatement({
          actions: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
          resources: [ecrRepository.repositoryArn],
        }));
        ecrRepository.grantPull(taskDefinition.executionRole!);
      }
      db.secret!.grantRead(taskDefinition.executionRole!);

      const serviceSg = new ec2.SecurityGroup(this, `${cfg.id}ServiceSecurityGroup`, {
        vpc,
        allowAllOutbound: true,
        description: `Security group for ${cfg.id} runtime`,
      });
      dbSg.addIngressRule(serviceSg, ec2.Port.tcp(5432), `Allow ${cfg.id} service to Postgres`);

      const service = new ecs.FargateService(this, `${cfg.id}Service`, {
        cluster,
        taskDefinition,
        desiredCount: cfg.desiredCount,
        minHealthyPercent: 100,
        assignPublicIp: false,
        securityGroups: [serviceSg],
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });

      const targetGroup = new elbv2.ApplicationTargetGroup(this, `${cfg.id}TargetGroup`, {
        vpc,
        targetType: elbv2.TargetType.IP,
        protocol: elbv2.ApplicationProtocol.HTTP,
        port: cfg.containerPort,
        healthCheck: {
          path: cfg.healthPath,
          healthyHttpCodes: '200',
          interval: cdk.Duration.seconds(30),
        },
      });

      service.attachToApplicationTargetGroup(targetGroup);

      const conditions: elbv2.ListenerCondition[] = [];
      if (cfg.routeHostHeaders && cfg.routeHostHeaders.length > 0) {
        conditions.push(elbv2.ListenerCondition.hostHeaders(cfg.routeHostHeaders));
      }
      if (cfg.routePathPatterns && cfg.routePathPatterns.length > 0) {
        conditions.push(elbv2.ListenerCondition.pathPatterns(cfg.routePathPatterns));
      }
      if (conditions.length === 0) {
        throw new Error(`No listener rule conditions provided for service: ${cfg.id}`);
      }

      listener.addTargetGroups(`${cfg.id}Route`, {
        priority: priorityCounter,
        targetGroups: [targetGroup],
        conditions,
      });
      priorityCounter += 10;

      services.push({ platform: cfg.id, service });
      return { service, targetGroup };
    };

    if (deploySlack) {
      const slackSecretArn = requireContext(app, 'slackSecretArn');
      const slackOwnerId = optionalContext(app, 'slackOwnerJid') ?? defaultOwnerId;
      if (!slackOwnerId) {
        throw new Error('Missing owner id for Slack. Set -c slackOwnerJid=<id> (or -c ownerJid=<id>).');
      }

      createService({
        id: 'slack',
        runtimePlatform: 'slack',
        mode: 'official',
        containerPort: 3002,
        routePathPatterns: ['/slack/events*'],
        routeHostHeaders: domainName ? [domainName] : undefined,
        healthPath: '/slack/events',
        ownerId: slackOwnerId,
        secretArn: slackSecretArn,
        desiredCount: contextNumber(app, 'slackDesiredCount', 1),
      });
    }

    if (deployDiscord) {
      const discordSecretArn = requireContext(app, 'discordSecretArn');
      const discordOwnerId = optionalContext(app, 'discordOwnerJid') ?? defaultOwnerId;
      if (!discordOwnerId) {
        throw new Error('Missing owner id for Discord. Set -c discordOwnerJid=<id> (or -c ownerJid=<id>).');
      }

      createService({
        id: 'discord',
        runtimePlatform: 'discord',
        mode: 'official',
        containerPort: 3003,
        routePathPatterns: ['/discord/interactions*'],
        routeHostHeaders: domainName ? [domainName] : undefined,
        healthPath: '/discord/interactions',
        ownerId: discordOwnerId,
        secretArn: discordSecretArn,
        desiredCount: contextNumber(app, 'discordDesiredCount', 1),
      });
    }

    if (deployDemo) {
      const demoOwnerId = optionalContext(app, 'demoOwnerJid') ?? defaultOwnerId;
      if (!demoOwnerId) {
        throw new Error('Missing owner id for demo runtime. Set -c demoOwnerJid=<id> (or -c ownerJid=<id>).');
      }

      if (demoDomainName && hasHttpsListener) {
        const demoCertificate = demoCertificateArn
          ? acm.Certificate.fromCertificateArn(this, 'DemoAlbCertificate', demoCertificateArn)
          : hostedZone
            ? new acm.Certificate(this, 'DemoAlbCertificateGenerated', {
              domainName: demoDomainName,
              validation: acm.CertificateValidation.fromDns(hostedZone),
            })
            : undefined;

        if (demoCertificate) {
          listener.addCertificates('DemoListenerCertificate', [demoCertificate]);
        } else {
          cdk.Annotations.of(this).addWarning(
            'Demo domain requested but no demoCertificateArn/hosted zone available to issue one.',
          );
        }
      } else if (demoDomainName) {
        cdk.Annotations.of(this).addWarning(
          'Demo domain is configured without certificateArn. Demo endpoint will be HTTP-only on port 80.',
        );
      }

      demoServiceMeta = createService({
        id: 'demo',
        runtimePlatform: 'slack',
        mode: 'demo',
        containerPort: contextNumber(app, 'demoPort', 3004),
        routePathPatterns: demoDomainName ? ['/*'] : ['/slack/demo*'],
        routeHostHeaders: demoDomainName ? [demoDomainName] : undefined,
        healthPath: '/slack/demo',
        ownerId: demoOwnerId,
        secretArn: demoSecretArn,
        desiredCount: contextNumber(app, 'demoDesiredCount', 1),
      });

      if (demoDomainName && hostedZone) {
        new route53.ARecord(this, 'DemoAlbAliasRecord', {
          zone: hostedZone,
          recordName: demoDomainName,
          target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
        });
      } else if (demoDomainName) {
        cdk.Annotations.of(this).addWarning(
          'Skipping demo Route53 record creation. Provide hostedZoneName (and optionally hostedZoneId).',
        );
      }
    }

    if (demoServiceMeta) {
      const demoMinCapacity = Math.max(1, contextNumber(app, 'demoMinCapacity', 1));
      const demoMaxCapacity = Math.max(demoMinCapacity, contextNumber(app, 'demoMaxCapacity', 2));
      const demoRequestsPerTarget = Math.max(5, contextNumber(app, 'demoRequestsPerTarget', 25));

      const demoScaling = demoServiceMeta.service.autoScaleTaskCount({
        minCapacity: demoMinCapacity,
        maxCapacity: demoMaxCapacity,
      });
      demoScaling.scaleOnRequestCount('DemoRequestScaling', {
        targetGroup: demoServiceMeta.targetGroup,
        requestsPerTarget: demoRequestsPerTarget,
        scaleOutCooldown: cdk.Duration.seconds(60),
        scaleInCooldown: cdk.Duration.seconds(180),
      });

      const demo5xxThreshold = Math.max(1, contextNumber(app, 'demo5xxAlarmThreshold', 10));
      const demoP95MsThreshold = Math.max(250, contextNumber(app, 'demoP95LatencyMsThreshold', 2500));
      const demoRequestBurstThreshold = Math.max(50, contextNumber(app, 'demoRequestBurstThreshold', 500));

      new cloudwatch.Alarm(this, 'DemoTarget5xxAlarm', {
        alarmDescription: 'Demo runtime target 5xx errors are elevated',
        metric: demoServiceMeta.targetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
          period: cdk.Duration.minutes(1),
          statistic: 'sum',
        }),
        threshold: demo5xxThreshold,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      new cloudwatch.Alarm(this, 'DemoTargetResponseP95Alarm', {
        alarmDescription: 'Demo runtime p95 response time is too high',
        metric: demoServiceMeta.targetGroup.metrics.targetResponseTime({
          period: cdk.Duration.minutes(1),
          statistic: 'p95',
        }),
        threshold: demoP95MsThreshold / 1000,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      new cloudwatch.Alarm(this, 'DemoRequestBurstAlarm', {
        alarmDescription: 'Demo runtime request burst detected',
        metric: demoServiceMeta.targetGroup.metrics.requestCount({
          period: cdk.Duration.minutes(1),
          statistic: 'sum',
        }),
        threshold: demoRequestBurstThreshold,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      if (demoDomainName) {
        const demoHostHeaderStatement: wafv2.CfnWebACL.StatementProperty = {
          byteMatchStatement: {
            fieldToMatch: { singleHeader: { Name: 'host' } },
            positionalConstraint: 'EXACTLY',
            searchString: demoDomainName.toLowerCase(),
            textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
          },
        };

        const demoPathStatement: wafv2.CfnWebACL.StatementProperty = {
          byteMatchStatement: {
            fieldToMatch: { uriPath: {} },
            positionalConstraint: 'STARTS_WITH',
            searchString: '/',
            textTransformations: [{ priority: 0, type: 'NONE' }],
          },
        };

        const demoScopeDownStatement: wafv2.CfnWebACL.StatementProperty = {
          andStatement: {
            statements: [demoHostHeaderStatement, demoPathStatement],
          },
        };

        const demoWebAcl = new wafv2.CfnWebACL(this, 'DemoWebAcl', {
          defaultAction: { allow: {} },
          scope: 'REGIONAL',
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: 'garbanzo-demo-web-acl',
          },
          rules: [
            {
              name: 'DemoRateLimit',
              priority: 1,
              action: { block: {} },
              statement: {
                rateBasedStatement: {
                  aggregateKeyType: 'IP',
                  limit: demoWafRateLimit,
                  scopeDownStatement: demoScopeDownStatement,
                },
              },
              visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                sampledRequestsEnabled: true,
                metricName: 'garbanzo-demo-rate-limit',
              },
            },
            {
              name: 'DemoManagedCommonRules',
              priority: 10,
              overrideAction: { none: {} },
              statement: {
                managedRuleGroupStatement: {
                  vendorName: 'AWS',
                  name: 'AWSManagedRulesCommonRuleSet',
                  scopeDownStatement: demoScopeDownStatement,
                },
              },
              visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                sampledRequestsEnabled: true,
                metricName: 'garbanzo-demo-common-rules',
              },
            },
            {
              name: 'DemoManagedBotRules',
              priority: 20,
              overrideAction: { count: {} },
              statement: {
                managedRuleGroupStatement: {
                  vendorName: 'AWS',
                  name: 'AWSManagedRulesBotControlRuleSet',
                  managedRuleGroupConfigs: [{
                    awsManagedRulesBotControlRuleSet: {
                      inspectionLevel: 'COMMON',
                    },
                  }],
                  scopeDownStatement: demoScopeDownStatement,
                },
              },
              visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                sampledRequestsEnabled: true,
                metricName: 'garbanzo-demo-bot-rules',
              },
            },
          ],
        });

        new wafv2.CfnWebACLAssociation(this, 'DemoWebAclAssociation', {
          resourceArn: alb.loadBalancerArn,
          webAclArn: demoWebAcl.attrArn,
        });
      } else {
        cdk.Annotations.of(this).addWarning(
          'Demo runtime deployed without demoDomainName. Skipping demo-host scoped WAF rules.',
        );
      }
    }

    if (domainName && hostedZone) {
      new route53.ARecord(this, 'AlbAliasRecord', {
        zone: hostedZone,
        recordName: domainName,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
      });
    } else if (domainName || hostedZoneName || hostedZoneId) {
      cdk.Annotations.of(this).addWarning(
        'Skipping Route53 record creation. Set domainName + hostedZoneName, optionally with hostedZoneId.',
      );
    }

    new cdk.CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'PostgresEndpoint', {
      value: `${db.instanceEndpoint.hostname}:${db.instanceEndpoint.port}`,
    });
    new cdk.CfnOutput(this, 'PostgresSecretArn', { value: db.secret.secretArn });
    new cdk.CfnOutput(this, 'ServiceImage', { value: `${imageRepo}:${imageTag}` });

    for (const item of services) {
      new cdk.CfnOutput(this, `${item.platform}ServiceName`, { value: item.service.serviceName });
    }
  }
}
