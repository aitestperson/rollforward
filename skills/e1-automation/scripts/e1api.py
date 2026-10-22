#!/usr/bin/env python3
"""Client for the E1 automation HTTP API (standard library only, so any agent can run it).

    python e1api.py health
    python e1api.py functions
    python e1api.py describe ap.xts_dncn_attachments
    python e1api.py run ap.xts_dncn_attachments --params '{"dncn_no": "AABOD26003"}' --download out
    python e1api.py run ap.standard_voucher_entry --params-file voucher.json            # dry run
    python e1api.py template ap.standard_voucher_entry vouchers.xlsx
    python e1api.py batch ap.xts_dncn_attachments dncn.xlsx --download out
    python e1api.py job <job id> --wait
    python e1api.py download <job id> out
    python e1api.py cancel <job id>

Settings (environment): E1AUTO_URL (default http://127.0.0.1:8765), E1AUTO_API_KEY; when the key is
not set it is read from E1AUTO_ENV_FILE (default: the e1_automation project's .env).
Output is JSON on stdout; the exit code is 0 when the call (and the job) succeeded.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path
from typing import Any

DEFAULT_URL = "http://127.0.0.1:8765"
DEFAULT_ENV_FILE = Path(r"C:\Users\v-GodtreeGao\files\ai_project\e1_automation\.env")
FINAL_STATES = {"succeeded", "partial", "failed", "cancelled"}
WAIT_SLICE_S = 60          # one long-poll request; repeated until the job ends or --timeout passes
DEFAULT_TIMEOUT_S = 1800
HTTP_TIMEOUT_S = WAIT_SLICE_S + 30


class ApiError(RuntimeError):
    def __init__(self, status: int, detail: Any):
        self.status, self.detail = status, detail
        super().__init__(f"HTTP {status}: {detail}")


def _key_from_env_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        name, sep, value = line.partition("=")
        if sep and name.strip() == "E1_API_KEY":
            return value.strip().strip("'\"") or None
    return None


class Client:
    def __init__(self, base_url: str | None = None, api_key: str | None = None):
        self.base_url = (base_url or os.environ.get("E1AUTO_URL") or DEFAULT_URL).rstrip("/")
        env_file = Path(os.environ.get("E1AUTO_ENV_FILE") or DEFAULT_ENV_FILE)
        self.api_key = api_key or os.environ.get("E1AUTO_API_KEY") or _key_from_env_file(env_file)

    # ------------------------------------------------------------------ HTTP
    def _request(self, method: str, path: str, *, query: dict | None = None, body: bytes | None = None,
                 content_type: str | None = None, raw: bool = False, timeout: float = HTTP_TIMEOUT_S) -> Any:
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        headers = {"Accept": "application/json"}
        if self.api_key:
            headers["X-API-Key"] = self.api_key
        if content_type:
            headers["Content-Type"] = content_type
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
        except urllib.error.HTTPError as ex:
            text = ex.read().decode("utf-8", "replace")
            try:
                detail = json.loads(text).get("detail", text)
            except (ValueError, AttributeError):
                detail = text
            raise ApiError(ex.code, detail) from None
        if raw:
            return data
        return json.loads(data.decode("utf-8")) if data else None

    def _json(self, method: str, path: str, payload: Any, query: dict | None = None) -> Any:
        return self._request(method, path, query=query, body=json.dumps(payload).encode("utf-8"),
                             content_type="application/json")

    # ------------------------------------------------------------------ API
    def health(self) -> dict:
        return self._request("GET", "/healthz")

    def functions(self) -> list[dict]:
        return self._request("GET", "/api/functions")

    def describe(self, name: str) -> dict:
        return self._request("GET", f"/api/functions/{urllib.parse.quote(name)}")

    def run(self, name: str, params: dict) -> dict:
        return self._json("POST", f"/api/functions/{urllib.parse.quote(name)}/run", {"params": params})

    def batch(self, name: str, excel: Path, dry_run: bool | None = None, stop_on_error: bool = False,
              sheet: str | None = None) -> dict:
        fields: dict[str, str] = {"stop_on_error": str(stop_on_error).lower()}
        if dry_run is not None:
            fields["dry_run"] = str(dry_run).lower()
        if sheet:
            fields["sheet"] = sheet
        body, content_type = _multipart(fields, "file", excel)
        return self._request("POST", f"/api/functions/{urllib.parse.quote(name)}/batch", body=body,
                             content_type=content_type)

    def job(self, job_id: str, wait: bool = False, timeout: float = WAIT_SLICE_S) -> dict:
        query = {"wait": "true", "timeout": timeout} if wait else None
        return self._request("GET", f"/api/jobs/{job_id}", query=query, timeout=timeout + 30)

    def wait(self, job_id: str, timeout: float = DEFAULT_TIMEOUT_S) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            job = self.job(job_id, wait=True, timeout=min(WAIT_SLICE_S, max(1.0, deadline - time.monotonic())))
            if job["state"] in FINAL_STATES or time.monotonic() >= deadline:
                return job

    def cancel(self, job_id: str) -> dict:
        return self._request("POST", f"/api/jobs/{job_id}/cancel")

    def template(self, name: str, out: Path) -> Path:
        out.write_bytes(self._request("GET", f"/api/functions/{urllib.parse.quote(name)}/template.xlsx", raw=True))
        return out

    def download(self, job_id: str, dest: Path) -> list[str]:
        """All files of a finished job, unpacked into ``dest`` (folder structure kept)."""
        dest.mkdir(parents=True, exist_ok=True)
        archive = dest / f"{job_id}.zip"
        archive.write_bytes(self._request("GET", f"/api/jobs/{job_id}/files.zip", raw=True))
        root = dest.resolve()
        with zipfile.ZipFile(archive) as z:
            for member in z.namelist():
                if not (root / member).resolve().is_relative_to(root):
                    raise ApiError(0, f"unsafe path in archive: {member}")
            z.extractall(dest)
            names = z.namelist()
        archive.unlink()
        return [str(dest / n) for n in names]


def _multipart(fields: dict[str, str], file_field: str, path: Path) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    filename = path.name.replace('"', "")
    parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'
                  "Content-Type: application/octet-stream\r\n\r\n").encode("utf-8") + path.read_bytes() + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


# ---------------------------------------------------------------------- command line
def _params(args: argparse.Namespace) -> dict:
    params: dict = {}
    if args.params_file:
        params.update(json.loads(Path(args.params_file).read_text(encoding="utf-8")))
    if args.params:
        params.update(json.loads(args.params))
    return params


def _finish(client: Client, job: dict, args: argparse.Namespace) -> dict:
    if getattr(args, "wait", True) and job["state"] not in FINAL_STATES:
        job = client.wait(job["id"], timeout=args.timeout)
    if getattr(args, "download", None) and job["state"] in FINAL_STATES:
        job["downloaded"] = client.download(job["id"], Path(args.download))
    return job


def _job_ok(job: dict) -> bool:
    if job.get("state") not in ("succeeded",):
        return False
    status = (job.get("result") or {}).get("status")
    return status is None or status in ("ok", "no_data", "validated", "skipped")


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="E1 automation HTTP API client")
    parser.add_argument("--url", help="service URL (default E1AUTO_URL or http://127.0.0.1:8765)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("health")
    sub.add_parser("functions")
    p = sub.add_parser("describe")
    p.add_argument("name")
    p = sub.add_parser("run")
    p.add_argument("name")
    p.add_argument("--params", help="JSON object")
    p.add_argument("--params-file", help="JSON file")
    p.add_argument("--no-wait", dest="wait", action="store_false")
    p.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_S)
    p.add_argument("--download", metavar="DIR", help="unpack the job's files into DIR")
    p = sub.add_parser("batch")
    p.add_argument("name")
    p.add_argument("excel")
    p.add_argument("--commit", action="store_true", help="really save (data-entry functions; UAT only)")
    p.add_argument("--stop-on-error", action="store_true")
    p.add_argument("--sheet")
    p.add_argument("--no-wait", dest="wait", action="store_false")
    p.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_S)
    p.add_argument("--download", metavar="DIR")
    p = sub.add_parser("job")
    p.add_argument("job_id")
    p.add_argument("--wait", action="store_true")
    p.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_S)
    p = sub.add_parser("download")
    p.add_argument("job_id")
    p.add_argument("dest")
    p = sub.add_parser("cancel")
    p.add_argument("job_id")
    p = sub.add_parser("template")
    p.add_argument("name")
    p.add_argument("out")
    args = parser.parse_args(argv)

    client = Client(args.url)
    ok = True
    try:
        if args.command == "health":
            out: Any = client.health()
        elif args.command == "functions":
            out = [{k: f[k] for k in ("name", "title", "menu", "changes_data", "description")} for f in client.functions()]
        elif args.command == "describe":
            out = client.describe(args.name)
        elif args.command == "run":
            out = _finish(client, client.run(args.name, _params(args)), args)
            ok = _job_ok(out) if args.wait else True  # --no-wait: accepted is success
        elif args.command == "batch":
            out = _finish(client, client.batch(args.name, Path(args.excel), dry_run=False if args.commit else None,
                                               stop_on_error=args.stop_on_error, sheet=args.sheet), args)
            ok = out["state"] == "succeeded" if args.wait else True
        elif args.command == "job":
            out = client.wait(args.job_id, args.timeout) if args.wait else client.job(args.job_id)
        elif args.command == "download":
            out = client.download(args.job_id, Path(args.dest))
        elif args.command == "cancel":
            out = client.cancel(args.job_id)
        else:
            out = str(client.template(args.name, Path(args.out)))
    except ApiError as ex:
        sys.stdout.write(json.dumps({"error": ex.status, "detail": ex.detail}, ensure_ascii=False, indent=1) + "\n")
        return 2
    except urllib.error.URLError as ex:
        sys.stdout.write(json.dumps({"error": "unreachable", "detail": str(ex.reason),
                                     "hint": "is the service running? (docker compose up -d in the project)"},
                                    ensure_ascii=False, indent=1) + "\n")
        return 3
    sys.stdout.write(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
