import io
import asyncio
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException, UploadFile
from app.main import DATA, WEB_PUBLIC_ASSETS, _ArticleText, _pptx_slide_order, _pptx_slide_text, _validate_public_url, extract_pptx, extract_url, pymupdf

if hasattr(asyncio, "WindowsSelectorEventLoopPolicy"):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


class ImportTests(unittest.TestCase):
    def test_missing_converters_disable_preserve_and_reject_before_extracting(self):
        from app.presentation import presentation_capabilities
        with patch('app.presentation.converters', return_value={'libreoffice': None, 'powerpoint': None}):
            self.assertFalse(presentation_capabilities()['preservePptx'])
            uploaded = UploadFile(filename='sample.pptx', file=io.BytesIO(b''))
            with self.assertRaises(HTTPException) as context:
                asyncio.run(extract_pptx(file=uploaded, projectId='test-no-converters', mode='preserve'))
            self.assertEqual(context.exception.status_code, 422)
            self.assertIn('PowerPoint', context.exception.detail)

    def test_article_parser_omits_navigation_and_scripts(self):
        parser = _ArticleText()
        parser.feed("<html><head><title>标题</title></head><body><nav>菜单</nav><h1>正文</h1><p>内容</p><script>bad()</script></body></html>")
        self.assertIn("内容", "".join(parser.parts))
        self.assertNotIn("菜单", "".join(parser.parts))
        self.assertNotIn("bad()", "".join(parser.parts))
        self.assertEqual("标题", " ".join(parser.title))

    def test_url_policy_rejects_private_hosts_and_nonstandard_ports(self):
        with self.assertRaises(ValueError):
            _validate_public_url("http://127.0.0.1/article")
        with self.assertRaises(ValueError):
            _validate_public_url("https://example.com:8443/article")
        with patch("app.main.socket.getaddrinfo", return_value=[(None, None, None, None, ("93.184.216.34", 443))]):
            self.assertEqual("https://example.com/article", _validate_public_url("https://example.com/article"))

    def test_pptx_extraction_reads_text_notes_and_relationship_images(self):
        buffer = io.BytesIO()
        slide_xml = b'''<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:sp><p:txBody><a:p><a:r><a:t>Slide title</a:t></a:r></a:p></p:txBody></p:sp></p:sld>'''
        notes_xml = b'''<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Speaker notes</a:t></a:r></a:p></p:notes>'''
        rels = b'''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>'''
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("ppt/slides/slide1.xml", slide_xml)
            archive.writestr("ppt/slides/_rels/slide1.xml.rels", rels)
            archive.writestr("ppt/notesSlides/notesSlide1.xml", notes_xml)
            archive.writestr("ppt/media/image1.png", b"image-data")
        with zipfile.ZipFile(io.BytesIO(buffer.getvalue())) as archive:
            content, notes, images = _pptx_slide_text(archive, "ppt/slides/slide1.xml", 1)
        self.assertIn("Slide title", content)
        self.assertIn("Speaker notes", notes)
        self.assertEqual([("image1.png", b"image-data")], images)

    def test_pptx_page_order_uses_presentation_relationships(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("ppt/presentation.xml", b'''<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>''')
            archive.writestr("ppt/_rels/presentation.xml.rels", b'''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>''')
            archive.writestr("ppt/slides/slide1.xml", b"<sld/>")
            archive.writestr("ppt/slides/slide2.xml", b"<sld/>")
        with zipfile.ZipFile(io.BytesIO(buffer.getvalue())) as archive:
            self.assertEqual(["ppt/slides/slide2.xml", "ppt/slides/slide1.xml"], _pptx_slide_order(archive))

    def test_pptx_rebuild_endpoint_returns_page_text_and_local_assets(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("ppt/slides/slide1.xml", b'''<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:sp><p:txBody><a:p><a:r><a:t>Overview</a:t></a:r></a:p></p:txBody></p:sp></p:sld>''')
            archive.writestr("ppt/slides/_rels/slide1.xml.rels", b'''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>''')
            archive.writestr("ppt/notesSlides/notesSlide1.xml", b'''<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Speaker notes</a:t></a:r></a:p></p:notes>''')
            archive.writestr("ppt/media/image1.png", b"image-data")
        project_id = "test-pptx-rebuild"
        self.addCleanup(shutil.rmtree, DATA / project_id, ignore_errors=True)
        self.addCleanup(shutil.rmtree, WEB_PUBLIC_ASSETS / project_id, ignore_errors=True)
        uploaded = UploadFile(filename="sample.pptx", file=io.BytesIO(buffer.getvalue()))
        payload = asyncio.run(extract_pptx(file=uploaded, projectId=project_id, mode="rebuild"))
        self.assertIn("Overview", payload["text"])
        self.assertIn("Speaker notes", payload["text"])
        self.assertTrue((WEB_PUBLIC_ASSETS / project_id / "assets" / "slide-001-image-01.png").is_file())

    def test_url_endpoint_rejects_loopback(self):
        with self.assertRaises(HTTPException) as context:
            asyncio.run(extract_url({"url": "http://127.0.0.1/article"}))
        self.assertEqual(context.exception.status_code, 422)

    def test_preserve_mode_reports_missing_powerpoint_renderer(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("ppt/slides/slide1.xml", b'''<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:sp><p:txBody><a:p><a:r><a:t>Slide</a:t></a:r></a:p></p:txBody></p:sp></p:sld>''')
        project_id = "test-pptx-renderer"
        self.addCleanup(shutil.rmtree, DATA / project_id, ignore_errors=True)
        self.addCleanup(shutil.rmtree, WEB_PUBLIC_ASSETS / project_id, ignore_errors=True)
        uploaded = UploadFile(filename="sample.pptx", file=io.BytesIO(buffer.getvalue()))
        with patch("app.main._render_pptx_pdf", side_effect=RuntimeError("需要 PowerPoint 或 LibreOffice")):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(extract_pptx(file=uploaded, projectId=project_id, mode="preserve"))
        self.assertEqual(context.exception.status_code, 422)
        self.assertIn("PowerPoint 或 LibreOffice", str(context.exception.detail))

    def test_preserve_mode_closes_pdf_before_cleaning_temporary_directory(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("ppt/slides/slide1.xml", b'''<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:sp><p:txBody><a:p><a:r><a:t>Slide</a:t></a:r></a:p></p:txBody></p:sp></p:sld>''')
        project_id = "test-pptx-preserve-cleanup"
        self.addCleanup(shutil.rmtree, DATA / project_id, ignore_errors=True)
        self.addCleanup(shutil.rmtree, WEB_PUBLIC_ASSETS / project_id, ignore_errors=True)
        uploaded = UploadFile(filename="sample.pptx", file=io.BytesIO(buffer.getvalue()))
        temporary_paths = []
        real_temporary_directory = tempfile.TemporaryDirectory

        def tracked_temporary_directory(*args, **kwargs):
            directory = real_temporary_directory(*args, **kwargs)
            temporary_paths.append(directory.name)
            return directory

        def render_pdf(_source, output_dir):
            pdf_path = output_dir / "source.pdf"
            doc = pymupdf.open()
            doc.new_page().insert_text((72, 72), "Slide")
            doc.save(pdf_path)
            doc.close()
            return pdf_path

        with patch("app.main.tempfile.TemporaryDirectory", side_effect=tracked_temporary_directory), patch("app.main._render_pptx_pdf", side_effect=render_pdf):
            payload = asyncio.run(extract_pptx(file=uploaded, projectId=project_id, mode="preserve"))

        self.assertEqual(payload["pages"], 1)
        self.assertTrue((WEB_PUBLIC_ASSETS / project_id / "assets" / "slide-001.png").is_file())
        self.assertEqual(len(temporary_paths), 1)
        self.assertFalse(Path(temporary_paths[0]).exists())


if __name__ == "__main__":
    unittest.main()
