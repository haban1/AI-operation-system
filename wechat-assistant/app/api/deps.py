from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import decode_access_token
from app.models.entities import User
import hmac
from sqlalchemy import select
from app.core.config import get_settings


oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    try:
        payload = decode_access_token(token)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc
    user_id = payload.get("sub")
    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Inactive or missing user")
    return user


def get_wechat_operator(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    """Service credentials are accepted only by the WeChat administration router."""
    expected = get_settings().tianhe_admin_token
    if expected and hmac.compare_digest(token, expected):
        user = db.scalar(select(User).where(User.username == "admin", User.is_active.is_(True)))
        if not user:
            raise HTTPException(status_code=503, detail="WeChat administrator is unavailable")
        return user
    return get_current_user(token=token, db=db)

