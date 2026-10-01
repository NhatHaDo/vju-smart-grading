# Import all models so Base.metadata sees them at init_db() time
from app.models.user import User, UserRole        # noqa: F401
from app.models.template import Template          # noqa: F401
from app.models.exam import Exam, AnswerKey       # noqa: F401
from app.models.sheet import Sheet                # noqa: F401
from app.models.result import GradingResult       # noqa: F401
from app.models.audit_log import AuditLog         # noqa: F401
from app.models.batch_result import BatchResult   # noqa: F401
from app.models.question_bank import QuestionCategory, Question, QuestionCategoryShare  # noqa: F401
from app.models.user_state import UserState     # noqa: F401
from app.models.exam_paper import ExamPaper, ExamPaperVersion  # noqa: F401
from app.models.question_asset import QuestionAsset  # noqa: F401
