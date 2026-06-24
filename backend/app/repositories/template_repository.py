from sqlalchemy.orm import Session

from app.models.template import Template


class TemplateRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_id(self, template_id: int) -> Template | None:
        return self.db.get(Template, template_id)

    def list_active(self, skip: int = 0, limit: int = 50) -> list[Template]:
        return (
            self.db.query(Template)
            .filter(Template.is_active.is_(True))
            .order_by(Template.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

    def list_all(self, skip: int = 0, limit: int = 50) -> list[Template]:
        return self.db.query(Template).order_by(Template.created_at.desc()).offset(skip).limit(limit).all()

    def list_custom_by_owner(self, owner_user_id: int, skip: int = 0, limit: int = 100) -> list[Template]:
        """Return active custom templates owned by user (type='custom')."""
        return (
            self.db.query(Template)
            .filter(
                Template.type == "custom",
                Template.owner_user_id == owner_user_id,
                Template.is_active.is_(True),
            )
            .order_by(Template.updated_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

    def get_custom_by_id_and_owner(self, template_id: int, owner_user_id: int) -> Template | None:
        return (
            self.db.query(Template)
            .filter(
                Template.id == template_id,
                Template.type == "custom",
                Template.owner_user_id == owner_user_id,
            )
            .first()
        )

    def create(self, name: str, type: str = "vju_sbd8", **kwargs) -> Template:
        tpl = Template(name=name, type=type, **kwargs)
        self.db.add(tpl)
        self.db.commit()
        self.db.refresh(tpl)
        return tpl

    def update(self, tpl: Template, **kwargs) -> Template:
        for key, value in kwargs.items():
            if value is not None and hasattr(tpl, key):
                setattr(tpl, key, value)
        self.db.commit()
        self.db.refresh(tpl)
        return tpl

    def delete(self, tpl: Template) -> None:
        self.db.delete(tpl)
        self.db.commit()
