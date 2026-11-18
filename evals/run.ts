/**
 * The curator eval: studies the agent-kit fixture with the real curator and grades the
 * documents in code against agent-kit/test-fixture/EXPECTED.md.
 *
 *   npm run eval                      one trial with the configured default model
 *   npm run eval -- --trials 3        pass^k over three independent trials
 *   npm run eval -- --model claude-opus-5-5 --budget 2
 *
 * This spends model tokens (two small repos and a portfolio pass per trial — cents, not
 * dollars, with a per-run cap). It needs Claude Code signed in or ANTHROPIC_API_KEY. It
 * writes nothing outside a temp folder except the JSON report in evals/results/.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { checkCitations } from '../src/curator/citations.js';
import { curatePortfolio, curateRepo } from '../src/curator/curator.js';
import { CuratorError } from '../src/curator/errors.js';
import { getRepoStatus, type CitationReport } from '../src/registry.js';
import {
  gradeCitations,
  gradeCrossRepo,
  gradeOrdersApi,
  gradePrivacy,
  type Grade,
} from './graders.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'agent-kit', 'test-fixture', 'repos');
const DOCS = ['card.md', 'architecture.md', 'map.md', 'activity.md', 'interfaces.md'];

const { values } = parseArgs({
  options: {
    trials: { type: 'string', default: '1' },
    model: { type: 'string' },
    budget: { type: 'string', default: '1.5' },
  },
});
const trials = Number(values.trials);
const budget = Number(values.budget);
if (!Number.isInteger(trials) || trials < 1 || trials > 10)
  throw new Error('--trials must be 1–10');
if (!(budget > 0)) throw new Error('--budget must be a positive number of dollars');

/** The fixture as real git repositories in a fresh folder, with a config pointing at them. */
function buildFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expert-eval-'));
  const reposDir = path.join(root, 'repos');
  fs.cpSync(FIXTURE, reposDir, { recursive: true });
  for (const name of fs.readdirSync(reposDir)) {
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', ...args],
        {
          cwd: path.join(reposDir, name),
          stdio: 'ignore',
        },
      );
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'initial');
  }
  const configPath = path.join(root, 'expert.config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      reposDir: './repos',
      knowledgeDir: './knowledge',
      curateMaxBudgetUsd: budget,
      ...(values.model !== undefined ? { model: values.model } : {}),
    }),
  );
  return configPath;
}

function read(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

interface Trial {
  grades: Grade[];
  costUsd: number;
  model: string;
  error?: string;
}

async function runTrial(n: number): Promise<Trial> {
  const cfg = loadConfig(buildFixture());
  console.error(
    `trial ${n}: studying orders-api, order-worker and the portfolio with ${cfg.model}…`,
  );
  let costUsd = 0;
  const citations: CitationReport[] = [];
  try {
    for (const name of ['orders-api', 'order-worker']) {
      const outcome = await curateRepo(cfg, await getRepoStatus(cfg, name));
      costUsd += outcome.stats?.costUsd ?? 0;
      citations.push(outcome.citations);
    }
    costUsd += (await curatePortfolio(cfg))?.costUsd ?? 0;
  } catch (err) {
    // A pass that failed was still paid for.
    if (err instanceof CuratorError) costUsd += err.stats?.costUsd ?? 0;
    return {
      grades: [],
      costUsd,
      model: cfg.model,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const repoDocs = (name: string) =>
    Object.fromEntries(DOCS.map((d) => [d, read(path.join(cfg.knowledgeDir, 'repos', name, d))]));
  const ordersApi = repoDocs('orders-api');
  const portfolio = read(path.join(cfg.knowledgeDir, 'portfolio.md'));
  const crossRepoMap = read(path.join(cfg.knowledgeDir, 'cross-repo-map.md'));
  // The portfolio documents cite across the collection ("orders-api/src/server.js:9"), so
  // they are checked against the repos folder rather than one repository.
  citations.push(
    checkCitations(cfg.reposDir, { 'portfolio.md': portfolio, 'cross-repo-map.md': crossRepoMap }),
  );
  const everything = [
    ...Object.values(ordersApi),
    ...Object.values(repoDocs('order-worker')),
    portfolio,
    crossRepoMap,
  ].join('\n');

  return {
    grades: [
      ...gradeOrdersApi(ordersApi),
      ...gradeCrossRepo(crossRepoMap),
      gradeCitations(citations),
      gradePrivacy(everything),
    ],
    costUsd,
    model: cfg.model,
  };
}

const results: Trial[] = [];
for (let n = 1; n <= trials; n++) results.push(await runTrial(n));

// pass^k: a grade counts only if it passed in every trial — the bar for something that
// runs unattended, where one bad run in three is a bad run someone acts on.
const ids = [...new Set(results.flatMap((t) => t.grades.map((g) => g.id)))];
let failedRequired = results.some((t) => t.error !== undefined);
console.log(
  `\nCurator eval — ${trials} trial${trials === 1 ? '' : 's'}, model ${results[0]?.model ?? '?'}\n`,
);
for (const id of ids) {
  const per = results.map((t) => t.grades.find((g) => g.id === id));
  const passes = per.filter((g) => g?.pass === true).length;
  const sample = per.find((g) => g !== undefined);
  const required = sample?.required === true;
  if (required && passes < trials) failedRequired = true;
  const mark = passes === trials ? 'pass' : required ? 'FAIL' : 'miss';
  console.log(`  ${mark}  ${id.padEnd(18)} ${passes}/${trials}  ${sample?.title ?? ''}`);
  for (const g of per) if (g !== undefined && !g.pass) console.log(`        ↳ ${g.detail}`);
}
for (const [i, t] of results.entries())
  if (t.error !== undefined) console.log(`  FAIL  trial ${i + 1} did not finish: ${t.error}`);
const spent = results.reduce((s, t) => s + t.costUsd, 0);
console.log(`\n  spent about $${spent.toFixed(2)} (the agent runtime's estimate)`);

const outDir = path.join(ROOT, 'evals', 'results');
fs.mkdirSync(outDir, { recursive: true });
const report = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(report, JSON.stringify({ trials, results }, null, 2));
console.log(`  report: ${path.relative(ROOT, report)}\n`);
process.exitCode = failedRequired ? 1 : 0;
