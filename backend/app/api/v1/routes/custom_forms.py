"""
routes/custom_forms.py
======================
Custom template CRUD + compile + preview-grid API.

Endpoints:
    GET    /api/v1/custom-forms              — list user's custom forms
    GET    /api/v1/custom-forms/{id}         — get areas + compiled template
    PUT    /api/v1/custom-forms/compile      — compile areas → template, save to DB + file
    POST   /api/v1/custom-forms/preview-grid — return bubble grid for a single area
    PUT    /api/v1/custom-forms/{id}/rename  — rename
    DELETE /api/v1/custom-forms/{id}         — delete
    POST   /api/v1/custom-forms/{id}/duplicate — clone
"""

from __future__ import annotations

import base64
import io
import json
import re
import shutil
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
from fastapi import APIRouter, Body, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.security.permissions import get_current_user
from app.core.omr.crop_on_markers import crop_on_markers
from app.core.omr.preprocessor import crop_page, resize_to_template
from app.core.templates.template_compiler import (
    CompileError,
    DEFAULT_PAGE_SIZE,
    build_preview_field_block,
    build_preview_grid_fallback,
    compile_template,
    extract_answer_fields_from_template,
)
from app.database import get_db
from app.models.user import User
from app.repositories.template_repository import TemplateRepository

router = APIRouter(prefix="/custom-forms", tags=["custom-forms"])

# ── Storage paths ─────────────────────────────────────────────────────────────

_BASE_DIR   = Path(__file__).parent.parent.parent.parent.parent  # backend/
_FORMS_DIR  = _BASE_DIR / "data" / "custom_forms"


def _ensure_forms_dir() -> Path:
    _FORMS_DIR.mkdir(parents=True, exist_ok=True)
    return _FORMS_DIR


# ── Pydantic models ────────────────────────────────────────────────────────────

class CompileRequest(BaseModel):
    name:              str
    pageDimensions:    list[int] = list(DEFAULT_PAGE_SIZE)
    areas:             list[dict] = []
    use_crop_on_markers: bool = False
    template_id:       int | None = None  # When set, update this template by ID (edit mode)


class RenameRequest(BaseModel):
    name: str


class PreviewGridRequest(BaseModel):
    area:           dict
    pageDimensions: list[int] = list(DEFAULT_PAGE_SIZE)


class CustomFormOut(BaseModel):
    id:             int
    name:           str
    type:           str
    page_width:     int | None
    page_height:    int | None
    area_count:     int
    is_active:      bool
    is_default:     bool
    created_at:     datetime
    updated_at:     datetime


# ── Helpers ────────────────────────────────────────────────────────────────────

def _safe_id(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "_", value or "").strip("_") or "form"


def _get_owned_or_404(template_id: int, user: User, repo: TemplateRepository):
    tpl = repo.get_custom_by_id_and_owner(template_id, user.id)
    if tpl is None:
        raise HTTPException(404, "Không tìm thấy custom template")
    return tpl


def _extract_info_fields(areas: list[dict]) -> list[dict]:
    """Return non-answer (INT info) fields from an areas list."""
    result = []
    for area in areas:
        if area.get("type") != "omr":
            continue
        if area.get("includeInAnswerKey", True):
            continue  # answer field — skip
        result.append({
            "key":         area.get("blockName", ""),
            "displayName": area.get("label") or area.get("blockName", ""),
            "fieldType":   area.get("fieldType", "QTYPE_INT"),
        })
    return result


def _area_count_from_path(areas_path: str | None) -> int:
    if not areas_path:
        return 0
    p = Path(areas_path)
    if not p.exists():
        return 0
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return len(data) if isinstance(data, list) else 0
    except Exception:
        return 0


def _to_out(tpl) -> dict:
    return {
        "id":           tpl.id,
        "name":         tpl.name,
        "type":         tpl.type,
        "page_width":   tpl.page_width,
        "page_height":  tpl.page_height,
        "area_count":   _area_count_from_path(tpl.areas_path),
        "is_active":    tpl.is_active,
        "is_default":   tpl.is_default,
        "created_at":   tpl.created_at.isoformat(),
        "updated_at":   tpl.updated_at.isoformat(),
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("")
def list_custom_forms(
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_user),
):
    """List all active custom templates owned by the current user."""
    repo  = TemplateRepository(db)
    forms = repo.list_custom_by_owner(user.id)
    return {"forms": [_to_out(f) for f in forms]}


@router.get("/{template_id}")
def get_custom_form(
    template_id: int,
    db:          Session = Depends(get_db),
    user:        User    = Depends(get_current_user),
):
    """Return areas + compiled template for a custom form."""
    tpl = _get_owned_or_404(template_id, user, TemplateRepository(db))

    areas: list = []
    if tpl.areas_path and Path(tpl.areas_path).exists():
        try:
            areas = json.loads(Path(tpl.areas_path).read_text(encoding="utf-8"))
        except Exception:
            areas = []

    compiled: dict = {}
    if tpl.file_path and Path(tpl.file_path).exists():
        try:
            compiled = json.loads(Path(tpl.file_path).read_text(encoding="utf-8"))
        except Exception:
            compiled = {}

    answer_fields = extract_answer_fields_from_template(compiled, areas)
    info_fields   = _extract_info_fields(areas)

    return {
        "id":            tpl.id,
        "name":          tpl.name,
        "page_width":    tpl.page_width,
        "page_height":   tpl.page_height,
        "areas":         areas,
        "template":      compiled,
        "answerFields":  answer_fields,
        "infoFields":    info_fields,
        "updated_at":    tpl.updated_at.isoformat(),
    }


@router.put("/compile")
def compile_custom_form(
    payload: CompileRequest,
    db:      Session = Depends(get_db),
    user:    User    = Depends(get_current_user),
):
    """
    Compile areas → template JSON, persist to disk + DB.
    Creates a new DB row if name is new; updates in-place if same name/user already exists.
    """
    page_dims = payload.pageDimensions
    if len(page_dims) < 2:
        raise HTTPException(400, "pageDimensions phải là [width, height]")

    try:
        compiled = compile_template(
            payload.areas,
            page_dimensions=(page_dims[0], page_dims[1]),
            use_crop_on_markers=payload.use_crop_on_markers,
        )
    except CompileError as exc:
        raise HTTPException(400, {"message": "Compile thất bại", "errors": exc.errors})

    forms_dir = _ensure_forms_dir()
    # Derive stable file ID from user + name
    form_slug  = _safe_id(f"u{user.id}_{payload.name}")
    tpl_path   = forms_dir / f"{form_slug}.template.json"
    areas_path = forms_dir / f"{form_slug}.areas.json"

    tpl_path.write_text(json.dumps(compiled, indent=2, ensure_ascii=False), encoding="utf-8")
    areas_path.write_text(json.dumps(payload.areas, indent=2, ensure_ascii=False), encoding="utf-8")

    # Upsert DB row
    repo = TemplateRepository(db)

    if payload.template_id is not None:
        # Edit mode: update by ID (prevents creating duplicates when editing)
        match = repo.get_custom_by_id_and_owner(payload.template_id, user.id)
        if match:
            tpl = repo.update(
                match,
                name=payload.name,
                file_path=str(tpl_path),
                areas_path=str(areas_path),
                page_width=page_dims[0],
                page_height=page_dims[1],
            )
        else:
            raise HTTPException(404, "Không tìm thấy template để cập nhật")
    else:
        # Create mode: upsert by name (existing behavior)
        existing = repo.list_custom_by_owner(user.id)
        match = next((t for t in existing if t.name == payload.name), None)
        if match:
            tpl = repo.update(
                match,
                file_path=str(tpl_path),
                areas_path=str(areas_path),
                page_width=page_dims[0],
                page_height=page_dims[1],
            )
        else:
            tpl = repo.create(
                name=payload.name,
                type="custom",
                version="1.0",
                file_path=str(tpl_path),
                areas_path=str(areas_path),
                page_width=page_dims[0],
                page_height=page_dims[1],
                owner_user_id=user.id,
                is_default=False,
            )

    answer_fields = extract_answer_fields_from_template(compiled, payload.areas)

    return {
        "id":           tpl.id,
        "name":         tpl.name,
        "template":     compiled,
        "answerFields": answer_fields,
        "file_path":    str(tpl_path),
        "areas_path":   str(areas_path),
    }


@router.post("/align-image")
async def align_image_for_picker(
    file: UploadFile = File(...),
    _:    None        = Depends(get_current_user),
):
    """
    Preprocess an uploaded image exactly as the OMR engine would before reading:
      CropOnMarkers (VJU corner markers) → CropPage fallback → resize to DEFAULT_PAGE_SIZE.

    Returns the aligned JPEG as base64 so the coordinate picker can pick
    coordinates in the correct grading space (1000 × 1414).

    The frontend MUST use this preprocessed image — NOT the raw upload — to
    ensure template coordinates match the space the engine reads at.
    """
    ALIGN_SIZE = list(DEFAULT_PAGE_SIZE)   # [1000, 1414]

    # ── Decode uploaded file ─────────────────────────────────────────────
    raw_bytes = await file.read()
    arr = np.frombuffer(raw_bytes, np.uint8)
    raw = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    if raw is None:
        raise HTTPException(400, "Không đọc được ảnh — hãy dùng JPEG/PNG")

    # ── Step 1: CropOnMarkers (no custom marker centers; legacy auto-detect) ─
    mr = crop_on_markers(
        raw,
        target_size=(ALIGN_SIZE[0], ALIGN_SIZE[1]),
        debug=False,
        marker_centers_in_template=None,
        # Use default quality gate (0.45) — same as engine's auto mode
    )

    if mr.success and mr.warp_used and mr.image is not None:
        aligned = mr.image
        method  = "markers"
    else:
        # ── Step 2: CropPage fallback ────────────────────────────────────
        cp = crop_page(raw)
        if cp.success and cp.image is not None:
            aligned = cp.image
            method  = "croppage"
        else:
            # ── Step 3: No crop — just use raw ───────────────────────────
            aligned = raw
            method  = "none"

    # ── Step 4: Resize to standard template size ─────────────────────────
    aligned = resize_to_template(aligned, ALIGN_SIZE)

    # ── Encode as JPEG base64 ────────────────────────────────────────────
    ok, buf = cv2.imencode(".jpg", aligned, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not ok:
        raise HTTPException(500, "Lỗi encode ảnh")

    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    return {
        "image":          b64,
        "mime":           "image/jpeg",
        "width":          ALIGN_SIZE[0],
        "height":         ALIGN_SIZE[1],
        "align_method":   method,
        "pageDimensions": ALIGN_SIZE,
    }


@router.post("/preview-grid")
def preview_grid(
    payload: PreviewGridRequest,
    _:       User    = Depends(get_current_user),
):
    """
    Compute bubble grid coordinates for a single area dict.
    Used by the frontend to render live bubble preview while editing.
    """
    page_dims = payload.pageDimensions
    if len(page_dims) < 2:
        raise HTTPException(400, "pageDimensions phải là [width, height]")
    page_w, page_h = int(page_dims[0]), int(page_dims[1])

    try:
        block_name, field_block, warnings = build_preview_field_block(payload.area)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    return build_preview_grid_fallback(block_name, field_block, page_w, page_h, warnings)


@router.put("/{template_id}/rename")
def rename_custom_form(
    template_id: int,
    payload:     RenameRequest,
    db:          Session = Depends(get_db),
    user:        User    = Depends(get_current_user),
):
    new_name = payload.name.strip()
    if not new_name:
        raise HTTPException(400, "Tên không được để trống")

    repo = TemplateRepository(db)
    tpl  = _get_owned_or_404(template_id, user, repo)
    tpl  = repo.update(tpl, name=new_name)
    return _to_out(tpl)


@router.delete("/{template_id}")
def delete_custom_form(
    template_id: int,
    db:          Session = Depends(get_db),
    user:        User    = Depends(get_current_user),
):
    repo = TemplateRepository(db)
    tpl  = _get_owned_or_404(template_id, user, repo)

    if tpl.is_default:
        raise HTTPException(403, "Không thể xoá template mặc định")

    # Delete files on disk
    for path_attr in ("file_path", "areas_path"):
        p = getattr(tpl, path_attr, None)
        if p:
            try:
                Path(p).unlink(missing_ok=True)
            except Exception:
                pass

    repo.delete(tpl)
    return {"status": "ok", "id": template_id}


@router.post("/{template_id}/duplicate")
def duplicate_custom_form(
    template_id: int,
    db:          Session = Depends(get_db),
    user:        User    = Depends(get_current_user),
):
    repo = TemplateRepository(db)
    tpl  = _get_owned_or_404(template_id, user, repo)

    forms_dir = _ensure_forms_dir()
    ts        = datetime.now().strftime("%Y%m%d_%H%M%S")
    new_name  = f"{tpl.name} (bản sao {ts})"
    new_slug  = _safe_id(f"u{user.id}_{new_name}")
    new_tpl_path   = forms_dir / f"{new_slug}.template.json"
    new_areas_path = forms_dir / f"{new_slug}.areas.json"

    if tpl.file_path and Path(tpl.file_path).exists():
        shutil.copy2(tpl.file_path, new_tpl_path)
    if tpl.areas_path and Path(tpl.areas_path).exists():
        shutil.copy2(tpl.areas_path, new_areas_path)

    new_tpl = repo.create(
        name=new_name,
        type="custom",
        version=tpl.version or "1.0",
        file_path=str(new_tpl_path) if new_tpl_path.exists() else None,
        areas_path=str(new_areas_path) if new_areas_path.exists() else None,
        page_width=tpl.page_width,
        page_height=tpl.page_height,
        owner_user_id=user.id,
        is_default=False,
    )

    return _to_out(new_tpl)
