const MOD_ID = 'bg3-dialogue-system';

Hooks.once('init', () => {
    game.settings.register(MOD_ID, 'npcFolder', {
        name: "NPC Folder Name",
        scope: "world",
        config: true,
        type: String,
        default: "BG3-Dialogue-NPCs"
    });
});

Hooks.once('ready', async () => {
    // Nur der GM führt die Erstellung der Standard-Daten aus
    if (game.user.isGM) {
        await BG3DialogueSystem.checkAndCreateDefaults();
    }

    // Socket Listener
    game.socket.on(`module.${MOD_ID}`, data => {
        if (data.type === "showDialog") {
            new BG3DialogueWindow(data.npcId, data.options).render(true);
        } else if (data.type === "choiceMade" && game.user.isGM) {
            BG3DialogueSystem.processChoice(data);
        }
    });
});

class BG3DialogueSystem {
    static async checkAndCreateDefaults() {
        const folderName = game.settings.get(MOD_ID, 'npcFolder');
        
        // 1. Ordner für NPCs erstellen
        let folder = game.folders.find(f => f.name === folderName && f.type === "Actor");
        if (!folder) {
            folder = await Folder.create({ name: folderName, type: "Actor", color: "#c1a35b" });
            ui.notifications.info(`${MOD_ID}: Ordner ${folderName} wurde erstellt.`);
        }

        // 2. Lore-Journal erstellen
        let journal = game.journal.getName("lore-info");
        if (!journal) {
            journal = await JournalEntry.create({
                name: "lore-info",
                pages: [{
                    name: "Welt-Aufzeichnungen",
                    type: "text",
                    text: { content: "<p>Hier werden die Aufzeichnungen der Spieler hinterlegt. Beispiel: Ishkandrael wurde gefunden.</p>" }
                }]
            });
            ui.notifications.info(`${MOD_ID}: Journal 'lore-info' wurde erstellt.`);
        }

        // 3. Beispiel NSC erstellen
        let exampleNpc = game.actors.find(a => a.name === "Beispiel NSC" && a.folder?.id === folder.id);
        if (!exampleNpc) {
            const exampleDialog = {
                startNode: {
                    text: "Seid gegrüßt! Ich bin ein automatisierter Test-NSC. Habt ihr das Schwert Ishkandrael schon gefunden?",
                    options: [
                        { text: "Ja, wir haben es bei uns.", nextNode: "success" },
                        { text: "Nein, was ist das?", nextNode: "info" }
                    ]
                }
            };

            await Actor.create({
                name: "Beispiel NSC",
                type: "npc",
                folder: folder.id,
                img: `modules/${MOD_ID}/assets/example-portrait.webp`, // Falls vorhanden, sonst Standard
                system: {
                    details: {
                        biography: {
                            value: JSON.stringify(exampleDialog, null, 2)
                        }
                    }
                }
            });
            ui.notifications.info(`${MOD_ID}: Beispiel NSC wurde im Ordner ${folderName} erstellt.`);
        }
    }

    static processChoice(data) {
        const npc = game.actors.get(data.npcId);
        ChatMessage.create({
            content: `<b>${npc.name}:</b> ${data.text}`,
            speaker: ChatMessage.getSpeaker({ actor: npc })
        });
    }
}

// ... Rest der BG3DialogueWindow Klasse bleibt gleich wie zuvor ...