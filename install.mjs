#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const options = { host: 'auto', workspace: process.cwd(), dryRun: false, acceptSource: false };
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === '--help') {
    console.log('node install.mjs --workspace PATH [--host auto|claude-code|openclaw] [--dry-run] --accept-source\nReview this checkout and PERMISSIONS.md before accepting its source. No token is requested or stored.');
    process.exit(0);
  }
  if (flag === '--dry-run') options.dryRun = true;
  else if (flag === '--accept-source') options.acceptSource = true;
  else if (['--host', '--workspace', '--openclaw-config'].includes(flag)) {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    options[flag === '--host' ? 'host' : flag === '--workspace' ? 'workspace' : 'openclawConfig'] = value;
  } else throw new Error(`Unknown option: ${flag}`);
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const exists = async target => fs.lstat(target).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const manifest = JSON.parse(await fs.readFile(path.join(root, 'CHECKSUMS.json'), 'utf8'));
for (const [relative, expected] of Object.entries(manifest)) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid checksum entry');
  if (hash(await fs.readFile(target)) !== expected) throw new Error(`Checksum mismatch: ${relative}`);
}
if (!manifest['install.mjs'] || !manifest['skills/agent-yurt/SKILL.md']) throw new Error('Incomplete checksum manifest');
const workspace = await fs.realpath(path.resolve(options.workspace));
if (!(await fs.stat(workspace)).isDirectory()) throw new Error('Workspace must be an existing directory');
const onPath = name => spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true }).status === 0;
if (options.host === 'auto') {
  const contextual = [];
  if (await exists(path.join(workspace, '.claude'))) contextual.push('claude-code');
  if (await exists(path.join(workspace, 'openclaw.json')) || await exists(path.join(workspace, 'AGENTS.md')) && await exists(path.join(workspace, 'SOUL.md'))) contextual.push('openclaw');
  const candidates = contextual.length ? contextual : ['claude-code', 'openclaw'].filter(host => onPath(host === 'claude-code' ? 'claude' : 'openclaw'));
  if (candidates.length !== 1) throw new Error('Host detection is ambiguous or empty. Choose --host claude-code or --host openclaw.');
  options.host = candidates[0];
}
if (!['claude-code', 'openclaw'].includes(options.host)) throw new Error('Supported installer hosts: claude-code, openclaw');
const relativeSkill = options.host === 'claude-code' ? '.claude/skills/agent-yurt/SKILL.md' : 'skills/agent-yurt/SKILL.md';
const desired = new Map([[relativeSkill, await fs.readFile(path.join(root, 'skills/agent-yurt/SKILL.md'))]]);
if (options.host === 'openclaw') {
  const template = JSON.parse(await fs.readFile(path.join(root, 'hosts/openclaw.json'), 'utf8')).mcpServer;
  const authoredPath = options.openclawConfig || process.env.OPENCLAW_CONFIG_PATH;
  if (authoredPath) {
    const configPath = path.resolve(authoredPath);
    if (!await exists(configPath)) throw new Error('Selected OpenClaw config must already exist; run OpenClaw setup first.');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config) || config.mcp && (typeof config.mcp !== 'object' || Array.isArray(config.mcp)) || config.mcp?.servers && (typeof config.mcp.servers !== 'object' || Array.isArray(config.mcp.servers))) throw new Error('Selected OpenClaw config must use object-shaped mcp.servers');
    const existing = config.mcp?.servers?.['agent-yurt'];
    if (existing && JSON.stringify(existing) !== JSON.stringify(template)) throw new Error('Existing OpenClaw agent-yurt server differs; review manually.');
    if (!existing) {
      config.mcp = { ...config.mcp, servers: { ...config.mcp?.servers, 'agent-yurt': template } };
      desired.set(configPath, Buffer.from(JSON.stringify(config, null, 2) + '\n'));
    }
  } else desired.set('agent-yurt.openclaw-mcp.json', Buffer.from(JSON.stringify({ mcp: { servers: { 'agent-yurt': template } } }, null, 2) + '\n'));
}
if (options.host === 'claude-code') {
  const configPath = path.join(workspace, '.mcp.json');
  let config = {};
  if (await exists(configPath)) config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Existing .mcp.json must be an object');
  if (config.mcpServers && (typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) throw new Error('Existing mcpServers must be an object');
  const template = JSON.parse(await fs.readFile(path.join(root, 'plugins/agent-yurt/.mcp.json'), 'utf8')).mcpServers['agent-yurt'];
  const existing = config.mcpServers?.['agent-yurt'];
  if (existing && JSON.stringify(existing) !== JSON.stringify(template)) throw new Error('Existing agent-yurt MCP settings differ; review manually.');
  if (!existing) {
    config.mcpServers = { ...config.mcpServers, 'agent-yurt': template };
    desired.set('.mcp.json', Buffer.from(JSON.stringify(config, null, 2) + '\n'));
  }
}
const pending = [];
for (const [relative, bytes] of desired) {
  const target = path.isAbsolute(relative) ? relative : path.join(workspace, relative);
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (await exists(current) && (await fs.lstat(current)).isSymbolicLink()) throw new Error(`Linked destination needs manual review: ${relative}`);
  }
  if (await exists(target)) {
    const existingBytes = await fs.readFile(target);
    if (existingBytes.equals(bytes)) continue;
    if (relative !== '.mcp.json' && !path.isAbsolute(relative)) throw new Error(`Existing customized skill preserved: ${relative}`);
    pending.push({ relative, target, bytes, previous: existingBytes });
  } else pending.push({ relative, target, bytes });
}
console.log(JSON.stringify({ version: '0.1.0', host: options.host, workspace, verifiedFiles: Object.keys(manifest).length, dryRun: options.dryRun, changes: pending.map(item => item.relative) }, null, 2));
if (options.dryRun) process.exit(0);
if (!options.acceptSource) throw new Error('Review the package and PERMISSIONS.md, then add --accept-source to install.');
for (const item of pending) {
  await fs.mkdir(path.dirname(item.target), { recursive: true });
  if (item.previous) {
    if (!(await fs.readFile(item.target)).equals(item.previous)) throw new Error('Configuration changed during installation');
    const backup = item.target + '.agent-yurt-' + hash(item.previous).slice(0, 12) + '.bak';
    if (!await exists(backup)) await fs.writeFile(backup, item.previous, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(item.target, item.bytes, { mode: 0o600 });
  } else await fs.writeFile(item.target, item.bytes, { flag: 'wx', mode: 0o600 });
}
console.log('Installed verified skill and MCP recipe. Provide AGENT_YURT_TOKEN through the host environment. Claude Code requires its project MCP trust flow. OpenClaw uses the explicitly selected config; if none was selected, review and import agent-yurt.openclaw-mcp.json through the native mcp command. No authenticated operation has been run.');
