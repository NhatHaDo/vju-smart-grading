"""
Answer sheets a bộ đề can be mixed for (2026-10-05).

"t muốn dropdown cái này … cái này có nhiều mẫu phiếu lắm mà": Trộn đề used
to offer only Mẫu 40 (VJU) and Phiếu Bộ GD, both hard-wired to 40 trắc
nghiệm / 8 Đúng/Sai / 6 trả lời ngắn. Now every answer sheet in the system
(the shared ones + the teacher's own custom templates) can be picked, and
what a bộ đề may hold is read from the sheet itself:
  - trắc nghiệm: its A/B/C/D… answer fields, in sheet order (and the fewest
    bubbles any of them has = most options a câu may have);
  - Đúng/Sai: its Đ/S fields, 4 per câu (ý a–d);
  - trả lời ngắn: its composite (dấu / dấu phẩy / chữ số) fields;
  - mã đề: the digit columns of its "Mã đề" field (none → only 1 mã đề).
The same field keys are what grading reads, so the answer key of each mã đề
is written straight into them (grading_key).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy.orm import Session

from app.models.template import Template

TF_OPTIONS = {"Đ", "S"}
_MA_DE = re.compile(r"m[ãa]\s*đ[ềe]", re.IGNORECASE)


@dataclass
class SheetLayout:
    id:          int
    name:        str
    mcq:         list[str] = field(default_factory=list)   # answer-field keys, câu 1, 2, …
    mcq_options: int = 4
    tf:          list[str] = field(default_factory=list)   # 4 keys per câu (ý a–d)
    short:       list[str] = field(default_factory=list)
    code_digits: int | None = None                          # columns of the Mã đề field

    @property
    def limits(self) -> dict[str, int]:
        return {"mcq": len(self.mcq), "tf": len(self.tf) // 4, "short": len(self.short)}

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "limits": self.limits,
                "mcq_options": self.mcq_options, "code_digits": self.code_digits}


def _load(path: str | None) -> object:
    if not path or not Path(path).exists():
        return None
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return None


def _code_digits(areas: list[dict]) -> int | None:
    for a in areas:
        if a.get("type") != "omr" or a.get("includeInAnswerKey", True) or a.get("compositeGroup"):
            continue
        if a.get("blockName") in ("made", "ma_de") or _MA_DE.search(a.get("label") or ""):
            cols = a.get("physicalCols")
            return int(cols) if cols else None
    return None


def layout_of(t: Template, name: str | None = None) -> SheetLayout | None:
    """What a bộ đề on this sheet may hold; None if the sheet has no answer field."""
    return _layout(t.id, name or t.name, t.file_path, t.areas_path)


def _layout(tid: int, name: str, template_path: object, areas_path: object) -> SheetLayout | None:
    from app.core.templates.template_compiler import extract_answer_fields_from_template

    compiled, areas = _load(template_path), _load(areas_path)
    if not isinstance(compiled, dict) or not isinstance(areas, list):
        return None
    lay = SheetLayout(id=tid, name=name, code_digits=_code_digits(areas))
    mcq_opts = []
    for f in extract_answer_fields_from_template(compiled, areas):
        opts = f.get("options") or []
        if f.get("composite"):
            lay.short.append(f["key"])
        elif opts and set(opts) <= TF_OPTIONS:
            lay.tf.append(f["key"])
        elif len(opts) >= 2 and all(len(o) == 1 and o.isalpha() and o.isupper() for o in opts):
            lay.mcq.append(f["key"])
            mcq_opts.append(len(opts))
    lay.tf = lay.tf[: len(lay.tf) // 4 * 4]
    lay.mcq_options = min(mcq_opts) if mcq_opts else 4
    if not (lay.mcq or lay.tf or lay.short):
        return None
    return lay


# Shown names of the shared sheets (their template names are long)
PINNED_NAMES = {"mau40": "Phiếu Mẫu 40 câu (VJU)", "bgd": "Phiếu Bộ GD"}


def _pinned(db: Session) -> dict[str, Template]:
    from app.services.shared_templates import find_bgd, find_mau40
    out = {}
    for key, t in (("mau40", find_mau40(db)), ("bgd", find_bgd(db))):
        if t is not None:
            out[key] = t
    return out


def default_sheet_id(db: Session) -> int | None:
    t = _pinned(db).get("mau40")
    return t.id if t else None


def resolve_sheet_id(db: Session, sheet: object) -> int | None:
    """A bộ đề's stored sheet as a template id. Bộ đề mixed before 2026-10-05
    stored "mau40" / "bgd" (or nothing = Mẫu 40)."""
    if isinstance(sheet, int) or (isinstance(sheet, str) and sheet.isdigit()):
        return int(sheet)
    t = _pinned(db).get(sheet if sheet in PINNED_NAMES else "mau40")
    return t.id if t else None


def list_layouts(db: Session, user_id: int | None) -> list[SheetLayout]:
    """The shared sheets first, then the teacher's own custom templates."""
    out: list[SheetLayout] = []
    seen: set[int] = set()
    for key, t in _pinned(db).items():
        lay = layout_of(t, PINNED_NAMES[key])
        if lay:
            out.append(lay)
            seen.add(t.id)
    own = (db.query(Template)
           .filter(Template.type == "custom", Template.owner_user_id == user_id, Template.is_active.is_(True))
           .order_by(Template.updated_at.desc()).all())
    for t in own:
        if t.id in seen:
            continue
        lay = layout_of(t)
        if lay:
            out.append(lay)
    return out


def get_layout(db: Session, sheet: object, user_id: int | None = None, check_access: bool = False) -> SheetLayout | None:
    tid = resolve_sheet_id(db, sheet)
    t = db.get(Template, tid) if tid is not None else None
    if tid is None and (sheet is None or sheet == "mau40"):
        # a database without the shared Mẫu 40 row yet (fresh/test): read
        # its shipped files, so mixing for Mẫu 40 works as before
        from app.services.shared_templates import MAU40_SRC_AREAS, MAU40_SRC_TPL
        return _layout(0, PINNED_NAMES["mau40"], MAU40_SRC_TPL, MAU40_SRC_AREAS)
    if t is None or t.type != "custom":
        return None
    if check_access and not (t.is_default or t.owner_user_id == user_id
                             or t.id in {p.id for p in _pinned(db).values()}):
        return None
    name = next((PINNED_NAMES[k] for k, p in _pinned(db).items() if p.id == t.id), None)
    return layout_of(t, name)
