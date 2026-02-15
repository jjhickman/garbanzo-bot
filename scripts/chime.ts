import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type ChimeKind = 'ready' | 'error';

type Player = { cmd: string; args: (wavPath: string) => string[]; name: string };

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function writeWavHeader(
  dataBytes: number,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
  const blockAlign = Math.floor((channels * bitsPerSample) / 8);
  const byteRate = sampleRate * blockAlign;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function generateReadyChimeWavBytes(): Buffer {
  // 16-bit PCM mono
  const sampleRate = 44100;
  const channels = 1;
  const bitsPerSample = 16;

  const segments: Array<{ hz: number; ms: number; amp: number }> = [
    { hz: 880, ms: 160, amp: 0.28 },
    { hz: 0, ms: 50, amp: 0 },
    { hz: 660, ms: 160, amp: 0.28 },
    { hz: 0, ms: 50, amp: 0 },
    { hz: 990, ms: 200, amp: 0.32 },
  ];

  const totalSamples = segments.reduce((sum, seg) => sum + Math.floor((seg.ms / 1000) * sampleRate), 0);
  const pcm = Buffer.alloc(totalSamples * 2);

  let offsetSamples = 0;
  for (const seg of segments) {
    const segSamples = Math.floor((seg.ms / 1000) * sampleRate);
    for (let i = 0; i < segSamples; i++) {
      const t = i / sampleRate;

      const fadeSamples = Math.min(Math.floor(sampleRate * 0.01), Math.floor(segSamples / 2));
      const fadeIn = fadeSamples > 0 ? clamp(i / fadeSamples, 0, 1) : 1;
      const fadeOut = fadeSamples > 0 ? clamp((segSamples - 1 - i) / fadeSamples, 0, 1) : 1;
      const env = fadeIn * fadeOut;

      let sample = 0;
      if (seg.hz > 0) {
        sample = Math.sin(2 * Math.PI * seg.hz * t) * seg.amp * env;
      }
      const s16 = Math.round(clamp(sample, -1, 1) * 32767);
      pcm.writeInt16LE(s16, (offsetSamples + i) * 2);
    }
    offsetSamples += segSamples;
  }

  const header = writeWavHeader(pcm.length, sampleRate, channels, bitsPerSample);
  return Buffer.concat([header, pcm]);
}

function generateErrorBuzzWavBytes(): Buffer {
  // 16-bit PCM mono; short "buzzy" alarm-like sound.
  const sampleRate = 44100;
  const channels = 1;
  const bitsPerSample = 16;

  const durationMs = 650;
  const totalSamples = Math.floor((durationMs / 1000) * sampleRate);
  const pcm = Buffer.alloc(totalSamples * 2);

  const baseHz = 120;
  const modHz = 18;
  const amp = 0.34;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;

    const fadeSamples = Math.min(Math.floor(sampleRate * 0.01), Math.floor(totalSamples / 2));
    const fadeIn = fadeSamples > 0 ? clamp(i / fadeSamples, 0, 1) : 1;
    const fadeOut = fadeSamples > 0 ? clamp((totalSamples - 1 - i) / fadeSamples, 0, 1) : 1;
    const env = fadeIn * fadeOut;

    const mod = 0.6 + 0.4 * Math.sin(2 * Math.PI * modHz * t);

    const s = (
      Math.sin(2 * Math.PI * baseHz * t)
      + 0.55 * Math.sin(2 * Math.PI * baseHz * 2 * t)
      + 0.35 * Math.sin(2 * Math.PI * baseHz * 3 * t)
    );

    const sample = s * amp * mod * env;
    const s16 = Math.round(clamp(sample, -1, 1) * 32767);
    pcm.writeInt16LE(s16, i * 2);
  }

  const header = writeWavHeader(pcm.length, sampleRate, channels, bitsPerSample);
  return Buffer.concat([header, pcm]);
}

function ensureWav(kind: ChimeKind): string {
  const outPath = join(tmpdir(), kind === 'ready' ? 'garbanzo-dev-ready.wav' : 'garbanzo-dev-error.wav');
  if (existsSync(outPath)) return outPath;

  const bytes = kind === 'ready' ? generateReadyChimeWavBytes() : generateErrorBuzzWavBytes();
  writeFileSync(outPath, bytes);
  return outPath;
}

async function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

async function playWav(wavPath: string, timeoutMs: number): Promise<boolean> {
  const players: Player[] = [
    // Ubuntu: prefer PulseAudio (paplay), then ALSA (aplay)
    { cmd: 'paplay', args: (p) => ['--volume=65536', p], name: 'paplay' },
    { cmd: 'paplay', args: (p) => [p], name: 'paplay' },
    { cmd: 'aplay', args: (p) => ['-q', p], name: 'aplay' },
  ];

  for (const p of players) {
    try {
      await runCommand(p.cmd, p.args(wavPath), timeoutMs);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT')) continue; // missing binary
      // If paplay doesn't support --volume, retry without it (handled by next candidate).
      continue;
    }
  }

  return false;
}

function usage(): string {
  return [
    'Usage: npm run chime:test',
    '   or: npm run chime:ready',
    '   or: npm run chime:error',
    '',
    'Notes:',
    '  - Ubuntu-only helper for local dev.',
    '  - Needs an audio player available: paplay (PulseAudio) or aplay (ALSA).',
    '  - Optional env overrides:',
    '      CHIME_READY_PATH=/path/to/ready.wav',
    '      CHIME_ERROR_PATH=/path/to/error.wav',
  ].join('\n');
}

async function play(kind: ChimeKind): Promise<void> {
  const envPath = (kind === 'ready'
    ? process.env.CHIME_READY_PATH
    : process.env.CHIME_ERROR_PATH)?.trim();

  const wavPath = (envPath && envPath.length > 0) ? envPath : ensureWav(kind);
  const timeoutMs = kind === 'error' ? 4000 : 2500;

  const ok = await playWav(wavPath, timeoutMs);
  if (!ok) {
    // Best-effort; do not fail CI / automation.
    process.stderr.write('chime: no audio player available (paplay/aplay)\n');
  }
}

async function main(): Promise<void> {
  const arg = (process.argv[2] ?? 'test').toLowerCase();

  if (arg === '--help' || arg === '-h' || arg === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (arg === 'ready') {
    await play('ready');
    return;
  }

  if (arg === 'error') {
    await play('error');
    return;
  }

  if (arg === 'test') {
    await play('ready');
    await new Promise((r) => setTimeout(r, 150));
    await play('error');
    return;
  }

  process.stdout.write(`${usage()}\n`);
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`chime failed: ${err instanceof Error ? err.message : String(err)}\n`);
  // Best-effort; do not fail CI / automation.
});
