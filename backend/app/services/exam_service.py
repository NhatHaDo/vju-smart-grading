from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.exam import AnswerKey, Exam
from app.repositories.exam_repository import ExamRepository


class ExamService:
    def __init__(self, db: Session) -> None:
        self.repo = ExamRepository(db)

    def get_or_404(self, exam_id: int) -> Exam:
        exam = self.repo.get_by_id(exam_id)
        if not exam:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Không tìm thấy kỳ thi")
        return exam

    def list_exams(self, owner_id: int | None = None, skip: int = 0, limit: int = 100) -> list[Exam]:
        if owner_id is not None:
            return self.repo.list_by_owner(owner_id, skip=skip, limit=limit)
        return self.repo.list_all(skip=skip, limit=limit)

    def create_exam(self, owner_id: int, **kwargs) -> Exam:
        code = kwargs.get("exam_code")
        if code and self.repo.get_by_code(code):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Mã kỳ thi '{code}' đã tồn tại",
            )
        return self.repo.create(owner_id=owner_id, **kwargs)

    def update_exam(self, exam_id: int, actor_id: int, **kwargs) -> Exam:
        exam = self.get_or_404(exam_id)
        return self.repo.update(exam, **kwargs)

    def delete_exam(self, exam_id: int, actor_id: int) -> None:
        exam = self.get_or_404(exam_id)
        self.repo.delete(exam)

    # ── Answer key ──────────────────────────────────────────────────
    def get_answer_key_or_404(self, exam_id: int) -> AnswerKey:
        key = self.repo.get_answer_key(exam_id)
        if not key:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chưa có đáp án cho kỳ thi này")
        return key

    def upsert_answer_key(self, exam_id: int, answers_json: str, scoring_json: str) -> AnswerKey:
        self.get_or_404(exam_id)   # ensure exam exists
        return self.repo.upsert_answer_key(exam_id, answers_json, scoring_json)
