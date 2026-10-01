from datetime import datetime

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class CategoryCreate(BaseModel):
    name:        str = Field(min_length=1, max_length=255)
    description: str | None = None


class CategoryUpdate(BaseModel):
    name:        str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None


class CategoryOut(BaseModel):
    id:             int
    name:           str
    description:    str | None
    owner_id:       int
    owner_name:     str = ""
    access:         Literal["owner", "edit", "view"] = "owner"
    question_count: int = 0
    type_counts:    dict[str, int] = {}   # {"mcq": n, "tf": n, "short": n}
    unanswered:     int = 0               # trắc nghiệm questions with no answer yet
    created_at:     datetime
    updated_at:     datetime


QType = Literal["mcq", "tf", "short"]


class QuestionOption(BaseModel):
    text:    str
    fixed:   bool = False
    correct: bool | None = None   # Đúng/Sai statements only


class QuestionIn(BaseModel):
    qtype:           QType = "mcq"
    content:         str
    options:         list[QuestionOption] = []
    answer:          int = 0             # mcq: index of the correct option, -1 = chưa có đáp án
    answer_text:     str | None = None   # short: e.g. "-1,5"
    shuffle_options: bool = True

    @field_validator("content")
    @classmethod
    def _content_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Nội dung câu hỏi không được để trống")
        return v.strip()

    @model_validator(mode="after")
    def _check_by_type(self):
        from app.services.question_io import TF_STATEMENTS, normalize_short_answer
        if self.qtype == "short":
            ans = normalize_short_answer(self.answer_text or "")
            if ans is None:
                raise ValueError("Đáp án trả lời ngắn phải tô được trên phiếu: tối đa 4 ký tự gồm dấu -, chữ số, dấu phẩy (vd 75, -1,5)")
            self.answer_text, self.options, self.answer, self.shuffle_options = ans, [], 0, False
            return self
        if any(not o.text.strip() for o in self.options):
            raise ValueError("Không để trống đáp án / ý")
        if self.qtype == "tf":
            if len(self.options) != TF_STATEMENTS:
                raise ValueError("Câu Đúng/Sai phải có đúng 4 ý a) b) c) d)")
            for o in self.options:
                o.correct = bool(o.correct)
            self.answer, self.answer_text, self.shuffle_options = 0, None, False
            return self
        if not 2 <= len(self.options) <= 8:
            raise ValueError("Câu hỏi phải có từ 2 đến 8 đáp án")
        if not (self.answer == -1 or 0 <= self.answer < len(self.options)):
            raise ValueError("Đáp án đúng không hợp lệ")
        for o in self.options:
            o.correct = None
        self.answer_text = None
        return self


class QuestionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:              int
    category_id:     int
    qtype:           QType
    content:         str
    options:         list[QuestionOption]
    answer:          int
    answer_text:     str | None
    shuffle_options: bool
    created_at:      datetime
    updated_at:      datetime


class ImportResult(BaseModel):
    dry_run:    bool
    found:      int          # valid questions parsed from the file
    new:        int          # added (or, when dry_run, would be added)
    duplicates: int          # skipped: same question already in category / file
    duplicate_list: list[str] = []   # which câu, and what each one repeats
    formula_note: str | None = None  # formulas kept but not drawable on the web (no LibreOffice)
    unanswered: int = 0      # of the found ones: trắc nghiệm with no answer marked — pick it on the page
    answered:   int = 0      # duplicates whose bank copy had no answer, given one by this import
    # the trắc nghiệm still without an answer that would land in the bank:
    # {i: index in the file, number, content, options}; answers picked on the
    # page go back as answers_json {i: option}
    unanswered_list: list[dict] = []
    mcq_all:    list[dict] = []   # every trắc nghiệm of the file (mcq_no, answer…), for the file đáp án
    warnings:   list[str]


class ShareCreate(BaseModel):
    email:      str = Field(min_length=3, max_length=255)
    permission: Literal["view", "edit"] = "view"


class ShareOut(BaseModel):
    id:         int
    user_id:    int
    email:      str
    name:       str
    permission: Literal["view", "edit"]
    created_at: datetime
