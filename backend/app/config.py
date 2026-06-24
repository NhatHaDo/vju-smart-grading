from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Database
    database_url: str = "sqlite:///./vju_smart_grading.db"

    # JWT
    jwt_secret_key: str = "dev-secret-change-in-production"
    jwt_access_expire_minutes: int = 30
    jwt_refresh_expire_days: int = 7

    # CORS
    cors_origins: str = "http://localhost:5173"

    # OMR paths
    omr_template_dir: str = "./templates"
    omr_upload_dir: str = "./uploads"
    omr_output_dir: str = "./outputs"

    # Rate limiting
    rate_limit_per_minute: int = 60

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",")]


@lru_cache
def get_settings() -> Settings:
    return Settings()
