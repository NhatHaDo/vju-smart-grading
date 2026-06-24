from sqlalchemy.orm import Session

from app.models.exam import AnswerKey, Exam


class ExamRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_id(self, exam_id: int) -> Exam | None:
        return self.db.get(Exam, exam_id)

    def get_by_code(self, code: str) -> Exam | None:
        return self.db.query(Exam).filter(Exam.exam_code == code).first()

    def list_all(self, skip: int = 0, limit: int = 100) -> list[Exam]:
        return self.db.query(Exam).order_by(Exam.created_at.desc()).offset(skip).limit(limit).all()

    def list_by_owner(self, owner_id: int, skip: int = 0, limit: int = 100) -> list[Exam]:
        return (
            self.db.query(Exam)
            .filter(Exam.owner_id == owner_id)
            .order_by(Exam.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

    def create(self, owner_id: int, **kwargs) -> Exam:
        exam = Exam(owner_id=owner_id, **kwargs)
        self.db.add(exam)
        self.db.commit()
        self.db.refresh(exam)
        return exam

    def update(self, exam: Exam, **kwargs) -> Exam:
        for key, value in kwargs.items():
            if value is not None and hasattr(exam, key):
                setattr(exam, key, value)
        self.db.commit()
        self.db.refresh(exam)
        return exam

    def delete(self, exam: Exam) -> None:
        self.db.delete(exam)
        self.db.commit()

    def increment_graded(self, exam_id: int) -> None:
        exam = self.get_by_id(exam_id)
        if exam:
            exam.graded_count = (exam.graded_count or 0) + 1
            self.db.commit()

    # ── Answer key ──────────────────────────────────────────────────
    def get_answer_key(self, exam_id: int) -> AnswerKey | None:
        return self.db.query(AnswerKey).filter(AnswerKey.exam_id == exam_id).first()

    def upsert_answer_key(self, exam_id: int, answers_json: str, scoring_json: str) -> AnswerKey:
        key = self.get_answer_key(exam_id)
        if key:
            key.answers_json = answers_json
            key.scoring_json = scoring_json
        else:
            key = AnswerKey(exam_id=exam_id, answers_json=answers_json, scoring_json=scoring_json)
            self.db.add(key)
        self.db.commit()
        self.db.refresh(key)
        return key
