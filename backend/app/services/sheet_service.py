from fastapi import HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.models.sheet import Sheet
from app.repositories.sheet_repository import SheetRepository
from app.services.file_service import save_upload


class SheetService:
    def __init__(self, db: Session) -> None:
        self.repo = SheetRepository(db)

    def get_or_404(self, sheet_id: int) -> Sheet:
        sheet = self.repo.get_by_id(sheet_id)
        if not sheet:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Không tìm thấy phiếu")
        return sheet

    def list_by_exam(self, exam_id: int, skip: int = 0, limit: int = 200) -> list[Sheet]:
        return self.repo.list_by_exam(exam_id, skip=skip, limit=limit)

    async def upload_sheet(
        self,
        exam_id: int,
        file: UploadFile,
        uploaded_by: int | None = None,
    ) -> Sheet:
        """Validate + save file, create Sheet record with status=pending."""
        file_path, file_size, original_filename = await save_upload(file)
        sheet = self.repo.create(
            exam_id=exam_id,
            file_path=file_path,
            file_size=file_size,
            mime_type=file.content_type,
            original_filename=original_filename,
            status="pending",
            uploaded_by=uploaded_by,
        )
        return sheet

    def delete_sheet(self, sheet_id: int) -> None:
        sheet = self.get_or_404(sheet_id)
        # Optionally delete the file from disk here (Phase 4)
        self.repo.delete(sheet)
