from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.security.permissions import get_current_user, require_roles
from app.database import get_db
from app.models.user import User
from app.schemas.template_schema import TemplateCreate, TemplateOut, TemplateUpdate
from app.services.template_service import TemplateService

router = APIRouter(prefix="/templates", tags=["templates"])


@router.get("", response_model=list[TemplateOut])
def list_templates(
    active_only: bool = True,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return TemplateService(db).list_templates(active_only=active_only)


@router.post("", response_model=TemplateOut, status_code=201)
def create_template(
    body: TemplateCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles("admin")),
):
    return TemplateService(db).create_template(**body.model_dump(exclude_none=True))


@router.get("/{template_id}", response_model=TemplateOut)
def get_template(
    template_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return TemplateService(db).get_or_404(template_id)


@router.put("/{template_id}", response_model=TemplateOut)
def update_template(
    template_id: int,
    body: TemplateUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles("admin")),
):
    return TemplateService(db).update_template(
        template_id, **body.model_dump(exclude_none=True)
    )


@router.delete("/{template_id}", status_code=204)
def delete_template(
    template_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles("admin")),
):
    TemplateService(db).delete_template(template_id)
