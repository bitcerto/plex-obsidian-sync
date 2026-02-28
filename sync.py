#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "Dependencia ausente: PyYAML. Rode: pip install -r scripts/plex-obsidian-sync/requirements.txt"
    ) from exc

try:
    from plexapi.server import PlexServer
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "Dependencia ausente: plexapi. Rode: pip install -r scripts/plex-obsidian-sync/requirements.txt"
    ) from exc


MANAGED_KEYS = [
    "plex_rating_key",
    "plex_guid",
    "biblioteca",
    "tipo",
    "titulo",
    "titulo_original",
    "ano",
    "assistido",
    "ultima_visualizacao_plex",
    "atualizado_plex_em",
    "sincronizado_em",
    "sincronizado_por",
]

SYNC_FIELDS = {"sincronizado_em", "sincronizado_por"}


@dataclass
class Config:
    plex_base_url: str
    plex_token: str
    vault_dir: Path
    notes_subdir: Path
    state_file: Path | None
    libraries: list[str]
    loop: bool
    interval_seconds: int
    dry_run: bool
    conflict_policy: str


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def to_iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat()
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc).replace(microsecond=0).isoformat()
    if isinstance(value, str):
        return value
    return str(value)


def to_epoch(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value or "")
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    lowered = ascii_only.lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "-", lowered).strip("-")
    return slug or "item"


def parse_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "y", "sim", "s"}:
            return True
        if normalized in {"false", "0", "no", "n", "nao"}:
            return False
    return default


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.DOTALL)
    if not match:
        return {}, text
    raw_yaml = match.group(1)
    body = match.group(2)
    loaded = yaml.safe_load(raw_yaml) if raw_yaml.strip() else {}
    if not isinstance(loaded, dict):
        loaded = {}
    return loaded, body


def render_markdown(frontmatter: dict[str, Any], body: str) -> str:
    yaml_content = yaml.safe_dump(frontmatter, allow_unicode=True, sort_keys=False).strip()
    normalized_body = body.lstrip("\n")
    if normalized_body and not normalized_body.endswith("\n"):
        normalized_body = normalized_body + "\n"
    if normalized_body:
        return f"---\n{yaml_content}\n---\n\n{normalized_body}"
    return f"---\n{yaml_content}\n---\n"


def read_note(path: Path) -> tuple[dict[str, Any], str]:
    content = path.read_text(encoding="utf-8")
    return parse_frontmatter(content)


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def file_mtime_epoch(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except FileNotFoundError:
        return 0.0


class PlexObsidianSync:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.notes_root = (config.vault_dir / config.notes_subdir).resolve()
        ensure_dir(self.notes_root)
        self.state_path = (
            config.state_file.resolve()
            if config.state_file
            else (self.notes_root / ".plex-obsidian-state.json")
        )
        self.server = PlexServer(config.plex_base_url, config.plex_token)
        self.state: dict[str, Any] = self._load_state()

    def _load_state(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return {"version": 1, "items": {}}
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            self._log(f"estado corrompido em {self.state_path}, reiniciando")
            return {"version": 1, "items": {}}
        if not isinstance(raw, dict):
            return {"version": 1, "items": {}}
        items = raw.get("items")
        if not isinstance(items, dict):
            items = {}
        raw["version"] = 1
        raw["items"] = items
        return raw

    def _save_state(self) -> None:
        if self.config.dry_run:
            return
        ensure_dir(self.state_path.parent)
        serialized = json.dumps(self.state, ensure_ascii=False, indent=2)
        self.state_path.write_text(serialized + "\n", encoding="utf-8")

    def _log(self, message: str) -> None:
        now = now_utc().strftime("%Y-%m-%d %H:%M:%S")
        print(f"[{now}] {message}")

    def run_once(self) -> None:
        all_items = self._fetch_plex_items()
        previous_items = self.state.get("items", {})
        if not isinstance(previous_items, dict):
            previous_items = {}

        new_items_state: dict[str, Any] = {}
        stats = {
            "created_notes": 0,
            "updated_notes": 0,
            "updated_plex": 0,
            "conflicts": 0,
            "total_items": len(all_items),
        }

        for key, payload in all_items.items():
            item = payload["item"]
            library_name = payload["library"]
            previous = previous_items.get(key, {})
            result = self._sync_single_item(key, item, library_name, previous)
            if result["note_created"]:
                stats["created_notes"] += 1
            if result["note_updated"]:
                stats["updated_notes"] += 1
            if result["plex_updated"]:
                stats["updated_plex"] += 1
            if result["conflict"]:
                stats["conflicts"] += 1
            new_items_state[key] = result["state"]

        self.state = {
            "version": 1,
            "items": new_items_state,
            "last_run_at": to_iso(now_utc()),
        }
        self._save_state()

        self._log(
            "sync concluido: "
            f"itens={stats['total_items']}, "
            f"notas_criadas={stats['created_notes']}, "
            f"notas_atualizadas={stats['updated_notes']}, "
            f"plex_atualizado={stats['updated_plex']}, "
            f"conflitos={stats['conflicts']}"
        )

    def run(self) -> None:
        if not self.config.loop:
            self.run_once()
            return
        self._log(
            f"modo continuo ativo (intervalo={self.config.interval_seconds}s, conflito={self.config.conflict_policy})"
        )
        while True:
            try:
                self.run_once()
            except Exception as exc:  # pragma: no cover
                self._log(f"erro durante sync: {exc}")
            time.sleep(self.config.interval_seconds)

    def _fetch_plex_items(self) -> dict[str, dict[str, Any]]:
        target_sections = self.config.libraries
        available_sections = {section.title: section for section in self.server.library.sections()}

        if not target_sections:
            # Apenas secoes de video para evitar misturar musica/fotos.
            target_sections = [
                section.title
                for section in available_sections.values()
                if section.type in {"movie", "show"}
            ]

        items: dict[str, dict[str, Any]] = {}
        for section_name in target_sections:
            section = available_sections.get(section_name)
            if section is None:
                self._log(f"biblioteca '{section_name}' nao encontrada no Plex, pulando")
                continue
            if section.type not in {"movie", "show"}:
                self._log(
                    f"biblioteca '{section_name}' (tipo={section.type}) nao suportada, pulando"
                )
                continue

            section_items = section.all()
            for item in section_items:
                key = str(item.ratingKey)
                items[key] = {"item": item, "library": section.title}

        return items

    def _sync_single_item(
        self,
        key: str,
        item: Any,
        library_name: str,
        previous_state: dict[str, Any],
    ) -> dict[str, Any]:
        previous_state = previous_state if isinstance(previous_state, dict) else {}
        plex_watched = self._plex_watched(item)

        note_path = self._resolve_note_path(key, item, library_name, previous_state.get("note_path"))
        note_exists = note_path.exists()
        existing_meta: dict[str, Any] = {}
        existing_body = ""
        if note_exists:
            try:
                existing_meta, existing_body = read_note(note_path)
            except Exception as exc:
                self._log(f"falha ao ler nota {note_path}: {exc}")
                existing_meta, existing_body = {}, ""

        obsidian_watched = (
            parse_bool(existing_meta.get("assistido"), plex_watched) if note_exists else plex_watched
        )

        prev_plex_watched = parse_bool(previous_state.get("plex_watched"), plex_watched)
        prev_obsidian_watched = parse_bool(previous_state.get("obsidian_watched"), obsidian_watched)
        has_previous = bool(previous_state)

        plex_changed = has_previous and (plex_watched != prev_plex_watched)
        obsidian_changed = has_previous and note_exists and (obsidian_watched != prev_obsidian_watched)

        note_created = False
        note_updated = False
        plex_updated = False
        conflict = False
        sync_source = "none"

        if not has_previous:
            sync_source = "plex"
        elif plex_changed and not obsidian_changed:
            obsidian_watched = plex_watched
            sync_source = "plex"
        elif obsidian_changed and not plex_changed:
            if obsidian_watched != plex_watched:
                self._set_plex_watched(item, obsidian_watched)
                plex_watched = obsidian_watched
                plex_updated = True
            sync_source = "obsidian"
        elif obsidian_changed and plex_changed and obsidian_watched != plex_watched:
            conflict = True
            winner = self._resolve_conflict(item, note_path)
            if winner == "obsidian":
                self._set_plex_watched(item, obsidian_watched)
                plex_watched = obsidian_watched
                plex_updated = True
                sync_source = "obsidian"
            else:
                obsidian_watched = plex_watched
                sync_source = "plex"
        elif obsidian_changed and plex_changed and obsidian_watched == plex_watched:
            sync_source = "both"

        if not note_exists:
            existing_body = self._default_body(item)
            note_created = True

        final_watched = obsidian_watched if sync_source == "plex" else plex_watched
        managed_meta = self._build_managed_meta(
            key=key,
            item=item,
            library_name=library_name,
            watched_value=final_watched,
            sync_source=sync_source,
            existing_meta=existing_meta,
            note_exists=note_exists,
        )

        merged_meta = self._merge_metadata(existing_meta, managed_meta)
        new_markdown = render_markdown(merged_meta, existing_body)
        previous_markdown = (
            render_markdown(existing_meta, existing_body) if note_exists else ""
        )

        if not note_exists or new_markdown != previous_markdown:
            note_updated = True
            if self.config.dry_run:
                self._log(f"[dry-run] atualizaria nota: {note_path}")
            else:
                ensure_dir(note_path.parent)
                note_path.write_text(new_markdown, encoding="utf-8")

        watched_for_state = parse_bool(merged_meta.get("assistido"), plex_watched)
        state_record = {
            "note_path": str(note_path.relative_to(self.notes_root).as_posix()),
            "plex_watched": plex_watched,
            "obsidian_watched": watched_for_state,
            "last_sync_at": to_iso(now_utc()),
            "last_sync_epoch": time.time(),
        }

        return {
            "state": state_record,
            "note_created": note_created,
            "note_updated": note_updated,
            "plex_updated": plex_updated,
            "conflict": conflict,
        }

    def _resolve_note_path(
        self,
        key: str,
        item: Any,
        library_name: str,
        previous_relative_path: str | None,
    ) -> Path:
        if previous_relative_path:
            candidate = self.notes_root / previous_relative_path
            if candidate.exists():
                return candidate

        library_slug = slugify(library_name)
        title = getattr(item, "title", "") or f"item-{key}"
        filename = f"{slugify(title)}-rk{key}.md"
        return self.notes_root / library_slug / filename

    def _resolve_conflict(self, item: Any, note_path: Path) -> str:
        policy = self.config.conflict_policy
        if policy in {"plex", "obsidian"}:
            return policy

        note_ts = file_mtime_epoch(note_path)
        plex_candidates = [to_epoch(getattr(item, "lastViewedAt", None))]
        plex_candidates.append(to_epoch(getattr(item, "updatedAt", None)))
        plex_ts = max([ts for ts in plex_candidates if ts is not None], default=0.0)
        return "obsidian" if note_ts >= plex_ts else "plex"

    def _set_plex_watched(self, item: Any, watched: bool) -> None:
        if self.config.dry_run:
            self._log(
                f"[dry-run] atualizaria Plex ratingKey={item.ratingKey} assistido={watched}"
            )
            return

        if watched:
            item.markPlayed()
        else:
            item.markUnplayed()
        item.reload()

    def _plex_watched(self, item: Any) -> bool:
        maybe_method = getattr(item, "isPlayed", None)
        if callable(maybe_method):
            try:
                return bool(maybe_method())
            except Exception:
                pass

        maybe_bool = getattr(item, "isPlayed", None)
        if isinstance(maybe_bool, bool):
            return maybe_bool

        view_count = getattr(item, "viewCount", None)
        if isinstance(view_count, int):
            return view_count > 0

        leaf_count = getattr(item, "leafCount", None)
        viewed_leaf_count = getattr(item, "viewedLeafCount", None)
        if isinstance(leaf_count, int) and isinstance(viewed_leaf_count, int) and leaf_count > 0:
            return viewed_leaf_count >= leaf_count

        return False

    def _build_managed_meta(
        self,
        key: str,
        item: Any,
        library_name: str,
        watched_value: bool,
        sync_source: str,
        existing_meta: dict[str, Any],
        note_exists: bool,
    ) -> dict[str, Any]:
        media_type = getattr(item, "type", None) or getattr(item, "TYPE", None)
        managed = {
            "plex_rating_key": key,
            "plex_guid": getattr(item, "guid", None),
            "biblioteca": library_name,
            "tipo": media_type,
            "titulo": getattr(item, "title", None),
            "titulo_original": getattr(item, "originalTitle", None),
            "ano": getattr(item, "year", None),
            "assistido": bool(watched_value),
            "ultima_visualizacao_plex": to_iso(getattr(item, "lastViewedAt", None)),
            "atualizado_plex_em": to_iso(getattr(item, "updatedAt", None)),
        }

        compared_keys = [key_name for key_name in MANAGED_KEYS if key_name not in SYNC_FIELDS]
        has_data_change = False
        for key_name in compared_keys:
            if existing_meta.get(key_name) != managed.get(key_name):
                has_data_change = True
                break

        if (not note_exists) or (sync_source != "none") or has_data_change:
            managed["sincronizado_em"] = to_iso(now_utc())
            managed["sincronizado_por"] = sync_source
        else:
            managed["sincronizado_em"] = existing_meta.get("sincronizado_em")
            managed["sincronizado_por"] = existing_meta.get("sincronizado_por")

        return managed

    def _merge_metadata(
        self, existing: dict[str, Any], managed: dict[str, Any]
    ) -> dict[str, Any]:
        merged: dict[str, Any] = {}

        for key in MANAGED_KEYS:
            value = managed.get(key)
            if value is not None and value != "":
                merged[key] = value

        for key, value in existing.items():
            if key not in MANAGED_KEYS:
                merged[key] = value

        return merged

    def _default_body(self, item: Any) -> str:
        title = getattr(item, "title", "Sem titulo")
        return (
            f"# {title}\n\n"
            "Nota sincronizada automaticamente com Plex.\n\n"
            "Edite o campo `assistido` no frontmatter para enviar alteracoes ao Plex.\n"
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sincroniza biblioteca e status assistido entre Plex e Obsidian."
    )
    parser.add_argument("--plex-url", default=os.getenv("PLEX_BASE_URL", ""))
    parser.add_argument("--plex-token", default=os.getenv("PLEX_TOKEN", ""))
    parser.add_argument("--vault-dir", default=os.getenv("OBSIDIAN_VAULT_DIR", ""))
    parser.add_argument(
        "--notes-dir",
        default=os.getenv("OBSIDIAN_NOTES_SUBDIR", "Media/Plex"),
        help="Subdiretorio dentro do vault para gravar as notas.",
    )
    parser.add_argument(
        "--state-file",
        default=os.getenv("SYNC_STATE_FILE", ""),
        help="Arquivo JSON de estado. Se vazio: <notes-dir>/.plex-obsidian-state.json",
    )
    parser.add_argument(
        "--libraries",
        default=os.getenv("PLEX_LIBRARIES", ""),
        help="Bibliotecas Plex separadas por virgula. Ex: Filmes,Series",
    )
    parser.add_argument(
        "--conflict-policy",
        choices=["plex", "obsidian", "latest"],
        default=os.getenv("SYNC_CONFLICT_POLICY", "plex"),
        help="Empate quando os dois lados mudaram no mesmo ciclo.",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=int(os.getenv("SYNC_INTERVAL_SECONDS", "30")),
        help="Intervalo em segundos para modo continuo.",
    )
    parser.add_argument("--loop", action="store_true", help="Executa sincronizacao continua.")
    parser.add_argument("--dry-run", action="store_true", help="Nao grava alteracoes.")
    return parser.parse_args()


def parse_libraries(raw: str) -> list[str]:
    if not raw.strip():
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def build_config(args: argparse.Namespace) -> Config:
    if not args.plex_url:
        raise SystemExit("Parametro obrigatorio ausente: --plex-url ou PLEX_BASE_URL")
    if not args.plex_token:
        raise SystemExit("Parametro obrigatorio ausente: --plex-token ou PLEX_TOKEN")
    if not args.vault_dir:
        raise SystemExit("Parametro obrigatorio ausente: --vault-dir ou OBSIDIAN_VAULT_DIR")
    if args.interval < 5:
        raise SystemExit("Intervalo minimo recomendado: 5 segundos")

    state_file = Path(args.state_file).expanduser() if args.state_file else None
    return Config(
        plex_base_url=args.plex_url.strip(),
        plex_token=args.plex_token.strip(),
        vault_dir=Path(args.vault_dir).expanduser(),
        notes_subdir=Path(args.notes_dir),
        state_file=state_file,
        libraries=parse_libraries(args.libraries),
        loop=bool(args.loop),
        interval_seconds=int(args.interval),
        dry_run=bool(args.dry_run),
        conflict_policy=args.conflict_policy,
    )


def main() -> None:
    args = parse_args()
    config = build_config(args)
    sync = PlexObsidianSync(config)
    sync.run()


if __name__ == "__main__":
    main()
