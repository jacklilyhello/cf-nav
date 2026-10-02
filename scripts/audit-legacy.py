#!/usr/bin/env python3
"""Bounded, reproducible legacy navigation audit. No third-party dependencies.

Input is an array (or {items: [...]}) of extracted navigation records. The audit
keeps every occurrence; deduplication is an explicit editorial decision. It does
not treat HTTP 200 as proof of service continuity, or bot blocking as death.
"""

import argparse
import concurrent.futures
import datetime
import hashlib
import html
import gzip
import io
from html.parser import HTMLParser
import ipaddress
import json
import re
import socket
import subprocess
import tempfile
import time
import urllib.parse
from pathlib import Path


class PageText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.title_parts = []
        self.in_title = False
        self.hidden = 0
        self.description = ""

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ("script", "style", "noscript"):
            self.hidden += 1
        if tag == "title":
            self.in_title = True
        if tag == "meta" and (attrs.get("name", "").lower() == "description" or
                               attrs.get("property", "").lower() == "og:description"):
            self.description = attrs.get("content", "")[:500]

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript"):
            self.hidden = max(0, self.hidden - 1)
        if tag == "title":
            self.in_title = False

    def handle_data(self, value):
        if self.in_title:
            self.title_parts.append(value)
        if not self.hidden:
            self.parts.append(value)

    @property
    def title(self):
        return re.sub(r"\s+", " ", " ".join(self.title_parts)).strip()[:300]

    @property
    def text(self):
        return re.sub(r"\s+", " ", " ".join(self.parts)).strip()[:12000]


def normalized_url(url):
    p = urllib.parse.urlsplit(url)
    host = (p.hostname or "").lower().removeprefix("www.")
    path = p.path.rstrip("/")
    query = urllib.parse.parse_qsl(p.query, keep_blank_values=True)
    query = [(k, v) for k, v in query if not re.match(r"^(utm_|ref$|referral$|aff|from$|spm$)", k, re.I)]
    return urllib.parse.urlunsplit(("https", host, path, urllib.parse.urlencode(sorted(query)), ""))


def public_target(url):
    p = urllib.parse.urlsplit(url)
    if p.scheme not in ("http", "https") or not p.hostname or p.username or p.password:
        raise ValueError("Only public HTTP(S) URLs without credentials may be probed")
    if p.port not in (None, 80, 443):
        raise ValueError("Nonstandard ports are not probed")
    host = p.hostname.encode("idna").decode("ascii")
    if host.rstrip(".").lower() in ("localhost", "metadata.google.internal") or "." not in host:
        raise ValueError("Local or metadata hostname rejected")
    addresses = {x[4][0] for x in socket.getaddrinfo(host, p.port or (443 if p.scheme == "https" else 80), type=socket.SOCK_STREAM)}
    if not addresses or any(not ipaddress.ip_address(x).is_global for x in addresses):
        raise ValueError("Private, reserved or mixed public/private DNS address rejected")
    # Pin a checked address for this individual request, including every redirect.
    address = sorted(addresses, key=lambda x: ":" in x)[0]
    if ":" in address:
        address = "[" + address + "]"
    return host, p.port or (443 if p.scheme == "https" else 80), address


def fetch_one(url):
    redirects = []
    current = url
    for _ in range(6):
        try:
            host, port, address = public_target(current)
        except socket.gaierror as error:
            return {"url": current, "redirects": redirects, "error": "dns_error", "detail": str(error)[:200]}
        except (ValueError, UnicodeError) as error:
            return {"url": current, "redirects": redirects, "error": "unsafe_url", "detail": str(error)[:200]}
        with tempfile.TemporaryDirectory(prefix="cf-nav-audit-") as folder:
            head = Path(folder) / "headers"
            body = Path(folder) / "body"
            command = ["curl", "--silent", "--show-error", "--noproxy", "*", "--connect-timeout", "8", "--max-time", "18",
                       "--max-filesize", "1048576", "--compressed", "--proto", "=http,https",
                       "--resolve", f"{host}:{port}:{address}", "--user-agent", "cf-nav-link-audit/1.0 (+https://nav.lily.lat/)",
                       "--dump-header", str(head), "--output", str(body), "--write-out", "%{http_code}", current]
            run = subprocess.run(command, capture_output=True, text=True, timeout=22)
            raw_head = head.read_text(errors="replace") if head.exists() else ""
            body_bytes = body.read_bytes()[:262144] if body.exists() else b""
            if body_bytes.startswith(b'\x1f\x8b'):
                try:
                    body_bytes = gzip.GzipFile(fileobj=io.BytesIO(body_bytes)).read(262144)
                except (OSError, EOFError):
                    pass
            charset_match = re.search(r'charset\s*=\s*["\']?([a-zA-Z0-9_-]+)', raw_head + body_bytes[:4096].decode('ascii', errors='ignore'), re.I)
            charset = charset_match.group(1) if charset_match else 'utf-8'
            try:
                raw_body = body_bytes.decode(charset, errors="replace")
            except LookupError:
                raw_body = body_bytes.decode("utf-8", errors="replace")
            status = int(run.stdout[-3:]) if run.stdout[-3:].isdigit() else 0
            if run.returncode not in (0, 63):
                error = {6: "dns_error", 7: "connection_error", 28: "timeout", 35: "tls_error", 60: "tls_error"}.get(run.returncode, "connection_error")
                return {"url": current, "redirects": redirects, "http_status": status or None, "error": error,
                        "detail": re.sub(r"\s+", " ", run.stderr)[:240]}
            if status in (301, 302, 303, 307, 308):
                locations = re.findall(r"^location:\s*(.+)$", raw_head, re.I | re.M)
                if not locations:
                    return {"url": current, "redirects": redirects, "http_status": status, "error": "redirect_without_location"}
                destination = urllib.parse.urljoin(current, locations[-1].strip())
                redirects.append({"from": current, "to": destination, "status": status})
                if destination == current or destination in [x["from"] for x in redirects]:
                    return {"url": destination, "redirects": redirects, "http_status": status, "error": "redirect_loop"}
                current = destination
                continue
            page = PageText()
            page.feed(raw_body)
            return {"url": current, "redirects": redirects, "http_status": status, "title": page.title,
                    "meta_description": page.description[:250], "text_excerpt": page.text[:500],
                    "content_sha256": hashlib.sha256(raw_body.encode()).hexdigest(),
                    "content_sample_truncated": len(raw_body) >= 262144 or run.returncode == 63,
                    "_body": raw_body[:100000], "_text": page.text}
    return {"url": current, "redirects": redirects, "error": "too_many_redirects"}


def classify(item, response):
    status = response.get("http_status")
    error = response.get("error")
    text = (response.get("title", "") + " " + response.get("meta_description", "") + " " + response.get("_text", "")).lower()
    body = response.get("_body", "").lower()
    title = response.get("title", "").lower()
    parking = r"domain (?:name )?(?:is |may be )?for sale|buy this domain|this domain is available|domain has expired|this domain has been registered|sedo domain parking|hugedomains\.com|hosted by one\.com|域名出售|域名转让|域名已过期"
    challenge = r"just a moment|checking your browser|verify (?:that )?you are (?:a )?human|attention required|captcha|security verification|access denied|automated access|enable javascript and cookies|人机验证|安全验证|验证访问|京东验证"
    if re.search(parking, text) or re.search(r"(?:afternic|sedoparking|parkingcrew)\.(?:com|net)", body) or 'expireddomains.com/domain/' in response.get('url', '') or 'afternic / godaddy' in title:
        return "domain_for_sale" if re.search(r"for sale|buy this domain|域名出售|域名转让", text) else "domain_parking", "remove", "Page contains explicit domain sale, parking, or expiry evidence."
    if re.search(challenge, title) or (len(text) < 1200 and re.search(challenge, text)) or '/antispider/' in response.get('url', ''):
        return "bot_protection", "review", "Bot challenge or access restriction prevents validating the current service."
    if status == 403:
        return "blocked", "review", "HTTP 403 is an access restriction; it is not evidence that the service is dead."
    if status == 429:
        return "rate_limited", "review", "HTTP 429 limits this probe; service continuity remains unverified."
    if error:
        return error, "review", "Probe could not establish service continuity; transient failure is not a death verdict."
    if status in (404, 410):
        return "not_found" if status == 404 else "gone", "remove", f"The exact legacy URL returned HTTP {status}; no verified replacement was found."
    if status and status >= 500:
        return "server_error", "review", f"HTTP {status}; retry or manual review is needed, not automatic permanent removal."
    if status and 200 <= status < 300:
        name = re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", item.get("name", "").lower())
        normalized_text = re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", text)
        if name and len(name) >= 2 and name in normalized_text:
            return "redirected" if response.get("redirects") else "healthy", "retain", "Current page contains the historical service name; title and excerpt are retained for editorial review."
        return "needs_review", "review", "HTTP response succeeds, but service identity is not established from the historical name and page evidence."
    return "unknown", "review", "The response does not establish current service identity."


def audit(item):
    start = time.monotonic()
    result = dict(item)
    result["checked_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    try:
        response = fetch_one(item["url"])
        if response.get("error") in ("timeout", "connection_error", "tls_error") or response.get("http_status", 0) in (500, 502, 503, 504):
            result["first_attempt"] = {k: v for k, v in response.items() if not k.startswith("_")}
            time.sleep(0.8)
            response = fetch_one(item["url"])
        health, decision, reason = classify(item, response)
        result.update({"probe": {k: v for k, v in response.items() if not k.startswith("_")},
                       "health_status": health, "suggested_action": decision, "reason": reason})
    except Exception as error:
        result.update({"health_status": "unknown", "suggested_action": "review", "reason": type(error).__name__ + ": " + str(error)[:180]})
    result["duration_seconds"] = round(time.monotonic() - start, 2)
    return result


def scrub_transient_queries(value):
    """Avoid committing ephemeral challenge/session values from third parties."""
    if isinstance(value, dict):
        return {key: scrub_transient_queries(item[:500] if key == 'text_excerpt' and isinstance(item, str) else item[:250] if key == 'meta_description' and isinstance(item, str) else item) for key, item in value.items()}
    if isinstance(value, list):
        return [scrub_transient_queries(item) for item in value]
    if isinstance(value, str) and value.startswith(('http://', 'https://')):
        parts = urllib.parse.urlsplit(value)
        params = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        transient = re.search(r'captcha|antispider|risk_handler|passport\.|challenge', value, re.I)
        sensitive = any(re.search(r'token|signature|secret|session|(^|_)ak$|logid|^ext$|suuid|_rand', key, re.I) for key, _ in params)
        if parts.query and (transient or sensitive):
            return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, '__redacted=transient_challenge', ''))
    if isinstance(value, str) and not value.startswith(('http://', 'https://')):
        value = re.sub(r'(?<![\w.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![\w.])', '[ip-redacted]', value)
        value = re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[email-redacted]', value)
        value = ''.join(char for char in value if char.isprintable() or char in '\n\t')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    source = json.loads(args.source.read_text())
    items = source["items"] if isinstance(source, dict) else source
    results = json.loads(args.output.read_text()) if args.resume and args.output.exists() else []
    done = {x["id"] for x in results}
    remaining = [x for x in items if x["id"] not in done]
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(args.workers, 8))) as pool:
        for result in pool.map(audit, remaining):
            results.append(result)
            args.output.write_text(json.dumps(scrub_transient_queries(results), ensure_ascii=False, indent=2) + "\n")
            print(f'{len(results)}/{len(items)} {result["name"]}: {result["health_status"]}', flush=True)


if __name__ == "__main__":
    main()
