"use strict";

// Compile high-tier project rules to a managed block in <repo>/AGENTS.md.
// One-way write: we never read user-authored content back into the DB.
// The managed block is delimited so existing AGENTS.md content survives
// untouched. If AGENTS.md doesn't exist we create one with the block only.

const fs = require("fs");
const path = require("path");
const { listRules } = require("./rules.cjs");

const BEGIN = "<!-- BEGIN teamagent rules — do not edit by hand, managed by Stop hook -->";
const END = "<!-- END teamagent rules -->";

// Default policy: which tiers ship to AGENTS.md and how many.
const DEFAULT_OPTS = {
  // Wilson floor below which a rule never compiles, even if its tier is high.
  minWilson: 0.65,
  // Tier whitelist — only these compile.
  tiers: new Set(["canonical", "canonical+"]),
  // Hard cap so an over-eager DB doesn't blow up AGENTS.md.
  maxRules: 20,
};

function escapeMd(s) {
  return String(s || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

// Render a single rule as a markdown bullet. Wilson is rounded to 2dp.
function renderRule(r) {
  const w = (typeof r.wilson_lower === "number" ? r.wilson_lower : 0).toFixed(2);
  return `- **[${r.tier}]** ${escapeMd(r.wrong)} → **${escapeMd(r.correct)}** _(${escapeMd(r.why)}, wilson ${w}, id \`${r.id}\`)_`;
}

// Build the body of the managed block from a rules array. Caller is
// responsible for filtering/sorting; this just renders.
function renderBlock(rules, opts = {}) {
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const lines = [
    BEGIN,
    "",
    "## TeamAgent rules (auto-compiled)",
    "",
    `_Generated ${generatedAt} from \`.teamagent/knowledge.db\`. Don't edit this block by hand — changes are overwritten on Stop. To suppress a rule, run \`teamagent classify ... b --condition "..."\` or demote it via the override prompt._`,
    "",
  ];
  if (rules.length === 0) {
    lines.push("_(No rules meet the threshold yet — rules graduate to this list at tier `canonical` with wilson ≥ 0.65.)_");
  } else {
    for (const r of rules) lines.push(renderRule(r));
  }
  lines.push("", END);
  return lines.join("\n");
}

// Pick the subset of rules that should compile, sorted for stable output.
function pickRules(allRules, opts = {}) {
  const merged = { ...DEFAULT_OPTS, ...opts };
  const tiers = merged.tiers instanceof Set ? merged.tiers : new Set(merged.tiers);
  return allRules
    .filter(r => r && r.tier && tiers.has(r.tier))
    .filter(r => typeof r.wilson_lower === "number" && r.wilson_lower >= merged.minWilson)
    .sort((a, b) => {
      // canonical+ above canonical, then wilson desc, then id for stability
      const ta = a.tier === "canonical+" ? 0 : 1;
      const tb = b.tier === "canonical+" ? 0 : 1;
      if (ta !== tb) return ta - tb;
      if (a.wilson_lower !== b.wilson_lower) return b.wilson_lower - a.wilson_lower;
      return String(a.id).localeCompare(String(b.id));
    })
    .slice(0, merged.maxRules);
}

// Splice the managed block into the file. Existing block is replaced
// in place; if no markers exist, the block is appended (with a blank
// line separator). Returns the new file content.
function spliceBlock(existing, block) {
  if (typeof existing !== "string" || existing.length === 0) {
    return block + "\n";
  }
  const beginIdx = existing.indexOf(BEGIN);
  const endIdx = existing.indexOf(END);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + END.length);
    // Preserve a clean newline boundary on each side.
    const left = before.endsWith("\n") || before.length === 0 ? before : before + "\n";
    const right = after.startsWith("\n") || after.length === 0 ? after : "\n" + after;
    return left + block + right;
  }
  // No markers — append with a separator if the file has content.
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block + "\n";
}

// Read AGENTS.md (if any), splice in the new managed block, write back.
// Returns { path, ruleCount, changed, skipped? }. `changed` is false if
// the new content is byte-identical to the old. We skip the write entirely
// when there are no rules to ship AND no existing managed block exists —
// no point creating a placeholder-only AGENTS.md before any rule graduates.
function writeAgentsMd(repoRoot, rules, opts = {}) {
  if (!repoRoot || typeof repoRoot !== "string") throw new Error("repoRoot required");
  const target = path.join(repoRoot, opts.filename || "AGENTS.md");
  let prev = "";
  try { prev = fs.readFileSync(target, "utf8"); } catch (_e) { prev = ""; }
  const hasExistingBlock = typeof prev === "string" && prev.indexOf(BEGIN) !== -1;
  if (rules.length === 0 && !hasExistingBlock) {
    return { path: target, ruleCount: 0, changed: false, skipped: "no_rules_no_existing_block" };
  }
  const block = renderBlock(rules, opts);
  const next = spliceBlock(prev, block);
  if (next === prev) {
    return { path: target, ruleCount: rules.length, changed: false };
  }
  fs.writeFileSync(target, next, "utf8");
  return { path: target, ruleCount: rules.length, changed: true };
}

// One-shot orchestration used by the Stop hook and the CLI. Reads project
// rules from `db`, picks the compile set, and writes the managed block.
function compileFromDb(db, repoRoot, opts = {}) {
  if (!db) return { path: null, ruleCount: 0, changed: false, skipped: "no_db" };
  if (!repoRoot) return { path: null, ruleCount: 0, changed: false, skipped: "no_repo_root" };
  const all = listRules(db, { scope: "project", limit: 1000 });
  const picks = pickRules(all, opts);
  return writeAgentsMd(repoRoot, picks, opts);
}

module.exports = {
  BEGIN, END, DEFAULT_OPTS,
  renderRule, renderBlock, pickRules, spliceBlock,
  writeAgentsMd, compileFromDb,
};
