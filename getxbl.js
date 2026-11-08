
const atob = require('atob');
const HttpClient = require('../process/HttpClient');

async function getxbl(host) {
    const http = new HttpClient();
    
    try {
        const loginRedirectUrl = "https://sisu.xboxlive.com/connect/XboxLive/?state=login&cobrandId=8058f65d-ce06-4c30-9559-473c9275a65d&tid=896928775&ru=https://www.minecraft.net/en-us/login&aid=1276276335";
        const loginRedirect = await http.get(loginRedirectUrl, {
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400
        });
        
        if (!loginRedirect?.headers?.location) {
            console.error("No redirect location in initial login");
            return false;
        }

        http.setCookie(`__Host-MSAAUTH=${host}`);
        const accessTokenRedirect = await http.get(loginRedirect.headers.location, {
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400
        });
        
        if (!accessTokenRedirect?.headers?.location) {
            console.error("No redirect location in auth step");
            return false;
        }

        const extractAccessToken = await http.get(accessTokenRedirect.headers.location, {
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400
        });
        
        const tokenMatch = extractAccessToken?.headers?.location?.match(/accessToken=([^&]*)/);
        const accessToken = tokenMatch?.[1];
        
        if (!accessToken) {
            console.error("No access token found in redirect");
            return false;
        }

        let json;
        try {
            json = JSON.parse(atob(accessToken));
        } catch (e) {
            console.error("Failed to decode token:", e.message);
            return false;
        }

        const uhs = json[0]?.Item2?.DisplayClaims?.xui[0]?.uhs;
        if (!uhs) {
            console.error("Missing UHS");
            return false;
        }

        let xsts = "";
        for (const item of Object.values(json)) {
            if (item?.Item1 === "rp://api.minecraftservices.com/") {
                xsts = item?.Item2?.Token;
                break;
            }
        }

        if (!xsts) {
            console.error("Missing XSTS");
            return false;
        }

        let gtg = null;
        for (const item of Object.values(json)) {
            if (item?.Item1 === "http://xboxlive.com" && item?.Item2?.DisplayClaims?.xui?.length > 0) {
                gtg = item.Item2.DisplayClaims.xui[0]?.gtg;
                break;
            }
        }

        return {
            xbl: `XBL3.0 x=${uhs};${xsts}`,
            gtg: gtg || undefined
        };

    } catch (e) {
        console.error("Error in xbl", e.message);
        return false;
    }
}


module.exports = {
    getxbl
};