import asyncio
from contextlib import suppress
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from app.core.config import get_settings
from sqlalchemy import select

from app.api import auth, chat, knowledge, wechat_robot, wecom
from app.core.database import SessionLocal, create_all
from app.core.security import hash_password
from app.models.entities import Role, User
from app.wecom.customer_service import customer_service_poller_status, run_customer_service_poller


@asynccontextmanager
async def lifespan(_: FastAPI):
    create_all()
    seed_admin()
    poller = asyncio.create_task(run_customer_service_poller())
    try:
        yield
    finally:
        poller.cancel()
        with suppress(asyncio.CancelledError):
            await poller


app = FastAPI(title="Enterprise FAQ Customer Service", version="0.3.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ],
    allow_origin_regex=r"http://(127\.0\.0\.1|localhost):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth.router)
if not get_settings().tianhe_knowledge_enabled:
    app.include_router(knowledge.router)
app.include_router(chat.router)
app.include_router(wecom.router)
app.include_router(wechat_robot.router)


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "wecom_kf_poller": customer_service_poller_status(),
    }


frontend_dir = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if get_settings().tianhe_knowledge_enabled:
    @app.get("/", include_in_schema=False)
    def unified_admin():
        return RedirectResponse(get_settings().tianhe_admin_url, status_code=307)
elif frontend_dir.is_dir():
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")


def seed_admin() -> None:
    with SessionLocal() as db:
        users = [
            ("admin", "admin123", Role.admin),
            ("student", "student123", Role.student),
        ]
        for username, password, role in users:
            existing = db.scalar(select(User).where(User.username == username))
            if existing:
                continue
            db.add(User(username=username, password_hash=hash_password(password), role=role))
        db.commit()
