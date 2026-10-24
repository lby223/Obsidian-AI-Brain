---
name: obsidian-ai-brain
description: Give an AI agent a persistent cross-session memory backed by an Obsidian vault. Use when an agent should stop forgetting between sessions — remembering environment facts, past mistakes with their exact error text, decisions and their rationale, and reusable approaches. Triggers on "remember this", "知识库/记忆库", "下次别再犯", setting up an AI knowledge base, or when a task ends and something is worth writing down for future sessions. Also covers the "should I even write this?" judgment gate, so the vault stays small and high-signal instead of turning into a log dump.
---

# Obsidian AI Brain

Most "AI memory" setups fail the same way twice: they either write everything down until the store is garbage, or they never write anything and the agent re-learns the same lesson every session.

This skill installs the structure that avoids both, and the rule that decides which one you are doing right now.

## The one-sentence version

> **Write it down only if it can migrate.**

Ask: *will the me in a session three months from now benefit from this?* If yes, write. If the honest answer is "that's just what happened this turn," don't. An empty turn is a normal turn.

## Directory layout

The vault is the memory. Every number is a job, not a category.

```
<vault>/
├── 0.导读.md            ← entry point: who writes what
├── 1.项目/              ← AI writes: active work with deliverables
│   └── 项目索引.md       ← the cross-project table (the only place projects connect)
├── 2.领域/              ← AI writes: cross-session conclusions  ← read here first
├── 3.自我/              ← who the user is: preferences, habits, vocabulary
├── 4.AI手册/            ← AI writes: the rules for AI (AI操作手册.md)
├── 5.日记/              ← USER only: daily notes
├── 6.资料/              ← AI writes: 模板/ 附件/ 参考/
└── 9.归档/              ← AI writes: finished/inactive, append-only
    └── 备份/
```

`3.自我/` and `5.日记/` are the most sensitive folders. You may read them, and `3.自我/` is yours to maintain — but only write what the user actually said or what you can point at as evidence, and state the basis in the note. Preferences you inferred from vibes pollute every later session.

## What gets written

Four types, and only four. Each one is testable.

| Type | Must contain | Failure mode it prevents |
|---|---|---|
| **Pitfalls** | the literal error text + root cause + the fix | Next session greps for the error and finds nothing |
| **Environment facts** | where things live, versions, the counter-intuitive part ("not in A, in B") | Re-deriving the same paths |
| **Decisions** | what was chosen **and why** | A decision without its reason is unreadable in six months |
| **Reusable approaches** | the method, and how to transplant it | Solving the same class of problem from scratch |

Everything else stays out: step-by-step process narration, one-off debugging, general knowledge (that's what search is for), the user's own words (that's what the diary is for), drafts of your own reasoning, status updates.

**The error text is the load-bearing part.** A pitfall note that says "had a problem with encoding" is worth nothing; the next session greps for `UnicodeDecodeError: 'gbk' codec can't decode byte`. Paste the message.

## Writing so it stays cheap to read

The point of a small vault is that a session can afford to load it. Three rules carry most of the weight:

1. **Conclusion in the first 8 lines.** Every note opens with `> **一句话结论**：…` — a session reads that line and knows whether to keep going, without loading the body.
2. **Real search terms in the title.** `Obsidian库迁移到Windows的坑.md`, not `笔记1.md`. Whatever you would type into search belongs in the filename and headings.
3. **Under 2KB per note.** Past that, split it and link the halves with `[[wiki links]]`.

If you have to read more than 3 notes to answer one question, the writing was wrong — go merge them.

## The read path

Before answering a question that might be in memory:

1. `4.AI手册/AI操作手册.md` — the rules themselves
2. `3.自我/` if it exists — the user's standing preferences
3. Search `2.领域/` first, then `1.项目/` — conclusions before history
4. `1.项目/项目索引.md` — when the question spans projects

**Search before answering.** Memory you half-remember is worse than memory you check: it comes back subtly wrong and the user cannot tell. If the search misses, say "not in the vault" plainly. Do not fill the gap with plausible invention — an invented memory is indistinguishable from a real one next time you read it.

## The write path

Before writing anything: **search for an existing note on the topic.** If one exists, add to it. Duplicate notes are the specific failure that kills these vaults — two half-truths on the same subject, and no later session can tell which to trust.

Then:

- One note, one subject. Two subjects means two notes plus a `[[link]]`.
- Frontmatter every time: `title`, `type` (one of `note | 项目 | 日记 | 复盘`), `date`, `tags`.
- Wiki-links point at concrete things (a project, a tool, a conclusion). Tags carry state or class (`#待验证`, `#复盘`, `#工具`). Don't do both for the same thing.
- Back up before overwriting: `9.归档/备份/<name>.bak-<timestamp>`.
- Never silently delete a note that has content. Only two things may be deleted: empty files (no body), and byte-identical duplicates of another note. Deprecate everything else by moving to `9.归档/`.
- **Credentials never go in.** Recording that a token exists is fine; recording its value is not. These vaults get synced, backed up, and screenshotted.

## Session boundaries

**Opening** — this is the part agents skip and then fail at. Reading the manual is what turns "generic assistant" into "assistant who knows this project."

**Closing** — run the migration question once, honestly. Then *stop*. Manufacturing a note to look productive is worse than writing nothing: it teaches the next session to skim, because the signal-to-noise is bad.

If the user says "记住这个" / "remember this," write it regardless of the rules — explicit requests override the gate.

## Install

Installing takes two independent steps — the vault structure, then the skill itself. Doing only the first changes nothing about agent behaviour.

**Step 1 — build the vault structure.** From the repo root:

```bash
python skills/obsidian-ai-brain/scripts/install.py --vault "C:/path/to/YourVault" --dry-run   # plan only
python skills/obsidian-ai-brain/scripts/install.py --vault "C:/path/to/YourVault" --agents-md
```

It is idempotent: it creates the numbered folders, writes the starter notes only where nothing exists, and never overwrites an existing note (it backs up instead). `--vault` must be a path you have already created — the script does not invent one, so it cannot collide with an existing vault.

`--agents-md` appends a memory section to `~/.dsh/AGENTS.md` (or `--agents-path` for another agent convention, e.g. `~/.codex/AGENTS.md`). **Without it, the skill alone does nothing** — the rules only run if the agent reads them every session.

**Step 2 — put the skill where the agent finds it:**

```bash
cp -r skills/obsidian-ai-brain ~/.dsh/skills/
```

Verify: the skill name should appear in the agent's available-skills list in a new session. There is no UI, no toggle, and no version row — a skill is a folder the agent reads, not a plugin.

If a user asks "it installed but nothing happened," check those two steps in that order, and check that nothing was nested one level too deep (`skills/obsidian-ai-brain/SKILL.md` is correct).

## Making it automatic

A skill is read because the agent decides to read it. That is the soft link in the chain. If "the agent remembers" needs to be a property of the system rather than of the agent's diligence, that requires a scheduled job that scans the day's sessions and extracts; a skill cannot do it.

The honest positioning: **this gives the agent a good place to put memory and a sharp rule for what belongs there.** It does not guarantee the agent reads it, and it does not write for you.
