from datetime import datetime

from pydantic import BaseModel, ConfigDict


class TemplateCreate(BaseModel):
    name:        str
    type:        str = "vju_sbd8"
    version:     str = "1.0"
    description: str | None = None


class TemplateUpdate(BaseModel):
    name:        str | None = None
    type:        str | None = None
    version:     str | None = None
    description: str | None = None
    is_active:   bool | None = None


class TemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id:             int
    name:           str
    type:           str
    version:        str
    file_path:      str | None
    description:    str | None
    is_active:      bool
    # custom template fields
    areas_path:     str | None = None
    page_width:     int | None = None
    page_height:    int | None = None
    owner_user_id:  int | None = None
    is_default:     bool = False
    created_at:     datetime
    updated_at:     datetime
