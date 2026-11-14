/**
 * getxbl3.js — XBL3.0 token + SSID fetcher
 *
 * Calls the FrostSecure Python XBL bridge (xbl_bridge.py) running at
 * http://127.0.0.1:7749 instead of the broken Node.js PKCE/SISU flow.
 *
 * The bridge handles:
 *  - Full SISU hop loop
 *  - CatB overprotective OTP challenges
 *  - identity/confirm challenges
 *  - PKCE (dynamic code_verifier/challenge)
 *  - Retry with backoff
 */

const axios = require('axios');

const BRIDGE_URL = 'http://127.0.0.1:7749';
const BRIDGE_TIMEOUT = 180_000; // 3 minutes — SISU + OTP can be slow

/**
 * Get XBL3.0 token and Minecraft SSID from Microsoft session cookies.
 *
 * @param {string|null} rawCookies - Raw "name=value; name2=value2" cookie string from Microsoft login
 * @param {string|null} securityEmail - Security email for CatB OTP (optional but recommended)
 * @returns {{ xbl: string, gtg: string|null, ssid: string|null }}
 */
async function getXbl3AndSsid(rawCookies, securityEmail = null) {
  const resp = await axios.post(
    `${BRIDGE_URL}/get-xbl`,
    {
      cookies: rawCookies || null,
      security_email: securityEmail || null,
    },
    { timeout: BRIDGE_TIMEOUT }
  );

  const { xbl, gtg, ssid } = resp.data;

  if (!xbl) {
    throw new Error('XBL bridge returned no xbl token');
  }

  return { xbl, gtg: gtg || null, ssid: ssid || null };
}

/**
 * Get Minecraft SSID (access token) from an XBL3.0 string.
 *
 * @param {string} xbl - "XBL3.0 x=uhs;token"
 * @returns {string} Minecraft access token
 */
async function getSsidFromXbl(xbl) {
  const resp = await axios.post(
    `${BRIDGE_URL}/get-ssid`,
    { xbl },
    { timeout: 60_000 }
  );

  const { ssid } = resp.data;
  if (!ssid) {
    throw new Error('XBL bridge returned no ssid');
  }
  return ssid;
}

/**
 * Check the bridge is running.
 */
async function checkBridge() {
  try {
    const resp = await axios.get(`${BRIDGE_URL}/health`, { timeout: 3000 });
    return resp.data?.ok === true;
  } catch {
    return false;
  }
}

module.exports = {
  getXbl3AndSsid,
  getSsidFromXbl,
  checkBridge,
};
