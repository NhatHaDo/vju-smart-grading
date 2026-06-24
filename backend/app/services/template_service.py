from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.template import Template
from app.repositories.template_repository import TemplateRepository


class TemplateService:
    def __init__(self, db: Session) -> None:
        self.repo = TemplateRepository(db)

    def get_or_404(self, template_id: int) -> Template:
        tpl = self.repo.get_by_id(template_id)
        if not tpl:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Không tìm thấy template")
        return tpl

    def list_templates(self, active_only: bool = True) -> list[Template]:
        return self.repo.list_active() if active_only else self.repo.list_all()

    def create_template(self, **kwargs) -> Template:
        name = kwargs.pop("name")
        return self.repo.create(name=name, **kwargs)

    def update_template(self, template_id: int, **kwargs) -> Template:
        tpl = self.get_or_404(template_id)
        return self.repo.update(tpl, **kwargs)

    def delete_template(self, template_id: int) -> None:
        tpl = self.get_or_404(template_id)
        self.repo.delete(tpl)
