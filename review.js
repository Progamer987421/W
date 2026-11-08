const {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
} = require("discord.js");

module.exports = {
    name: "review",
    description: "Leave a review for our service!",

    async execute(client, interaction) {
        const modal = new ModalBuilder()
            .setCustomId("review")
            .setTitle("Leave a Review ⭐");

        const starsInput = new TextInputBuilder()
            .setCustomId("review_stars")
            .setLabel("Rating (1-5 stars)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("Enter a number from 1 to 5")
            .setMinLength(1)
            .setMaxLength(1)
            .setRequired(true);

        const commentInput = new TextInputBuilder()
            .setCustomId("review_comment")
            .setLabel("Your Review")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("Tell us about your experience...")
            .setMinLength(5)
            .setMaxLength(500)
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(starsInput),
            new ActionRowBuilder().addComponents(commentInput)
        );

        await interaction.showModal(modal);
    },
};
