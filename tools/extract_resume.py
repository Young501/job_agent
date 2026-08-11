#!/usr/bin/env python3
"""Extract plain text from a local resume without making network requests."""

from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree


# Node reads this program's JSON output as UTF-8. Windows consoles often default
# to a legacy code page that cannot represent resume bullets or Chinese text.
sys.stdout.reconfigure(encoding="utf-8")


def compact(text: str) -> str:
    return re.sub(r"[ \t]+", " ", re.sub(r"\n{3,}", "\n\n", text)).strip()


def extract_docx(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if name == "word/document.xml"]
        if not names:
            raise ValueError("DOCX does not include word/document.xml")
        root = ElementTree.fromstring(archive.read(names[0]))
    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    paragraphs = []
    for paragraph in root.iter(f"{namespace}p"):
        chunks = [node.text or "" for node in paragraph.iter(f"{namespace}t")]
        text = "".join(chunks).strip()
        if text:
            paragraphs.append(text)
    return "\n".join(paragraphs)


def extract_pdf(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as error:
        raise ValueError("PDF extraction needs pypdf in the configured Python runtime") from error
    reader = PdfReader(str(path))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: extract_resume.py <path>")
    path = Path(sys.argv[1])
    suffix = path.suffix.lower()
    if suffix == ".docx":
        text = extract_docx(path)
    elif suffix == ".pdf":
        text = extract_pdf(path)
    elif suffix in {".txt", ".md"}:
        text = path.read_text(encoding="utf-8", errors="replace")
    else:
        raise ValueError("Only .txt, .md, .docx, and .pdf resumes are supported")
    print(json.dumps({"text": compact(text)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
