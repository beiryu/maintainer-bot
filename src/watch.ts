import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoConfig, SourceConfig } from './config.js';
import { mirrorDir } from './git.js';
import * as gh from './github.js';
import type { Ctx } from './orchestrator.js';

// Upstream watcher: what the repo pins (a commit in its build script, a page it describes) versus
// what is there now. Plain code gathers the difference; the planner decides whether it matters.

/** The 40-hex sha that follows the repo's name in `file`, e.g. `repo: 'a/b', sha: '…'` or a markdown table row. */
export function pinnedSha(file: string, repo: string): string | null {
  const i = file.indexOf(repo);
  if (i < 0) return null;
  const after = file.slice(i, i + 600);
  return /\b([0-9a-f]{40})\b/.exec(after)?.[1] ?? /\b([0-9a-f]{7,12})\b/.exec(after.replace(repo, ''))?.[1] ?? null;
}

export interface SourceCheck { name: string; pinned: string | null; upstream: string | null; digest: string }

async function checkGithub(rc: RepoConfig, s: SourceConfig, root: string): Promise<SourceCheck> {
  const files = s.pinned_from ? [s.pinned_from] : ['packages/core/data/SOURCES.md', 'SOURCES.md', 'scripts/build-data.ts'];
  let pinned: string | null = null;
  for (const f of files) {
    if (!existsSync(join(root, f))) continue;
    pinned = pinnedSha(readFileSync(join(root, f), 'utf8'), s.repo!);
    if (pinned) break;
  }
  const info = await gh.repoInfo(s.repo!);
  const upstream = await gh.branchHead(s.repo!, info.defaultBranch);
  if (!pinned) return { name: s.name, pinned, upstream, digest: `${s.name} (${s.repo}): no pinned commit found in ${files.join(', ')}; upstream head is ${upstream.slice(0, 10)}` };
  if (upstream.startsWith(pinned)) return { name: s.name, pinned, upstream, digest: '' };
  const cmp = await gh.compareCommits(s.repo!, pinned, upstream);
  const touched = s.paths.length ? cmp.files.filter((f) => s.paths.some((p) => f.filename.startsWith(p))) : cmp.files;
  if (s.paths.length && !touched.length) return { name: s.name, pinned, upstream, digest: '' };
  const lines = [
    `${s.name} (${s.repo}): pinned ${pinned.slice(0, 10)}, upstream ${info.defaultBranch} is ${cmp.aheadBy} commit(s) ahead at ${upstream.slice(0, 10)}${s.note ? ` — ${s.note}` : ''}`,
    ...cmp.commits.slice(-15).map((c) => `  ${c.date.slice(0, 10)} ${c.sha.slice(0, 8)} ${c.message.slice(0, 100)}`),
    `  files touched${s.paths.length ? ` under ${s.paths.join(', ')}` : ''}: ${touched.slice(0, 30).map((f) => `${f.filename} (${f.status})`).join(', ')}${touched.length > 30 ? ` … +${touched.length - 30}` : ''}`,
  ];
  return { name: s.name, pinned, upstream, digest: lines.join('\n') };
}

/** A page's text, tags stripped, so the diff is about words and numbers rather than markup. */
async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'user-agent': 'maintainer-bot' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** Lines in `b` not in `a` and vice versa, capped: enough for the planner to see what moved. */
export function lineDiff(a: string, b: string, max = 40): string {
  const A = new Set(a.split('\n')), B = new Set(b.split('\n'));
  const added = [...B].filter((l) => !A.has(l)).slice(0, max);
  const removed = [...A].filter((l) => !B.has(l)).slice(0, max);
  return [...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)].join('\n');
}

async function checkUrl(ctx: Ctx, rc: RepoConfig, s: SourceConfig): Promise<SourceCheck> {
  const text = await fetchText(s.url!);
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const prev = ctx.db.source(rc.full_name, s.name);
  const snapFile = join('data', 'sources', `${rc.full_name.replace('/', '__')}__${s.name}.txt`);
  const old = existsSync(snapFile) ? readFileSync(snapFile, 'utf8') : '';
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join('data', 'sources'), { recursive: true });
  writeFileSync(snapFile, text);
  if (!prev || !old) return { name: s.name, pinned: hash, upstream: hash, digest: '' }; // first sight: nothing to compare yet
  if (prev.upstream === hash) return { name: s.name, pinned: prev.pinned, upstream: hash, digest: '' };
  return { name: s.name, pinned: prev.pinned, upstream: hash, digest: `${s.name} (${s.url}) changed since last check${s.note ? ` — ${s.note}` : ''}:\n${lineDiff(old, text)}` };
}

/** Checks every source of a repo, stores the result, returns the text the planner gets. */
export async function sourceDigest(ctx: Ctx, rc: RepoConfig, log: (m: string) => void): Promise<string> {
  const parts: string[] = [];
  for (const s of rc.sources) {
    try {
      const c = s.kind === 'github' ? await checkGithub(rc, s, mirrorDir(rc.full_name)) : await checkUrl(ctx, rc, s);
      ctx.db.setSource({ repo: rc.full_name, name: s.name, pinned: c.pinned, upstream: c.upstream, digest: c.digest || null });
      if (c.digest) { parts.push(c.digest); log(`${rc.full_name}: source ${s.name} changed upstream`); }
    } catch (e) {
      log(`${rc.full_name}: source ${s.name}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  return parts.join('\n\n');
}
