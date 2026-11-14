/**
 * getssid.js — Minecraft SSID via FrostSecure XBL bridge
 *
 * Drop-in replacement for the old getssid.js.
 * Calls http://127.0.0.1:7749/get-ssid (xbl_bridge.py).
 */

const axios = require('axios');

const BRIDGE_URL = 'http://127.0.0.1:7749';

async function getssid(xbl) {
  if (!xbl || typeof xbl !== 'string') {
    throw new Error('getssid: xbl token is required');
  }

  // Normalize to XBL3.0 format just in case
  let token = xbl.trim();
  if (!token.startsWith('XBL3.0')) {
    token = `XBL3.0 x=${token}`;
  }

  console.log('[getssid] calling bridge with xbl:', token.substring(0, 40) + '...');

  const resp = await axios.post(
    `${BRIDGE_URL}/get-ssid`,
    { xbl: token },
    { timeout: 60_000 }
  );

  const ssid = resp.data?.ssid;
  if (!ssid) {
    throw new Error('getssid: bridge returned no ssid');
  }

  console.log('[getssid] got ssid:', ssid.substring(0, 20) + '...');
  return ssid;
}

module.exports = getssid;
