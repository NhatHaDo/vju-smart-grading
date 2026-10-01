"""
Shared ("pinned") custom templates that every environment must have.

2026-09-29: the frontend used to hard-code the DB id of "Mẫu 40 câu TN +
Đúng/Sai" (2 = production's id). On any other database — a fresh dev clone,
a new server — the template either didn't exist at all or got a different
id, so the Upload / Answer Key pages showed "Không tải được cấu trúc custom
template" and 0 questions. Now:
  - init_db() installs the template automatically when it's missing
    (ensure_shared_templates), so a fresh clone works with no manual script;
  - the frontend asks GET /custom-forms/pinned for the id instead of
    guessing (find_pinned_template_ids).

Identity is the compiled file name ("40tn_dungsai"), the same way omr.py
already recognises this template — not the numeric id and not the display
name, which an admin can rename.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from sqlalchemy.orm import Session

from app.models.template import Template

_log = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent
SRC_DIR     = BACKEND_DIR / "data" / "shared_templates"
DEST_DIR    = BACKEND_DIR / "data" / "custom_forms"

MAU40_NAME   = "Mẫu 40 câu TN + Đúng/Sai"
MAU40_MARKER = "40tn_dungsai"   # also used by omr.py to pick signature detection
MAU40_SRC_TPL,  MAU40_SRC_AREAS  = SRC_DIR / "sheet_40tn_dungsai.template.json",  SRC_DIR / "sheet_40tn_dungsai.areas.json"
MAU40_DEST_TPL, MAU40_DEST_AREAS = DEST_DIR / "shared_40tn_dungsai.template.json", DEST_DIR / "shared_40tn_dungsai.areas.json"


def find_mau40(db: Session) -> Template | None:
    """The oldest custom template that is Mẫu 40 — matched by its file name,
    falling back to its name (rows created before the file naming existed)."""
    for t in db.query(Template).filter(Template.type == "custom").order_by(Template.id):
        if MAU40_MARKER in (t.file_path or ""):
            return t
    return (db.query(Template)
            .filter(Template.type == "custom", Template.name == MAU40_NAME)
            .order_by(Template.id).first())


def find_pinned_template_ids(db: Session) -> dict[str, int | None]:
    t = find_mau40(db)
    return {"mau40": t.id if t else None}


def install_mau40(db: Session, update_existing: bool = True) -> tuple[Template, bool]:
    """Copy the committed compiled files into data/custom_forms and upsert the
    DB row (shared: is_default=True). Returns (template, created)."""
    if not MAU40_SRC_TPL.exists() or not MAU40_SRC_AREAS.exists():
        raise FileNotFoundError(f"Thiếu file nguồn trong {SRC_DIR}")

    existing = find_mau40(db)
    if existing is not None and not update_existing:
        return existing, False

    DEST_DIR.mkdir(parents=True, exist_ok=True)
    MAU40_DEST_TPL.write_text(MAU40_SRC_TPL.read_text(encoding="utf-8"), encoding="utf-8")
    MAU40_DEST_AREAS.write_text(MAU40_SRC_AREAS.read_text(encoding="utf-8"), encoding="utf-8")
    compiled = json.loads(MAU40_DEST_TPL.read_text(encoding="utf-8"))
    page_w, page_h = (compiled.get("pageDimensions") or [1000, 1414])[:2]

    if existing is None:
        tpl = Template(
            name=MAU40_NAME, type="custom", version="1.0",
            file_path=str(MAU40_DEST_TPL), areas_path=str(MAU40_DEST_AREAS),
            page_width=page_w, page_height=page_h,
            owner_user_id=None,   # shared — not tied to one account
            is_default=True,
        )
        db.add(tpl)
        db.commit()
        db.refresh(tpl)
        return tpl, True

    existing.file_path   = str(MAU40_DEST_TPL)
    existing.areas_path  = str(MAU40_DEST_AREAS)
    existing.page_width  = page_w
    existing.page_height = page_h
    existing.is_default  = True
    db.commit()
    return existing, False


def ensure_shared_templates(db: Session) -> None:
    """Called at startup: install Mẫu 40 only if this DB doesn't have it yet.
    An existing row (e.g. production's) is never modified here."""
    try:
        tpl, created = install_mau40(db, update_existing=False)
        if created:
            _log.info("[SEED] Installed shared template %r (id=%d)", MAU40_NAME, tpl.id)
    except Exception as exc:   # never block startup over this
        db.rollback()
        _log.warning("[SEED] Could not install shared template %r: %s", MAU40_NAME, exc)


def mau40_short_labels(db: Session) -> list[str]:
    """Answer-key labels of the 6 Phần IV (trả lời ngắn, signed-decimal) questions of Mẫu 40,
    in sheet order — the composite group id of each, as used by the grader
    (see extract_answer_fields_from_template's compositeAnswerFields)."""
    tpl = find_mau40(db)
    path = Path(tpl.areas_path) if tpl and tpl.areas_path else MAU40_DEST_AREAS
    if not path.exists():
        path = MAU40_SRC_AREAS
    areas = json.loads(path.read_text(encoding="utf-8"))
    labels: list[str] = []
    for a in areas:
        group = a.get("compositeGroup")
        if group and group not in labels:
            labels.append(group)
    return labels
