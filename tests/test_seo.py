"""
SEO / PWA 路由测试
"""


def test_robots_txt(client):
    resp = client.get("/robots.txt")
    assert resp.status_code == 200
    assert "text/plain" in resp.headers["content-type"]
    body = resp.text
    assert "User-agent" in body
    assert "/api/" in body  # 应禁止收录 API


def test_sitemap_xml(client):
    resp = client.get("/sitemap.xml")
    assert resp.status_code == 200
    assert "xml" in resp.headers["content-type"]
    assert "<urlset" in resp.text


def test_manifest(client):
    resp = client.get("/manifest.webmanifest")
    assert resp.status_code == 200
    assert "manifest+json" in resp.headers["content-type"]
    assert '"name"' in resp.text


def test_static_index(client):
    # 根路径应 302 到 /static/index.html
    resp = client.get("/", follow_redirects=False)
    assert resp.status_code in (302, 307)
    assert "/static/index.html" in resp.headers.get("location", "")
