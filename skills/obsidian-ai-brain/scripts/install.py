#!/usr/bin/env python3
"""Install the Obsidian AI Brain structure into an existing vault.

Idempotent by design: creates missing folders, writes starter notes only where
nothing exists, and backs up (never silently overwrites) a file it is about to
replace. It will not create the vault itself -- the path must already exist, so
this can never collide with a vault the user already has.

    python install.py --vault "C:/path/to/YourVault"
    python install.py --vault "C:/path/to/YourVault" --agents-md
    python install.py --vault "C:/path/to/YourVault" --dry-run
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import shutil
import sys
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "assets" / "vault"

FOLDERS = [
    "1.项目",
    "1.项目/归档",
    "2.领域",
    "7.探索",
    "3.自我",
    "4.AI手册",
    "5.日记",
    "6.资料",
    "6.资料/模板",
    "6.资料/附件",
    "6.资料/参考",
    "社交人格",
    "9.归档",
    "9.归档/备份",
]

# asset path (relative to assets/vault) -> vault path
NOTES = {
    "0.导读.md": "0.导读.md",
    "1.项目/项目索引.md": "1.项目/项目索引.md",
    "4.AI手册/AI操作手册.md": "4.AI手册/AI操作手册.md",
    "6.资料/模板/笔记模板.md": "6.资料/模板/笔记模板.md",
    "6.资料/模板/每日模板.md": "6.资料/模板/每日模板.md",
    "社交人格/人设.md": "社交人格/人设.md",
    "社交人格/观察笔记模板.md": "社交人格/观察笔记模板.md",
}

# Files we own and may refresh when the template is newer; everything else is
# written once and left alone.
REFRESHABLE = {"4.AI手册/AI操作手册.md", "6.资料/模板/笔记模板.md", "6.资料/模板/每日模板.md"}

AGENTS_SECTION = """
## 外接大脑（知识库）

用户有一个 Obsidian 知识库 `{vault}`，定位是 **给 AI 用的持久记忆**。规则见
`{vault}/4.AI手册/AI操作手册.md`，所有会话开工前先读那一份。

- **接手与知识库相关的工作前**：先读 `4.AI手册/AI操作手册.md`，再读 `1.项目/项目索引.md`，
  按话题搜 `2.领域/` 和 `1.项目/`。
- **每轮任务完成时自动判断要不要落盘**，不值得写就不写。判定标准：**能不能迁移**——
  下个项目、下次会话会不会因为这条受益。只收四类：带报错原文的坑、环境与路径事实、
  决策与理由、可复用的做法/工具/思路。
- **不写**：过程流水账、一次性调试、通用常识、用户原话复制、进展汇报。
- **省算力**：每篇前 8 行内写 `> **一句话结论**：…`；单篇 2KB 以内；标题放真实检索词。
- **不写敏感信息**：密钥、token、密码的值不进库。
- `3.自我/` 归用户，AI 不擅自写；`5.日记/` 也是用户写。
"""


def _say(action: str, path: Path, dry: bool) -> None:
    print(f"  [{'plan' if dry else action}] {path}")


def _backup(vault: Path, path: Path, stamp: str, dry: bool) -> None:
    """Copy an about-to-be-modified file into <vault>/9.归档/备份/."""
    backup_dir = vault / "9.归档" / "备份"
    dest = backup_dir / f"{path.name}.bak-{stamp}"
    if dry:
        _say("backup", dest, dry)
        return
    backup_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)
    _say("backup", dest, dry)


def _read_json(path: Path) -> dict:
    """Parse JSON tolerating a UTF-8 BOM and UTF-16 (PowerShell redirects)."""
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "utf-16"):
        try:
            return json.loads(raw.decode(enc))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
    raise ValueError("unparsable json")


def install_vault(vault: Path, dry: bool) -> tuple[int, int, int]:
    created = skipped = replaced = 0

    for rel in FOLDERS:
        target = vault / rel
        if target.is_dir():
            continue
        if not dry:
            target.mkdir(parents=True, exist_ok=True)
        _say("mkdir", target, dry)
        created += 1

    stamp = _dt.datetime.now().strftime("%Y%m%d%H%M%S")
    today = _dt.date.today().isoformat()

    for src_rel, dst_rel in NOTES.items():
        src = ASSETS / src_rel
        dst = vault / dst_rel
        if not src.is_file():
            print(f"  [warn] 模板缺失，跳过: {src}")
            continue
        body = src.read_text(encoding="utf-8").replace("{{DATE}}", today)

        if dst.is_file():
            old = dst.read_text(encoding="utf-8", errors="replace")
            same = old.replace("\r\n", "\n").strip() == body.replace("\r\n", "\n").strip()
            if same:
                _say("skip", dst, dry)
                skipped += 1
                continue
            # The user (or a previous agent) edited it -- keep their version.
            _say("skip (已存在且内容不同，保留原文件)", dst, dry)
            skipped += 1
            continue

        if not dry:
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(body, encoding="utf-8", newline="\n")
        _say("create", dst, dry)
        created += 1

    _ = replaced
    return created, skipped, replaced


def install_agents_md(vault: Path, agents_path: Path, dry: bool) -> None:
    marker = "## 外接大脑（知识库）"
    existing = agents_path.read_text(encoding="utf-8") if agents_path.is_file() else ""
    if marker in existing:
        print(f"  [skip] {agents_path} 已有知识库一节，未改动")
        return
    block = AGENTS_SECTION.format(vault=str(vault).replace("\\", "/"))
    if not dry:
        agents_path.parent.mkdir(parents=True, exist_ok=True)
        with agents_path.open("a", encoding="utf-8", newline="\n") as fh:
            if existing and not existing.endswith("\n"):
                fh.write("\n")
            fh.write(block)
    _say("append", agents_path, dry)


def configure_obsidian(vault: Path, dry: bool) -> None:
    """Write the Obsidian settings that make the layout work. Never touches user keys."""
    obs = vault / ".obsidian"
    if not obs.is_dir():
        print(f"  [skip] 未发现 {obs}（这个库还没被 Obsidian 打开过？）")
        return

    stamp = _dt.datetime.now().strftime("%Y%m%d%H%M%S")

    def patch(name: str, updates: dict) -> None:
        path = obs / name
        if path.is_file():
            try:
                data = _read_json(path)
            except ValueError:
                print(f"  [warn] {name} 解析失败（不是 JSON 或损坏），跳过")
                return
            if not isinstance(data, dict):
                print(f"  [warn] {name} 顶层不是对象，跳过")
                return
        else:
            data = {}
        changed = {k: v for k, v in updates.items() if data.get(k) != v}
        if not changed:
            _say("skip", path, dry)
            return
        if path.is_file():
            _backup(vault, path, stamp, dry)
        data.update(changed)
        if not dry:
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8", newline="\n")
        _say("patch", path, dry)

    patch("app.json", {
        "attachmentFolderPath": "6.资料/附件",
        "alwaysUpdateLinks": True,
        "newFileLocation": "root",
        "userIgnoreFilters": ["9.归档/备份/"],
    })
    patch("daily-notes.json", {
        "folder": "5.日记",
        "format": "YYYY-MM-DD",
        "template": "6.资料/模板/每日模板.md",
    })
    patch("templates.json", {"folder": "6.资料/模板"})


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="把 Obsidian AI Brain 的目录结构与规则装进一个已存在的库")
    ap.add_argument("--vault", required=True, help="已存在的 Obsidian 库路径")
    ap.add_argument("--agents-md", action="store_true", help="同时把记忆规则追加到 agent 配置")
    ap.add_argument("--agents-path", default=None, help="AGENTS.md 落点，默认 ~/.dsh/AGENTS.md")
    ap.add_argument("--skip-obsidian-config", action="store_true", help="不改 .obsidian 配置")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不落盘")
    args = ap.parse_args(argv)

    vault = Path(args.vault).expanduser().resolve()
    if not vault.is_dir():
        print(f"错误：库目录不存在：{vault}")
        print("这个脚本不会自建库目录——请先在 Obsidian 里建库，或手动创建该目录。")
        return 2

    print(f"库：{vault}")
    if args.dry_run:
        print("（dry-run，不写任何文件）")

    created, skipped, _ = install_vault(vault, args.dry_run)

    if not args.skip_obsidian_config:
        print("\nObsidian 配置：")
        configure_obsidian(vault, args.dry_run)

    if args.agents_md:
        print("\nAgent 配置：")
        target = Path(args.agents_path).expanduser() if args.agents_path else Path.home() / ".dsh" / "AGENTS.md"
        install_agents_md(vault, target, args.dry_run)

    print(f"\n完成：新建 {created} 项，跳过 {skipped} 项")
    print("下一步：打开 Obsidian，确认 0.导读 能正常显示；把本 skill 装进 agent 的 skills 目录。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
