/**
 * `expert help` — an orientation, not a flag list. Commander already prints the flags;
 * what someone stuck actually needs is where their files are, what state they are in,
 * and the single next command worth typing.
 */
export interface HelpState {
  version: string;
  /** null when no config has been created yet. */
  configPath: string | null;
  reposDir: string | null;
  reposListFile: string | null;
  listedCount: number;
  repoCount: number;
  curatedCount: number;
  githubUser: string | null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function nextStep(s: HelpState): string[] {
  if (s.configPath === null) {
    return [
      '  expert init',
      '     Asks where your projects are, then connects this to Claude Desktop.',
    ];
  }
  if (s.repoCount === 0 && s.listedCount > 0) {
    return [
      '  expert sync',
      `     ${plural(s.listedCount, 'project')} listed but not cloned yet.`,
    ];
  }
  if (s.repoCount === 0) {
    return [
      '  expert add https://github.com/you/your-project.git',
      `     Adds it to ${s.reposListFile ?? 'your project list'} and clones it.`,
      `     Copying project folders into ${s.reposDir ?? 'your projects folder'} works just as well.`,
    ];
  }
  if (s.curatedCount === 0) {
    return [
      '  expert refresh <project>',
      '     Studies one project — a few minutes — so you can check the result before',
      '     doing the rest. `expert status` lists the names.',
    ];
  }
  if (s.curatedCount < s.repoCount) {
    return [
      '  expert refresh <project>',
      `     ${plural(s.repoCount - s.curatedCount, 'project')} not studied yet. Name the ones you care about;`,
      '     `expert curate --stale` does all of them (slow, uses your Claude allowance).',
    ];
  }
  return [
    '  Ask Claude — everything is studied.',
    '     Restart Claude Desktop and try "what projects do I have, and how do they connect?"',
    '     `expert refresh` later re-studies only what changed.',
  ];
}

export function helpText(s: HelpState): string {
  const lines: string[] = [
    `repos-expert ${s.version} — answers questions about a folder of code repositories`,
    '',
    'Where things are',
    `  Config           ${s.configPath ?? '(not set up yet — run `expert init`)'}`,
    `  Projects folder  ${s.reposDir ?? '-'}${
      s.reposDir === null ? '' : `   (${plural(s.repoCount, 'project')}, ${s.curatedCount} studied)`
    }`,
    `  Project list     ${s.reposListFile ?? '-'}${
      s.reposListFile === null ? '' : `   (${plural(s.listedCount, 'URL')})`
    }`,
  ];
  if (s.githubUser !== null) {
    lines.push(`  GitHub account   ${s.githubUser}   (\`expert sync\` mirrors all of it)`);
  }

  lines.push('', 'Next step:', ...nextStep(s));

  lines.push(
    '',
    'Commands',
    '  expert init                  Set up config and connect to Claude Desktop',
    '  expert add <url>...          Add projects to the list and clone them',
    '  expert status                What is in the folder, and what has been studied',
    '  expert sync                  Clone/update everything listed (and GitHub, if set)',
    '  expert refresh [names...]    Study what changed, or the projects you name',
    '  expert curate --stale        Study everything not yet studied (slow, uses the model)',
    '  expert mcp                   Run the MCP server (your AI client does this for you)',
    '',
    'Any command with --help shows its options. Full guide: https://npmjs.com/package/repos-expert',
  );
  return lines.join('\n');
}
