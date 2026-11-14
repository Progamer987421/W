"""
XBL Bridge Microservice
Runs at http://127.0.0.1:7749
Called by autosecure Node.js bot to get XBL3.0 token and SSID.

POST /get-xbl
  Body: { "cookies": "<raw cookie string>", "security_email": "<email>|null" }
  Returns: { "xbl": "XBL3.0 x=...", "gtg": "...", "ssid": "..." }

POST /get-ssid
  Body: { "xbl": "XBL3.0 x=..." }
  Returns: { "ssid": "..." }

GET /health
  Returns: { "ok": true }
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import os

# Must run from frostsecure root so imports resolve
sys.path.insert(0, os.path.dirname(__file__))

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import httpx
import uvicorn

from minecraft.get_xbl import get_xbl
from minecraft.get_ssid import get_ssid
from securing.auth.initial_session import get_session

logging.basicConfig(level=logging.INFO, format="[xbl_bridge] %(levelname)s %(message)s")
log = logging.getLogger(__name__)

app = FastAPI()


class XblRequest(BaseModel):
    cookies: str | None = None          # raw "name=value; name2=value2" cookie string
    security_email: str | None = None   # used for CatB OTP challenges


class SsidRequest(BaseModel):
    xbl: str                            # "XBL3.0 x=uhs;token"


def _parse_cookies(raw: str | None) -> httpx.Cookies:
    """Parse a raw 'name=value; name2=value2' cookie string into httpx.Cookies."""
    cookies = httpx.Cookies()
    if not raw:
        return cookies
    for part in raw.split(";"):
        part = part.strip()
        if "=" in part:
            name, _, value = part.partition("=")
            cookies.set(name.strip(), value.strip())
    return cookies


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/get-xbl")
async def get_xbl_endpoint(req: XblRequest):
    """
    Given Microsoft session cookies, run the full SISU XBL flow and return
    XBL3.0 token + SSID (Minecraft access token).
    """
    log.info("get-xbl called security_email=%s", req.security_email)

    cookies = _parse_cookies(req.cookies)
    session = get_session(cookies=cookies)

    try:
        result = await get_xbl(session, security_email=req.security_email or None)
    except Exception as e:
        log.exception("get_xbl failed")
        raise HTTPException(status_code=500, detail=f"get_xbl error: {str(e)}")
    finally:
        await session.aclose()

    if not result:
        raise HTTPException(status_code=502, detail="get_xbl returned None — SISU flow failed")

    xbl_str = result.get("xbl")
    gtg = result.get("gtg")

    if not xbl_str:
        raise HTTPException(status_code=502, detail="get_xbl missing xbl token in result")

    # Also get SSID (Minecraft access token) right away
    ssid = None
    try:
        ssid = await get_ssid(xbl_str)
    except Exception as e:
        log.warning("get_ssid failed after get_xbl: %s", e)

    return {
        "xbl": xbl_str,
        "gtg": gtg,
        "ssid": ssid,
    }


@app.post("/get-ssid")
async def get_ssid_endpoint(req: SsidRequest):
    """
    Given an XBL3.0 token string, get the Minecraft SSID (access token).
    """
    log.info("get-ssid called")
    try:
        ssid = await get_ssid(req.xbl)
    except Exception as e:
        log.exception("get_ssid failed")
        raise HTTPException(status_code=500, detail=f"get_ssid error: {str(e)}")

    if not ssid:
        raise HTTPException(status_code=502, detail="get_ssid returned None — login_with_xbox failed")

    return {"ssid": ssid}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=7749, log_level="info")
