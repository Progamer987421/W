'use strict';

/**
 * getxbl_new.js — Xbox Live SSO for Minecraft
 * Ported from sunnysecure/minecraft/get_xbl.py
 *
 * Handles the full sisu.xboxlive.com SSO hop chain including:
 *   - HTML form extraction + POST forwarding (fixes the 200-instead-of-302 issue)
 *   - CatB overprotective interrupts
 *   - proofs/remind confirmation
 *   - KMSI finish pages
 *   - identity/confirm interrupts
 *   - fido/create skipping
 *   - TOU accrue acceptance
 *   - 7 retries with exponential backoff
 */

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const https = require('https');

const SISU_URL =
    'https://sisu.xboxlive.com/connect/XboxLive/' +
    '?state=login&cobrandId=8058f65d-ce06-4c30-9559-473c9275a65d' +
    '&tid=896928775&ru=https://www.minecraft.net/en-us/login&aid=1142970254';

const MAX_HOPS = 20;
const SEND_OTT_URL = 'https://account.live.com/API/Proofs/SendOtt';

class TransientError extends Error {
    constructor(msg, status = null) {
        super(msg);
        this.status = status;
    }
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function makeSession(cookies = null) {
    const jar = cookies || new CookieJar();
    const instance = wrapper(axios.create({
        jar,
        withCredentials: true,
        maxRedirects: 0,
        validateStatus: s => s >= 100 && s < 600,
        timeout: 45000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        },
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    }));
    instance._jar = jar;
    return instance;
}

async function httpGet(session, url) {
    try {
        const r = await session.get(url);
        return { status: r.status, headers: r.headers, data: r.data || '', url };
    } catch (e) {
        throw new TransientError(`GET ${url.slice(0, 120)} failed: ${e.message}`);
    }
}

async function httpPost(session, url, data, extraHeaders = {}) {
    try {
        const r = await session.post(url, data, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extraHeaders },
        });
        return { status: r.status, headers: r.headers, data: r.data || '', url };
    } catch (e) {
        throw new TransientError(`POST ${url.slice(0, 120)} failed: ${e.message}`);
    }
}

function resolveUrl(base, rel) {
    if (!rel) return base;
    if (rel.startsWith('http')) return rel;
    try { return new URL(rel, base).href; } catch { return rel; }
}

// ─── Token extraction ─────────────────────────────────────────────────────────

function extractAccessToken(str) {
    const m = (str || '').match(/accessToken=([^&#"'\s]+)/);
    return m ? m[1] : null;
}

function tokenFromResponse(resp) {
    for (const candidate of [
        (resp.headers || {})['location'] || '',
        resp.url || '',
        typeof resp.data === 'string' ? resp.data : '',
    ]) {
        const t = extractAccessToken(candidate);
        if (t) return t;
    }
    return null;
}

// ─── HTML parsing helpers ─────────────────────────────────────────────────────

function extractHiddenFields(html) {
    const fields = {};
    const tags = (html || '').match(/<input[^>]+>/gi) || [];
    for (const tag of tags) {
        const nm = tag.match(/name=["']([^"']+)["']/i);
        if (!nm) continue;
        const vm = tag.match(/value=["']([^"']*)["']/i);
        fields[nm[1]] = vm ? vm[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"') : '';
    }
    return fields;
}

function extractFormAction(html, baseUrl) {
    const pats = [
        /<form[^>]*id=["']frmAddProof["'][^>]*action=["']([^"']+)["']/i,
        /<form[^>]*action=["']([^"']+)["']/i,
    ];
    for (const pat of pats) {
        const m = (html || '').match(pat);
        if (m) {
            const action = m[1].replace(/&amp;/g, '&');
            if (action.startsWith('http')) return action;
            return resolveUrl(baseUrl || 'https://login.live.com/', action);
        }
    }
    return null;
}

function cfgStr(html, ...keys) {
    for (const key of keys) {
        let m = (html || '').match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, ''));
        if (m) {
            try { return JSON.parse(`"${m[1]}"`); } catch { return m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/\\"/g, '"'); }
        }
        m = (html || '').match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`, ''));
        if (m) return m[1];
        m = (html || '').match(new RegExp(`(?:^|[,\\s{])${key}\\s*:\\s*'((?:\\\\'|[^'])*)'`));
        if (m) return m[1];
    }
    return null;
}

function findProofOption(html, preferredEmail = null) {
    const options = [...((html || '').matchAll(/value="(OTT\|\|[^"]+)"/gi))].map(m => m[1]);
    if (!options.length) {
        const m = (html || '').match(/name="iProofOptions"[^>]*value="([^"]+)"/i);
        if (m) options.push(m[1]);
    }
    if (!options.length) return null;
    if (preferredEmail) {
        const domain = preferredEmail.split('@')[1]?.toLowerCase() || '';
        const local = preferredEmail.split('@')[0]?.toLowerCase() || '';
        for (const opt of options) {
            const parts = opt.split('||');
            const obs = (parts[1] || '').toLowerCase();
            if (domain && obs.includes(domain) && (!local || obs.startsWith(local.slice(0, 2)))) return opt;
            if (obs.includes(preferredEmail.toLowerCase())) return opt;
        }
    }
    return options[0];
}

function isProofsInterrupt(url, html = '') {
    const u = (url || '').toLowerCase();
    if (['proofs/verify', 'proofs/add', 'proofs/remind', 'overprotective', 'mpcxt=catb'].some(x => u.includes(x))) return true;
    if (html && isAutoSubmitBridge(html, url)) return true;
    if (u.includes('login.live.com') || u.includes('oauth20')) return false;
    const t = (html || '').toLowerCase();
    return ['frmaddproof', 'help us protect your account', 'mpcxt=catb'].some(x => t.includes(x));
}

function isCatbVerify(url, html = '') {
    const u = (url || '').toLowerCase();
    const t = (html || '').toLowerCase();
    if (u.includes('proofs/remind')) return false;
    if (isAutoSubmitBridge(html, url)) return false;
    if (u.includes('mpcxt=catb') || t.includes('mpcxt=catb') || t.includes('"scontext":"catb"')) {
        return u.includes('proofs/verify') || !!findProofOption(html);
    }
    if (u.includes('proofs/verify') && (t.includes('overprotective') || (t.includes('scontext') && t.includes('catb')))) return true;
    return false;
}

function isAutoSubmitBridge(html, pageUrl = '') {
    if (!html) return false;
    const low = html.toLowerCase();
    function actionIsProofs(action) {
        const a = (action || '').toLowerCase();
        return ['proofs/verify', 'proofs/add', 'proofs/remind', 'mpcxt=catb', 'overprotective'].some(x => a.includes(x));
    }
    if (low.includes('dosubmit()') || low.includes('id="fmhf"') || low.includes('name="fmhf"')) {
        const action = extractFormAction(html, pageUrl || 'https://login.live.com/') || '';
        return actionIsProofs(action);
    }
    if (html.length < 5000 && low.includes('pprid') && (low.includes('name="ipt"') || low.includes("name='ipt'"))) {
        const action = extractFormAction(html, pageUrl || 'https://login.live.com/') || '';
        return actionIsProofs(action);
    }
    return false;
}

function ssoPayload(html, baseUrl) {
    const fields = extractHiddenFields(html);
    const action = extractFormAction(html, baseUrl);
    if (!action) return null;
    if (fields.pprid && fields.NAP && fields.ANON && fields.t) {
        return [action, { pprid: fields.pprid, NAP: fields.NAP, ANON: fields.ANON, t: fields.t }];
    }
    if (fields.pprid && (fields.ipt || fields.t)) {
        return [action, fields];
    }
    return null;
}

function kmsiPayload(html) {
    const pageId = (html || '').match(/PageID" content="([^"]+)"/);
    if (pageId && !['i5245', 'i5643'].includes(pageId[1])) return null;
    const urlM = (html || '').match(/"urlPost"\s*:\s*"(https:\/\/[^"]+post\.srf[^"]*)"/);
    const sftM = (html || '').match(/"sFT"\s*:\s*"([^"]+)"/);
    if (urlM && sftM) return [urlM[1], sftM[1]];
    return null;
}

function decodeXbl(accessToken) {
    const padded = accessToken + '='.repeat((4 - accessToken.length % 4) % 4);
    let json;
    try {
        json = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
    } catch (e) {
        throw new TransientError(`accessToken decode failed: ${e.message}`);
    }
    if (!Array.isArray(json) || !json.length) throw new TransientError('decoded XBL token not a list');

    const uhs = json[0]?.Item2?.DisplayClaims?.xui?.[0]?.uhs;
    let xsts = '';
    let gtg = null;
    let xuid = null;
    let playfabxbl = null;
    let purchasingtoken = null;

    for (const item of json) {
        if (item.Item1 === 'rp://api.minecraftservices.com/') xsts = item.Item2?.Token || '';
        if (item.Item1 === 'http://xboxlive.com' && item.Item2?.DisplayClaims?.xui?.length > 0) {
            gtg = item.Item2.DisplayClaims.xui[0]?.gtg;
            xuid = item.Item2.DisplayClaims.xui[0]?.xid;
        }
        if (item.Item1 === 'http://playfab.xboxlive.com/') {
            const secondtoken = item.Item2?.Token;
            playfabxbl = `XBL3.0 x=${uhs};${secondtoken}`;
        }
        if (item.Item1 === 'http://mp.microsoft.com/') {
            const thirdtoken = item.Item2?.Token;
            purchasingtoken = `XBL3.0 x=${uhs};${thirdtoken}`;
        }
    }

    if (!uhs || !xsts) throw new TransientError('decoded XBL token missing uhs/xsts');
    return {
        xbl: `XBL3.0 x=${uhs};${xsts}`,
        gtg,
        xuid,
        playfabxbl,
        purchasingtoken,
    };
}

// ─── Form posting helpers ─────────────────────────────────────────────────────

async function postAutoSubmitBridge(session, html, pageUrl) {
    const sso = ssoPayload(html, pageUrl);
    if (!sso) throw new TransientError(`proofs auto-submit bridge missing pprid/ipt fields url=${pageUrl.slice(0, 160)}`);
    const [action, fields] = sso;
    let resp = await httpPost(session, action, new URLSearchParams(fields).toString());
    for (let i = 0; i < 6; i++) {
        const token = tokenFromResponse(resp);
        if (token) return resp;
        const body = resp.data || '';
        if (body && !isAutoSubmitBridge(body, resp.url || '')) {
            if (isProofsInterrupt(resp.url || '', body) || findProofOption(body)) return resp;
            if (body.includes('sProofData') || body.includes('sNetId')) return resp;
        }
        const loc = resp.headers?.location;
        if (loc) { resp = await httpGet(session, resolveUrl(resp.url || pageUrl, loc)); continue; }
        if (body && isAutoSubmitBridge(body, resp.url || '')) {
            const nested = ssoPayload(body, resp.url || '');
            if (nested) {
                const [a2, f2] = nested;
                resp = await httpPost(session, a2, new URLSearchParams(f2).toString());
                continue;
            }
        }
        break;
    }
    return resp;
}

async function skipProofsRemind(session, html, pageUrl) {
    const fields = extractHiddenFields(html);
    const canary = fields.canary || cfgStr(html, 'canary', 'apiCanary') || '';
    if (!canary) throw new TransientError(`proofs/remind missing canary url=${pageUrl.slice(0, 160)}`);
    const action = extractFormAction(html, pageUrl) || pageUrl;
    const data = {
        ProofFreshnessAction: fields.ProofFreshnessAction || 'LooksGood',
        canary,
    };
    return httpPost(session, action, new URLSearchParams(data).toString());
}

async function skipProofsInterrupt(session, html, pageUrl) {
    if ((pageUrl || '').toLowerCase().includes('proofs/remind')) {
        return skipProofsRemind(session, html, pageUrl);
    }
    const skipM = (html || '').match(/"skip"\s*:\s*\{\s*"url"\s*:\s*"([^"]+)"/) ||
                  (html || '').match(/"skipUrl"\s*:\s*"([^"]+)"/) ||
                  (html || '').match(/"cancel"\s*:\s*\{\s*"url"\s*:\s*"([^"]+)"/);
    if (skipM) {
        const skipUrl = skipM[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
        return httpGet(session, skipUrl);
    }
    let action = extractFormAction(html, pageUrl);
    const fields = extractHiddenFields(html);
    if (!action) {
        if (fields.canary || fields.ProofFreshnessAction) action = pageUrl;
        else throw new TransientError(`proofs interrupt missing form action url=${pageUrl.slice(0, 160)}`);
    }
    fields.action = 'Skip';
    fields.iOttText = fields.iOttText || '';
    const proofOpt = (html || '').match(/name="iProofOptions"[^>]*value="([^"]+)"/i) ||
                     (html || '').match(/value="(OTT\|\|[^"]+)"/i);
    if (proofOpt) {
        fields.iProofOptions = proofOpt[1];
        fields.proof = fields.proof || proofOpt[1];
    }
    if (!fields.canary) {
        const c = cfgStr(html, 'canary', 'apiCanary');
        if (c) fields.canary = c;
    }
    return httpPost(session, action, new URLSearchParams(fields).toString());
}

async function resolveProofsInterrupt(session, html, pageUrl, securityEmail) {
    if (isAutoSubmitBridge(html, pageUrl)) {
        let bridged = await postAutoSubmitBridge(session, html, pageUrl);
        const token = tokenFromResponse(bridged);
        if (token) return bridged;
        html = bridged.data || '';
        pageUrl = bridged.url || pageUrl;
        const loc = bridged.headers?.location;
        if (loc && (!html.trim() || isAutoSubmitBridge(html, pageUrl))) {
            bridged = await httpGet(session, resolveUrl(bridged.url || pageUrl, loc));
            const t2 = tokenFromResponse(bridged);
            if (t2) return bridged;
            html = bridged.data || '';
            pageUrl = bridged.url || pageUrl;
        }
    }

    if ((pageUrl || '').toLowerCase().includes('proofs/remind')) {
        console.log('[~] - proofs/remind during Xbox SSO — confirming Looks good');
        return skipProofsRemind(session, html, pageUrl);
    }

    // CatB — go straight to OTP when we have a security email
    if (securityEmail && isCatbVerify(pageUrl, html) && (findProofOption(html) || cfgStr(html, 'sProofData'))) {
        console.log('[~] - CatB overprotective during Xbox SSO — no OTP handler in JS port, skipping');
        return skipProofsInterrupt(session, html, pageUrl);
    }

    return skipProofsInterrupt(session, html, pageUrl);
}

async function followLocation(session, resp) {
    let current = resp;
    for (let i = 0; i < 8; i++) {
        if (tokenFromResponse(current)) return current;
        const loc = current.headers?.location;
        if (!loc) return current;
        const url = resolveUrl(current.url || '', loc);
        current = await httpGet(session, url);
    }
    return current;
}

// ─── Main SSO hop loop ────────────────────────────────────────────────────────

async function followSisu(session, securityEmail = null) {
    let url = SISU_URL;

    for (let hop = 0; hop < MAX_HOPS; hop++) {
        const resp = await httpGet(session, url);
        const { status, headers, data: body } = resp;
        const pageUrl = url;
        const location = headers?.location || '';

        const token = tokenFromResponse(resp);
        if (token) return decodeXbl(token);

        if ([429, 500, 502, 503, 504].includes(status)) {
            throw new TransientError(`sisu hop status ${status}`, status);
        }

        if (location && isProofsInterrupt(location)) {
            let verify = await httpGet(session, resolveUrl(pageUrl, location));
            const t2 = tokenFromResponse(verify);
            if (t2) return decodeXbl(t2);
            const vloc = verify.headers?.location;
            if (vloc && !(verify.data || '').trim()) {
                verify = await httpGet(session, resolveUrl(verify.url || pageUrl, vloc));
            }
            const resolved = await resolveProofsInterrupt(session, verify.data || '', verify.url || location, securityEmail);
            const t3 = tokenFromResponse(resolved);
            if (t3) return decodeXbl(t3);
            const loc2 = resolved.headers?.location;
            if (loc2) { url = resolveUrl(resolved.url || '', loc2); continue; }
            const body2 = resolved.data || '';
            const pu2 = resolved.url || '';
            if (!isProofsInterrupt(pu2, body2)) {
                const sso2 = ssoPayload(body2, pu2);
                if (sso2) { url = pu2; continue; }
            }
        } else if (location) {
            url = resolveUrl(pageUrl, location);
            continue;
        }

        if (status !== 200 || !body) {
            throw new TransientError(`sisu hop stuck (status=${status} url=${url.slice(0, 160)} no Location)`);
        }

        if (isProofsInterrupt(pageUrl, body)) {
            const resolved = await resolveProofsInterrupt(session, body, pageUrl, securityEmail);
            const t2 = tokenFromResponse(resolved);
            if (t2) return decodeXbl(t2);
            const loc2 = resolved.headers?.location;
            if (loc2) { url = resolveUrl(resolved.url || '', loc2); continue; }
            const body2 = resolved.data || '';
            const pu2 = resolved.url || pageUrl;
            if (isProofsInterrupt(pu2, body2) && !ssoPayload(body2, pu2)) {
                throw new TransientError(`proofs resolve did not continue SSO url=${pu2.slice(0, 160)}`);
            }
            // Fall through with new body
        }

        const sso = ssoPayload(body, pageUrl);
        if (sso) {
            const [action, fields] = sso;
            if (isProofsInterrupt(action)) {
                const post = await httpPost(session, action, new URLSearchParams(fields).toString());
                const t2 = tokenFromResponse(post);
                if (t2) return decodeXbl(t2);
                const loc2 = post.headers?.location;
                let verifyHtml = post.data || '';
                let verifyUrl = post.url || '';
                if (loc2 && isProofsInterrupt(loc2)) {
                    const verify = await httpGet(session, resolveUrl(post.url || '', loc2));
                    const t3 = tokenFromResponse(verify);
                    if (t3) return decodeXbl(t3);
                    verifyHtml = verify.data || '';
                    verifyUrl = verify.url || '';
                } else if (loc2) {
                    url = resolveUrl(post.url || '', loc2);
                    continue;
                }
                const resolved = await resolveProofsInterrupt(session, verifyHtml, verifyUrl, securityEmail);
                const t3 = tokenFromResponse(resolved);
                if (t3) return decodeXbl(t3);
                const loc3 = resolved.headers?.location;
                if (loc3) { url = resolveUrl(resolved.url || '', loc3); continue; }
                throw new TransientError('sisu proofs/Verify SSO did not yield accessToken after resolve');
            }

            let post = await httpPost(session, action, new URLSearchParams(fields).toString());
            const t2 = tokenFromResponse(post);
            if (t2) return decodeXbl(t2);
            const loc2 = post.headers?.location;
            if (loc2) { url = resolveUrl(post.url || '', loc2); continue; }

            if (isAutoSubmitBridge(post.data || '', post.url || '')) {
                const bridged = await postAutoSubmitBridge(session, post.data || '', post.url || '');
                const t3 = tokenFromResponse(bridged);
                if (t3) return decodeXbl(t3);
                const locb = bridged.headers?.location;
                if (locb) { url = resolveUrl(bridged.url || '', locb); continue; }
                post = bridged;
            }

            const sso2 = ssoPayload(post.data || '', post.url || '');
            if (sso2) {
                const [action2, fields2] = sso2;
                const post2 = await httpPost(session, action2, new URLSearchParams(fields2).toString());
                const t3 = tokenFromResponse(post2);
                if (t3) return decodeXbl(t3);
                const loc3 = post2.headers?.location;
                if (loc3) { url = resolveUrl(post2.url || '', loc3); continue; }
            }

            // Follow up interrupts (TOU, fido, etc.)
            for (let step = 0; step < 5; step++) {
                const pu = post.url || '';
                const pb = post.data || '';
                if (pu.toLowerCase().includes('tou/accrue')) {
                    const canary = cfgStr(pb, 'sCanary', 'apiCanary');
                    const authToken = cfgStr(pb, 'sAuthenticationToken');
                    if (canary && authToken) {
                        post = await httpPost(session, pu, new URLSearchParams({ canary, sCanary: canary, sAuthenticationToken: authToken, accept: 'Yes' }).toString(), { canary });
                    } else break;
                } else if (pu.toLowerCase().includes('fido/create') || pb.includes('CreateFido')) {
                    const postBackM = pb.match(/name=['"]postBackUrl['"]\s+value=['"]([^'"]+)['"]/i) || pb.match(/"postBackUrl"\s*:\s*"([^"]+)"/);
                    if (postBackM) {
                        const target = postBackM[1].replace(/&amp;/g, '&');
                        const ruM = target.match(/[?&]ru=([^&"']+)/);
                        if (ruM) { post = await httpGet(session, decodeURIComponent(ruM[1])); }
                        else break;
                    } else break;
                } else {
                    const fAction = extractFormAction(pb, pu);
                    const fFields = extractHiddenFields(pb);
                    if (!fAction || !Object.keys(fFields).length) break;
                    post = await httpPost(session, fAction, new URLSearchParams(fFields).toString());
                }
                const t3 = tokenFromResponse(post);
                if (t3) return decodeXbl(t3);
                const locStep = post.headers?.location;
                if (locStep) { url = resolveUrl(post.url || '', locStep); break; }
            }
            if (post.headers?.location) continue;

            const pageId2 = (post.data || '').match(/PageID" content="([^"]+)"/);
            const title2M = (post.data || '').match(/<title[^>]*>(.*?)<\/title>/is);
            const title2 = title2M ? title2M[1].replace(/\s+/g, ' ').trim().slice(0, 80) : '?';
            throw new TransientError(
                `sisu SSO form did not yield accessToken (status=${post.status} pageId=${pageId2?.[1] || null} title=${title2} url=${(post.url || '').slice(0, 160)})`
            );
        }

        const kmsi = kmsiPayload(body);
        if (kmsi) {
            const [urlPost, sft] = kmsi;
            const post = await httpPost(session, urlPost, `PPFT=${encodeURIComponent(sft)}&canary=&LoginOptions=3&type=28&hpgrequestid=&ctx=`);
            const t2 = tokenFromResponse(post);
            if (t2) return decodeXbl(t2);
            const loc2 = post.headers?.location;
            if (loc2) { url = resolveUrl(post.url || '', loc2); continue; }
            throw new TransientError('sisu KMSI did not yield accessToken');
        }

        const sidM = (pageUrl + body).match(/[?&#]sid=([A-Za-z0-9]+)/);
        if (sidM && pageUrl.includes('sisu.xboxlive.com/client/')) {
            const proxyUrl = 'https://sisu.xboxlive.com/proxy?sessionid=' + sidM[1];
            const proxied = await httpGet(session, proxyUrl);
            const t2 = tokenFromResponse(proxied);
            if (t2) return decodeXbl(t2);
            const locp = proxied.headers?.location;
            if (locp) { url = resolveUrl(proxied.url || '', locp); continue; }
        }

        const pageId = (body || '').match(/PageID" content="([^"]+)"/);
        const titleM = (body || '').match(/<title[^>]*>(.*?)<\/title>/is);
        const title = titleM ? titleM[1].replace(/\s+/g, ' ').trim().slice(0, 80) : '?';
        throw new TransientError(
            `sisu hop got HTML without Location/form (status=${status} pageId=${pageId?.[1] || null} title=${title} url=${pageUrl.slice(0, 160)})`
        );
    }

    throw new TransientError(`sisu exceeded ${MAX_HOPS} hops without accessToken`);
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────

async function withRetries(label, fn, attempts = 7, baseDelay = 4000) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const result = await fn();
            return result;
        } catch (e) {
            console.error(`${label} attempt ${attempt}/${attempts} failed: ${e.message}`);
            if (attempt >= attempts) return null;
            await new Promise(r => setTimeout(r, baseDelay * attempt));
        }
    }
    return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * getXblDirect(host, securityEmail)
 *
 * @param {string} host - The Microsoft auth host cookie value (passed to session)
 * @param {string|null} securityEmail - Security email for CatB OTP challenges
 * @returns {Promise<{xbl, gtg, xuid, playfabxbl, purchasingtoken}|null>}
 */
async function getXblDirect(host, securityEmail = null) {
    const session = makeSession();
    if (host) {
        try {
            await session._jar.setCookie(`__Host-MSAAUTH=${host}`, 'https://sisu.xboxlive.com');
        } catch {}
    }
    return withRetries('getXblDirect', () => followSisu(session, securityEmail));
}

module.exports = { getXblDirect };
