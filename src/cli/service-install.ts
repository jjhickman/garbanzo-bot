import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { CliPrinter } from './cli-print.js';

export type ServiceAction = 'install' | 'uninstall';

export interface ServiceOptions {
  action: ServiceAction;
  force: boolean;
  system: boolean;
  packageRoot: string;
  homeDir: string;
  templatePath: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
}

export interface ServiceEntry {
  entryPath: string;
  entryArgs: string[];
}

export interface UnitRenderOptions extends ServiceEntry {
  template: string;
  nodePath: string;
  packageRoot: string;
  homeDir: string;
}

export interface PlistRenderOptions extends ServiceEntry {
  nodePath: string;
  packageRoot: string;
  homeDir: string;
}

const SERVICE_NAME = 'garbanzo.service';
const PLIST_NAME = 'com.garbanzo.bot.plist';

export function isEphemeralNpxRoot(packageRoot: string): boolean {
  return packageRoot.includes('/.npm/_npx/') || packageRoot.includes('\\.npm\\_npx\\') || packageRoot.includes('_cacache');
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function systemdEscape(value: string): string {
  if (/^[A-Za-z0-9_/@%+=:,.-]+$/.test(value)) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function replaceOrAppend(lines: string[], prefix: string, value: string, insertAfterPrefix: string): string[] {
  const existingIndex = lines.findIndex((line) => line.startsWith(prefix));
  if (existingIndex >= 0) {
    lines[existingIndex] = value;
    return lines;
  }

  const insertAfterIndex = lines.findIndex((line) => line.startsWith(insertAfterPrefix));
  if (insertAfterIndex >= 0) {
    lines.splice(insertAfterIndex + 1, 0, value);
  } else {
    lines.push(value);
  }
  return lines;
}

export function renderSystemdUnit(options: UnitRenderOptions): string {
  const lines = options.template.split(/\r?\n/);
  const execStart = [
    systemdEscape(options.nodePath),
    systemdEscape(options.entryPath),
    ...options.entryArgs.map(systemdEscape),
  ].join(' ');

  replaceOrAppend(lines, 'Description=', 'Description=Garbanzo Bot', '[Unit]');
  replaceOrAppend(lines, 'WorkingDirectory=', `WorkingDirectory=${systemdEscape(options.packageRoot)}`, '[Service]');
  replaceOrAppend(lines, 'ExecStart=', `ExecStart=${execStart}`, 'WorkingDirectory=');

  const envHomeLine = `Environment=${systemdEscape(`GARBANZO_HOME=${options.homeDir}`)}`;
  if (!lines.some((line) => line === envHomeLine || line.startsWith('Environment=GARBANZO_HOME='))) {
    const nodeEnvIndex = lines.findIndex((line) => line === 'Environment=NODE_ENV=production');
    lines.splice(nodeEnvIndex >= 0 ? nodeEnvIndex + 1 : lines.findIndex((line) => line.startsWith('RestartSec=')) + 1, 0, envHomeLine);
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderLaunchdPlist(options: PlistRenderOptions): string {
  const args = [options.nodePath, options.entryPath, ...options.entryArgs]
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.garbanzo.bot</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(options.packageRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>GARBANZO_HOME</key>
    <string>${xmlEscape(options.homeDir)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(options.homeDir, 'garbanzo.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(options.homeDir, 'garbanzo.err.log'))}</string>
</dict>
</plist>
`;
}

function resolveServiceEntry(packageRoot: string): ServiceEntry {
  return {
    entryPath: join(packageRoot, 'dist', 'cli.js'),
    entryArgs: ['start'],
  };
}

function linuxServicePath(system: boolean): string {
  return system
    ? join('/etc', 'systemd', 'system', SERVICE_NAME)
    : join(homedir(), '.config', 'systemd', 'user', SERVICE_NAME);
}

function launchdPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', PLIST_NAME);
}

async function writeFileCreatingParents(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

function printNpxRefusal(printer: CliPrinter, packageRoot: string): void {
  printer.stderr([
    'Refusing to install a service from an ephemeral npx/npm cache.',
    `Package root: ${packageRoot}`,
    'Install a durable copy first:',
    '  npm i -g garbanzo-bot',
    'Then run:',
    '  garbanzo service install',
    'Use --force only if you understand the service may point at a cache path npm can delete.',
    '',
  ].join('\n'));
}

function printLinuxCommands(printer: CliPrinter, system: boolean, servicePath: string): void {
  if (system) {
    printer.stdout([
      `Wrote ${servicePath}`,
      'Run these commands to enable it:',
      '  sudo systemctl daemon-reload',
      `  sudo systemctl enable --now ${SERVICE_NAME}`,
      `  journalctl -u ${SERVICE_NAME} -f`,
      '',
    ].join('\n'));
    return;
  }

  printer.stdout([
    `Wrote ${servicePath}`,
    'Run these commands to enable it:',
    '  systemctl --user daemon-reload',
    `  systemctl --user enable --now ${SERVICE_NAME}`,
    `  journalctl --user -u ${SERVICE_NAME} -f`,
    '',
  ].join('\n'));
}

function printLinuxUninstallCommands(printer: CliPrinter, system: boolean, servicePath: string): void {
  if (system) {
    printer.stdout([
      `Removed ${servicePath}`,
      'Run these commands to finish uninstalling:',
      `  sudo systemctl disable --now ${SERVICE_NAME}`,
      '  sudo systemctl daemon-reload',
      '',
    ].join('\n'));
    return;
  }

  printer.stdout([
    `Removed ${servicePath}`,
    'Run these commands to finish uninstalling:',
    `  systemctl --user disable --now ${SERVICE_NAME}`,
    '  systemctl --user daemon-reload',
    '',
  ].join('\n'));
}

function printWindowsGuidance(printer: CliPrinter, packageRoot: string): void {
  printer.stdout([
    'Windows service automation is not included in this release.',
    'Use Task Scheduler to run this command at logon:',
    `  "${process.execPath}" "${join(packageRoot, 'dist', 'cli.js')}" start`,
    'Set the working directory to the Garbanzo package directory and set GARBANZO_HOME to your data directory.',
    '',
  ].join('\n'));
}

export async function runServiceCommand(options: ServiceOptions, printer: CliPrinter): Promise<number> {
  const platform = options.platform ?? process.platform;
  const nodePath = options.nodePath ?? process.execPath;

  if (platform === 'win32') {
    printWindowsGuidance(printer, options.packageRoot);
    return 0;
  }

  if (options.action === 'install' && isEphemeralNpxRoot(options.packageRoot)) {
    if (!options.force) {
      printNpxRefusal(printer, options.packageRoot);
      return 1;
    }
    printer.stderr('Warning: --force allowed service install from an ephemeral npm cache path. The service may break when npm deletes the cache.\n');
  }

  if (platform === 'darwin') {
    const plistPath = launchdPath();
    if (options.action === 'uninstall') {
      await rm(plistPath, { force: true });
      printer.stdout([
        `Removed ${plistPath}`,
        'Run this command if the agent is loaded:',
        `  launchctl unload ${plistPath}`,
        '',
      ].join('\n'));
      return 0;
    }

    const entry = resolveServiceEntry(options.packageRoot);
    await writeFileCreatingParents(plistPath, renderLaunchdPlist({
      nodePath,
      packageRoot: options.packageRoot,
      homeDir: options.homeDir,
      ...entry,
    }));
    printer.stdout([
      `Wrote ${plistPath}`,
      'Run this command to load it:',
      `  launchctl load ${plistPath}`,
      '',
    ].join('\n'));
    return 0;
  }

  const servicePath = linuxServicePath(options.system);
  if (options.action === 'uninstall') {
    await rm(servicePath, { force: true });
    printLinuxUninstallCommands(printer, options.system, servicePath);
    return 0;
  }

  const template = existsSync(options.templatePath)
    ? await readFile(options.templatePath, 'utf8')
    : '';
  const entry = resolveServiceEntry(options.packageRoot);
  await writeFileCreatingParents(servicePath, renderSystemdUnit({
    template,
    nodePath,
    packageRoot: options.packageRoot,
    homeDir: options.homeDir,
    ...entry,
  }));
  printLinuxCommands(printer, options.system, servicePath);
  return 0;
}
