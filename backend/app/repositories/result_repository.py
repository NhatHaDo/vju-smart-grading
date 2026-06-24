from sqlalchemy.orm import Session

from app.models.result import GradingResult


class ResultRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_sheet(self, sheet_id: int) -> GradingResult | None:
        return self.db.query(GradingResult).filter(GradingResult.sheet_id == sheet_id).first()

    def list_by_exam(self, exam_id: int) -> list[GradingResult]:
        return self.db.query(GradingResult).filter(GradingResult.exam_id == exam_id).all()

    def create(self, sheet_id: int, exam_id: int, **kwargs) -> GradingResult:
        result = GradingResult(sheet_id=sheet_id, exam_id=exam_id, **kwargs)
        self.db.add(result)
        self.db.commit()
        self.db.refresh(result)
        return result

    def upsert(self, sheet_id: int, exam_id: int, **kwargs) -> GradingResult:
        result = self.get_by_sheet(sheet_id)
        if result:
            for k, v in kwargs.items():
                if hasattr(result, k):
                    setattr(result, k, v)
            self.db.commit()
            self.db.refresh(result)
            return result
        return self.create(sheet_id=sheet_id, exam_id=exam_id, **kwargs)
