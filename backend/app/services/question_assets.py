"""Store and look up question assets (công thức / hình) — see rich_objects.py."""
from __future__ import annotations

import json
import logging

from sqlalchemy.orm import Session

from app.models.question_asset import QuestionAsset
from app.services import rich_objects as ro

logger = logging.getLogger(__name__)


def assets_of(questions) -> dict[str, dict]:
    """Every asset the parsed questions carry, by id."""
    out: dict[str, dict] = {}
    for q in questions:
        out.update(getattr(q, "assets", None) or {})
    return out


def save(db: Session, assets: dict[str, dict]) -> int:
    """Keep the assets not stored yet, and draw the web SVG of any still
    missing one. Returns how many still have no SVG (no LibreOffice)."""
    if not assets:
        return 0
    have = {a.id: a for a in db.query(QuestionAsset).filter(QuestionAsset.id.in_(list(assets))).all()}
    for aid, a in assets.items():
        if aid not in have:
            row = QuestionAsset(id=aid, kind=a["kind"], xml=a["xml"], parts_json=json.dumps(ro.parts_to_json(a["parts"])),
                                w_pt=a["w_pt"] or 0, h_pt=a["h_pt"] or 0)
            db.add(row)
            have[aid] = row
    todo = [assets[aid] for aid, row in have.items() if row.svg is None]
    if todo:
        try:
            svgs = ro.svgs_for(todo)
        except Exception:
            logger.exception("drawing %d formulas failed", len(todo))
            svgs = {}
        for aid, svg in svgs.items():
            have[aid].svg = svg
    db.commit()
    return sum(1 for row in have.values() if row.svg is None)


def render_missing(db: Session, ids) -> int:
    """Draw the web SVG of the given assets that have none yet (stored before
    LibreOffice was there). One LibreOffice run for all; a no-op without it.
    Returns how many are still missing."""
    ids = list(set(ids))
    if not ids:
        return 0
    rows = db.query(QuestionAsset).filter(QuestionAsset.id.in_(ids), QuestionAsset.svg.is_(None)).all()
    if not rows or ro.soffice_path() is None:
        return len(rows)
    assets = load(db, [r.id for r in rows])
    try:
        svgs = ro.svgs_for(list(assets.values()))
    except Exception:
        logger.exception("drawing %d formulas failed", len(rows))
        return len(rows)
    for r in rows:
        if r.id in svgs:
            r.svg = svgs[r.id]
    db.commit()
    return sum(1 for r in rows if r.svg is None)


def load(db: Session, ids) -> dict[str, dict]:
    """Assets by id, as rich_objects wants them (for writing Word files)."""
    ids = list(set(ids))
    if not ids:
        return {}
    rows = db.query(QuestionAsset).filter(QuestionAsset.id.in_(ids)).all()
    return {r.id: {"id": r.id, "kind": r.kind, "xml": r.xml, "parts": ro.parts_from_json(json.loads(r.parts_json or "{}")),
                   "w_pt": r.w_pt, "h_pt": r.h_pt} for r in rows}


def ids_in_questions(items) -> list[str]:
    """Asset ids used by questions / snapshots (anything with .content and .options)."""
    ids: list[str] = []
    for q in items:
        ids += ro.ids_in(q.content)
        for o in q.options or []:
            ids += ro.ids_in(o.get("text", ""))
    return ids


NO_SVG_NOTE = ("Công thức, hình ảnh đã được lưu và vẫn giữ nguyên khi xuất Word, trộn đề; "
               "nhưng máy chủ chưa cài LibreOffice nên chưa hiển thị được trên web")
