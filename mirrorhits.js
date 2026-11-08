const axios = require('axios');
const config = require('../../../config.json');

/**
 * Mirrors a hit embed/message to the main hits feed with extra context.
 * - Adds Server (name + id) and Owner (bot owner id mention) fields.
 * - Adds Split Mode info if applicable.
 * - Removes interactive components to keep the global feed clean.
 * - Supports either a Discord channel ID (mainHitsChannel) or a webhook (mainHitsWebhook).
 *
 * @param {import('discord.js').Client} client
 * @param {object} messageObj The original message payload (e.g., from listAccount): { embeds, components, ... }
 * @param {import('discord.js').Interaction} interaction For guild/name context and attribution
 * @param {object} splitInfo Optional split mode info: { shouldSplit, ownerId, ratio }
 */
async function mirrorToMainHits(client, messageObj, interaction, splitInfo = null) {
  try {
    const channelId = config.mainHitsChannel;
    const webhookUrl = config.mainHitsWebhook;
    if (!channelId && !webhookUrl) return; // not configured

    // Clone original message and add extra info
    const cloned = JSON.parse(JSON.stringify(messageObj || {}));
    cloned.embeds = cloned.embeds || [];
    if (cloned.embeds.length === 0) cloned.embeds.push({});

    const emb = cloned.embeds[0];
    emb.fields = emb.fields || [];

    const serverName = interaction?.guild?.name || 'Unknown Server';
    const serverId = interaction?.guild?.id || '?';
    const ownerId = client?.username || 'unknown'; // this project stores owner id on client.username

    // Push extra fields
    emb.fields.push(
      { name: 'Server', value: `\`${serverName} (${serverId})\``, inline: true },
      { name: 'Owner', value: `<@${ownerId}> (\`${ownerId}\`)`, inline: true }
    );

    // Add split mode info if available
    if (splitInfo) {
      if (splitInfo.shouldSplit && splitInfo.ownerId) {
        emb.fields.push({ 
          name: '🔀 Split Mode', 
          value: `✅ Sent to <@${splitInfo.ownerId}> (1:${splitInfo.ratio})`, 
          inline: false 
        });
        // Add a color indicator for split accounts
        if (!emb.color) emb.color = 0x9B59B6; // Purple for split accounts
      } else if (splitInfo.ratio) {
        emb.fields.push({ 
          name: '🔀 Split Mode', 
          value: `⏳ Counting (1:${splitInfo.ratio})`, 
          inline: false 
        });
      }
    }

    // Tag footer so you can distinguish mirrored posts
    emb.footer = emb.footer || {};
    emb.footer.text = emb.footer.text ? `${emb.footer.text} • mirrored` : 'mirrored';

    // Remove components to avoid cross-server action buttons
    delete cloned.components;

    if (channelId) {
      const chan = client.channels.cache.get(channelId);
      if (chan) {
        await chan.send(cloned);
        return;
      }
      console.warn(`mirrorToMainHits: mainHitsChannel ${channelId} not found in cache`);
    }

    if (webhookUrl) {
      await axios.post(webhookUrl, cloned);
      return;
    }
  } catch (err) {
    console.error('mirrorToMainHits failed:', err?.response?.data || err?.message || err);
  }
}

module.exports = { mirrorToMainHits };
