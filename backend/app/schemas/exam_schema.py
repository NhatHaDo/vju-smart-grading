from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ExamCreate(BaseModel):
    name:             str
    subject:          str = ""
    exam_code:        str | None = None
    exam_date:        str | None = None   # YYYY-MM-DD
    template_id:      int | None = None
    total_students:   int = 0
    notes:            str | None = None
    # ── Extended wizard fields (Phase 2) ──────────────────────────────────
    subject_code:     str | None = None
    semester:         str | None = None
    academic_year:    str | None = None
    lecturer_title:   str | None = None
    lecturer_name:    str | None = None
    class_name:       str | None = None
    faculty:          str | None = None
    training_program: str | None = None
    exam_time:        str | None = None
    room:             str | None = None
    shift:            str | None = None


class ExamUpdate(BaseModel):
    name:             str | None = None
    subject:          str | None = None
    exam_code:        str | None = None
    exam_date:        str | None = None
    template_id:      int | None = None
    total_students:   int | None = None
    status:           str | None = None
    notes:            str | None = None
    # ── Extended wizard fields (Phase 2) ──────────────────────────────────
    subject_code:     str | None = None
    semester:         str | None = None
    academic_year:    str | None = None
    lecturer_title:   str | None = None
    lecturer_name:    str | None = None
    class_name:       str | None = None
    faculty:          str | None = None
    training_program: str | None = None
    exam_time:        str | None = None
    room:             str | None = None
    shift:            str | None = None


class ExamOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:               int
    name:             str
    subject:          str
    exam_code:        str | None
    status:           str
    owner_id:         int
    template_id:      int | None
    total_students:   int
    graded_count:     int
    exam_date:        str | None
    notes:            str | None
    # ── Extended wizard fields (Phase 2) ──────────────────────────────────
    subject_code:     str | None = None
    semester:         str | None = None
    academic_year:    str | None = None
    lecturer_title:   str | None = None
    lecturer_name:    str | None = None
    class_name:       str | None = None
    faculty:          str | None = None
    training_program: str | None = None
    exam_time:        str | None = None
    room:             str | None = None
    shift:            str | None = None
    created_at:       datetime
    updated_at:       datetime


class AnswerKeyCreate(BaseModel):
    answers_json: str   # raw JSON string {"toan1":"A",...}
    scoring_json: str = '{"correct":1.0,"wrong":-0.25,"unanswered":0.0}'


class AnswerKeyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:           int
    exam_id:      int
    answers_json: str
    scoring_json: str
    created_at:   datetime
    updated_at:   datetime
