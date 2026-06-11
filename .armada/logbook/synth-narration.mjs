/**
 * Synthesize chapter narrations into the logbook recorder's clip cache.
 *
 * The recorder muxes a chapter's voice clip only if the file at
 * chapterPlan[i].clip.file already exists. Rather than replicating its
 * content-hash naming (the recorder binary's hash input differs subtly from
 * the documented formula), we ask the recorder itself — via --dry-run, which
 * prints the chapterPlan including each clip's expected path — and then
 * synthesize any missing clips directly to those paths via ElevenLabs.
 *
 * Env: ELEVENLABS_API_KEY (required), LOGBOOK_TTS_PROVIDER=elevenlabs,
 *      LOGBOOK_VOICE (voice id, optional)
 */

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error("ELEVENLABS_API_KEY not set");
const VOICE = process.env.LOGBOOK_VOICE || "default";
const voiceId = VOICE !== "default" ? VOICE : "21m00Tcm4TlvDq8ikWAM";

const dry = spawnSync(
  process.execPath,
  [
    path.join(__dirname, "bin", "logbook-recorder.mjs"),
    "--staging", path.join(__dirname, "staging.json"),
    "--plan", path.join(__dirname, "chapters.json"),
    "--dry-run",
  ],
  { encoding: "utf-8" },
);
if (dry.status !== 0) throw new Error(`recorder dry-run failed: ${dry.stderr}`);
const plan = JSON.parse(dry.stdout).chapterPlan;

for (const ch of plan) {
  const clip = ch.clip || {};
  if (clip.mode !== "voice" || !clip.file) {
    console.log(`skip    ${ch.title} (mode=${clip.mode || "none"})`);
    continue;
  }
  if (existsSync(clip.file)) {
    console.log(`cached  ${path.basename(clip.file)}  ${ch.title}`);
    continue;
  }
  mkdirSync(path.dirname(clip.file), { recursive: true });
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": KEY, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text: ch.narration, model_id: "eleven_turbo_v2" }),
  });
  if (!res.ok) throw new Error(`elevenlabs ${res.status}: ${await res.text()}`);
  writeFileSync(clip.file, Buffer.from(await res.arrayBuffer()));
  console.log(`synth   ${path.basename(clip.file)}  ${ch.title}`);
}
