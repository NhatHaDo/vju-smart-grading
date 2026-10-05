"""A .txt đề written like the Word one reads exactly like it (anh Tú: ".txt
với .word để cùng định dạng"); a Moodle (Aiken) .txt still reads as before."""
from pathlib import Path

from app.services.question_io import parse_docx, parse_txt

SAMPLES = Path(__file__).resolve().parents[2] / "frontend" / "public" / "samples"


def _rows(qs):
    return [(q.qtype, q.content, [o["text"] for o in q.options], q.answer, q.answer_text,
             [o.get("correct") for o in q.options]) for q in qs]


def test_sample_txt_and_docx_read_the_same():
    txt, wt = parse_txt((SAMPLES / "mau-de.txt").read_text(encoding="utf-8"))
    doc, wd = parse_docx((SAMPLES / "mau-de.docx").read_bytes())
    assert wt == wd == []
    assert _rows(txt) == _rows(doc)
    assert [q.qtype for q in txt] == ["mcq"] * 3 + ["tf"] * 2 + ["short"] * 3
    assert txt[3].options[1]["correct"] is False and txt[7].answer_text == "-1,5"


def test_moodle_aiken_txt_still_reads():
    qs, w = parse_txt("Which is the fastest cache?\nA) L1\nB) L2\nC) L3\nD) L4\nANSWER: A\n")
    assert w == [] and len(qs) == 1 and qs[0].answer == 0 and qs[0].options[1]["text"] == "L2"
