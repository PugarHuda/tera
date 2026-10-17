import os
import requests

BASE_URL = os.environ.get("TERA_BASE_URL", "https://tera-orpin-three.vercel.app")


def test_public_api_allows_browser_calls_from_any_origin() -> None:
    """FR7: the cookie-less REST API answers CORS preflights and real requests from other origins."""
    pre = requests.options(f"{BASE_URL}/api/simulate", headers={"Origin": "https://example.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"}, timeout=30)
    assert pre.status_code in (200, 204), pre.status_code
    assert pre.headers.get("access-control-allow-origin") == "*", pre.headers
    assert "POST" in pre.headers.get("access-control-allow-methods", "")
    res = requests.post(f"{BASE_URL}/api/simulate", headers={"Origin": "https://example.com"},
                        json={"timeline": [{"at": "2027-01-01T00:00:00Z", "type": "subscribe", "price": "starter_m"}]}, timeout=30)
    assert res.status_code == 200 and res.headers.get("access-control-allow-origin") == "*"
    assert res.json()["invoices"][0]["total"] == 2900


def test_pages_send_security_headers_and_crawl_files_exist() -> None:
    page = requests.get(f"{BASE_URL}/", timeout=30)
    csp = page.headers.get("content-security-policy", "")
    assert "default-src 'self'" in csp and "object-src 'none'" in csp, csp
    assert page.headers.get("x-content-type-options") == "nosniff"
    robots = requests.get(f"{BASE_URL}/robots.txt", timeout=30)
    assert robots.status_code == 200 and "Disallow: /api/" in robots.text and "sitemap.xml" in robots.text
    sitemap = requests.get(f"{BASE_URL}/sitemap.xml", timeout=30)
    assert sitemap.status_code == 200 and "/parity</loc>" in sitemap.text
    llms = requests.get(f"{BASE_URL}/llms.txt", timeout=30)
    assert llms.status_code == 200 and "verify_timeline_in_stripe" in llms.text


test_public_api_allows_browser_calls_from_any_origin()
test_pages_send_security_headers_and_crawl_files_exist()
