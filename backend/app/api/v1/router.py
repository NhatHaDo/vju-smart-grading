from fastapi import APIRouter

from app.api.v1.routes.auth         import router as auth_router
from app.api.v1.routes.custom_forms import router as custom_forms_router
from app.api.v1.routes.exams        import router as exams_router
from app.api.v1.routes.exam_papers  import router as exam_papers_router
from app.api.v1.routes.grading      import router as grading_router
from app.api.v1.routes.health       import router as health_router
from app.api.v1.routes.omr          import router as omr_router
from app.api.v1.routes.question_bank import router as question_bank_router
from app.api.v1.routes.user_state   import router as user_state_router
from app.api.v1.routes.results      import router as results_router
from app.api.v1.routes.sheets       import router as sheets_router
from app.api.v1.routes.templates    import router as templates_router
from app.api.v1.routes.users        import router as users_router

api_router = APIRouter(prefix="/api/v1")

api_router.include_router(health_router)
api_router.include_router(auth_router)
api_router.include_router(users_router)
api_router.include_router(exams_router)
api_router.include_router(exam_papers_router)
api_router.include_router(sheets_router)
api_router.include_router(grading_router)
api_router.include_router(templates_router)
api_router.include_router(custom_forms_router)
api_router.include_router(results_router)
api_router.include_router(omr_router)
api_router.include_router(question_bank_router)
api_router.include_router(user_state_router)
