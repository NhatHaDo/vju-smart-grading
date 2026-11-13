from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.v1.router import api_router
from app.config import get_settings
from app.database import init_db

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    init_db()
    yield
    # Shutdown (cleanup nếu cần)


app = FastAPI(
    title="VJU Smart Grading API",
    version="0.1.0",
    description="OMR-based exam grading system for Vietnam Japan University",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(api_router)

# Static files — serve debug overlay images at /outputs/...
_outputs_dir = Path(settings.omr_output_dir)
_outputs_dir.mkdir(parents=True, exist_ok=True)
app.mount("/outputs", StaticFiles(directory=str(_outputs_dir)), name="outputs")

# Static files — serve uploaded images at /uploads/...
# Needed so the frontend can display the original (raw) uploaded image in the result modal.
_uploads_dir = Path(settings.omr_upload_dir)
_uploads_dir.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(_uploads_dir)), name="uploads")


_dist = Path(settings.frontend_dist) if settings.frontend_dist else None
_serve_web = bool(_dist and (_dist / "index.html").is_file())

if not _serve_web:
    @app.get("/")
    async def root():
        return {"message": "VJU Smart Grading API", "docs": "/docs"}
else:
    # Phục vụ giao diện React đã build — đăng ký CUỐI CÙNG để không đè /api, /uploads, /outputs
    _no_cache = {"Cache-Control": "no-cache, no-store, must-revalidate"}

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str):
        if full_path.split("/", 1)[0] in ("api", "uploads", "outputs", "docs", "openapi.json"):
            raise HTTPException(404)
        target = (_dist / full_path).resolve()
        if full_path and target.is_file() and _dist.resolve() in target.parents:
            # file build có hash trong tên (assets/) → cache lâu được
            hdr = {"Cache-Control": "public, max-age=31536000, immutable"} if full_path.startswith("assets/") else _no_cache
            return FileResponse(target, headers=hdr)
        return FileResponse(_dist / "index.html", headers=_no_cache)
