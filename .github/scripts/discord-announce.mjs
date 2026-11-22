// Posts a Discord embed announcing a GitHub release.
// Runs from .github/workflows/discord.yml. No dependencies (Node 18+ has fetch).
//
// Set DRY_RUN=1 to print the payload instead of sending it, e.g. to test locally:
//   RELEASE_TAG=v1.1.0 RELEASE_NAME="Beryl 1.1.0" RELEASE_BODY="$(cat notes.md)" DRY_RUN=1 \
//     node .github/scripts/discord-announce.mjs

import { existsSync, readFileSync } from 'node:fs';

const env = process.env;

// Manual runs hand the release over as the JSON of `gh release view --json tagName,name,body,publishedAt,assets`
// (the file only exists in that case); release events pass each field in its own RELEASE_* variable.
const jsonFile = env.RELEASE_JSON_FILE;
const release = jsonFile && existsSync(jsonFile) ? JSON.parse(readFileSync(jsonFile, 'utf8')) : {};

const repo = env.GITHUB_REPOSITORY || 'miguel66633/beryl-releases';
const server = env.GITHUB_SERVER_URL || 'https://github.com';
const tag = (env.RELEASE_TAG || release.tagName || '').trim();
const name = (env.RELEASE_NAME || release.name || '').trim() || tag;
const body = (env.RELEASE_BODY || release.body || '').replace(/\r/g, '');
const assetName = (env.RELEASE_ASSET_NAME || release.assets?.[0]?.name || '').trim();
const publishedAt = (env.RELEASE_PUBLISHED_AT || release.publishedAt || '').trim();
const mentionSetting = (env.MENTION || '').trim();

if (!tag) {
  console.error('RELEASE_TAG is empty: this script must run from a release event.');
  process.exit(1);
}

// Discord limits are 256 (title), 4096 (description), 1024 (field value) and 6000 (whole embed).
// The caps below leave a margin, and they count code points so emoji are never cut in half.
function clip(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max - 2).join('');
  const lastBreak = cut.lastIndexOf('\n');
  return lastBreak > max / 2 ? `${cut.slice(0, lastBreak).trimEnd()}\n…` : `${cut.trimEnd()}…`;
}

const lines = body.split('\n');
const isHeading = (line) => /^#{1,6}\s/.test(line);

// First paragraph of the notes, before the first "###" section (a "#" or "##" title is skipped).
// Hard-wrapped lines are joined with a space so Discord doesn't show the wrap as a line break.
function intro() {
  const out = [];
  for (const line of lines) {
    if (/^#{3,6}\s/.test(line) || /^[-*]\s/.test(line)) break;
    if (/^#{1,2}\s/.test(line)) continue;
    if (!line.trim()) {
      if (out.length) break;
      continue;
    }
    out.push(line.trim());
  }
  return out.join(' ');
}

// Text under the first heading that matches `wanted`, up to the next heading.
function section(wanted) {
  const out = [];
  let on = false;
  for (const line of lines) {
    if (isHeading(line)) {
      if (on) break;
      on = wanted.test(line);
      continue;
    }
    if (on) out.push(line);
  }
  return out.join('\n').trim();
}

const bullets = (text) => text.replace(/^[-*]\s+/gm, '• ');

// Mention: "@everyone" by default, "none" for no ping, or any text such as a role mention "<@&123>".
let mention = '@everyone';
if (mentionSetting.toLowerCase() === 'none') mention = '';
else if (mentionSetting) mention = mentionSetting;

const allowedMentions = { parse: [], roles: [] };
if (mention.includes('@everyone')) allowedMentions.parse.push('everyone');
for (const match of mention.matchAll(/<@&(\d+)>/g)) allowedMentions.roles.push(match[1]);

const version = /^v?\d/.test(tag) ? tag.replace(/^v/, '') : '';
const headline = version ? `Beryl ${version}` : name;

const releaseUrl = `${server}/${repo}/releases/tag/${encodeURIComponent(tag)}`;
const links = [];
if (assetName) {
  links.push(
    `[⬇️ Download ${assetName}](${server}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)})`,
  );
}
links.push(`[Full changelog on GitHub](${releaseUrl})`);

const fields = [];
const features = bullets(section(/top features|highlights/i));
if (features) fields.push({ name: '⭐ Top Features', value: clip(features, 1000) });
const install = bullets(section(/install/i));
if (install) fields.push({ name: '📥 Install', value: clip(install, 1000) });
fields.push({ name: '🔗 Links', value: links.join(' | ') });

const summary = intro();
const embed = {
  title: clip(`🚀 ${name}`, 250),
  url: releaseUrl,
  color: 3462041,
  ...(summary && { description: clip(summary, 900) }),
  fields,
  footer: { text: 'Beryl Development' },
  ...(publishedAt && { timestamp: publishedAt }),
};

const payload = {
  content: `${mention ? `${mention} ` : ''}🎉 **${headline} is out!**`,
  embeds: [embed],
  allowed_mentions: allowedMentions,
};

if (env.DRY_RUN === '1') {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const webhook = env.DISCORD_WEBHOOK_URL;
if (!webhook) {
  console.error('DISCORD_WEBHOOK_URL is not set: add it as a repository secret.');
  process.exit(1);
}
if (!/^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\//.test(webhook)) {
  console.error('DISCORD_WEBHOOK_URL does not look like a Discord webhook URL.');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (let attempt = 1; attempt <= 3; attempt++) {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    console.log(`Announced ${headline} on Discord (HTTP ${res.status}).`);
    process.exit(0);
  }
  if (res.status === 429 && attempt < 3) {
    const data = await res.json().catch(() => ({}));
    await sleep(((data.retry_after ?? 2) + 0.5) * 1000);
    continue;
  }
  console.error(`Discord answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  process.exit(1);
}
