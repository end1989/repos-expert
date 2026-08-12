import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { formatDiagnosis, runChecks, type Check, type Probes } from '../src/cli/doctor.js';
import { makeTempDir } from './helpers.js';

function probes(over: Partial<Probes> = {}): Probes {
  return {
    nodeVersion: 'v22.0.0',
    ripgrepPath: 'C:/rg.exe',
    hasCommand: () => true,
    env: {},
    ...over,
  };
}

function find(checks: Check[], name: string): Check {
  const c = checks.find((x) => x.name === name);
  if (c === undefined) throw new Error(`no check named ${name}: ${checks.map((x) => x.name).join(', ')}`);
  return c;
}

function goodConfig(root: string): string {
  const configPath = path.join(root, 'expert.config.json');
  fs.mkdirSync(path.join(root, 'repos', 'a-project', '.git'), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ reposDir: './repos', knowledgeDir: './knowledge' }));
  return configPath;
}

describe('runChecks', () => {
  it('passes a healthy setup', () => {
    const root = makeTempDir('expert-doctor-');
    const checks = runChecks(goodConfig(root), probes());
    expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(find(checks, 'projects').detail).toMatch(/1 project/);
  });

  it('fails, with the fixing command, when there is no config', () => {
    const checks = runChecks(null, probes());
    const cfg = find(checks, 'config');
    expect(cfg.status).toBe('fail');
    expect(cfg.fix).toMatch(/expert init/);
  });

  it('does not pretend to check repos it could not find a config for', () => {
    const checks = runChecks(null, probes());
    expect(checks.find((c) => c.name === 'projects')).toBeUndefined();
  });

  it('reports an unreadable config as a failure rather than throwing', () => {
    const root = makeTempDir('expert-doctor-');
    const configPath = path.join(root, 'expert.config.json');
    fs.writeFileSync(configPath, '{ not json');
    const checks = runChecks(configPath, probes());
    expect(find(checks, 'config').status).toBe('fail');
  });

  it('flags a repos folder that does not exist', () => {
    const root = makeTempDir('expert-doctor-');
    const configPath = path.join(root, 'expert.config.json');
    fs.writeFileSync(configPath, JSON.stringify({ reposDir: './nowhere' }));
    expect(find(runChecks(configPath, probes()), 'repos folder').status).toBe('fail');
  });

  it('warns, not fails, on an empty repos folder — that is a next step, not a break', () => {
    const root = makeTempDir('expert-doctor-');
    const configPath = path.join(root, 'expert.config.json');
    fs.mkdirSync(path.join(root, 'repos'), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ reposDir: './repos' }));
    const projects = find(runChecks(configPath, probes()), 'projects');
    expect(projects.status).toBe('warn');
    expect(projects.fix).toMatch(/expert add/);
  });

  it('fails when ripgrep is missing — search is the half that needs no model', () => {
    const root = makeTempDir('expert-doctor-');
    const checks = runChecks(goodConfig(root), probes({ ripgrepPath: null }));
    expect(find(checks, 'ripgrep').status).toBe('fail');
    expect(find(checks, 'ripgrep').fix).toMatch(/npm/);
  });

  it('fails an unsupported Node', () => {
    const root = makeTempDir('expert-doctor-');
    expect(
      find(runChecks(goodConfig(root), probes({ nodeVersion: 'v18.4.0' })), 'node').status,
    ).toBe('fail');
  });

  it('warns when neither Claude Code nor an API key is available', () => {
    const root = makeTempDir('expert-doctor-');
    const checks = runChecks(goodConfig(root), probes({ hasCommand: () => false }));
    const model = find(checks, 'model access');
    expect(model.status).toBe('warn');
    expect(model.detail).toMatch(/search/i);
  });

  it('passes model access on an API key alone, and says it is billed per token', () => {
    const root = makeTempDir('expert-doctor-');
    const checks = runChecks(
      goodConfig(root),
      probes({ hasCommand: () => false, env: { ANTHROPIC_API_KEY: 'sk-secret' } }),
    );
    const model = find(checks, 'model access');
    expect(model.status).toBe('ok');
    expect(model.detail).toMatch(/per.token/i);
    expect(model.detail).not.toContain('sk-secret');
  });

  it('names the subscription when that is what would actually be spent', () => {
    const root = makeTempDir('expert-doctor-');
    expect(find(runChecks(goodConfig(root), probes()), 'model access').detail).toMatch(
      /subscription/i,
    );
  });

  it('reports a local endpoint configured in curatorEnv, and that it came from config', () => {
    const root = makeTempDir('expert-doctor-');
    const configPath = path.join(root, 'expert.config.json');
    fs.mkdirSync(path.join(root, 'repos', 'a-project', '.git'), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        reposDir: './repos',
        curatorEnv: { ANTHROPIC_BASE_URL: 'http://localhost:4000' },
      }),
    );
    const model = find(runChecks(configPath, probes()), 'model access');
    expect(model.detail).toContain('http://localhost:4000');
    expect(model.detail).toMatch(/curatorEnv/);
  });

  it('still reports model access when there is no config to read', () => {
    expect(find(runChecks(null, probes()), 'model access').status).toBe('ok');
  });
});

describe('formatDiagnosis', () => {
  it('leads with the first thing to fix, and says so when nothing is wrong', () => {
    const healthy: Check[] = [{ name: 'node', status: 'ok', detail: 'v22' }];
    expect(formatDiagnosis(healthy)).toMatch(/ready|good|ok/i);

    const broken: Check[] = [
      { name: 'node', status: 'ok', detail: 'v22' },
      { name: 'config', status: 'fail', detail: 'missing', fix: 'expert init' },
    ];
    const out = formatDiagnosis(broken);
    expect(out).toMatch(/expert init/);
    expect(out.indexOf('expert init')).toBeGreaterThan(out.indexOf('config'));
  });
});
