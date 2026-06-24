from datetime import datetime

from pydantic import BaseModel, ConfigDict


class SheetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:                int
    exam_id:           int
    student_id:        str | None
    student_name:      str | None
    original_filename: str | None
    file_size:         int
    mime_type:         str | None
    status:            str
    needs_review:      bool
    alignment_warning: str | None
    error_message:     str | None
    uploaded_by:       int | None
    created_at:        datetime
    updated_at:        datetime


class SheetUpdate(BaseModel):
    student_id:        str | None = None
    student_name:      str | None = None
    status:            str | None = None
    needs_review:      bool | None = None
    alignment_warning: str | None = None
