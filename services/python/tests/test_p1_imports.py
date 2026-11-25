"""P1 import regressions: #305 article scopes, #314 sparse PDFs, #315 PowerPoint runs."""
import asyncio
import io
import unittest
import zipfile

from fastapi import HTTPException, UploadFile
from app.main import _ArticleText, _pptx_slide_text, extract_pdf, pymupdf

if hasattr(asyncio, "WindowsSelectorEventLoopPolicy"):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"


class P1ImportTests(unittest.TestCase):
    def test_305_inner_div_does_not_close_the_article_root(self):
        opening = "开篇段落" * 30
        parser = _ArticleText()
        parser.feed(f'<html><body><div class="article-content"><div>{opening}</div><p>后续段落必须保留。</p></div><div>页面其它内容</div></body></html>')
        body = parser.body()
        self.assertIn("后续段落必须保留。", body)
        self.assertNotIn("页面其它内容", body)

    def test_305_nested_div_does_not_end_sidebar_filtering(self):
        parser = _ArticleText()
        parser.feed('<html><body><div class="sidebar"><div>内层</div><p>侧栏链接列表</p></div><article><p>正文内容。</p></article></body></html>')
        text = "".join(parser.parts)
        self.assertIn("正文内容。", text)
        self.assertNotIn("侧栏链接列表", text)

    def test_314_page_headings_do_not_count_as_source_text(self):
        doc = pymupdf.open()
        for _ in range(5):
            doc.new_page().insert_text((72, 72), "A")
        raw = doc.tobytes()
        doc.close()
        uploaded = UploadFile(filename="sparse.pdf", file=io.BytesIO(raw))
        with self.assertRaises(HTTPException) as context:
            asyncio.run(extract_pdf(file=uploaded))
        self.assertEqual(context.exception.status_code, 422)
        self.assertIn("足够正文", str(context.exception.detail))

    def test_315_table_cell_runs_are_concatenated_within_a_paragraph(self):
        slide = f'''<p:sld xmlns:p="{P}" xmlns:a="{A}"><p:cSld><p:spTree><p:graphicFrame><a:graphic><a:graphicData><a:tbl>
<a:tr><a:tc><a:txBody><a:p><a:r><a:t>1.</a:t></a:r><a:r><a:t>5</a:t></a:r></a:p></a:txBody></a:tc>
<a:tc><a:txBody><a:p><a:r><a:t>机器</a:t></a:r><a:r><a:t>学习</a:t></a:r></a:p><a:p><a:r><a:t>第二段</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
</a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>'''
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("ppt/slides/slide1.xml", slide.encode("utf-8"))
        with zipfile.ZipFile(io.BytesIO(buffer.getvalue())) as archive:
            text = _pptx_slide_text(archive, "ppt/slides/slide1.xml", 1)[0]
        self.assertIn("1.5", text)
        self.assertIn("机器学习 第二段", text)
        self.assertNotIn("1. 5", text)


if __name__ == "__main__":
    unittest.main()
