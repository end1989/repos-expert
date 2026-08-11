export const DOC_FILES = ['card.md', 'architecture.md', 'map.md', 'activity.md'] as const;

export interface RepoContext {
  name: string;
  gitLog: string;
  branches: string;
  previousDocs?: Record<string, string>;
  changesSincePrevious?: string;
}

export interface PortfolioContext {
  cards: Record<string, string>;
  manifests: Record<string, string>;
}

const TEMPLATES = `Required sections per document:
- card.md: Purpose · Tech stack · Status (active/dormant/archived) · Entry points · How to run · Related repos
- architecture.md: Overview · Key modules (with paths) · Data flow · External dependencies/services · Design decisions & conventions
- map.md: Annotated directory tree — for each significant directory/file, one line on what happens there
- activity.md: Recent focus (from git log) · Open branches and what they contain · Apparent unfinished work / TODOs`;

const OUTPUT_RULES = (files: readonly string[]) => `Output ONLY the documents, each preceded by its marker line, nothing after the last document:
${files.map((f) => `===FILE: ${f}===`).join('\n[document content]\n')}
[document content]`;

export function buildRepoPrompt(ctx: RepoContext): string {
  const parts: string[] = [];
  parts.push(
    `You are curating an expert knowledge-base entry for the repository "${ctx.name}".`,
    `Explore the repository with your Read, Glob, and Grep tools until you understand what it does, how it is built, and where things happen. Be concrete: cite real paths.`,
    TEMPLATES,
    `Git context (pre-computed for you):\n\nRecent commits:\n${ctx.gitLog}\n\nBranches:\n${ctx.branches}`,
  );
  if (ctx.previousDocs !== undefined) {
    const prev = Object.entries(ctx.previousDocs)
      .map(([file, body]) => `--- ${file} ---\n${body}`)
      .join('\n\n');
    parts.push(
      `Previous docs exist. UPDATE them rather than rewriting from scratch — preserve still-valid insight, revise what changed.\n\nChanges since last curation:\n${ctx.changesSincePrevious ?? '(none recorded)'}\n\nPrevious docs:\n${prev}`,
    );
  }
  parts.push(OUTPUT_RULES(DOC_FILES));
  return parts.join('\n\n');
}

export function buildPortfolioPrompt(ctx: PortfolioContext): string {
  const cards = Object.entries(ctx.cards)
    .map(([name, body]) => `--- card: ${name} ---\n${body}`)
    .join('\n\n');
  const manifests = Object.entries(ctx.manifests)
    .map(([name, body]) => `--- manifest: ${name} ---\n${body}`)
    .join('\n\n');
  return [
    `You are curating the portfolio-level knowledge for a collection of repositories owned by one developer.`,
    `Write two documents:
- portfolio.md: what repos exist, what each is for (one line each), how they group into themes, overall status of the portfolio.
- cross-repo-map.md: dependencies and relationships between the repos — shared libraries, one repo consuming another, shared patterns or conventions, data flowing between them. Cite evidence from the cards and manifests.`,
    `Repo cards:\n\n${cards}`,
    `Manifests:\n\n${manifests}`,
    OUTPUT_RULES(['portfolio.md', 'cross-repo-map.md']),
  ].join('\n\n');
}

export function parseCuratedDocs(
  output: string,
  expected: readonly string[],
): Record<string, string> {
  const re = /^===FILE: (.+?)===\r?$/gm;
  const markers: { name: string; contentStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    markers.push({ name: m[1].trim(), contentStart: m.index + m[0].length });
  }
  const docs: Record<string, string> = {};
  markers.forEach((marker, i) => {
    const next = markers[i + 1];
    const end = next === undefined ? output.length : output.lastIndexOf('===FILE:', next.contentStart);
    docs[marker.name] = output.slice(marker.contentStart, end).trim();
  });
  const missing = expected.filter((f) => docs[f] === undefined || docs[f].length === 0);
  if (missing.length > 0) {
    throw new Error(`Curator output missing docs: ${missing.join(', ')}`);
  }
  return docs;
}
