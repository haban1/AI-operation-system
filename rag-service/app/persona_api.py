from fastapi import APIRouter, Path, Request

from .persona import PROMPT_VERSION, AnswerProfile, load_answer_profile, save_answer_profile

router = APIRouter()


def profile_response(knowledge_base_id: str, profile: AnswerProfile) -> dict:
    return {
        "knowledgeBaseId": knowledge_base_id,
        "profile": profile.model_dump(),
        "scope": "answer_presentation_only",
        "promptVersion": PROMPT_VERSION,
    }


@router.get("/rag-admin-api/v1/knowledge-bases/{knowledge_base_id}/answer-profile")
async def read_answer_profile(request: Request, knowledge_base_id: str = Path(min_length=1, max_length=120)):
    return profile_response(knowledge_base_id, load_answer_profile(request.app.state.service.db, knowledge_base_id))


@router.put("/rag-admin-api/v1/knowledge-bases/{knowledge_base_id}/answer-profile")
async def update_answer_profile(request: Request, profile: AnswerProfile, knowledge_base_id: str = Path(min_length=1, max_length=120)):
    save_answer_profile(request.app.state.service.db, knowledge_base_id, profile)
    return profile_response(knowledge_base_id, profile)
