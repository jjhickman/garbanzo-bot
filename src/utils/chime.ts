import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logger } from '../middleware/logger.js';
import { config } from './config.js';

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

function generateChimeWavBytes(): Buffer {
  // 16-bit PCM mono
  const sampleRate = 44100;
  const channels = 1;
  const bitsPerSample = 16;

  const segments: Array<{ hz: number; ms: number; amp: number }> = [
    { hz: 880, ms: 180, amp: 0.22 },
    { hz: 0, ms: 60, amp: 0 },
    { hz: 660, ms: 180, amp: 0.22 },
    { hz: 0, ms: 60, amp: 0 },
    { hz: 990, ms: 220, amp: 0.25 },
  ];

  const totalSamples = segments.reduce((sum, seg) => sum + Math.floor((seg.ms / 1000) * sampleRate), 0);
  const pcm = Buffer.alloc(totalSamples * 2);

  let offsetSamples = 0;
  for (const seg of segments) {
    const segSamples = Math.floor((seg.ms / 1000) * sampleRate);
    for (let i = 0; i < segSamples; i++) {
      const t = i / sampleRate;
      // Simple fade in/out to avoid clicks.
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

function ensureDefaultChimeFile(): string {
  const outPath = join(tmpdir(), 'garbanzo-chime.wav');
  if (!existsSync(outPath)) {
    const bytes = generateChimeWavBytes();
    writeFileSync(outPath, bytes);
  }
  return outPath;
}

async function runCommand(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });

    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

/**
 * Play an operator chime on the machine running Garbanzo.
 *
 * Best-effort only: if no audio player is available or CHIME_ENABLED=false,
 * this returns false and does nothing.
 */
export async function playChime(reason: string = 'chime'): Promise<boolean> {
  if (!config.CHIME_ENABLED) return false;

  const wavPath = (config.CHIME_PATH && config.CHIME_PATH.trim().length > 0)
    ? config.CHIME_PATH.trim()
    : ensureDefaultChimeFile();

  const candidates: Array<{ cmd: string; args: string[]; name: string }> = [];

  if (process.platform === 'darwin') {
    candidates.push({ cmd: 'afplay', args: [wavPath], name: 'afplay' });
  } else if (process.platform === 'win32') {
    candidates.push({
      cmd: 'powershell',
      args: [
        '-NoProfile',
        '-Command',
        `(New-Object Media.SoundPlayer '${wavPath.replace(/'/g, "''")}').PlaySync()`,
      ],
      name: 'powershell SoundPlayer',
    });
  } else {
    // Linux / BSD — try PulseAudio then ALSA.
    candidates.push({ cmd: 'paplay', args: [wavPath], name: 'paplay' });
    candidates.push({ cmd: 'aplay', args: ['-q', wavPath], name: 'aplay' });
  }

  for (const c of candidates) {
    try {
      await runCommand(c.cmd, c.args);
      logger.info({ reason, player: c.name }, 'Chime played');
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Missing binary is expected in containers.
      if (msg.includes('ENOENT')) continue;
      logger.debug({ err, player: c.name, reason }, 'Failed to play chime');
    }
  }

  logger.warn({ reason }, 'No audio player available to play chime');
  return false;
}
