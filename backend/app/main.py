from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
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


@app.get("/")
async def root():
    return {"message": "VJU Smart Grading API", "docs": "/docs"}
