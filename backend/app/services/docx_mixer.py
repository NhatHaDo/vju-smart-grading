"""
Trộn đề giữ nguyên định dạng Word (2026-09-30).

The text mixer (exam_mixer.version_docx) writes a brand-new document from the
question TEXT, so MathType formulas, pictures, tables and fonts are lost — a
Toán/Lý/Hóa đề comes out with empty options. This module instead opens the
teacher's own .docx and rearranges ITS paragraphs for each mã đề:

  - questions are put in the version's order, part by part, and renumbered
    ("Câu 3." / "3." — the file's own style);
  - a trắc nghiệm question's options are moved into their new A/B/C/D slots,
    keeping the line layout (4 on a line, 2 + 2, one per line…);
  - answer marks are removed (red/underlined letters, an option coloured as a
    whole) and "Đáp án: …" lines, "<gN>" lines and section headings between
    questions are dropped, so the đề students get shows no answer;
  - the title/instructions before the first question and a "HẾT" line at the
    end are kept; "Mã đề: …" is added at the top.

Everything else (formula objects, drawings, runs' fonts) is moved as-is, inside
the same package, so the images/OLE parts they reference stay valid.

Where things are comes from question_io.parse_docx_layout: per question the
body elements it spans and, per option line, the character offsets of each
option's separator / label / content. Offsets count the text of the
paragraph's direct <w:r> runs exactly like python-docx's paragraph.runs, so
parse and mix agree.
"""
from __future__ import annotations

import copy
import io

from app.services.question_io import LETTERS, QTYPES, parse_docx_layout

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_R, _RPR, _PPR, _T = _W + "r", _W + "rPr", _W + "pPr", _W + "t"
_TEXT_TAGS = {_W + "t", _W + "tab", _W + "br", _W + "cr", _W + "noBreakHyphen", _W + "ptab"}


class DocxMixError(ValueError):
    pass


# ── Runs and text offsets ────────────────────────────────────────────────────

def _item_len(el) -> int:
    return len(str(el)) if el.tag in _TEXT_TAGS else 0


def _run_len(r) -> int:
    return sum(_item_len(c) for c in r if c.tag != _RPR)


def _new_run_like(r):
    """An empty run with the same formatting as r."""
    n = r.makeelement(_R, r.attrib)
    rpr = r.find(_RPR)
    if rpr is not None:
        n.append(copy.deepcopy(rpr))
    return n


def _split_run(r, off: int) -> None:
    """Split run r at text offset off (0 < off < len): r keeps [0, off), a new
    run inserted right after it gets the rest (and any non-text item there)."""
    tail = _new_run_like(r)
    pos = 0
    for c in [c for c in r if c.tag != _RPR]:
        n = _item_len(c)
        if pos >= off:
            tail.append(c)                       # moves c out of r
        elif pos + n > off:                      # a <w:t> straddling the split
            text = c.text or ""
            k = off - pos
            c.text = text[:k]
            t2 = c.makeelement(_T, {})
            t2.text = text[k:]
            t2.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            c.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            tail.append(t2)
        pos += n
    r.addnext(tail)


def _has_item_after_text(r) -> bool:
    """A formula/picture sitting in the same run right after its text ("11. ⟨obj⟩")."""
    items = [c for c in r if c.tag != _RPR]
    last_text = max((i for i, c in enumerate(items) if _item_len(c)), default=-1)
    return any(not _item_len(c) for c in items[last_text + 1:])


def _cut_at(p, offsets) -> None:
    """Make every offset fall between two runs of paragraph p — including a
    formula/picture that shares a run with the text just before the offset,
    so replacing "11. " or "B. " never takes the formula with it."""
    for off in sorted(set(offsets)):
        pos = 0
        for r in list(p.iterchildren(_R)):
            n = _run_len(r)
            if pos < off < pos + n or (n and off == pos + n and _has_item_after_text(r)):
                _split_run(r, off - pos)
                break
            pos += n


def _children_with_pos(p):
    """(child, start, length) for every child of p but pPr — only direct runs
    carry text; hyperlinks, oMath, bookmarks… count as zero-length."""
    out, pos = [], 0
    for c in p:
        if c.tag == _PPR:
            continue
        n = _run_len(c) if c.tag == _R else 0
        out.append((c, pos, n))
        pos += n
    return out


def _segments(p, spans):
    """Split p's children into named segments. spans = [(name, start, end,
    is_content)] covering the paragraph text in order. A zero-length item
    (formula, picture run) at a border goes to the content next to it, so a
    formula right after "B. " or right before the next tab stays with its option."""
    _cut_at(p, [s for _, s, _, _ in spans] + [e for _, _, e, _ in spans])
    got = {name: [] for name, *_ in spans}
    last = spans[-1][0]
    for c, pos, n in _children_with_pos(p):
        target = None
        if n:
            target = next((name for name, s, e, _ in spans if s <= pos < e), last)
        else:
            target = next((name for name, s, e, content in spans if content and s <= pos <= e), None) \
                or next((name for name, s, e, _ in spans if s <= pos < e), last)
        got[target].append(c)
    return got


def _text_of(items) -> str:
    return "".join(str(x) for r in items if r.tag == _R for x in r if x.tag in _TEXT_TAGS)


# ── Answer marks ─────────────────────────────────────────────────────────────

def _is_red_hex(val: str | None) -> bool:
    try:
        r, g, b = int(val[0:2], 16), int(val[2:4], 16), int(val[4:6], 16)
    except (TypeError, ValueError):
        return False
    return r >= 0xB0 and g <= 0x60 and b <= 0x60


def _unmark(items) -> None:
    """Remove what marks an answer: red colour, underline, highlight."""
    for it in items:
        for rpr in it.iter(_RPR):
            for tag in ("u", "highlight"):
                for e in rpr.findall(_W + tag):
                    rpr.remove(e)
            for e in rpr.findall(_W + "color"):
                if _is_red_hex(e.get(_W + "val")):
                    rpr.remove(e)


def _label_run(template_items, text: str):
    """A run showing `text` with the formatting of the original label's first run."""
    base = next((i for i in template_items if i.tag == _R), None)
    if base is None:
        raise DocxMixError("option label without a run")
    r = _new_run_like(base)
    t = r.makeelement(_T, {})
    t.text = text
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    r.append(t)
    _unmark([r])
    return r


def _keepers(items) -> list:
    """What must survive when a label/number is rewritten: formulas, pictures,
    anything that isn't plain text."""
    return [c for c in items if c.tag != _R or not _run_len(c)]


def _replace_start(p, end: int, text: str) -> None:
    """Replace the paragraph's first `end` characters (the "Câu 12." number)."""
    got = _segments(p, [("num", 0, end, False), ("rest", end, 10 ** 9, True)])
    old = [c for c in got["num"] if c.tag == _R and _run_len(c)]
    if not old:
        return
    new = _label_run(old, text)
    old[0].addprevious(new)
    for c in old:
        p.remove(c)


# ── One question ─────────────────────────────────────────────────────────────

def _rebuild_options(children, src: dict, perm: list[int] | None, lower: bool) -> list:
    """Move options into their new slots (perm[k] = original option shown at
    position k; None = keep the order) and unmark them. Returns the elements
    of the question in output order."""
    slots = src["slots"]
    marked = set(src.get("body_marked") or [])
    parts: dict[int, dict] = {}          # original option index → its label/content items
    layouts = []                          # per slot line: its paragraph, prefix, and per position its sep/label
    for slot in slots:
        p = children[slot["bi"]]
        spans = [("prefix", 0, slot["prefix_end"], False)]
        for o in slot["opts"]:
            i = o["index"]
            spans += [(f"sep{i}", o["sep"], o["label"], False), (f"label{i}", o["label"], o["content"], False),
                      (f"content{i}", o["content"], o["end"], True)]
        got = _segments(p, spans)
        layouts.append((p, got["prefix"], [(o["index"], got[f"sep{o['index']}"], got[f"label{o['index']}"])
                                            for o in slot["opts"]]))
        for o in slot["opts"]:
            i = o["index"]
            label = got[f"label{i}"]
            # a formula caught inside "B. " goes with the option, not with the old label
            parts[i] = {"label": [c for c in label if c not in _keepers(label)],
                        "content": _keepers(label) + got[f"content{i}"]}
            _unmark(parts[i]["label"])
            if i in marked:
                _unmark(parts[i]["content"])

    order = perm if perm is not None else sorted(parts)
    extras = src.get("extra") or {}
    moved_extras = any(extras.get(str(i)) or extras.get(i) for i in parts) and order != sorted(parts)

    def label_text(pos: int, template) -> str:
        orig = _text_of(template).lstrip("#")
        punct = orig[1:2] or "."
        trail = orig[2:] or " "
        letter = LETTERS[pos].lower() if lower else LETTERS[pos]
        return f"{letter}{punct}{trail}"

    if not moved_extras:
        # Same lines, same number of options per line — just refill them.
        pos = 0
        for p, prefix, slots_here in layouts:
            for c in [c for c in p if c.tag != _PPR]:
                p.remove(c)
            for c in prefix:
                p.append(c)
            for _, sep, label in slots_here:
                for c in sep:
                    p.append(c)
                p.append(_label_run(label, label_text(pos, label)))
                for c in parts[order[pos]]["content"]:
                    p.append(c)
                pos += 1
        return None

    # An option spans several paragraphs: one option per line, its extra
    # paragraphs right under it.
    first_p = layouts[0][0]
    new_ps = []
    for pos, i in enumerate(order):
        np_ = first_p.makeelement(first_p.tag, first_p.attrib)
        ppr = first_p.find(_PPR)
        if ppr is not None:
            np_.append(copy.deepcopy(ppr))
        np_.append(_label_run(parts[i]["label"], label_text(pos, parts[i]["label"])))
        for c in parts[i]["content"]:
            np_.append(c)
        new_ps.append(np_)
        for bi in extras.get(str(i)) or extras.get(i) or []:
            new_ps.append(children[bi])
    return new_ps


def _question_elements(children, src: dict, number: str, perm: list[int] | None) -> list:
    drop = set(src.get("drop") or [])
    kind = src.get("qtype")
    if kind in ("mcq", "tf") and src["slots"]:
        replaced = _rebuild_options(children, src, perm if kind == "mcq" else None, lower=(kind == "tf"))
    else:
        replaced = None
    # Only the number itself ("11."), not the spaces after it: a formula may sit
    # between those spaces ("11. ⟨obj⟩ xác định…").
    core = len(src["number"].rstrip())
    _replace_start(children[src["qline"]], core, number.rstrip())

    if replaced is None:
        return [children[i] for i in src["elems"] if i not in drop]
    slot_bis = {s["bi"] for s in src["slots"]}
    extra_bis = {bi for v in (src.get("extra") or {}).values() for bi in v}
    first, last = min(slot_bis), max(slot_bis)
    before = [children[i] for i in src["elems"] if i < first and i not in drop]
    after = [children[i] for i in src["elems"] if i > last and i not in drop and i not in extra_bis]
    return before + replaced + after


# ── Whole đề ─────────────────────────────────────────────────────────────────

def _is_section_heading(el) -> bool:
    from app.services.question_io import _DOCX_SECTION
    if el.tag != _W + "p":
        return False
    text = "".join(str(x) for r in el.iterchildren(_R) for x in r if x.tag in _TEXT_TAGS)
    return bool(_DOCX_SECTION.match(text))


def version_docx_keep_format(source: bytes, code: str, plan: list[dict]) -> bytes:
    """The mã đề `code` built from the teacher's own file. plan = the version's
    questions in order: [{"src": question index in parse_docx_layout,
    "qtype": …, "perm": [original option per position] | None}]."""
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    questions, _, layout = parse_docx_layout(source, allow_unanswered=True)
    if not questions:
        raise DocxMixError("no question in the source file")
    doc = Document(io.BytesIO(source))
    body = doc.element.body
    children = list(body.iterchildren())
    sect = children[-1] if children and children[-1].tag == _W + "sectPr" else None

    by_index = {q.src_index: q for q in questions}
    prefix_end = layout.get("prefix_end") or 0
    # Title and instructions stay; section headings ("A. PHẦN ĐẠI SỐ",
    # "I/ CĂN THỨC") don't — the mixed questions no longer follow them.
    out = [c for c in children[:prefix_end] if c is not sect and not _is_section_heading(c)]

    head = doc.add_paragraph()
    head.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = head.add_run(f"Mã đề: {code}")
    # same font as the question text, so it doesn't stand out in Word's default font
    q0 = by_index.get(plan[0]["src"]) if plan else None
    base = next(iter(children[q0.src["qline"]].iterchildren(_R)), None) if q0 and q0.src else None
    if base is not None and base.find(_RPR) is not None:
        run._r.insert(0, copy.deepcopy(base.find(_RPR)))
        _unmark([run._r])
    run.bold = True
    out.append(head._p)

    headings = {}
    for bi, qt in layout.get("parts") or []:
        headings.setdefault(qt, children[bi])
    for qt in QTYPES:
        items = [it for it in plan if it["qtype"] == qt]
        if not items:
            continue
        if qt in headings:
            out.append(headings[qt])
        for n, it in enumerate(items, start=1):
            q = by_index.get(it["src"])
            if q is None or q.src is None:
                raise DocxMixError(f"question {it['src']} not found in the source file")
            style = q.src["number"].strip()
            number = f"Câu {n}. " if not style[:1].isdigit() else f"{n}. "
            out.extend(_question_elements(children, q.src, number, it.get("perm")))

    if layout.get("footer") is not None:
        out.extend(c for c in children[layout["footer"]:] if c is not sect and c is not head._p)

    for c in list(body):
        if c is not sect:
            body.remove(c)
    for c in out:
        if sect is not None:
            sect.addprevious(c)
        else:
            body.append(c)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
