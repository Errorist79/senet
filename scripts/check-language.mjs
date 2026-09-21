// Check the text of this repository against the language rules and the type rules.
//
//   node scripts/check-language.mjs [file ...]
//
// The rules ask for one style of English in every comment and every document
// here, and they carve out no directory. A rule that a person keeps by memory
// is a rule that a tired person drops. The drop is silent, so this command
// reads the text. Nobody then needs to hold the rules in their head.
//
// A caller may name files, and a commit hook names the staged paths. A caller
// that names nothing reads every target.
//
// Some rules judge and some rules ask. A banned word is a fault. A passive
// voice needs a person to look, and the word `review` marks those.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The root comes from this file rather than from a shared module. The gate has
// to run on a fresh clone, before anybody installs a dependency, so it imports
// nothing outside node itself.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The trees that the walk reads, and the single files beside them. */
const TARGETS = ['packages', 'server', 'app', 'scripts', 'deploy', 'contracts', 'docs', '.github'];
// Files that no target directory holds. `README.md` is the most public document
// in this repository and the first thing a stranger reads, and no target
// reached it until somebody looked. The two workspace documents sit inside
// targets already, so the walk finds them.
const EXTRA = [
  'package.json', 'tsconfig.base.json', '.env.example', 'README.md',
  'Cargo.toml', 'rust-toolchain.toml',
];

/**
 * Directories of build output, by name.
 *
 * A directory with one of these names holds installed or built files wherever
 * it sits. Nobody writes prose in one, so the name alone is enough.
 */
const BUILD_OUTPUT = new Set(['node_modules', 'dist', 'target']);

/**
 * Directories that a person decided to leave out, by path.
 *
 * A name matches at any depth, and a new directory that shares a word with an
 * old one then disappears without a word. That happened here. The name
 * `evidence` was in the list for a source package. It took the generated tree
 * `scripts/out/evidence` with it, and the three trees beside that one stayed
 * in the walk. Nobody chose that, and nothing reported it.
 *
 * A path names one directory and nothing else. The report below names each of
 * these and counts the files that it hides, so a skip is as visible as a
 * suspension.
 */
const SKIPPED = [
  'packages/core/test/fixtures',
  'server/test/fixtures',
  // A run of the confirmation check writes these, and git carries neither. The
  // sweep counted whatever the last run left on the machine. The same commit
  // reported 217 files here and 195 from a clone. A count that moves with a
  // machine is not a fact about the repository.
  'scripts/out/confirm-check/captures',
  'scripts/out/confirm-check/listener.json',
];

const BANNED_WORDS = [
  // language-rules: off
  'robust', 'seamless', 'seamlessly', 'powerful', 'leverage', 'leverages',
  'leveraging', 'cutting-edge', 'best-in-class', 'effortless', 'blazing',
  'simply', 'just works', 'game-changing', 'state-of-the-art', 'rich set',
  'unlock', 'supercharge', 'delightful', 'elegant',
  // language-rules: on
];
const INTERNAL_REFS = [
  // language-rules: off
  'CLAUDE.md', 'PLAN.md', 'internal-docs', 'archive/', 'the plan', 'the SOW',
  'section 5.2', 'W1-0', 'W2-0', 'W3-0', 'W4-0', 'see the design', 'as planned',
  'this task', 'the sprint', 'funding document', 'the owner',
  // language-rules: on
];
const PARTICIPLES =
  '(been|done|gone|made|seen|taken|written|changed|added|removed|shipped|' +
  'produced|returned|failed|passed|become|come|run|set|put|read|built|kept|' +
  'left|found|given|held|told|brought|paid|sent|spent|lost|meant|felt|shown)';
const PERFECT = new RegExp(`\\b(has|have|had)\\s+(not\\s+|never\\s+|already\\s+)?${PARTICIPLES}\\b`, 'i');

// The kinds that carry prose. A shell script, an nginx file, a systemd unit
// and a Stellar information file write their prose in `#` comments. One
// extractor therefore reads all four. The report below names any other kind
// that a caller hands over, because a silent refusal reads as a clean file.
const SCANNABLE = /\.(ts|md|json|mjs|css|html|webmanifest|sh|conf|service|toml|rs|yml|yaml)$/;
const HASH_COMMENT = /\.(sh|conf|service|toml|yml|yaml)$/;
// The type rules read code. A Markdown file holds code inside a fence, and the
// prose complement below leaves the fence, so the rules still reach a sample.
const CODE = /\.(ts|mjs|md)$/;

/**
 * Two markers that suspend every rule between them.
 *
 * A file that defines the rules holds the words that the rules ban. This one
 * does, and so does any file that lists a term for a reader to avoid. An
 * exemption by file name would hide the whole file for ever. The suspension is
 * therefore a span, and the summary counts the suspended lines of each file. A
 * suspension that nobody can see is the fault that this command exists to stop.
 */
const SUSPEND_OFF = /language-rules:\s*off/;
const SUSPEND_ON = /language-rules:\s*on/;

const findings = [];
const suspended = [];
const skipped = [];
const add = (file, line, rule, text) =>
  findings.push({ file, line, rule, text: text.trim().slice(0, 110) });

function walk(dir, out = [], record = true) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(ROOT, full);
    if (fs.statSync(full).isDirectory()) {
      if (BUILD_OUTPUT.has(name)) continue;
      if (SKIPPED.includes(rel)) {
        // Read the skipped tree anyway, to say how many files the skip hides.
        if (record) skipped.push({ tree: rel, files: walk(full, [], false).length });
        continue;
      }
      walk(full, out, record);
    } else if (SKIPPED.includes(rel)) {
      if (record) skipped.push({ tree: rel, files: 1 });
    } else if (SCANNABLE.test(name)) out.push(full);
  }
  return out;
}

const named = process.argv.slice(2).map((f) => path.resolve(ROOT, f));
const everything = [
  ...TARGETS.flatMap((t) => walk(path.join(ROOT, t))),
  ...EXTRA.map((f) => path.join(ROOT, f)),
];
// A caller that names files gets those files, whether or not a target
// directory holds them. An earlier version crossed the named list with the
// walk, so a named file outside `TARGETS` scanned nothing and reported `scan
// clean over 0 files`. That is a gate that calls a file clean and never opens
// it, which is the fault this repository keeps finding.
const files = named.length > 0 ? named.filter((f) => fs.existsSync(f) && SCANNABLE.test(f)) : everything;
for (const one of named) {
  if (!fs.existsSync(one)) continue;
  if (!SCANNABLE.test(one)) console.log(`not scanned, no rule for this kind: ${path.relative(ROOT, one)}`);
}

/** The line numbers that lie between a suspension marker and its partner. */
function suspendedLines(lines) {
  const off = new Set();
  let inside = false;
  lines.forEach((raw, i) => {
    if (SUSPEND_OFF.test(raw)) { inside = true; off.add(i + 1); return; }
    if (SUSPEND_ON.test(raw)) { inside = false; off.add(i + 1); return; }
    if (inside) off.add(i + 1);
  });
  return off;
}

/** Prose lines: comment bodies in TypeScript, everything outside code fences in Markdown. */
function proseLines(file, lines) {
  const isMd = file.endsWith('.md');
  const isHash = HASH_COMMENT.test(file);
  const out = [];
  let inFence = false;
  lines.forEach((raw, i) => {
    const n = i + 1;
    if (isHash) {
      // A shebang names an interpreter. It is not a sentence.
      if (n === 1 && /^#!/.test(raw)) return;
      const hash = raw.match(/^\s*#+\s?(.*)$/);
      if (hash && hash[1] !== undefined && hash[1].trim() !== '') out.push([n, hash[1], false]);
      return;
    }
    if (isMd) {
      if (/^```/.test(raw)) { inFence = !inFence; return; }
      if (inFence) return;
      if (/^\s*\|/.test(raw)) return;
      out.push([n, raw, false]);
      return;
    }
    const m = raw.match(/^\s*(?:\/\/[\/!]?|\/\*\*?|\*)\s?(.*)$/);
    if (m && m[1] !== undefined && !/^\/$/.test(m[1])) { out.push([n, m[1], false]); return; }
    // A test title and an error message are prose that a reader sees.
    for (const lit of raw.matchAll(/'([^'\\]{12,})'|`([^`$\\]{12,})`/g)) {
      out.push([n, lit[1] ?? lit[2] ?? '', true]);
    }
  });
  return out;
}

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split('\n');

  const off = suspendedLines(lines);
  if (off.size > 0) suspended.push({ file: rel, lines: off.size });
  const prose = proseLines(file, lines).filter((one) => !off.has(one[0]));
  // A type name inside a sentence is a sentence. The assertion rule read the
  // words `as JSON,` in a comment and called them a type assertion, which no
  // comment can hold. The type rules therefore take the complement of the
  // prose lines, and they read only the kinds that carry code.
  const sentenceLines = new Set(prose.filter((one) => one[2] === false).map((one) => one[0]));

  lines.forEach((raw, i) => {
    const n = i + 1;
    if (off.has(n)) return;
    // A dash is wrong in prose and in code alike, so this rule reads both.
    // The patterns below hold the very characters that they refuse.
    // language-rules: off
    if (/[—–]/.test(raw)) add(rel, n, 'em-dash or en-dash', raw);
    if (!CODE.test(rel) || sentenceLines.has(n)) return;
    if (/\bas\s+[A-Z][A-Za-z0-9_<>[\]]*\s*[;,)\]}=]/.test(raw) && !/\bas\s+const\b/.test(raw)) {
      add(rel, n, 'type assertion "as T"', raw);
    }
    if (/<[A-Z][A-Za-z0-9_]*>\s*[a-z_$(]/.test(raw) && !/\.(md)$/.test(rel)) {
      add(rel, n, 'angle-bracket assertion', raw);
    }
    if (/\)!|\w!\.|\w!\[|\w!\s*[;,)]/.test(raw)) add(rel, n, 'non-null assertion "!"', raw);
    if (/:\s*any\b|<any>|\bas\s+any\b|\bany\[\]|Array<any>|Record<[^>]*any/.test(raw)) {
      add(rel, n, 'the any type', raw);
    }
    // language-rules: on
  });

  // Rules that apply to prose only.
  for (const [n, text] of prose) {
    const lower = text.toLowerCase();
    for (const word of BANNED_WORDS) {
      if (new RegExp(`\\b${word.replace(/[-/]/g, '[-/]')}\\b`).test(lower)) {
        add(rel, n, `banned word "${word}"`, text);
      }
    }
    for (const ref of INTERNAL_REFS) {
      if (lower.includes(ref.toLowerCase())) add(rel, n, `internal reference "${ref}"`, text);
    }
    if (PERFECT.test(text)) add(rel, n, 'perfect tense', text);
    const dropped = text.match(
      /\b(the|a|an|one|every|each)\s+[a-z-]+\s+(a|an|the|this|it|they|we|you)\s+(would|can|will|must|may|[a-z]+s)\b/i,
    );
    if (dropped) add(rel, n, `review dropped relative pronoun "${dropped[0]}"`, text);
    const passive = text.match(
      new RegExp(`\\b(is|are|was|were|be|been|being)\\s+(not\\s+)?(\\w+ed|${PARTICIPLES})\\b`, 'i'),
    );
    // A participle that names a state is an adjective. Nothing performs the
    // action in `the events between are gone`, and there is no agent to
    // restore, so the sentence is active already.
    const adjectival = /\b(is|are|was|were)\s+(not\s+)?(gone|malformed)\b/i;
    if (passive && !adjectival.test(passive[0])) {
      add(rel, n, `review passive voice "${passive[0]}"`, text);
    }
    const gerund = text.match(
      /\b(the|of|by|for|after|before|without|with)\s+([a-z]+ing)\b/i,
    );
    // A participle inside a fixed technical term is an adjective, not a noun.
    const compound =
      /working directory|working tree|signing key|relying party|funding service/i.test(text);
    // `anything` and its family merely end in those three letters. This rule
    // looks for a verb that stands as a noun, and those words are pronouns.
    //
    // Each word stands between boundaries. Without them `thing` covers every
    // word of that family. It covers `breathing` and `clothing` as well, and
    // those are the words that this rule exists to catch.
    const notGerund =
      /\b(following|during|remaining|being|ceiling|string|keyring|thing|nothing|anything|something|everything)\b/i;
    if (gerund && !compound && !notGerund.test(gerund[0])) {
      add(rel, n, `review -ing form "${gerund[0]}"`, text);
    }
  }

  // Sentence length, over the joined prose of each comment block or paragraph.
  let block = [];
  let blockStart = 0;
  const flush = () => {
    if (!block.length) return;
    const joined = block.join(' ').replace(/\s+/g, ' ');
    for (const sentence of joined.split(/(?<=[.:;?!])\s+/)) {
      const words = sentence.trim().split(/\s+/).filter(Boolean);
      if (words.length > 25) add(rel, blockStart, `sentence of ${words.length} words`, sentence);
    }
    const count = joined.split(/(?<=[.?!])\s+/).filter((s) => s.trim().length > 1);
    if (count.length > 6) add(rel, blockStart, `paragraph of ${count.length} sentences`, joined);
    block = [];
  };
  let previous = -2;
  for (const [n, text, isLiteral] of prose) {
    if (isLiteral) continue;
    // A vertical list carries one item for each line, so each item is a block.
    const startsItem = /^\s*([-*+]|\d+\.)\s/.test(text);
    if (n !== previous + 1 || text.trim() === '' || startsItem) { flush(); blockStart = n; }
    if (text.trim() !== '') block.push(text);
    previous = n;
  }
  flush();
}

// A suspension never passes in silence. A reader of this output sees which
// files hold one, and how many lines it covers.
for (const one of suspended) {
  console.log(`${one.file} suspends the rules over ${one.lines} lines`);
}
for (const one of skipped) {
  console.log(`${one.tree} is out of the walk and hides ${one.files} files`);
}

if (!findings.length) {
  console.log(`scan clean over ${files.length} files`);
} else {
  console.log(`${findings.length} findings over ${files.length} files`);
  for (const f of findings) console.log(`${f.file}:${f.line}  ${f.rule}\n    ${f.text}`);
  // A non-zero exit lets a caller chain this before a commit. It exited zero
  // once with findings on the screen, and the commit went through anyway.
  process.exitCode = 1;
}
