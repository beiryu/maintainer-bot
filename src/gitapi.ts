import { git, gitBytes } from './git.js';
import * as gh from './github.js';

// Pushing without `git push`: the commits made locally are replayed on the branch through
// GitHub's API, one createCommitOnBranch per commit, with the same messages and resulting
// file contents. GitHub signs each one (Verified) under the account whose token is used,
// so the signing key never has to be on the machine that runs the bot.

/** The calls that reach GitHub, replaceable in tests. */
export interface RefApi {
  refSha: typeof gh.refSha;
  createRef: typeof gh.createRef;
  forceRef: typeof gh.forceRef;
  deleteRef: typeof gh.deleteRef;
  createCommitOnBranch: typeof gh.createCommitOnBranch;
}
const live: RefApi = { refSha: gh.refSha, createRef: gh.createRef, forceRef: gh.forceRef, deleteRef: gh.deleteRef, createCommitOnBranch: gh.createCommitOnBranch };

/** The files a commit touches, as createCommitOnBranch takes them (a rename is a deletion and an addition). */
export async function commitFileChanges(dir: string, sha: string): Promise<gh.FileChanges> {
  const out: gh.FileChanges = { additions: [], deletions: [] };
  const parts = (await git(dir, ['diff-tree', '--no-commit-id', '-r', '--no-renames', '--name-status', '-z', sha])).split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [status, path] = [parts[i], parts[i + 1]];
    if (status === 'D') out.deletions.push({ path });
    else out.additions.push({ path, contents: (await gitBytes(dir, ['show', `${sha}:${path}`])).toString('base64') });
  }
  return out;
}

/**
 * Replays the local commits `base..HEAD` of `dir` onto `branch` on GitHub. `expectedHead` is
 * the branch's tip as last seen (null: the branch does not exist and is created at `base`);
 * with `force` the branch is replaced, but only if it still is at `expectedHead` (the same
 * guarantee as --force-with-lease). The replacement is built on a scratch branch and the
 * branch is moved once at the end: pointing a PR branch at its base even for a moment makes
 * GitHub close the PR as empty. Returns the new tip.
 */
export async function pushViaApi(repo: string, dir: string, branch: string, base: string,
  opts: { expectedHead: string | null; force?: boolean }, api: RefApi = live): Promise<string> {
  const replay = async (onto: string, head: string) => {
    const shas = (await git(dir, ['rev-list', '--reverse', `${base}..HEAD`])).split('\n').filter(Boolean);
    for (const sha of shas) {
      const [headline, ...rest] = (await git(dir, ['log', '-1', '--format=%B', sha])).split('\n');
      head = await api.createCommitOnBranch(repo, onto, head, { headline, body: rest.join('\n').trim() }, await commitFileChanges(dir, sha));
    }
    return head;
  };
  if (opts.expectedHead === null) {
    await api.createRef(repo, branch, base);
    return replay(branch, base);
  }
  if (!opts.force) return replay(branch, opts.expectedHead);
  const now = await api.refSha(repo, branch);
  if (now !== opts.expectedHead) throw new Error(`${branch} moved on GitHub (${now?.slice(0, 10)} ≠ ${opts.expectedHead.slice(0, 10)}); not replacing it`);
  const scratch = `maintainer-bot/tmp-${Date.now().toString(36)}`;
  await api.createRef(repo, scratch, base);
  try {
    const tip = await replay(scratch, base);
    if (await api.refSha(repo, branch) !== opts.expectedHead) throw new Error(`${branch} moved on GitHub while the replacement was built; not replacing it`);
    await api.forceRef(repo, branch, tip);
    return tip;
  } finally {
    await api.deleteRef(repo, scratch).catch(() => undefined);
  }
}
