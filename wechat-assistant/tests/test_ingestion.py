from app.ingestion.parsers import chunk_sections


def test_chunk_sections_preserves_page_or_slide_metadata():
    sections = [{"page_or_slide": "slide 3", "text": "a" * 1300}]

    chunks = chunk_sections(sections, max_chars=1000, overlap=100)

    assert len(chunks) == 2
    assert {chunk["page_or_slide"] for chunk in chunks} == {"slide 3"}
    assert chunks[0]["text"] == "a" * 1000

