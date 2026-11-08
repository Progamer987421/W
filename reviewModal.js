const { EmbedBuilder } = require("discord.js");

const REVIEW_CHANNEL_ID = "1569007966814736384";

const STAR_MAP = {
    1: "⭐",
    2: "⭐⭐",
    3: "⭐⭐⭐",
    4: "⭐⭐⭐⭐",
    5: "⭐⭐⭐⭐⭐",
};

const COLOR_MAP = {
    1: 0xff3c3c,
    2: 0xff8c00,
    3: 0xf5c518,
    4: 0x7cfc00,
    5: 0x39ff14,
};

module.exports = {
    name: "review",

    async callback(client, interaction) {
        const starsRaw = interaction.fields.getTextInputValue("review_stars").trim();
        const comment  = interaction.fields.getTextInputValue("review_comment").trim();

        const stars = parseInt(starsRaw);

        // Validate star input
        if (isNaN(stars) || stars < 1 || stars > 5) {
            return interaction.reply({
                content: "❌ Invalid rating. Please enter a number between **1** and **5**.",
                ephemeral: true,
            });
        }

        const starDisplay = STAR_MAP[stars];
        const color       = COLOR_MAP[stars];
        const user        = interaction.user;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setAuthor({
                name:    `${user.username}`,
                iconURL: user.displayAvatarURL({ dynamic: true }),
            })
            .setTitle(`New Review ${starDisplay}`)
            .addFields(
                { name: "Rating",   value: `${starDisplay} (${stars}/5)`,         inline: false },
                { name: "Review",   value: `\`\`\`${comment}\`\`\``,              inline: false },
                { name: "User",     value: `<@${user.id}> \`${user.id}\``,        inline: false },
            )
            .setFooter({ text: `Review submitted` })
            .setTimestamp();

        try {
            const channel = await client.channels.fetch(REVIEW_CHANNEL_ID).catch(() => null);

            if (!channel) {
                return interaction.reply({
                    content: "❌ Review channel not found. Please contact an admin.",
                    ephemeral: true,
                });
            }

            await channel.send({ embeds: [embed] });

            await interaction.reply({
                content: `✅ Thank you for your review, **${user.username}**! ${starDisplay}`,
                ephemeral: true,
            });

        } catch (e) {
            console.error("Review modal error:", e);
            await interaction.reply({
                content: "❌ Something went wrong submitting your review. Try again later.",
                ephemeral: true,
            });
        }
    },
};
