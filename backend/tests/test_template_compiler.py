"""
tests/test_template_compiler.py
================================
Unit tests for app.core.templates.template_compiler.

Covers:
- INT block compile: origin / gap / labels
- MCQ4 block compile: labels / direction
- Duplicate labels → rejected
- Bubble outside page → rejected
- Invalid fieldType → rejected
- Missing blockName → rejected
- autoFit geometry
- extract_answer_fields_from_template
- build_preview_field_block
- build_preview_grid_fallback
"""

import pytest

from app.core.templates.template_compiler import (
    CompileError,
    FIELD_TYPE_VALUES,
    compile_template,
    autofit_geometry_from_box,
    build_preview_field_block,
    build_preview_grid_fallback,
    extract_answer_fields_from_template,
)

# ── Helpers ───────────────────────────────────────────────────────────────────

def _int_area(
    key: str = "SoBaoDanh",
    *,
    origin=(50, 100),
    cols=6,
    labels="sbd1..6",
    bubblesGap=40,
    labelsGap=30,
    bubbleDimensions=(20, 30),
    semantic_type="SBD",
) -> dict:
    return {
        "type": "omr",
        "blockName": key,
        "semanticType": semantic_type,
        "fieldType": "QTYPE_INT",
        "origin": list(origin),
        "physicalRows": 10,
        "physicalCols": cols,
        "fieldLabels": labels,
        "bubblesGap": bubblesGap,
        "labelsGap": labelsGap,
        "bubbleDimensions": list(bubbleDimensions),
    }


def _mcq_area(
    key: str = "Q_Block",
    *,
    origin=(50, 600),
    rows=10,
    labels="q1..10",
    bubblesGap=60,
    labelsGap=50,
    bubbleDimensions=(40, 30),
    semantic_type="MCQ4",
) -> dict:
    return {
        "type": "omr",
        "blockName": key,
        "semanticType": semantic_type,
        "fieldType": "QTYPE_MCQ4",
        "origin": list(origin),
        "physicalRows": rows,
        "physicalCols": 4,
        "fieldLabels": labels,
        "bubblesGap": bubblesGap,
        "labelsGap": labelsGap,
        "bubbleDimensions": list(bubbleDimensions),
    }


PAGE = (1000, 1414)


# ── compile_template: INT block ────────────────────────────────────────────────

class TestCompileIntBlock:
    def test_basic_compile(self):
        area = _int_area()
        tmpl = compile_template([area], PAGE)
        assert "SoBaoDanh" in tmpl["fieldBlocks"]
        block = tmpl["fieldBlocks"]["SoBaoDanh"]
        assert block["origin"] == [50, 100]
        assert block["bubblesGap"] == 40
        assert block["labelsGap"] == 30
        assert block["bubbleDimensions"] == [20, 30]
        assert block["fieldType"] == "QTYPE_INT"

    def test_field_labels_expanded(self):
        area = _int_area(labels="sbd1..6")
        tmpl = compile_template([area], PAGE)
        # raw_field_labels stored as list with range string (OMR engine expands at runtime)
        raw = tmpl["fieldBlocks"]["SoBaoDanh"]["fieldLabels"]
        assert "sbd1..6" in raw or raw == ["sbd1..6"]

    def test_page_dimensions_preserved(self):
        tmpl = compile_template([_int_area()], PAGE)
        assert tmpl["pageDimensions"] == [1000, 1414]

    def test_no_markers_by_default(self):
        tmpl = compile_template([_int_area()], PAGE)
        assert tmpl["use_markers"] is False
        assert tmpl["preProcessors"] == []

    def test_with_markers(self):
        tmpl = compile_template([_int_area()], PAGE, use_crop_on_markers=True)
        assert tmpl["use_markers"] is True
        assert any(p["name"] == "CropOnMarkers" for p in tmpl["preProcessors"])


# ── compile_template: MCQ4 block ───────────────────────────────────────────────

class TestCompileMcq4Block:
    def test_basic_compile(self):
        area = _mcq_area()
        tmpl = compile_template([area], PAGE)
        assert "Q_Block" in tmpl["fieldBlocks"]
        block = tmpl["fieldBlocks"]["Q_Block"]
        assert block["fieldType"] == "QTYPE_MCQ4"
        assert block["origin"] == [50, 600]

    def test_multiple_blocks(self):
        areas = [
            _int_area("SBD", origin=(50, 50), labels="sbd1..6"),
            _mcq_area("MCQ1", origin=(50, 400), labels="q1..10"),
            _mcq_area("MCQ2", origin=(500, 400), labels="q11..20"),
        ]
        tmpl = compile_template(areas, PAGE)
        assert set(tmpl["fieldBlocks"].keys()) == {"SBD", "MCQ1", "MCQ2"}

    def test_direction_horizontal(self):
        area = _mcq_area()
        tmpl = compile_template([area], PAGE)
        # MCQ4 is horizontal — no explicit direction stored in block
        block = tmpl["fieldBlocks"]["Q_Block"]
        assert block.get("direction", None) is None   # direction implicit via fieldType
        assert block["fieldType"] == "QTYPE_MCQ4"


# ── compile_template: validation errors ───────────────────────────────────────

class TestValidationErrors:
    def test_duplicate_labels_rejected(self):
        areas = [
            _mcq_area("MCQ1", origin=(50, 400), labels="q1..10"),
            _mcq_area("MCQ2", origin=(500, 400), labels="q5..14"),   # overlaps q5..q10
        ]
        with pytest.raises(CompileError) as exc_info:
            compile_template(areas, PAGE)
        assert any("trùng" in e for e in exc_info.value.errors)

    def test_duplicate_block_name_rejected(self):
        areas = [
            _mcq_area("MCQ1", origin=(50, 400), labels="q1..10"),
            _mcq_area("MCQ1", origin=(500, 600), labels="q11..20"),
        ]
        with pytest.raises(CompileError) as exc_info:
            compile_template(areas, PAGE)
        assert any("trùng" in e or "blockName" in e for e in exc_info.value.errors)

    def test_invalid_field_type_rejected(self):
        area = _int_area()
        area["fieldType"] = "QTYPE_UNKNOWN"
        area["semanticType"] = ""  # bypass semantic override
        with pytest.raises(CompileError) as exc_info:
            compile_template([area], PAGE)
        assert any("fieldType" in e for e in exc_info.value.errors)

    def test_missing_block_name_rejected(self):
        area = _int_area()
        area["blockName"] = ""
        area["key"] = ""
        with pytest.raises(CompileError) as exc_info:
            compile_template([area], PAGE)
        assert any("blockName" in e or "thiếu" in e for e in exc_info.value.errors)

    def test_origin_outside_page_rejected(self):
        area = _int_area(origin=(999, 1413))   # origin right at edge, block overflows
        with pytest.raises(CompileError) as exc_info:
            compile_template([area], PAGE)
        assert any("ngoài" in e or "overflow" in e for e in exc_info.value.errors)

    def test_bubble_outside_page(self):
        # Origin very close to right edge → block overflows
        area = _int_area(
            origin=(950, 50),
            cols=6,
            labels="sbd1..6",
            bubblesGap=40,
            labelsGap=30,
            bubbleDimensions=(20, 30),
        )
        with pytest.raises(CompileError):
            compile_template([area], PAGE)

    def test_invalid_page_dimensions_rejected(self):
        with pytest.raises(CompileError):
            compile_template([], (0, 1414))
        with pytest.raises(CompileError):
            compile_template([], (1000, -1))

    def test_non_omr_areas_skipped(self):
        areas = [
            {"type": "qr", "blockName": "QR_Code"},
            {"type": "ocr", "blockName": "OCR_Name"},
            _int_area("SBD", origin=(50, 50), labels="sbd1..6"),
        ]
        tmpl = compile_template(areas, PAGE)
        assert "SBD" in tmpl["fieldBlocks"]
        assert "QR_Code" not in tmpl["fieldBlocks"]
        assert "OCR_Name" not in tmpl["fieldBlocks"]

    def test_empty_field_labels_rejected(self):
        area = _int_area(labels="")
        area["semanticType"] = ""  # force manual labels path
        area["autoFit"] = False
        with pytest.raises(CompileError) as exc_info:
            compile_template([area], PAGE)
        assert any("fieldLabels" in e or "rỗng" in e for e in exc_info.value.errors)


# ── autofit_geometry_from_box ──────────────────────────────────────────────────

class TestAutofitGeometry:
    def test_int_vertical(self):
        area = {"box": [100, 100, 300, 600]}
        result = autofit_geometry_from_box(
            area, direction="vertical", field_type="QTYPE_INT",
            physical_rows=10, physical_cols=4,
        )
        assert result["origin"] == [100, 100]
        assert result["physicalRows"] == 10
        assert result["physicalCols"] == 4
        assert result["bubblesGap"] >= 0
        assert result["labelsGap"] >= 0
        assert result["bubbleDimensions"][0] >= 1
        assert result["bubbleDimensions"][1] >= 1

    def test_mcq4_horizontal(self):
        area = {"box": [50, 400, 450, 700]}
        result = autofit_geometry_from_box(
            area, direction="horizontal", field_type="QTYPE_MCQ4",
            physical_rows=10, physical_cols=4,
        )
        assert result["origin"] == [50, 400]
        assert result["bubbleDimensions"][0] >= 1

    def test_missing_box_raises(self):
        with pytest.raises(ValueError, match="box"):
            autofit_geometry_from_box(
                {}, direction="vertical", field_type="QTYPE_INT",
                physical_rows=10, physical_cols=4,
            )


# ── build_preview_field_block ──────────────────────────────────────────────────

class TestBuildPreviewFieldBlock:
    def _base_area(self) -> dict:
        return {
            "blockName": "Q_Block",
            "fieldType": "QTYPE_MCQ4",
            "origin": [100, 200],
            "fieldLabels": ["q1..5"],
            "bubblesGap": 60,
            "labelsGap": 50,
            "bubbleDimensions": [40, 30],
        }

    def test_basic(self):
        block_name, block, warnings = build_preview_field_block(self._base_area())
        assert block_name == "Q_Block"
        assert block["fieldType"] == "QTYPE_MCQ4"
        assert block["origin"] == [100, 200]
        assert block["fieldLabels"] == ["q1..5"]
        assert warnings == []

    def test_missing_origin_raises(self):
        area = self._base_area()
        del area["origin"]
        with pytest.raises(ValueError, match="origin"):
            build_preview_field_block(area)

    def test_empty_field_labels_raises(self):
        area = self._base_area()
        area["fieldLabels"] = []
        with pytest.raises(ValueError, match="fieldLabels"):
            build_preview_field_block(area)

    def test_invalid_field_type_raises(self):
        area = self._base_area()
        area["fieldType"] = "QTYPE_UNKNOWN"
        with pytest.raises(ValueError, match="fieldType"):
            build_preview_field_block(area)

    def test_custom_field_type_no_bubble_values_raises(self):
        area = self._base_area()
        area["fieldType"] = ""
        area["bubbleValues"] = ""
        area["direction"] = "horizontal"
        with pytest.raises(ValueError, match="bubbleValues"):
            build_preview_field_block(area)

    def test_custom_field_type_no_direction_raises(self):
        area = self._base_area()
        area["fieldType"] = ""
        area["bubbleValues"] = "A,B,C"
        area["direction"] = "diagonal"   # invalid
        with pytest.raises(ValueError, match="direction"):
            build_preview_field_block(area)


# ── build_preview_grid_fallback ────────────────────────────────────────────────

class TestBuildPreviewGridFallback:
    def _field_block(self) -> dict:
        return {
            "fieldType": "QTYPE_MCQ4",
            "origin": [50, 100],
            "fieldLabels": ["q1..5"],
            "bubblesGap": 70,
            "labelsGap": 60,
            "bubbleDimensions": [40, 30],
        }

    def test_bubble_count(self):
        fb = self._field_block()
        result = build_preview_grid_fallback("Q_Block", fb, 1000, 1414, [])
        # 5 labels × 4 values = 20 bubbles
        assert len(result["bubbles"]) == 5 * 4

    def test_bubble_keys(self):
        fb = self._field_block()
        result = build_preview_grid_fallback("Q_Block", fb, 1000, 1414, [])
        b = result["bubbles"][0]
        assert {"fieldLabel", "value", "x", "y", "w", "h", "centerX", "centerY"} <= set(b.keys())

    def test_out_of_bounds_warning(self):
        # Put origin very close to edge so bubbles overflow
        fb = self._field_block()
        fb["origin"] = [990, 100]
        warnings: list[str] = []
        result = build_preview_grid_fallback("Q_Block", fb, 1000, 1414, warnings)
        assert any("ngoài" in w for w in result["warnings"])

    def test_block_dimensions(self):
        fb = self._field_block()
        result = build_preview_grid_fallback("Q_Block", fb, 1000, 1414, [])
        block = result["block"]
        assert block["x"] == 50
        assert block["y"] == 100
        assert block["w"] > 0
        assert block["h"] > 0


# ── extract_answer_fields_from_template ────────────────────────────────────────

class TestExtractAnswerFields:
    def _template_with(self, blocks: dict) -> dict:
        return {"pageDimensions": [1000, 1414], "fieldBlocks": blocks}

    def test_mcq_block_included(self):
        tmpl = self._template_with({
            "Q_Block": {
                "fieldType": "QTYPE_MCQ4",
                "fieldLabels": ["q1..5"],
                "origin": [50, 100],
                "bubblesGap": 60, "labelsGap": 50,
                "bubbleDimensions": [40, 30],
            }
        })
        fields = extract_answer_fields_from_template(tmpl)
        assert len(fields) == 5
        assert fields[0]["options"] == ["A", "B", "C", "D"]
        assert fields[0]["key"] == "q1"

    def test_sbd_block_excluded(self):
        areas = [{"blockName": "SoBaoDanh", "semanticType": "SBD"}]
        tmpl = self._template_with({
            "SoBaoDanh": {
                "fieldType": "QTYPE_INT",
                "fieldLabels": ["sbd1..6"],
                "origin": [50, 50],
                "bubblesGap": 40, "labelsGap": 30,
                "bubbleDimensions": [20, 30],
            }
        })
        fields = extract_answer_fields_from_template(tmpl, areas)
        assert fields == []

    def test_int_non_answer_excluded_by_field_type(self):
        # INT block without semanticType but with no includeInAnswerKey override
        tmpl = self._template_with({
            "MyInt": {
                "fieldType": "QTYPE_INT",
                "fieldLabels": ["x1..3"],
                "origin": [50, 50],
                "bubblesGap": 40, "labelsGap": 30,
                "bubbleDimensions": [20, 30],
            }
        })
        fields = extract_answer_fields_from_template(tmpl)
        assert fields == []

    def test_include_in_answer_key_override(self):
        areas = [{"blockName": "MyInt", "includeInAnswerKey": True}]
        tmpl = self._template_with({
            "MyInt": {
                "fieldType": "QTYPE_INT",
                "fieldLabels": ["x1..3"],
                "origin": [50, 50],
                "bubblesGap": 40, "labelsGap": 30,
                "bubbleDimensions": [20, 30],
            }
        })
        fields = extract_answer_fields_from_template(tmpl, areas)
        # composite=True for INT answer blocks
        assert len(fields) == 1
        assert fields[0]["composite"] is True

    def test_mixed_blocks(self):
        areas = [
            {"blockName": "SoBaoDanh", "semanticType": "SBD"},
        ]
        tmpl = self._template_with({
            "SoBaoDanh": {
                "fieldType": "QTYPE_INT",
                "fieldLabels": ["sbd1..6"],
                "origin": [50, 50],
                "bubblesGap": 40, "labelsGap": 30,
                "bubbleDimensions": [20, 30],
            },
            "Q_Block": {
                "fieldType": "QTYPE_MCQ4",
                "fieldLabels": ["q1..10"],
                "origin": [50, 400],
                "bubblesGap": 60, "labelsGap": 50,
                "bubbleDimensions": [40, 30],
            },
        })
        fields = extract_answer_fields_from_template(tmpl, areas)
        assert len(fields) == 10
        keys = [f["key"] for f in fields]
        assert "q1" in keys
        assert "sbd1" not in keys
