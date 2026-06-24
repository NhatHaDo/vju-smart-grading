from sqlalchemy.orm import Session

from app.models.sheet import Sheet


class SheetRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_id(self, sheet_id: int) -> Sheet | None:
        return self.db.get(Sheet, sheet_id)

    def list_by_exam(self, exam_id: int, skip: int = 0, limit: int = 200) -> list[Sheet]:
        return (
            self.db.query(Sheet)
            .filter(Sheet.exam_id == exam_id)
            .order_by(Sheet.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

    def list_needs_review(self, exam_id: int) -> list[Sheet]:
        return (
            self.db.query(Sheet)
            .filter(Sheet.exam_id == exam_id, Sheet.needs_review.is_(True))
            .all()
        )

    def create(self, exam_id: int, file_path: str, **kwargs) -> Sheet:
        sheet = Sheet(exam_id=exam_id, file_path=file_path, **kwargs)
        self.db.add(sheet)
        self.db.commit()
        self.db.refresh(sheet)
        return sheet

    def update(self, sheet: Sheet, **kwargs) -> Sheet:
        for key, value in kwargs.items():
            if hasattr(sheet, key):
                setattr(sheet, key, value)
        self.db.commit()
        self.db.refresh(sheet)
        return sheet

    def delete(self, sheet: Sheet) -> None:
        self.db.delete(sheet)
        self.db.commit()

    def count_by_exam(self, exam_id: int) -> int:
        return self.db.query(Sheet).filter(Sheet.exam_id == exam_id).count()
