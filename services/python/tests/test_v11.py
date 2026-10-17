import asyncio
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch
from fastapi import HTTPException, UploadFile
from app.main import extract_pdf, extract_url, _ArticleText, _headline, _pptx_slide_text, pymupdf

class V11ImportTests(unittest.TestCase):
    def test_searchable_pdf_preserves_page_markers(self):
        with pymupdf.open() as document:
            document.new_page().insert_text((72, 72), 'This document contains enough searchable text for an explainer video.')
            raw = document.tobytes()
        result = asyncio.run(extract_pdf(UploadFile(filename='source.pdf', file=io.BytesIO(raw))))
        self.assertIn('第 1 页', result['text'])
        self.assertEqual(result['ocrPages'], [])

    def test_scanned_page_uses_local_ocr_and_reports_page(self):
        page = MagicMock()
        page.get_text.side_effect = ['', 'Recognized scanned text with enough content to create a complete video.']
        page.get_images.return_value = [object()]
        document = MagicMock()
        document.needs_pass = False
        document.__len__.return_value = 1
        document.__iter__.return_value = iter([page])
        document.__enter__.return_value = document
        with patch('app.main.pymupdf.open', return_value=document), patch('app.main._ocr_data_dir', return_value='local-tessdata'):
            result = asyncio.run(extract_pdf(UploadFile(filename='scan.pdf', file=io.BytesIO(b'pdf'))))
        self.assertEqual(result['ocrPages'], [1])
        self.assertEqual(page.get_textpage_ocr.call_args.kwargs['language'], 'chi_sim+eng')

    def test_encrypted_pdf_reports_actionable_error(self):
        document = MagicMock()
        document.needs_pass = True
        document.__enter__.return_value = document
        with patch('app.main.pymupdf.open', return_value=document):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(extract_pdf(UploadFile(filename='locked.pdf', file=io.BytesIO(b'pdf'))))
        self.assertIn('解除密码', error.exception.detail)

    def test_single_unreadable_page_keeps_the_readable_pages(self):
        good = MagicMock()
        good.get_text.return_value = 'This page has enough searchable text to become part of an explainer video.'
        bad = MagicMock()
        bad.get_text.side_effect = RuntimeError('页面数据损坏')
        document = MagicMock()
        document.needs_pass = False
        document.__len__.return_value = 2
        document.__iter__.return_value = iter([good, bad])
        document.__enter__.return_value = document
        with patch('app.main.pymupdf.open', return_value=document):
            result = asyncio.run(extract_pdf(UploadFile(filename='partial.pdf', file=io.BytesIO(b'pdf'))))
        self.assertIn('第 1 页', result['text'])
        self.assertEqual([page['page'] for page in result['failedPages']], [2])
        self.assertEqual(result['pages'], 2)

    def test_url_timeout_reports_actionable_message(self):
        with patch('app.main._validate_public_url', return_value='https://example.com/article'), patch('app.main.build_opener') as opener:
            opener.return_value.open.side_effect = TimeoutError('timed out')
            with self.assertRaises(HTTPException) as error:
                asyncio.run(extract_url({'url': 'https://example.com/article'}))
        self.assertIn('45 秒', error.exception.detail)
        self.assertNotIn('timed out', error.exception.detail)

    def test_article_priority_preserves_article_header_and_excludes_navigation(self):
        parser = _ArticleText()
        parser.feed('<nav>Navigation</nav><main><article><header><h1>Article title</h1></header><p>Article body</p></article></main><aside>Related</aside>')
        self.assertIn('Article title', parser.article_parts)
        self.assertIn('Article body', parser.article_parts)
        self.assertNotIn('Navigation', parser.article_parts)
        self.assertNotIn('Related', parser.article_parts)

    def test_site_chrome_around_the_body_is_dropped(self):
        # Most sites mark menus with plain divs, not <nav>, so class/id and link
        # density have to do the work or navigation ends up in the narration source.
        parser = _ArticleText()
        parser.feed('''<html><body>
            <div class="top-nav"><a href="/">首页</a><a href="/news">新闻</a><a href="/video">视频</a></div>
            <div id="breadcrumb"><a href="/">首页</a> &gt; <a href="/tech">科技</a></div>
            <div class="sidebar"><ul><li><a href="/a">热榜第一条</a></li><li><a href="/b">热榜第二条</a></li></ul></div>
            <div class="article-content">
              <h1>大模型推理成本正在下降</h1>
              <p>过去一年，主流厂商的推理单价下降了约十倍，这让长上下文应用第一次具备商业可行性。</p>
              <ul class="share-buttons"><li><a href="/share/weibo">分享到微博</a></li><li><a href="/share/wx">分享到微信</a></li></ul>
              <p>成本下降主要来自三方面：更高效的注意力实现、更激进的量化，以及请求批处理调度。</p>
            </div>
            <div class="related-posts"><a href="/x">相关阅读：另一篇文章</a></div>
            <div class="cookie-consent">本站使用 Cookie 以改善体验，点击接受即表示同意。</div>
        </body></html>''')
        body = parser.body()
        self.assertIn('推理单价下降了约十倍', body)
        self.assertIn('请求批处理调度', body)
        for chrome in ('首页', '热榜第一条', '分享到微博', '相关阅读', 'Cookie'):
            self.assertNotIn(chrome, body)

    def test_url_extraction_reports_one_page_and_readable_body(self):
        page = '<html><head><title>示例文章</title></head><body><nav><a href="/">首页</a></nav><article><p>' + ('这是一段足够长的正文内容，用于验证网页抽取结果。' * 8) + '</p></article></body></html>'
        response = MagicMock()
        response.headers.get.return_value = 'text/html; charset=utf-8'
        response.headers.get_content_charset.return_value = 'utf-8'
        response.read.return_value = page.encode('utf-8')
        response.__enter__.return_value = response
        with patch('app.main._validate_public_url', return_value='https://example.com/article'), patch('app.main.build_opener') as opener:
            opener.return_value.open.return_value = response
            result = asyncio.run(extract_url({'url': 'https://example.com/article'}))
        self.assertEqual(result['pages'], 1)
        self.assertIn('验证网页抽取结果', result['text'])
        self.assertNotIn('首页', result['text'])

    def test_inline_elements_join_without_spurious_or_missing_spaces(self):
        parser = _ArticleText()
        parser.feed('<article><p>水循环是由<b>水</b><i>循环</i>驱动的，它是一个连续的<b>过程</b>。'
                    '<a href="/x">deforestation</a>,<a href="/y">urbanization</a> and <span>runoff</span>(surface flow) all matter here[12].</p></article>')
        body = parser.body()
        self.assertIn('水循环是由水循环驱动的', body)
        self.assertIn('它是一个连续的过程', body)
        self.assertIn('deforestation, urbanization and runoff (surface flow)', body)
        self.assertNotIn('[12]', body)

    def test_site_suffix_in_title_is_not_repeated_over_the_heading(self):
        body = ('Water cycle\n\nThe water cycle is a biogeochemical cycle that involves the continuous change in form of water.\n\n'
                'The water cycle is driven by energy exchanges in the form of heat transfers.')
        # <title> carries the site name, the article's own <h1> does not.
        self.assertEqual(_headline('Water cycle - Wikipedia', body), '')
        self.assertEqual(_headline('Water cycle | USGS', body), '')
        # A different (or missing) opening still needs the heading.
        self.assertEqual(_headline('Water cycle - Wikipedia', 'Some other opening paragraph.'), 'Water cycle - Wikipedia')
        self.assertEqual(_headline('', body), '')

    def test_table_cells_are_not_repeated_as_plain_paragraphs(self):
        slide = ('<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
                 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>'
                 '<p:sp><p:txBody><a:p><a:r><a:t>表格标题</a:t></a:r></a:p></p:txBody></p:sp>'
                 '<a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>指标</a:t></a:r></a:p></a:txBody></a:tc>'
                 '<a:tc><a:txBody><a:p><a:r><a:t>数值</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl>'
                 '</p:spTree></p:cSld></p:sld>')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'deck.pptx'
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('ppt/slides/slide1.xml', slide)
            with zipfile.ZipFile(path) as archive:
                text, notes, images = _pptx_slide_text(archive, 'ppt/slides/slide1.xml', 1)
        self.assertEqual(text.splitlines(), ['表格标题', '表格行：指标 | 数值'])
        self.assertEqual(notes, '')
        self.assertEqual(images, [])


if __name__ == '__main__':
    unittest.main()
