#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ALLOWED_PROVIDERS = new Set(['openrouter', 'anthropic', 'openai', 'gemini', 'bedrock']);

function parseContextArgs(argv) {
  const context = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--context' && argv[i + 1]) {
      const [key, ...rest] = argv[i + 1].split('=');
      const value = rest.join('=');
      if (key && value) context[key] = value;
      i += 1;
    }
  }
  return context;
}

function parseProviderOrder(orderValue) {
  return orderValue
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
}

function providerOrderErrors(name, value) {
  const providers = parseProviderOrder(value);
  if (providers.length === 0) return [`${name} is empty`];
  const invalid = providers.filter((p) => !ALLOWED_PROVIDERS.has(p));
  if (invalid.length > 0) return [`${name} has invalid providers: ${invalid.join(', ')}`];
  return [];
}

function hasAction(policyDoc, action) {
  const statements = Array.isArray(policyDoc?.Statement)
    ? policyDoc.Statement
    : policyDoc?.Statement ? [policyDoc.Statement] : [];

  return statements.some((statement) => {
    const actions = Array.isArray(statement?.Action)
      ? statement.Action
      : statement?.Action ? [statement.Action] : [];
    return actions.includes(action);
  });
}

function failWith(message, details = []) {
  console.error(`\n❌ ECS stack audit failed: ${message}`);
  for (const detail of details) console.error(`  - ${detail}`);
  process.exit(1);
}

const cliContext = parseContextArgs(process.argv.slice(2));

const defaultContext = {
  deployEc2: 'false',
  deployEcs: 'true',
  deploySlack: 'true',
  deployDiscord: 'true',
  deployDemo: 'true',
  ownerJid: 'audit-owner',
  slackSecretArn: 'garbanzo/slack',
  discordSecretArn: 'garbanzo/discord',
  demoSecretArn: 'garbanzo/demo',
  aiSecretArn: 'garbanzo/ai',
  aiProviderOrder: 'openrouter,anthropic,openai',
  demoAiProviderOrder: 'openrouter',
  domainName: 'bot.garbanzobot.com',
  demoDomainName: 'demo.garbanzobot.com',
  hostedZoneName: 'garbanzobot.com',
  hostedZoneId: 'ZAUDIT123456',
  certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/audit-main',
  demoCertificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/audit-demo',
  imageRepo: '580028686392.dkr.ecr.us-east-1.amazonaws.com/garbanzo',
  imageTag: 'audit',
};

const context = { ...defaultContext, ...cliContext };

const providerErrors = [
  ...providerOrderErrors('aiProviderOrder', context.aiProviderOrder),
  ...providerOrderErrors('demoAiProviderOrder', context.demoAiProviderOrder),
];
if (providerErrors.length > 0) failWith('provider configuration is invalid', providerErrors);

const outputDir = mkdtempSync(join(tmpdir(), 'garbanzo-cdk-audit-'));

const synthArgs = ['cdk', 'synth', 'GarbanzoEcsStack', '--json', '--output', outputDir];
for (const [key, value] of Object.entries(context)) {
  synthArgs.push('-c', `${key}=${value}`);
}

const synth = spawnSync('npx', synthArgs, { encoding: 'utf8', cwd: process.cwd() });
if (synth.status !== 0) {
  rmSync(outputDir, { recursive: true, force: true });
  failWith('cdk synth failed', [synth.stderr || synth.stdout || 'Unknown synth error']);
}

const synthWarnings = (synth.stderr || '').trim();
if (synthWarnings.includes('@aws-cdk/aws-ecs:ecrImageRequiresPolicy')) {
  rmSync(outputDir, { recursive: true, force: true });
  failWith('synth emitted ECR pull-policy warning', [synthWarnings]);
}

let template;
try {
  const templatePath = join(outputDir, 'GarbanzoEcsStack.template.json');
  template = JSON.parse(readFileSync(templatePath, 'utf8'));
} catch (err) {
  rmSync(outputDir, { recursive: true, force: true });
  failWith('failed to parse synthesized template JSON', [String(err)]);
}

const resources = template?.Resources ?? {};
const resourceEntries = Object.entries(resources);

const taskDefs = resourceEntries.filter(([, r]) => r?.Type === 'AWS::ECS::TaskDefinition');
if (taskDefs.length < 3) {
  failWith('expected 3 ECS task definitions (slack/discord/demo)', [`found ${taskDefs.length}`]);
}

const executionPolicies = resourceEntries.filter(([, r]) =>
  r?.Type === 'AWS::IAM::Policy' && String(r?.Properties?.PolicyName ?? '').includes('ExecutionRoleDefaultPolicy'),
);
if (executionPolicies.length === 0) {
  failWith('no execution role policies found in synthesized template');
}

const ecrTokenPolicyCount = executionPolicies
  .map(([, r]) => r?.Properties?.PolicyDocument)
  .filter((doc) => hasAction(doc, 'ecr:GetAuthorizationToken')).length;

if (ecrTokenPolicyCount === 0) {
  failWith('no execution role policy grants ecr:GetAuthorizationToken');
}

const hasDemoWaf = resourceEntries.some(([, r]) => r?.Type === 'AWS::WAFv2::WebACL');
const hasDemoAlarm = resourceEntries.some(([, r]) => r?.Type === 'AWS::CloudWatch::Alarm');
if (!hasDemoWaf || !hasDemoAlarm) {
  failWith('missing expected demo abuse controls', [
    `WAF present: ${hasDemoWaf}`,
    `CloudWatch alarms present: ${hasDemoAlarm}`,
  ]);
}

rmSync(outputDir, { recursive: true, force: true });

console.log('✅ ECS stack audit passed');
console.log(`   Task definitions: ${taskDefs.length}`);
console.log(`   Execution policies with ECR auth: ${ecrTokenPolicyCount}`);
console.log(`   Demo WAF: ${hasDemoWaf}`);
console.log(`   Demo alarms: ${hasDemoAlarm}`);
