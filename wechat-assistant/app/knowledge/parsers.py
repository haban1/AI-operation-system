"""Extract source text and locations without converting documents into FAQs."""
from io import BytesIO
from pathlib import Path
from zipfile import BadZipFile, ZipFile

SUPPORTED_SUFFIXES = {".pdf", ".docx", ".txt", ".md"}
MAX_CHARS = 2_000_000
MAX_CHUNKS = 2500


def parse_document(filename: str, content: bytes) -> list[dict]:
    suffix = Path(filename).suffix.lower()
    sections: list[tuple[str, str]] = []
    if suffix == ".pdf":
        from pypdf import PdfReader
        reader = PdfReader(BytesIO(content))
        if reader.is_encrypted and not reader.decrypt(""):
            raise ValueError("PDF 已加密，请上传解除密码保护后的文件。")
        if len(reader.pages) > 500:
            raise ValueError("文档超过 500 页，请拆分后上传。")
        for number, page in enumerate(reader.pages, 1):
            sections.append((f"第 {number} 页", page.extract_text() or ""))
            if sum(len(text) for _, text in sections) > MAX_CHARS:
                raise ValueError("文档文字过多，请拆分后上传。")
    elif suffix == ".docx":
        from docx import Document
        from docx.table import Table
        from docx.text.paragraph import Paragraph
        try:
            with ZipFile(BytesIO(content)) as archive:
                if sum(item.file_size for item in archive.infolist()) > 100_000_000:
                    raise ValueError("Word 文件解压后过大，请拆分后上传。")
        except BadZipFile as exc:
            raise ValueError("Word 文件损坏，请重新保存为 .docx 后上传。") from exc
        document = Document(BytesIO(content))
        paragraph_count = table_count = 0
        for block in document.iter_inner_content():
            if isinstance(block, Paragraph):
                paragraph_count += 1
                sections.append((f"第 {paragraph_count} 段", block.text))
            elif isinstance(block, Table):
                table_count += 1
                for row_index, row in enumerate(block.rows, 1):
                    # Retain column headers with every row, including across chunks.
                    headers = " | ".join(c.text for c in block.rows[0].cells)
                    text = " | ".join(c.text for c in row.cells)
                    sections.append((f"表 {table_count} · 行 {row_index}", text if row_index == 1 else headers + "\n" + text))
    elif suffix in {".txt", ".md"}:
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ValueError("文本文件需要使用 UTF-8 编码。") from exc
        sections = [(f"第 {n} 行", line) for n, line in enumerate(text.splitlines(), 1)]
    else:
        raise ValueError("支持 PDF、Word（.docx）、TXT 和 Markdown 文件。")
    if sum(len(text) for _, text in sections) > MAX_CHARS:
        raise ValueError("文档文字过多，请拆分后上传。")
    # Merge adjacent paragraphs for useful context; do not merge PDF pages.
    blocks: list[tuple[str, str]] = []
    for location, text in sections:
        text = text.strip().replace("\x00", "")
        if not text:
            continue
        if suffix != ".pdf" and blocks and len(blocks[-1][1]) + len(text) < 1200:
            first, previous = blocks[-1]
            blocks[-1] = (first.split(" 至 ")[0] + " 至 " + location, previous + "\n" + text)
        else:
            blocks.append((location, text))
    chunks = []
    for location, text in blocks:
        for start in range(0, len(text), 1000):
            chunks.append({"location": location, "text": text[start:start + 1200]})
            if start + 1200 >= len(text):
                break
    if not chunks:
        raise ValueError("没有解析到文字。扫描件或图片 PDF 请先进行 OCR 文字识别，再上传可搜索的版本。")
    if len(chunks) > MAX_CHUNKS:
        raise ValueError("文档内容过多，请拆分后上传。")
    return chunks
