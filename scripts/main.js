const MOD_ID = 'bg3-dialogue-system';

Hooks.once('init', () => {
    // Registrierung der Welt-Einstellungen
    game.settings.register(MOD_ID, 'npcFolder', {
        name: "NPC Folder Name",
        scope: "world",
        config: true,
        type: String,
        default: "BG3-Dialogue-NPCs"
    });
});

Hooks.once('ready', async () => {
    // GM erstellt Standard-Ordner und Journale
    if (game.user.isGM) {
        await BG3DialogueSystem.checkAndCreateDefaults();
    }

    // Socket-Handler für eingehende Nachrichten
    game.socket.on(`module.${MOD_ID}`, data => {
        if (data.type === "showDialog" && game.user.id === data.receiverId) {
            new BG3DialogueWindow(data.npcId, data.options).render(true);
        } else if (data.type === "choiceMade" && game.user.isGM) {
            BG3DialogueSystem.processChoice(data);
        }
    });
});

// Integration in die linke Werkzeugleiste (Scene Controls)
Hooks.on('getSceneControlButtons', (controls) => {
    if (!game.user.isGM) return;

    controls.push({
        name: "bg3-dialogue",
        title: "BG3 Dialogue System",
        icon: "fas fa-comments",
        layer: "tokens", // Muss ein existierender Layer sein (tokens, notes, etc.)
        visible: true,
        tools: [
            {
                name: "start-bg3-conv",
                title: "Gespräch starten",
                icon: "fas fa-play",
                onClick: () => BG3DialogueSystem.showSelectionDialog(),
                button: true
            }
        ]
    });
});

class BG3DialogueSystem {
    static async checkAndCreateDefaults() {
        const folderName = game.settings.get(MOD_ID, 'npcFolder');
        let folder = game.folders.find(f => f.name === folderName && f.type === "Actor");
        if (!folder) {
            folder = await Folder.create({ name: folderName, type: "Actor", color: "#c1a35b" });
        }

        let journal = game.journal.getName("lore-info");
        if (!journal) {
            await JournalEntry.create({
                name: "lore-info",
                pages: [{ name: "Welt-Aufzeichnungen", type: "text", text: { content: "Hier Lore-Einträge hinterlegen." }}]
            });
        }
    }

    static showSelectionDialog() {
        const folderName = game.settings.get(MOD_ID, 'npcFolder');
        const folder = game.folders.find(f => f.name === folderName && f.type === "Actor");
        
        if (!folder) return ui.notifications.error(`Ordner '${folderName}' wurde nicht gefunden.`);

        const npcs = game.actors.filter(a => a.folder?.id === folder.id);
        const players = game.users.filter(u => u.active && !u.isGM);

        if (npcs.length === 0) return ui.notifications.warn("Keine NPCs im BG3-Ordner.");
        if (players.length === 0) return ui.notifications.warn("Keine aktiven Spieler online.");

        let npcOptions = npcs.map(n => `<option value="${n.id}">${n.name}</option>`).join("");
        let playerOptions = players.map(p => `<option value="${p.id}">${p.name}</option>`).join("");

        new Dialog({
            title: "BG3 Gesprächskonfiguration",
            content: `
                <form>
                    <div class="form-group"><label>NPC:</label><select name="npcId">${npcOptions}</select></div>
                    <div class="form-group"><label>Spieler:</label><select name="playerId">${playerOptions}</select></div>
                </form>`,
            buttons: {
                go: {
                    label: "Senden",
                    callback: (html) => {
                        const npcId = html.find('[name="npcId"]').val();
                        const playerId = html.find('[name="playerId"]').val();
                        this.initiateDialogue(npcId, playerId);
                    }
                }
            }
        }).render(true);
    }

    static async initiateDialogue(npcId, userId) {
        const npc = game.actors.get(npcId);
        let bioValue = npc.system.details.biography.value || "";
        
        // Bereinigung des JSON-Strings von HTML-Tags
        const rawJson = bioValue.replace(/(<([^>]+)>)/gi, "").trim();
        
        try {
            const dialogData = JSON.parse(rawJson);
            game.socket.emit(`module.${MOD_ID}`, {
                type: "showDialog",
                npcId: npcId,
                receiverId: userId,
                options: dialogData.startNode
            });
            // GM sieht das Fenster als Observer
            new BG3DialogueWindow(npcId, dialogData.startNode, true).render(true);
        } catch (e) {
            console.error(e);
            ui.notifications.error("Das Biografie-Feld des NPCs enthält kein gültiges JSON.");
        }
    }

    static processChoice(data) {
        const npc = game.actors.get(data.npcId);
        ChatMessage.create({
            content: `<b>${npc.name}:</b> ${data.text}`,
            speaker: { alias: npc.name }
        });
    }
}

class BG3DialogueWindow extends Application {
    constructor(npcId, data, isObserver = false) {
        super();
        this.npc = game.actors.get(npcId);
        this.dialogData = data;
        this.isObserver = isObserver;
    }

    static get defaultOptions() {
        return mergeObject(super.defaultOptions, {
            id: "bg3-dialog-ui",
            template: `modules/${MOD_ID}/templates/dialog.html`,
            width: 700,
            height: "auto",
            popOut: true,
            title: "Gespräch"
        });
    }

    getData() {
        return {
            npcName: this.npc.name,
            npcImg: this.npc.img,
            text: this.dialogData.text,
            options: this.dialogData.options,
            isObserver: this.isObserver
        };
    }

    activateListeners(html) {
        html.find('.dialog-option').click(ev => {
            if (this.isObserver) return;
            const idx = $(ev.currentTarget).data('index');
            const selected = this.dialogData.options[idx];
            
            game.socket.emit(`module.${MOD_ID}`, {
                type: "choiceMade",
                npcId: this.npc.id,
                text: selected.text
            });
            this.close();
        });
    }
}